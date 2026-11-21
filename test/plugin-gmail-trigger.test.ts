/**
 * TODO 1217: the trigger of `aios.gmail`. The rules (`host/trigger.ts`) and how sync (`host/sync.ts`) notifies are pinned down with fixtures.
 * It connects to neither the real Gmail nor aios (`api` is a fake).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { BrokerNetFetchResult, PluginApi } from '../src/shared/plugin.js'
import type { PluginTriggerEvent, TriggerEmitResult } from '../src/shared/trigger.js'
import { parseManifest } from '../src/main/plugin/manifest.js'
import { MAX_NOTIFY_CARRY, MAX_NOTIFY_TRIES, parseState, runSync } from '../plugins/aios.gmail/host/sync.js'
import type { GmailMessage } from '../plugins/aios.gmail/host/message.js'
import { matchesSettingFormat } from '../src/shared/setting-format.js'
import { resolvePluginSettings } from '../src/shared/plugin-settings.js'
import {
  isAllowEntry,
  aligned,
  authenticated,
  DEFAULT_TRIGGER_SETTINGS,
  evaluateMail,
  parseAuthResults,
  parseTriggerSettings,
  referenceText,
  type RejectReason,
  type TriggerSettings
} from '../plugins/aios.gmail/host/trigger.js'

const NOW = 1_761_600_000_000
const ME = 'me@example.com'
const GOOD_AUTH =
  'mx.google.com; dkim=pass header.i=@acme.com header.s=s1 header.b=abc; spf=pass (google.com: domain of bob@acme.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=bob@acme.com; dmarc=pass header.from=acme.com'

interface Spec {
  id?: string
  labels?: string[]
  headers?: Record<string, string | string[] | null>
  internalDate?: number
}

function mail(spec: Spec = {}): GmailMessage {
  const base: Record<string, string | string[] | null> = {
    Subject: '見積の件',
    From: 'Bob <bob@acme.com>',
    To: ME,
    Date: 'Tue, 28 Oct 2026 09:00:00 +0900',
    'Authentication-Results': GOOD_AUTH,
    ...spec.headers
  }
  const headers = Object.entries(base).flatMap(([name, value]) =>
    value === null ? [] : (Array.isArray(value) ? value : [value]).map((v) => ({ name, value: v }))
  )
  const id = spec.id ?? 'm1'
  return {
    id,
    threadId: `t-${id}`,
    labelIds: spec.labels ?? ['INBOX', 'UNREAD'],
    internalDate: String(spec.internalDate ?? NOW - 60_000),
    payload: { mimeType: 'text/plain', headers, body: { data: Buffer.from('SECRET BODY', 'utf8').toString('base64url') } }
  }
}

const verdictOf = (spec: Spec, settings: TriggerSettings = DEFAULT_TRIGGER_SETTINGS, since = 0): 'pass' | RejectReason => {
  const verdict = evaluateMail(mail(spec), ME, settings, NOW, since)
  return verdict.pass ? 'pass' : verdict.reason
}

describe('規則 evaluateMail', () => {
  it('INBOX・To・未読・認証 pass の 1 通は通り、事実だけを返す (本文は無い)', () => {
    const verdict = evaluateMail(mail(), ME, DEFAULT_TRIGGER_SETTINGS, NOW, 0)
    expect(verdict).toEqual({
      pass: true,
      facts: { subject: '見積の件', from: 'Bob <bob@acme.com>', fromAddress: 'bob@acme.com', date: 'Tue, 28 Oct 2026 09:00:00 +0900', threadId: 't-m1', messageId: 'm1' },
      gate: { internalDate: NOW - 60_000, ccOnly: false, authOk: true }
    })
    expect(JSON.stringify(verdict)).not.toContain('SECRET BODY')
  })

  it('ラベル: INBOX と UNREAD が要る。カテゴリ・SENT・DRAFT・SPAM・TRASH は除く', () => {
    expect(verdictOf({ labels: ['UNREAD'] })).toBe('no-labels')
    expect(verdictOf({ labels: ['INBOX'] })).toBe('no-labels')
    for (const label of ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'SENT', 'DRAFT', 'SPAM', 'TRASH']) {
      expect(verdictOf({ labels: ['INBOX', 'UNREAD', label] })).toBe('excluded-label')
    }
    expect(verdictOf({ labels: ['INBOX', 'UNREAD', 'IMPORTANT', 'CATEGORY_PERSONAL'] })).toBe('pass')
  })

  it('メーリングリスト・一斉配信 (List-Unsubscribe / List-Id / Precedence) と noreply を除く', () => {
    expect(verdictOf({ headers: { 'List-Unsubscribe': '<mailto:u@acme.com>' } })).toBe('list')
    expect(verdictOf({ headers: { 'List-Id': '<ml.acme.com>' } })).toBe('list')
    expect(verdictOf({ headers: { Precedence: 'bulk' } })).toBe('list')
    for (const from of ['noreply@acme.com', 'No-Reply <no-reply@acme.com>', 'do-not-reply@acme.com', 'donotreply@acme.com', 'noreply+x@acme.com', 'MAILER-DAEMON@acme.com']) {
      expect(verdictOf({ headers: { From: from } })).toBe('noreply')
    }
    // A plain person whose name merely contains a similar word passes.
    expect(verdictOf({ headers: { From: 'Reply Team <reply.person@acme.com>' } })).toBe('pass')
  })

  it('To: 自分が To に居るときだけ。Cc だけは既定で通さず、設定 includeCc で通す。どちらでもなければ not-to-me', () => {
    expect(verdictOf({ headers: { To: 'other@example.com', Cc: ME } })).toBe('cc-only')
    expect(verdictOf({ headers: { To: 'other@example.com', Cc: ME } }, { ...DEFAULT_TRIGGER_SETTINGS, includeCc: true })).toBe('pass')
    expect(verdictOf({ headers: { To: 'other@example.com', Cc: 'x@example.com' } }, { ...DEFAULT_TRIGGER_SETTINGS, includeCc: true })).toBe('not-to-me')
    expect(verdictOf({ headers: { To: 'Me Myself <ME@Example.com>, other@example.com' } })).toBe('pass')
    // An address inside a display name is not counted.
    expect(verdictOf({ headers: { To: `"${ME}" <other@example.com>` } })).toBe('not-to-me')
    expect(verdictOf({ headers: { To: null } })).toBe('not-to-me')
  })

  it('送信元の許可表: アドレスかドメイン。無ければ (null) 上の規則だけ、入れたらその外は通さない。空の表は誰も通さない', () => {
    const allow = (...allowFrom: string[]): TriggerSettings => ({ ...DEFAULT_TRIGGER_SETTINGS, allowFrom })
    expect(verdictOf({}, DEFAULT_TRIGGER_SETTINGS)).toBe('pass')
    expect(verdictOf({}, allow())).toBe('sender-not-allowed')
    expect(verdictOf({}, allow('acme.com'))).toBe('pass')
    expect(verdictOf({}, allow('@acme.com'))).toBe('pass')
    expect(verdictOf({}, allow('bob@acme.com'))).toBe('pass')
    expect(verdictOf({}, allow('carol@acme.com'))).toBe('sender-not-allowed')
    expect(verdictOf({}, allow('other.com'))).toBe('sender-not-allowed')
    expect(verdictOf({}, allow('example.com'))).toBe('sender-not-allowed')
  })

  it('認証: Gmail の Authentication-Results で差出人に揃った dkim / spf の pass が要る', () => {
    expect(verdictOf({ headers: { 'Authentication-Results': null } })).toBe('auth')
    expect(verdictOf({ headers: { 'Authentication-Results': 'mx.google.com; dkim=fail header.i=@acme.com; spf=fail smtp.mailfrom=bob@acme.com' } })).toBe('auth')
    // Passes with dkim pass alone, or with spf pass alone.
    expect(verdictOf({ headers: { 'Authentication-Results': 'mx.google.com; dkim=pass header.d=acme.com; spf=fail smtp.mailfrom=bob@acme.com' } })).toBe('pass')
    expect(verdictOf({ headers: { 'Authentication-Results': 'mx.google.com; dkim=none; spf=pass smtp.mailfrom=bob@acme.com' } })).toBe('pass')
    // A pass for a domain different from the sender cannot serve as a base for spoofing.
    expect(verdictOf({ headers: { 'Authentication-Results': 'mx.google.com; dkim=pass header.i=@evil.test; spf=pass smtp.mailfrom=x@evil.test' } })).toBe('auth')
    // A header added by something other than Gmail (written by the sender itself) is not looked at.
    expect(verdictOf({ headers: { 'Authentication-Results': 'evil.test; dkim=pass header.d=acme.com; spf=pass smtp.mailfrom=bob@acme.com' } })).toBe('auth')
    // The authserv-id must be an exact match of mx.google.com only.
    for (const id of ['evil.google.com.example', 'evil.google.com', 'google.com', 'xmx.google.com', 'mx.google.com.evil.test']) {
      expect(verdictOf({ headers: { 'Authentication-Results': `${id}; dkim=pass header.d=acme.com; dmarc=pass header.from=acme.com` } })).toBe('auth')
    }
    // Ordering assumption: payload.headers runs from top to bottom. A fake pass below the first (Gmail's) fail does not pass.
    const fail = 'mx.google.com; dkim=fail header.i=@acme.com; spf=fail smtp.mailfrom=bob@acme.com; dmarc=fail header.from=acme.com'
    const forged = 'mx.google.com; dkim=pass header.d=acme.com; spf=pass smtp.mailfrom=bob@acme.com; dmarc=pass header.from=acme.com'
    expect(verdictOf({ headers: { 'Authentication-Results': [fail, forged] } })).toBe('auth')
    // Even when a single fake pass is present (no genuine Gmail one), if its head only claims mx.google.com, the two cannot be told apart.
    // But if the head is not Gmail's (another authserv-id comes first), it does not pass.
    expect(verdictOf({ headers: { 'Authentication-Results': ['evil.test; dkim=pass header.d=acme.com', forged] } })).toBe('auth')
    // dmarc is the deciding factor: even with dkim / spf pass, it does not pass if dmarc=fail. When there is no dmarc, dkim / spf are picked up.
    expect(verdictOf({ headers: { 'Authentication-Results': 'mx.google.com; dkim=pass header.d=acme.com; dmarc=fail header.from=acme.com' } })).toBe('auth')
    expect(verdictOf({ headers: { 'Authentication-Results': 'mx.google.com; dmarc=pass header.from=other.test' } })).toBe('auth')
    expect(verdictOf({ headers: { 'Authentication-Results': 'mx.google.com; dmarc=pass header.from=acme.com' } })).toBe('pass')
    // Can be turned off in the settings.
    expect(verdictOf({ headers: { 'Authentication-Results': null } }, { ...DEFAULT_TRIGGER_SETTINGS, requireAuth: false })).toBe('pass')
    // If the head is Gmail's with pass, it passes even with other headers below (the lower ones are not read).
    expect(verdictOf({ headers: { 'Authentication-Results': [GOOD_AUTH, 'evil.test; dkim=fail'] } })).toBe('pass')
    // If the head is not Gmail's, it does not pass even with a genuine one below (a mail whose ordering assumption is broken is suspected).
    expect(verdictOf({ headers: { 'Authentication-Results': ['evil.test; dkim=none', GOOD_AUTH] } })).toBe('auth')
  })

  it('認証の字句 (RFC 8601): コメント・引用符の中の ; や dmarc=pass は区切りにも結果にもならない (セキュリティレビュー)', () => {
    const auth = (value: string): 'pass' | RejectReason => verdictOf({ headers: { 'Authentication-Results': value } })
    // dmarc=pass inside a comment.
    expect(auth('mx.google.com; dmarc=fail (dmarc=pass) header.from=acme.com')).toBe('auth')
    expect(auth('mx.google.com; spf=pass (x; dmarc=pass header.from=acme.com) smtp.mailfrom=bob@evil.test; dmarc=fail header.from=acme.com')).toBe('auth')
    // Nested comments and escaped parentheses.
    expect(auth('mx.google.com; dmarc=fail (a (b \\) ; dmarc=pass header.from=acme.com) c) header.from=acme.com')).toBe('auth')
    // ;dmarc=pass inside quotes (a reason string, and the local part of smtp.mailfrom).
    expect(auth('mx.google.com; dkim=fail reason="bad;dmarc=pass header.from=acme.com" header.d=acme.com')).toBe('auth')
    expect(auth('mx.google.com; spf=pass smtp.mailfrom="x;dmarc=pass header.from=acme.com"@evil.test; dmarc=fail header.from=acme.com')).toBe('auth')
    // In a quoted local part the domain is still after the @. An spf=pass with no dmarc passes if they match; writing acme.com in the local part does not let evil.test through.
    expect(auth('mx.google.com; spf=pass smtp.mailfrom="a.b"@acme.com')).toBe('pass')
    // The ; ( ) inside quotes are material for a disagreement in how the header is read, so even a valid form is not passed (on the safe side; the third security review of wave 84).
    expect(auth('mx.google.com; spf=pass smtp.mailfrom="a;b"@acme.com')).toBe('auth')
    expect(auth('mx.google.com; spf=pass smtp.mailfrom="a)b"@acme.com')).toBe('auth')
    // A form where a ) in a quoted local part inside a comment closes the comment early, bringing a fake dmarc=pass to the front of the next segment (Gmail writes the sender's local part as it is in the SPF comment).
    // If there is a " inside the comment it is not read, so it does not pass, whether or not a genuine dmarc=fail follows.
    expect(auth('mx.google.com; spf=pass (google.com: domain of "x);dmarc=pass header.from=acme.com;(y"@evil.test designates 1.2.3.4) smtp.mailfrom=evil.test; dmarc=fail header.from=evil.test')).toBe('auth')
    expect(auth('mx.google.com; spf=pass (google.com: domain of "x);dmarc=pass header.from=acme.com;(y"@evil.test designates 1.2.3.4) smtp.mailfrom=evil.test')).toBe('auth')
    expect(auth('mx.google.com; spf=pass smtp.mailfrom="x@acme.com"@evil.test')).toBe('auth')
    // Plants ;dmarc=pass inside header.from's value (quoted or bare).
    expect(auth('mx.google.com; dmarc=fail header.from="acme.com;dmarc=pass"')).toBe('auth')
    expect(auth('mx.google.com; dmarc=fail header.from=evil.test;dmarc=pass header.from=acme.com')).toBe('auth')
    // Exactly one dmarc. Both pass and fail (in either order), or two passes, do not pass.
    expect(auth('mx.google.com; dmarc=pass header.from=acme.com; dmarc=fail header.from=acme.com')).toBe('auth')
    expect(auth('mx.google.com; dmarc=fail header.from=acme.com; dmarc=pass header.from=acme.com')).toBe('auth')
    expect(auth('mx.google.com; dmarc=pass header.from=acme.com; dmarc=pass header.from=acme.com')).toBe('auth')
    // header.from is required (absent, only inside a comment, or two of them).
    expect(auth('mx.google.com; dmarc=pass')).toBe('auth')
    expect(auth('mx.google.com; dmarc=pass (header.from=acme.com)')).toBe('auth')
    expect(auth('mx.google.com; dmarc=pass header.from=acme.com header.from=evil.test')).toBe('auth')
    // header.from must match the sender's domain (a different domain or a subdomain does not pass).
    expect(auth('mx.google.com; dmarc=pass header.from=evil.test')).toBe('auth')
    expect(auth('mx.google.com; dmarc=pass header.from=mail.acme.com')).toBe('auth')
    // When there is no dmarc, a pass of dkim / spf is not counted without its attributes (header.d / header.i / smtp.mailfrom).
    expect(auth('mx.google.com; dkim=pass; spf=pass')).toBe('auth')
    expect(auth('mx.google.com; dkim=pass (header.d=acme.com) header.s=s1')).toBe('auth')
    expect(auth('mx.google.com; spf=pass (smtp.mailfrom=bob@acme.com)')).toBe('auth')
    // Headers that cannot be read (a comment or quote that does not close, unpaired parentheses, a quote where the method name should be) do not pass.
    expect(auth('mx.google.com; dmarc=pass header.from=acme.com (open')).toBe('auth')
    expect(auth('mx.google.com; dmarc=pass header.from="acme.com')).toBe('auth')
    expect(auth('mx.google.com; dmarc=pass header.from=acme.com )')).toBe('auth')
    expect(auth('mx.google.com; "dmarc"=pass header.from=acme.com')).toBe('auth')
    // A correct form passes (the spaces around = are also allowed, as RFC says).
    expect(auth('mx.google.com; dmarc=pass header.from=acme.com')).toBe('pass')
    expect(auth('mx.google.com; dmarc = pass header.from = acme.com')).toBe('pass')
    expect(auth('mx.google.com; none')).toBe('auth')
  })

  it('実物の Gmail の形 (公開されている例の形から作った合成。ドメイン・IP・署名は差し替え) が通る', () => {
    // Line folding (CRLF + space), dmarc=pass inside an ARC result's comment, a ':' in an spf comment, and dmarc containing (p=… sp=… dis=…).
    const gmail = [
      'mx.google.com;',
      '       dkim=pass header.i=@acme.com header.s=20230601 header.b=AbCd12Ef;',
      '       arc=pass (i=1 spf=pass spfdomain=acme.com dkim=pass dkdomain=acme.com dmarc=pass fromdomain=acme.com);',
      '       spf=pass (google.com: domain of bob@acme.com designates 209.85.220.41 as permitted sender) smtp.mailfrom=bob@acme.com;',
      '       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=acme.com'
    ].join('\r\n')
    expect(verdictOf({ headers: { 'Authentication-Results': gmail } })).toBe('pass')
    // With the same form, if only dmarc is fail, it does not pass even when dmarc=pass is inside an arc comment.
    expect(verdictOf({ headers: { 'Authentication-Results': gmail.replace('dmarc=pass (p=', 'dmarc=fail (p=') } })).toBe('auth')
    const parsed = parseAuthResults(gmail.replace(/\r\n/g, ' '))
    expect(parsed?.authservId).toBe('mx.google.com')
    expect(parsed?.results.map((result) => `${result.method}=${result.result}`)).toEqual(['dkim=pass', 'arc=pass', 'spf=pass', 'dmarc=pass'])
    expect(parsed?.results[3]?.props.get('header.from')).toEqual(['acme.com'])
  })

  it('aligned / authenticated の小さな検査', () => {
    expect(aligned('mail.acme.com', 'acme.com')).toBe(true)
    expect(aligned('acme.com', 'mail.acme.com')).toBe(true)
    expect(aligned('notacme.com', 'acme.com')).toBe(false)
    expect(aligned('com', 'acme.com')).toBe(false)
    expect(authenticated([{ name: 'Authentication-Results', value: GOOD_AUTH }], '')).toBe(false)
  })

  it('新しさ: 下限 (有効にした時刻) 以前と 48 時間より古いものは通さない', () => {
    expect(verdictOf({ internalDate: NOW - 1000 }, DEFAULT_TRIGGER_SETTINGS, NOW - 500)).toBe('too-old')
    expect(verdictOf({ internalDate: NOW - 1000 }, DEFAULT_TRIGGER_SETTINGS, NOW - 2000)).toBe('pass')
    expect(verdictOf({ internalDate: NOW - 49 * 3_600_000 })).toBe('too-old')
  })

  it('直し X: 設定の読みは閉じる側 — 形が壊れていれば null、許可表は読めた行だけで絞り、1 行も読めなければ誰も通さない', () => {
    const base = { allowFrom: [], includeCc: false, requireAuth: true }
    expect(parseTriggerSettings(base)).toEqual(DEFAULT_TRIGGER_SETTINGS)
    expect(DEFAULT_TRIGGER_SETTINGS.allowFrom).toBeNull()
    for (const broken of [null, 'x', [], {}, { ...base, allowFrom: 'a.com' }, { ...base, includeCc: 'yes' }, { ...base, requireAuth: 0 }]) {
      expect(parseTriggerSettings(broken), JSON.stringify(broken)).toBeNull()
    }
    // Only partly readable: only the readable lines (it does not widen).
    expect(parseTriggerSettings({ ...base, allowFrom: ['  ACME.com ', 5, '', 'a b', 'Alice <alice@example.com>'] })).toEqual({
      ...base,
      allowFrom: ['acme.com']
    })
    // Nothing readable: an empty array = nobody passes (it is not "no allow list").
    const none = parseTriggerSettings({ ...base, allowFrom: ['Alice <alice@example.com>', 'a@x.com b@y.com', 'localhost'] })
    expect(none).toEqual({ ...base, allowFrom: [] })
    expect(verdictOf({}, none!)).toBe('sender-not-allowed')
    expect(verdictOf({}, { ...DEFAULT_TRIGGER_SETTINGS, allowFrom: null })).toBe('pass')
  })

  it('直し X: 許可表の 1 行の形はマニフェストの format (email-or-domain) で、main の判定と拡張機能の写しが食い違わない', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'plugins', 'aios.gmail', 'manifest.json'), 'utf8')) as {
      configuration: { properties: { allowFrom: { items: { format: string } } } }
    }
    expect(manifest.configuration.properties.allowFrom.items.format).toBe('email-or-domain')
    const good = ['bob@acme.com', 'Boss@Example.COM', '@acme.com', 'acme.com', 'mail.acme.co.jp', 'a+b@x-y.com', 'x@a1.b2']
    const bad = [
      'Alice <alice@example.com>',
      'a@x.com b@y.com',
      'localhost',
      'a@',
      '@',
      'a@b',
      'a,b@x.com',
      '"a"@x.com',
      'x.com.',
      '-a.com',
      'a-.com',
      'a..com',
      '@@a.com',
      'a@b@c.com',
      `${'a'.repeat(65)}@x.com`,
      `${'a'.repeat(64)}.com`,
      `${'a.'.repeat(130)}com`,
      'a@x.com\u00a0',
      ''
    ]
    for (const entry of good) {
      expect(matchesSettingFormat('email-or-domain', entry), entry).toBe(true)
      expect(isAllowEntry(entry), entry).toBe(true)
    }
    for (const entry of bad) {
      expect(matchesSettingFormat('email-or-domain', entry), entry).toBe(false)
      expect(isAllowEntry(entry), entry).toBe(false)
    }
    // For many shapes (combinations of separators) both answers are the same. If they disagreed, the side that closes (which the extension discards) would apply; this pins down that they do not disagree here.
    const parts = ['a', 'B', '1', '-', '.', '@', '+', ' ', '<', '_', 'é']
    const corpus: string[] = []
    for (const x of parts) for (const y of parts) for (const z of parts) corpus.push(`${x}${y}${z}`, `${x}${y}.${z}om`, `u@${x}${y}.${z}c`)
    for (const entry of corpus) expect(isAllowEntry(entry), entry).toBe(matchesSettingFormat('email-or-domain', entry))
  })

  it('直し X (セキュリティレビュー): 宣言が厳しくなった後の保存済みの許可表 (今の形に合わない) は渡らず、出来事は 0 件', async () => {
    const manifest = parseManifest(JSON.parse(readFileSync(join(process.cwd(), 'plugins', 'aios.gmail', 'manifest.json'), 'utf8')))
    // A row saved by an earlier version (which does not fit the current format). main does not fall back to the default (= no filtering); it drops the whole field from the value.
    const values = resolvePluginSettings(manifest.configuration, { allowFrom: ['Alice <bob@acme.com>'], includeCc: false, requireAuth: true })
    expect(values).toEqual({ includeCc: false, requireAuth: true })
    expect(parseTriggerSettings(values)).toBeNull()
    const fake = new Fake()
    fake.messages.set('m', mail({ id: 'm' }))
    fake.history = [{ id: '1001', messagesAdded: [added('m')] }]
    fake.rawSettings = values
    await runAll(fake, settled())
    expect(fake.emitted).toEqual([])
  })

  it('prompt は参照だけ。本文を含まず 2,000 字以内、件名が長くても切れる', () => {
    const verdict = evaluateMail(mail({ headers: { Subject: 'あ'.repeat(5000) } }), ME, DEFAULT_TRIGGER_SETTINGS, NOW, 0)
    if (!verdict.pass) throw new Error('should pass')
    const text = referenceText(verdict.facts, 'gmail://t-m1/m1')
    expect(text.length).toBeLessThanOrEqual(2000)
    expect(text).toContain('Ref: gmail://t-m1/m1')
    expect(text).toContain(`source_id "${verdict.facts.messageId}"`)
    expect(text).not.toContain('SECRET BODY')
  })
})

describe('manifest', () => {
  it('triggers に new-mail を宣言し、defaultPrompt は本文の取り方と送信しないことを言う', () => {
    const manifest = parseManifest(JSON.parse(readFileSync(join(__dirname, '../plugins/aios.gmail/manifest.json'), 'utf8')))
    const trigger = manifest.triggers?.find((t) => t.id === 'new-mail')
    expect(trigger).toBeDefined()
    expect(trigger?.defaultPrompt).toContain('getDocumentText')
    expect(trigger?.defaultPrompt).toContain('送信')
    expect(manifest.capabilities).not.toHaveProperty('triggers')
  })
})

// ---- how sync notifies ----

const encoder = new TextEncoder()

class Fake {
  messages = new Map<string, GmailMessage>()
  history: unknown[] = []
  emitted: PluginTriggerEvent[] = []
  putOrder: string[] = []
  verdicts: TriggerEmitResult[] = [{ accepted: true }]
  throwOnEmit = false
  seen = new Set<string>()
  /**
   * TODO 1225: the "settings" values of the extension details (what `api.settings.get()` returns). main returns every field of the declaration (with defaults where absent),
   * so only the fields that were written are overlaid on the defaults. If `rawSettings` is set, that is returned as it is (a value with a broken shape).
   */
  settings: Record<string, unknown> = {}
  rawSettings: unknown = undefined

  api(): PluginApi {
    return {
      fs: {
        read: async () => {
          throw new Error('no fs')
        }
      },
      browser: {
        fetchPage: async () => {
          throw new Error('no browser')
        }
      },
      triggers: {
        emit: async (event: PluginTriggerEvent): Promise<TriggerEmitResult> => {
          this.putOrder.push(`emit:${event.key}`)
          if (this.throwOnEmit) throw new Error('not-consented')
          this.emitted.push(event)
          const next = this.verdicts[0]!
          if (next.accepted && this.seen.has(event.key)) return { accepted: false, reason: 'duplicate' }
          if (next.accepted) this.seen.add(event.key)
          return next
        }
      },
      settings: {
        get: async () =>
          this.rawSettings !== undefined ? this.rawSettings : { allowFrom: [], includeCc: false, requireAuth: true, ...this.settings }
      },
      ui: { notify: async () => undefined },
      sidebar: { setRows: async () => undefined },
      status: { report: async () => undefined },
      credentials: { status: async () => ({ present: true, host: 'gmail.googleapis.com' }) },
      index: {
        put: async (doc: { sourceId: string }) => {
          this.putOrder.push(`put:${doc.sourceId}`)
        },
        remove: async () => undefined
      },
      net: { fetch: async (url: string, init?: { body?: string | Uint8Array }) => this.fetch(url, init ?? {}) }
    } as unknown as PluginApi
  }

  async fetch(url: string, init: { body?: string | Uint8Array }): Promise<BrokerNetFetchResult> {
    const u = new URL(url)
    const jsonRes = (value: unknown): BrokerNetFetchResult => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: encoder.encode(JSON.stringify(value)),
      truncated: false
    })
    if (u.pathname.endsWith('/profile')) return jsonRes({ emailAddress: ME, historyId: '1000' })
    if (u.pathname.endsWith('/messages')) return jsonRes({ messages: [...this.messages.values()].map((m) => ({ id: m.id, threadId: m.threadId })) })
    if (u.pathname.endsWith('/history')) return jsonRes({ history: this.history, historyId: '2000' })
    const ids = [...String(init.body).matchAll(/messages\/([^?]+)\?format/g)].map((m) => m[1]!)
    const parts = ids.map((id, i) => {
      const m = this.messages.get(id)
      return `--R\r\nContent-Type: application/http\r\nContent-ID: <response-item-${i}>\r\n\r\nHTTP/1.1 ${m ? '200 OK' : '404 Not Found'}\r\n\r\n${m ? JSON.stringify(m) : '{}'}\r\n`
    })
    return { status: 200, headers: { 'content-type': 'multipart/mixed; boundary=R' }, body: encoder.encode(`${parts.join('')}--R--\r\n`), truncated: false }
  }
}

const added = (id: string, labels: string[] = ['INBOX', 'UNREAD']) => ({ message: { id, labelIds: labels } })
const clock = (): number => NOW

async function runAll(fake: Fake, state: Record<string, unknown> | null): Promise<Record<string, unknown>> {
  let current = state
  for (let i = 0; i < 20; i += 1) {
    const result = await runSync({ state: current, reason: 'idle' }, fake.api(), 30, clock)
    current = (result.state ?? current) as Record<string, unknown> | null
    if (result.more !== true) break
  }
  return current as Record<string, unknown>
}

/** The state where the full import is done and the differences are at position 1000. */
const settled = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  account: ME,
  historyId: '1000',
  fullDone: true,
  fetched: 0,
  pendingIds: [],
  failures: {},
  backoffMs: 0,
  fullPageToken: null,
  ...extra
})

describe('同期からの知らせ', () => {
  it('初回の全件の取り込みでは 1 通も知らせない', async () => {
    const fake = new Fake()
    for (const id of ['a', 'b', 'c']) fake.messages.set(id, mail({ id }))
    await runAll(fake, null)
    expect(fake.emitted).toEqual([])
    expect(fake.putOrder.filter((x) => x.startsWith('put:')).length).toBe(3)
  })

  it('差分の messagesAdded の規則を通った新着を、スレッドの id を鍵に・参照だけの prompt で知らせる。索引に入れた後', async () => {
    const fake = new Fake()
    fake.messages.set('n1', mail({ id: 'n1' }))
    fake.history = [{ id: '1001', messagesAdded: [added('n1')] }]
    const state = await runAll(fake, settled())
    expect(fake.emitted).toHaveLength(1)
    const event = fake.emitted[0]!
    expect(event).toMatchObject({ trigger: 'new-mail', key: 't-n1', title: '見積の件' })
    expect(event.url).toBe('https://mail.google.com/mail/?authuser=me%40example.com#all/t-n1')
    expect(event.prompt).toContain('Ref: gmail://t-n1/n1')
    expect(event.prompt).not.toContain('SECRET BODY')
    expect(event.cwd).toBeUndefined()
    expect(fake.putOrder).toEqual(['put:n1', 'emit:t-n1'])
    expect(state['pendingIds']).toEqual([])
    expect(state['newIds']).toEqual([])
  })

  it('ラベルの変化だけで取った古いメールは知らせない (新着ではない)', async () => {
    const fake = new Fake()
    fake.messages.set('old', mail({ id: 'old' }))
    fake.history = [{ id: '1001', labelsAdded: [added('old')] }]
    await runAll(fake, settled())
    expect(fake.emitted).toEqual([])
  })

  it('規則に落ちた新着 (メーリングリスト・Cc のみ・カテゴリ) は知らせない', async () => {
    const fake = new Fake()
    fake.messages.set('l', mail({ id: 'l', headers: { 'List-Id': '<x.acme.com>' } }))
    fake.messages.set('c', mail({ id: 'c', headers: { To: 'o@example.com', Cc: ME } }))
    fake.messages.set('p', mail({ id: 'p', labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'] }))
    fake.history = [{ id: '1001', messagesAdded: [added('l'), added('c'), added('p')] }]
    await runAll(fake, settled())
    expect(fake.emitted).toEqual([])
  })

  it('TODO 1225: 設定 (拡張の詳細の「設定」) の includeCc を入れると Cc のみも通る。設定は状態に持たず、毎回読む', async () => {
    const fake = new Fake()
    fake.messages.set('c', mail({ id: 'c', headers: { To: 'o@example.com', Cc: ME } }))
    fake.history = [{ id: '1001', messagesAdded: [added('c')] }]
    fake.settings = { includeCc: true }
    const state = await runAll(fake, settled())
    expect(fake.emitted).toHaveLength(1)
    expect(state).not.toHaveProperty('triggerSettings')
    // The triggerSettings that an earlier version put into the state are not read (loose values left over do not take effect).
    const old = new Fake()
    old.messages.set('c', mail({ id: 'c', headers: { To: 'o@example.com', Cc: ME } }))
    old.history = [{ id: '1001', messagesAdded: [added('c')] }]
    await runAll(old, settled({ triggerSettings: { includeCc: true, requireAuth: false } }))
    expect(old.emitted).toEqual([])
  })

  it('直し X: 設定を読めない (例外・形が壊れている) 回は出来事を 0 件。持ち越して、読めた回に今の設定で判定し直す', async () => {
    const fake = new Fake()
    fake.messages.set('m', mail({ id: 'm' }))
    fake.history = [{ id: '1001', messagesAdded: [added('m')] }]
    const api = fake.api()
    const broken = { ...api, settings: { get: async () => Promise.reject(new Error('unavailable')) } } as PluginApi
    const first = await runSync({ state: settled(), reason: 'idle' }, broken, 30, clock)
    expect(fake.emitted).toEqual([])
    expect((first.state?.['notifyCarry'] as unknown[]).length).toBe(1)
    // Even with a broken-shape value, the result is 0 (it does not fall back to the default "no allow list").
    fake.history = []
    fake.rawSettings = { allowFrom: 'bob@acme.com', includeCc: false, requireAuth: true }
    const second = await runSync({ state: { ...first.state!, historyId: '2000' }, reason: 'idle' }, fake.api(), 30, clock)
    expect(fake.emitted).toEqual([])
    // On a run that can read it, judge again with the current settings (filtered by the allow list): if it is outside the allow list, it is not emitted.
    fake.rawSettings = undefined
    fake.settings = { allowFrom: ['other.com'] }
    const third = await runSync({ state: { ...second.state!, historyId: '2000' }, reason: 'idle' }, fake.api(), 30, clock)
    expect(fake.emitted).toEqual([])
    expect(third.state?.['notifyCarry']).toEqual([])
  })

  it('直し X: 許可表を入れたが 1 行も読めない設定なら、全送信元を許可へ倒さず 0 件', async () => {
    const fake = new Fake()
    fake.messages.set('m', mail({ id: 'm' }))
    fake.history = [{ id: '1001', messagesAdded: [added('m')] }]
    fake.settings = { allowFrom: ['Alice <bob@acme.com>'] }
    await runAll(fake, settled())
    expect(fake.emitted).toEqual([])
    // Only partly readable: filter only by the readable line (acme.com).
    const partial = new Fake()
    partial.messages.set('m', mail({ id: 'm' }))
    partial.history = [{ id: '1001', messagesAdded: [added('m')] }]
    partial.settings = { allowFrom: ['Alice <x@y.com>', 'acme.com'] }
    await runAll(partial, settled())
    expect(partial.emitted).toHaveLength(1)
  })

  it('同じスレッドの続きのメールは duplicate で、状態は進む (新しい会話は起きない)', async () => {
    const fake = new Fake()
    fake.messages.set('r1', { ...mail({ id: 'r1' }), threadId: 'T' })
    fake.messages.set('r2', { ...mail({ id: 'r2' }), threadId: 'T' })
    fake.history = [{ id: '1001', messagesAdded: [added('r1')] }]
    let state = await runAll(fake, settled())
    fake.history = [{ id: '2001', messagesAdded: [added('r2')] }]
    state = await runAll(fake, { ...state, historyId: '2000' })
    expect(fake.emitted.map((e) => e.key)).toEqual(['T', 'T'])
    expect(fake.seen.size).toBe(1)
    expect(state['pendingIds']).toEqual([])
  })

  it('disabled: 片づけて (再送しない) 時刻を覚え、その前に届いたメールは有効にした後も出さない', async () => {
    const fake = new Fake()
    fake.verdicts = [{ accepted: false, reason: 'disabled' }]
    fake.messages.set('d1', mail({ id: 'd1', internalDate: NOW - 5000 }))
    fake.history = [{ id: '1001', messagesAdded: [added('d1')] }]
    const state = await runAll(fake, settled())
    expect(state['pendingIds']).toEqual([])
    expect(state['disabledAt']).toBe(NOW)
    // After it is enabled, even if the same mail (which arrived before disabledAt) is seen again, it is not emitted.
    fake.verdicts = [{ accepted: true }]
    fake.history = [{ id: '3001', messagesAdded: [added('d1')] }]
    await runAll(fake, { ...state, historyId: '3000' })
    expect(fake.emitted).toHaveLength(1)
  })

  it('直し V: unavailable / 例外 (同意なし) は取得の失敗に数えず、知らせだけを持ち越す。daily-cap / invalid は片づける', async () => {
    const fake = new Fake()
    fake.verdicts = [{ accepted: false, reason: 'unavailable' }]
    fake.messages.set('u', mail({ id: 'u' }))
    fake.history = [{ id: '1001', messagesAdded: [added('u')] }]
    const first = await runSync({ state: settled(), reason: 'idle' }, fake.api(), 30, clock)
    const state = first.state as Record<string, unknown>
    // The mails are put into the index and cleared (not fetched again). Only the notice is carried over.
    expect(state['pendingIds']).toEqual([])
    expect(state['newIds']).toEqual([])
    expect(state['failures']).toEqual({})
    expect(state['notifyCarry']).toEqual([
      {
        facts: expect.objectContaining({ threadId: 't-u', messageId: 'u', fromAddress: 'bob@acme.com' }),
        gate: { internalDate: NOW - 60_000, ccOnly: false, authOk: true },
        tries: 1
      }
    ])
    expect(fake.putOrder).toEqual(['put:u', 'emit:t-u'])

    const thrown = new Fake()
    thrown.throwOnEmit = true
    thrown.messages.set('e', mail({ id: 'e' }))
    thrown.history = [{ id: '1001', messagesAdded: [added('e')] }]
    const afterThrow = await runSync({ state: settled(), reason: 'idle' }, thrown.api(), 30, clock)
    expect((afterThrow.state as Record<string, unknown>)['pendingIds']).toEqual([])
    expect(((afterThrow.state as Record<string, unknown>)['notifyCarry'] as unknown[]).length).toBe(1)

    for (const reason of ['daily-cap', 'invalid'] as const) {
      const f = new Fake()
      f.verdicts = [{ accepted: false, reason }]
      f.messages.set('x', mail({ id: 'x' }))
      f.history = [{ id: '1001', messagesAdded: [added('x')] }]
      const done = await runAll(f, settled())
      expect(done['pendingIds']).toEqual([])
      expect(done['notifyCarry']).toEqual([])
    }
  })

  it('直し V: 持ち越した知らせは次の回に Gmail へ問い合わせずに送り直す。届けば消え、届かなければ回数を足し、上限で捨ててログに 1 行 (値は出さない)', async () => {
    const fake = new Fake()
    fake.verdicts = [{ accepted: false, reason: 'unavailable' }]
    fake.messages.set('u', mail({ id: 'u' }))
    fake.history = [{ id: '1001', messagesAdded: [added('u')] }]
    let state = (await runSync({ state: settled(), reason: 'idle' }, fake.api(), 30, clock)).state as Record<string, unknown>
    // Under AIOS_DISABLE_AGENT and the proxy verification (autoRun faked), unavailable continues. Sends (net.fetch) do not increase.
    const fetches: string[] = []
    const counting = (): PluginApi => {
      const api = fake.api()
      const inner = api.net.fetch
      return { ...api, net: { fetch: async (url: string, init?: unknown) => {
        fetches.push(url)
        return inner(url, init as never)
      } } } as unknown as PluginApi
    }
    fake.history = []
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line))
    })
    try {
      for (let run = 2; run <= MAX_NOTIFY_TRIES; run += 1) {
        state = (await runSync({ state, reason: 'idle' }, counting(), 30, clock)).state as Record<string, unknown>
      }
    } finally {
      spy.mockRestore()
    }
    expect(fake.emitted.filter((e) => e.key === 't-u')).toHaveLength(MAX_NOTIFY_TRIES)
    expect(fake.putOrder.filter((x) => x === 'put:u')).toHaveLength(1)
    // Only the read of differences (history); there is no fetch of mails (batch).
    expect(fetches.every((url) => !url.includes('/batch'))).toBe(true)
    expect(state['notifyCarry']).toEqual([])
    const dropped = logs.filter((line) => line.includes('gmail.trigger.carry.dropped'))
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).not.toContain('見積')
    expect(dropped[0]).not.toContain('t-u')

    // It disappears once delivered.
    const ok = new Fake()
    ok.verdicts = [{ accepted: false, reason: 'unavailable' }]
    ok.messages.set('v', mail({ id: 'v' }))
    ok.history = [{ id: '1001', messagesAdded: [added('v')] }]
    let carried = (await runSync({ state: settled(), reason: 'idle' }, ok.api(), 30, clock)).state as Record<string, unknown>
    ok.verdicts = [{ accepted: true }]
    ok.history = []
    carried = (await runSync({ state: carried, reason: 'idle' }, ok.api(), 30, clock)).state as Record<string, unknown>
    expect(carried['notifyCarry']).toEqual([])
    expect(ok.seen.has('t-v')).toBe(true)
  })

  /** Creates a state with one carried-over item (the first run ended with unavailable). */
  async function carriedState(fake: Fake, spec: Spec = {}): Promise<Record<string, unknown>> {
    fake.verdicts = [{ accepted: false, reason: 'unavailable' }]
    fake.messages.set('u', mail({ id: 'u', ...spec }))
    fake.history = [{ id: '1001', messagesAdded: [added('u')] }]
    const state = (await runSync({ state: settled(), reason: 'idle' }, fake.api(), 30, clock)).state as Record<string, unknown>
    expect((state['notifyCarry'] as unknown[]).length).toBe(1)
    fake.verdicts = [{ accepted: true }]
    fake.history = []
    return state
  }

  /** Runs one retry, and returns the number of items retried and the logs that were discarded. */
  async function retryOnce(
    fake: Fake,
    state: Record<string, unknown>,
    now: () => number = clock
  ): Promise<{ emitted: number; logs: string[]; state: Record<string, unknown> }> {
    const before = fake.emitted.length
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line))
    })
    try {
      const next = (await runSync({ state, reason: 'idle' }, fake.api(), 30, now)).state as Record<string, unknown>
      return { emitted: fake.emitted.length - before, logs, state: next }
    } finally {
      spy.mockRestore()
    }
  }

  it('直し V (セキュリティレビュー): 送り直す前に今の設定・disabledAt・古さで判定し直し、落ちたら捨ててログに 1 行 (値は出さない)', async () => {
    const cases: Array<[string, (state: Record<string, unknown>) => Record<string, unknown>, (() => number) | undefined, string, Record<string, unknown>]> = [
      ['allowFrom', (st) => st, undefined, 'sender-not-allowed', { allowFrom: ['other.com'] }],
      ['disabledAt', (st) => ({ ...st, disabledAt: NOW }), undefined, 'too-old', {}],
      ['age', (st) => st, () => NOW + 48 * 60 * 60_000, 'too-old', {}]
    ]
    for (const [name, change, now, reason, settings] of cases) {
      const fake = new Fake()
      const state = await carriedState(fake)
      // TODO 1225: the user changed the settings while items were carried over (it takes effect from the next run).
      fake.settings = settings
      const result = await retryOnce(fake, change(state), now)
      expect(result.emitted, name).toBe(0)
      expect(result.state['notifyCarry'], name).toEqual([])
      const dropped = result.logs.filter((line) => line.includes('gmail.trigger.carry.dropped'))
      expect(dropped, name).toHaveLength(1)
      expect(dropped[0], name).toContain(reason)
      expect(dropped[0], name).not.toContain('見積')
      expect(dropped[0], name).not.toContain('bob@')
    }
    // includeCc was turned off: what had passed only through Cc is discarded.
    const cc = new Fake()
    cc.verdicts = [{ accepted: false, reason: 'unavailable' }]
    cc.messages.set('c', mail({ id: 'c', headers: { To: 'o@example.com', Cc: ME } }))
    cc.history = [{ id: '1001', messagesAdded: [added('c')] }]
    cc.settings = { includeCc: true }
    const ccState = (await runSync({ state: settled(), reason: 'idle' }, cc.api(), 30, clock)).state as Record<string, unknown>
    cc.verdicts = [{ accepted: true }]
    cc.history = []
    cc.settings = { includeCc: false }
    expect((await retryOnce(cc, ccState)).emitted).toBe(0)
    // requireAuth was turned on: mails whose authentication did not pass (carried over while requireAuth was off) are discarded.
    const auth = new Fake()
    auth.verdicts = [{ accepted: false, reason: 'unavailable' }]
    auth.messages.set('a', mail({ id: 'a', headers: { 'Authentication-Results': 'mx.google.com; dkim=fail header.i=@acme.com; spf=fail smtp.mailfrom=bob@acme.com' } }))
    auth.history = [{ id: '1001', messagesAdded: [added('a')] }]
    auth.settings = { requireAuth: false }
    const authState = (await runSync({ state: settled(), reason: 'idle' }, auth.api(), 30, clock)).state as Record<string, unknown>
    expect((authState['notifyCarry'] as unknown[]).length).toBe(1)
    auth.verdicts = [{ accepted: true }]
    auth.history = []
    auth.settings = { requireAuth: true }
    expect((await retryOnce(auth, authState)).emitted).toBe(0)
    // If nothing changed, resend.
    const same = new Fake()
    expect((await retryOnce(same, await carriedState(same))).emitted).toBe(1)
  })

  it('直し V (セキュリティレビュー): 同じ回の差分の削除・SPAM / TRASH・INBOX / UNREAD の外れを先に反映し、持ち越しから外す', async () => {
    const records: Array<[string, Record<string, unknown>]> = [
      ['deleted', { id: '1002', messagesDeleted: [{ message: { id: 'u' } }] }],
      ['trash', { id: '1002', labelsAdded: [{ message: { id: 'u', labelIds: ['TRASH', 'UNREAD'] }, labelIds: ['TRASH'] }] }],
      ['spam', { id: '1002', labelsAdded: [{ message: { id: 'u' }, labelIds: ['SPAM'] }] }],
      ['read', { id: '1002', labelsRemoved: [{ message: { id: 'u', labelIds: ['INBOX'] }, labelIds: ['UNREAD'] }] }],
      ['archived', { id: '1002', labelsRemoved: [{ message: { id: 'u' }, labelIds: ['INBOX'] }] }]
    ]
    for (const [name, record] of records) {
      const fake = new Fake()
      const state = await carriedState(fake)
      fake.history = [record]
      const result = await retryOnce(fake, state)
      expect(result.emitted, name).toBe(0)
      expect(result.state['notifyCarry'], name).toEqual([])
      expect(result.logs.some((line) => line.includes('gmail.trigger.carry.dropped')), name).toBe(true)
    }
    // A change of an unrelated label (STARRED) does not remove it.
    const starred = new Fake()
    const state = await carriedState(starred)
    starred.history = [{ id: '1002', labelsAdded: [{ message: { id: 'u', labelIds: ['INBOX', 'UNREAD', 'STARRED'] }, labelIds: ['STARRED'] }] }]
    expect((await retryOnce(starred, state)).emitted).toBe(1)
  })

  it('直し V: 持ち越しは MAX_NOTIFY_CARRY 件まで (溢れた分はログに 1 行)。状態の形が違えば読み捨てる', async () => {
    const fake = new Fake()
    fake.verdicts = [{ accepted: false, reason: 'unavailable' }]
    const ids = Array.from({ length: MAX_NOTIFY_CARRY + 2 }, (_, i) => `m${i}`)
    for (const id of ids) fake.messages.set(id, mail({ id }))
    fake.history = [{ id: '1001', messagesAdded: ids.map((id) => added(id)) }]
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    let state: Record<string, unknown>
    try {
      state = (await runSync({ state: settled(), reason: 'idle' }, fake.api(), 30, clock)).state as Record<string, unknown>
    } finally {
      spy.mockRestore()
    }
    expect((state['notifyCarry'] as unknown[]).length).toBe(MAX_NOTIFY_CARRY)
    expect(state['pendingIds']).toEqual([])
    expect(JSON.stringify(state).length).toBeLessThan(16 * 1024)
    expect(parseState({ ...settled(), notifyCarry: [{ facts: { subject: 1 }, tries: 1 }, 'x', { tries: 99 }] })?.notifyCarry).toEqual([])
  })

  it('許可表が空でない設定では、その外の送信元は知らせない', async () => {
    const fake = new Fake()
    fake.messages.set('o', mail({ id: 'o' }))
    fake.history = [{ id: '1001', messagesAdded: [added('o')] }]
    fake.settings = { allowFrom: ['other.com'] }
    await runAll(fake, settled())
    expect(fake.emitted).toEqual([])
  })
})
