/**
 * Trigger rules for `aios.gmail` (TODO 1217, ARCHITECTURE 6.2.6 / 7.5). **Only pure functions that never call the model.**
 *
 * Mechanically pick, during sync, "new mail addressed to me that probably needs a reply". A message passes only if it satisfies all of the following:
 *   - It is in `INBOX` and `UNREAD`, and is not something I sent (`SENT`), a draft, spam or trash.
 *   - It is not in a Gmail category (Promotions / Social / Updates / Forums).
 *   - It has no `List-Unsubscribe` / `List-Id` / `Precedence: bulk|list|junk` (mailing lists, bulk mail).
 *   - The sender is not a `noreply`-style address.
 *   - My address is in `To` (`Cc` alone is not passed by default — the setting `includeCc` lets it through. Owner decision 2026-11-13).
 *   - If a sender allow-list (`allowFrom`) is set, a sender outside it is not passed. If it was set but not a single line could be read, nobody is passed
 *     (fix X, code-review: silently dropping unreadable lines used to fall back to "allow every sender").
 *   - Read the top `Authentication-Results` (the one Gmail itself added) lexically per RFC 8601: `dmarc=pass` (header.from matches the sender),
 *     or, if there is no dmarc, a `dkim=pass` or `spf=pass` aligned with the sender's domain (a defense against a forged From. No header, fail, or unreadable -> not passed).
 *
 * The body is not read (only subject, sender, date and id). The model gets the body with the gateway's `getDocumentText` (constraints 9 / 10).
 */
import type { GmailHeader, GmailMessage } from './message.js'

export interface TriggerSettings {
  /**
   * Allowed senders. `user@example.com` (that address) or `example.com` / `@example.com` (that domain).
   * **null = no allow-list was set** (only the rules above apply). **An empty array = it was set but not a single line could be read** -> nobody is passed (the closed side).
   */
  readonly allowFrom: readonly string[] | null
  /** Also pass mail where I am only in `Cc`. Default false. */
  readonly includeCc: boolean
  /** Require `Authentication-Results`. Default true (false is an escape hatch for people who set an allow-list). */
  readonly requireAuth: boolean
}

export const DEFAULT_TRIGGER_SETTINGS: TriggerSettings = { allowFrom: null, includeCc: false, requireAuth: true }

/** Upper limits on the number and length of allow-list entries (same as `maxItems` / `maxLength` in the manifest). */
const MAX_ALLOW = 100
const MAX_ALLOW_LEN = 254

/**
 * The shape of one allow-list line: `user@example.com` / `@example.com` / `example.com` (a domain has two or more labels). This is the manifest's
 * `configuration.properties.allowFrom.items.format` (`email-or-domain`); main checks with the same rule before saving, and rejects lines that do not fit
 * (`Alice <alice@example.com>`, two entries separated by a space, etc.) and shows an error in the field (it does not fix them silently).
 *
 * **A copy of `email-or-domain` in `src/shared/setting-format.ts`** (constraint 8: `plugins/` cannot import `src/`). A hand-written check that avoids
 * backtracking regular expressions and looks at the length limit first. `test/plugin-gmail-trigger.test.ts` compares that both give the same answer,
 * and a mismatch still falls to the closed side (a line main accepts but this rejects is dropped, which narrows the list. If no line remains, nobody is passed).
 */
export function isAllowEntry(text: string): boolean {
  if (text.length === 0 || text.length > MAX_ALLOW_LEN) return false
  if (text.charCodeAt(0) === 0x40) return isHostname(text.slice(1), 2)
  return text.includes('@') ? isEmail(text) : isHostname(text, 2)
}

function isAlnum(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
}

function isHostname(text: string, minLabels: number): boolean {
  if (text.length === 0 || text.length > 253) return false
  let labels = 0
  let start = 0
  for (let i = 0; i <= text.length; i += 1) {
    if (i < text.length && text.charCodeAt(i) !== 0x2e) continue
    const length = i - start
    if (length === 0 || length > 63) return false
    if (!isAlnum(text.charCodeAt(start)) || !isAlnum(text.charCodeAt(i - 1))) return false
    for (let k = start; k < i; k += 1) {
      const code = text.charCodeAt(k)
      if (!isAlnum(code) && code !== 0x2d) return false
    }
    labels += 1
    start = i + 1
  }
  return labels >= minLabels
}

function isLocalChar(code: number): boolean {
  if (code <= 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false
  if (code === 0xa0 || code === 0x2028 || code === 0x2029 || code === 0xfeff || code === 0x3000) return false
  return !'@<>()[],;:"\\'.includes(String.fromCharCode(code))
}

function isEmail(text: string): boolean {
  const at = text.indexOf('@')
  if (at <= 0 || at > 64 || text.indexOf('@', at + 1) !== -1) return false
  for (let i = 0; i < at; i += 1) if (!isLocalChar(text.charCodeAt(i))) return false
  return isHostname(text.slice(at + 1), 2)
}

/**
 * Validate the value of `api.settings.get()` (fix X, code-review: **fall to the closed side**).
 *  - A broken shape (not an object, `allowFrom` not an array, `includeCc` / `requireAuth` not booleans) -> **null**. The caller then
 *    emits no trigger event that round (it does not fall back to the default "no allow-list").
 *  - An empty `allowFrom` array -> no allow-list (null). With one or more lines, narrow using only the lines that fit the shape — even if some are
 *    unreadable it does not widen, and if not one line is readable the result is an empty array (nobody is passed).
 */
export function parseTriggerSettings(raw: unknown): TriggerSettings | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const { allowFrom, includeCc, requireAuth } = record
  if (!Array.isArray(allowFrom) || typeof includeCc !== 'boolean' || typeof requireAuth !== 'boolean') return null
  let allow: string[] | null = null
  if (allowFrom.length > 0) {
    allow = []
    for (const item of (allowFrom as unknown[]).slice(0, MAX_ALLOW)) {
      if (typeof item !== 'string') continue
      const entry = item.trim().toLowerCase()
      if (!isAllowEntry(entry) || allow.includes(entry)) continue
      allow.push(entry)
    }
  }
  return { allowFrom: allow, includeCc, requireAuth }
}

/** Category labels. */
export const EXCLUDED_LABELS: readonly string[] = [
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
  'SENT',
  'DRAFT',
  'SPAM',
  'TRASH'
]

export type RejectReason =
  | 'no-labels'
  | 'excluded-label'
  | 'list'
  | 'noreply'
  | 'not-to-me'
  | 'cc-only'
  | 'sender-not-allowed'
  | 'auth'
  | 'no-from'
  | 'too-old'

export interface MailFacts {
  readonly subject: string
  readonly from: string
  readonly fromAddress: string
  readonly date: string
  readonly threadId: string
  readonly messageId: string
}

/**
 * Fix V (security review): the material for judging again, before resending a carried-over notice, against the **current** settings, `disabledAt` and the age of the mail.
 * It holds no body: the arrival time, whether it was `Cc` only, and whether the sender's authentication passed (the result judged regardless of `requireAuth`).
 */
export interface MailGate {
  readonly internalDate: number
  readonly ccOnly: boolean
  readonly authOk: boolean
}

export type Verdict =
  | { readonly pass: true; readonly facts: MailFacts; readonly gate: MailGate }
  | { readonly pass: false; readonly reason: RejectReason }

function headerValues(headers: readonly GmailHeader[] | undefined, name: string): string[] {
  const lower = name.toLowerCase()
  return (headers ?? []).filter((header) => header.name?.toLowerCase() === lower).map((header) => header.value ?? '')
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Addresses inside a header value (lowercase). Display names inside quotes are dropped first. */
export function addressesOf(value: string): string[] {
  const stripped = value.replace(/"(?:[^"\\]|\\.)*"/g, ' ').replace(/\([^)]*\)/g, ' ')
  const found = stripped.match(/[^\s<>,;:"()[\]]+@[^\s<>,;:"()[\]]+/g) ?? []
  return found.map((address) => address.toLowerCase().replace(/\.+$/, ''))
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@')
  return at < 0 ? '' : address.slice(at + 1)
}

const NOREPLY = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster)([-_.+].*)?$/i

/** Whether the domains are aligned (same as DMARC relaxed: one is a subdomain of the other). */
export function aligned(a: string, b: string): boolean {
  if (!a.includes('.') || !b.includes('.')) return false
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`)
}

/** Tokens of `Authentication-Results`. Comments `( … )` are dropped, and a quoted string becomes a single value of its contents. */
type AuthToken =
  | { readonly kind: 'word'; readonly text: string; readonly start: number }
  | { readonly kind: 'quoted'; readonly text: string; readonly end: number }
  | { readonly kind: '=' }
  | { readonly kind: ';' }

/**
 * Split into tokens following RFC 8601 (and CFWS / quoted-string of RFC 5322). Comments are dropped, counting nesting and `\` escapes.
 * Returns `null` if a comment or quote is not closed, there is a `)` with no matching `(`, there is a `"` inside a comment, or there is a `;` `(` `)` inside a quote
 * (an unreadable header is not passed. Wave 84 security review, round 3).
 */
function tokenizeAuthResults(text: string): AuthToken[] | null {
  const tokens: AuthToken[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i] as string
    if (/\s/.test(c)) {
      i += 1
    } else if (c === '(') {
      let depth = 0
      for (; i < text.length; i += 1) {
        const ch = text[i]
        if (ch === '\\') i += 1
        // A quote inside a comment is ctext in RFC 5322, but Gmail writes a quoted local part chosen by the sender (`"a)dmarc=pass;"@x`) into
        // the SPF comment as is. Either reading can shift the delimiters, so if a comment contains `"`, do not read it (do not pass).
        else if (ch === '"') return null
        else if (ch === '(') depth += 1
        else if (ch === ')') {
          depth -= 1
          if (depth === 0) break
        }
      }
      if (depth !== 0) return null
      i += 1
    } else if (c === ')') {
      return null
    } else if (c === '"') {
      let value = ''
      let closed = false
      for (i += 1; i < text.length; i += 1) {
        const ch = text[i] as string
        if (ch === '\\') {
          i += 1
          value += text[i] ?? ''
        } else if (ch === '"') {
          closed = true
          break
        } else value += ch
      }
      if (!closed) return null
      // A `;` `(` `)` inside a quote is material that makes the reading disagree with the other reading (comment / delimiter), so if present, do not read it (do not pass).
      if (/[;()]/.test(value)) return null
      i += 1
      tokens.push({ kind: 'quoted', text: value, end: i })
    } else if (c === ';' || c === '=') {
      tokens.push({ kind: c })
      i += 1
    } else {
      const start = i
      while (i < text.length && !/[\s();="]/.test(text[i] as string)) i += 1
      tokens.push({ kind: 'word', text: text.slice(start, i), start })
    }
  }
  return tokens
}

/** One result (`method=result` and its attributes). Attribute names are lowercase; the same name can come many times, so it is an array. */
export interface AuthResult {
  readonly method: string
  readonly result: string
  readonly props: ReadonlyMap<string, readonly string[]>
}

export interface ParsedAuthResults {
  readonly authservId: string
  readonly results: readonly AuthResult[]
}

const METHOD = /^([A-Za-z0-9][A-Za-z0-9_-]*)(?:\/[0-9]+)?$/
const KEYWORD = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const PROP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)?$/

/** Read one `;`-separated piece (resinfo). The method name is only the word at the start of the piece (outside comments and quotes). `null` if the shape is broken. */
function parseResinfo(tokens: readonly AuthToken[]): AuthResult | 'none' | null {
  const [m, eq, r] = tokens
  if (tokens.length === 1 && m?.kind === 'word' && m.text.toLowerCase() === 'none') return 'none'
  if (m?.kind !== 'word' || eq?.kind !== '=' || r?.kind !== 'word') return null
  const method = METHOD.exec(m.text)?.[1]
  if (method === undefined || !KEYWORD.test(r.text)) return null
  const props = new Map<string, string[]>()
  let i = 3
  while (i < tokens.length) {
    const name = tokens[i]
    const sep = tokens[i + 1]
    const value = tokens[i + 2]
    if (name?.kind !== 'word' || !PROP_NAME.test(name.text) || sep?.kind !== '=') return null
    let text: string
    if (value?.kind === 'word') {
      text = value.text
      i += 3
    } else if (value?.kind === 'quoted') {
      // An addr-spec with a quoted local part (`"a;b"@example.com`): a word `@…` that follows with no gap is taken together as one value.
      const next = tokens[i + 3]
      if (next?.kind === 'word' && next.start === value.end && next.text.startsWith('@')) {
        text = value.text + next.text
        i += 4
      } else {
        text = value.text
        i += 3
      }
    } else return null
    const key = name.text.toLowerCase()
    props.set(key, [...(props.get(key) ?? []), text])
  }
  return { method: method.toLowerCase(), result: r.text.toLowerCase(), props }
}

/**
 * Read one `Authentication-Results` value (RFC 8601 section 2.2). The first piece is the authserv-id (and the digit of the optional version),
 * and each following `;` starts a sequence of `method=result` and `ptype.property=value`. A `;` or `dmarc=pass` inside a comment or quote is neither a delimiter nor a result.
 * `null` if the shape is broken (the caller does not pass it).
 */
export function parseAuthResults(value: string): ParsedAuthResults | null {
  const tokens = tokenizeAuthResults(value)
  if (tokens === null) return null
  const segments: AuthToken[][] = [[]]
  for (const token of tokens) {
    if (token.kind === ';') segments.push([])
    else (segments[segments.length - 1] as AuthToken[]).push(token)
  }
  const [head = [], ...rest] = segments
  const [id, version, ...extra] = head
  if (id?.kind !== 'word' || extra.length > 0) return null
  if (version !== undefined && !(version.kind === 'word' && /^[0-9]+$/.test(version.text))) return null
  const results: AuthResult[] = []
  for (const segment of rest) {
    const parsed = parseResinfo(segment)
    if (parsed === null) return null
    if (parsed !== 'none') results.push(parsed)
  }
  return { authservId: id.text.toLowerCase(), results }
}

/** The value (lowercase) only when there is exactly one attribute. undefined if there is none or several (it cannot be decided which to trust). */
function single(result: AuthResult, key: string): string | undefined {
  const values = result.props.get(key)
  return values?.length === 1 ? (values[0] as string).toLowerCase() : undefined
}

/** The domain of `user@example.com` / `@example.com` / `example.com` (a trailing `.` is dropped). */
function domainPart(value: string): string {
  return (value.includes('@') ? domainOf(value) : value).replace(/\.+$/, '')
}

/**
 * Whether the sender is authenticated by the `Authentication-Results` that Gmail added. **Only the topmost one** is looked at.
 *
 * Gmail prepends its own `Authentication-Results: mx.google.com; …` to the top of received mail. `payload.headers` is in top-to-bottom order, so
 * the first one is Gmail's. Anything below it (what the sender wrote from the start, or what a relay added on the way) can be forged
 * (a sender can write "Authentication-Results: mx.google.com; dkim=pass …" themselves), so it is **not read**.
 * If the authserv-id of the first one does not match `mx.google.com` exactly (it is not Gmail's), it is not passed.
 *
 * It is read with `parseAuthResults` (RFC 8601 tokens): even if a sender buries `;dmarc=pass` in a value (the local part of `smtp.mailfrom`, a reason string, a comment),
 * it does not become a method name at the start of a piece.
 *
 * Decision: if there is a `dmarc` result it is decisive. It must be **exactly one** result, `pass`, with exactly one `header.from` matching the sender's domain
 * (Gmail writes the From domain as is. Several, non-pass, or no `header.from` are not passed). If there is no `dmarc` (a domain with no DMARC record),
 * take a `dkim=pass` aligned with the sender's domain (`header.d`, else `header.i`) or `spf=pass` (`smtp.mailfrom`). An attribute that is missing is not counted.
 */
export function authenticated(headers: readonly GmailHeader[] | undefined, fromDomain: string): boolean {
  if (fromDomain === '') return false
  const top = headerValues(headers, 'authentication-results')[0]
  if (top === undefined) return false
  const parsed = parseAuthResults(oneLine(top))
  if (parsed === null || parsed.authservId !== 'mx.google.com') return false
  const from = fromDomain.toLowerCase()
  const dmarc = parsed.results.filter((result) => result.method === 'dmarc')
  if (dmarc.length > 1) return false
  if (dmarc.length === 1) {
    const [result] = dmarc as [AuthResult]
    if (result.result !== 'pass') return false
    const headerFrom = single(result, 'header.from')
    return headerFrom !== undefined && domainPart(headerFrom) === from
  }
  for (const result of parsed.results) {
    if (result.result !== 'pass') continue
    let domain: string | undefined
    if (result.method === 'dkim') {
      const d = single(result, 'header.d')
      const i = single(result, 'header.i')
      domain = d !== undefined ? domainPart(d) : i !== undefined ? domainPart(i) : undefined
    } else if (result.method === 'spf') {
      const mailfrom = single(result, 'smtp.mailfrom')
      domain = mailfrom !== undefined ? domainPart(mailfrom) : undefined
    }
    if (domain !== undefined && domain !== '' && aligned(domain, from)) return true
  }
  return false
}

function allowedSender(address: string, allowFrom: readonly string[] | null): boolean {
  // Only no allow-list (null) means "do not narrow by sender". An empty array (set but unreadable) passes nobody.
  if (allowFrom === null) return true
  const domain = domainOf(address)
  return allowFrom.some((entry) => {
    if (entry.includes('@') && !entry.startsWith('@')) return entry === address
    return entry.replace(/^@/, '') === domain
  })
}

/** How recent mail must be to be accepted (ms). Keeps old mail from being announced when ingestion resumes after a long stop. */
export const MAX_MAIL_AGE_MS = 48 * 60 * 60_000

/**
 * Whether one message is "new mail addressed to me". `account` is my address; `since` is a lower bound: mail that arrived at or before this time (ms) is not emitted
 * (nothing from before the time the rule was enabled).
 */
export function evaluateMail(message: GmailMessage, account: string, settings: TriggerSettings, now: number, since: number): Verdict {
  const labels = message.labelIds ?? []
  if (!labels.includes('INBOX') || !labels.includes('UNREAD')) return { pass: false, reason: 'no-labels' }
  if (labels.some((label) => EXCLUDED_LABELS.includes(label))) return { pass: false, reason: 'excluded-label' }
  const internal = Number(message.internalDate)
  if (!Number.isSafeInteger(internal) || internal <= since || now - internal > MAX_MAIL_AGE_MS) return { pass: false, reason: 'too-old' }
  const headers = message.payload?.headers
  if (headerValues(headers, 'list-unsubscribe').length > 0 || headerValues(headers, 'list-id').length > 0) return { pass: false, reason: 'list' }
  if (headerValues(headers, 'precedence').some((value) => /^\s*(bulk|list|junk)\b/i.test(value))) return { pass: false, reason: 'list' }
  const fromHeader = oneLine(headerValues(headers, 'from')[0] ?? '')
  const fromAddress = addressesOf(fromHeader)[0] ?? ''
  if (fromAddress === '') return { pass: false, reason: 'no-from' }
  if (NOREPLY.test(fromAddress.slice(0, fromAddress.lastIndexOf('@')))) return { pass: false, reason: 'noreply' }
  const me = account.trim().toLowerCase()
  if (me === '') return { pass: false, reason: 'not-to-me' }
  const toMe = headerValues(headers, 'to').some((value) => addressesOf(value).includes(me))
  if (!toMe) {
    const ccMe = headerValues(headers, 'cc').some((value) => addressesOf(value).includes(me))
    if (!(ccMe && settings.includeCc)) return { pass: false, reason: ccMe ? 'cc-only' : 'not-to-me' }
  }
  if (!allowedSender(fromAddress, settings.allowFrom)) return { pass: false, reason: 'sender-not-allowed' }
  const authOk = authenticated(headers, domainOf(fromAddress))
  if (settings.requireAuth && !authOk) return { pass: false, reason: 'auth' }
  const threadId = message.threadId ?? message.id ?? ''
  const messageId = message.id ?? ''
  if (threadId === '' || messageId === '') return { pass: false, reason: 'no-labels' }
  return {
    pass: true,
    gate: { internalDate: internal, ccOnly: !toMe, authOk },
    facts: {
      subject: oneLine(headerValues(headers, 'subject')[0] ?? ''),
      from: fromHeader,
      fromAddress,
      date: oneLine(headerValues(headers, 'date')[0] ?? ''),
      threadId,
      messageId
    }
  }
}

/**
 * Fix V (security review): before resending a carried-over notice, judge again against the **current** settings, the lower bound (`since` = `disabledAt`) and the age.
 * Labels (INBOX / UNREAD / SPAM / TRASH) and deletion are removed from the carry-over by the sync diff (`dropCarried` in `sync.ts`). Things decided by the contents of the mail
 * (bulk mail, noreply, addressed to me) do not change from the first judgment.
 */
export function recheckCarried(
  fromAddress: string,
  gate: MailGate,
  settings: TriggerSettings,
  now: number,
  since: number
): { readonly pass: true } | { readonly pass: false; readonly reason: RejectReason } {
  if (gate.internalDate <= since || now - gate.internalDate > MAX_MAIL_AGE_MS) return { pass: false, reason: 'too-old' }
  if (gate.ccOnly && !settings.includeCc) return { pass: false, reason: 'cc-only' }
  if (!allowedSender(fromAddress, settings.allowFrom)) return { pass: false, reason: 'sender-not-allowed' }
  if (settings.requireAuth && !gate.authOk) return { pass: false, reason: 'auth' }
  return { pass: true }
}

export const TRIGGER_ID = 'new-mail'

/** The URL to open in the Gmail UI (https). The account is given with `authuser`. The API's thread id also works on the web. */
export function threadUrl(account: string, threadId: string): string {
  const user = account === '' ? '0' : encodeURIComponent(account)
  return `https://mail.google.com/mail/?authuser=${user}#all/${encodeURIComponent(threadId)}`
}

/**
 * The reference text passed to `api.triggers.emit`. **It does not include the body** (constraints 9 / 10). Only the subject, sender, date, the `gmail://` id, and
 * how to get the body (`getDocumentText` for the index document by source + source_id; if it is missing, `search` -> `getDocumentText`). At most 2,000 characters.
 */
export function referenceText(facts: MailFacts, uri: string): string {
  const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)
  return [
    `Subject: ${clip(facts.subject === '' ? '(no subject)' : facts.subject, 300)}`,
    `From: ${clip(facts.from, 300)}`,
    `Date: ${clip(facts.date, 100)}`,
    `Ref: ${uri}`,
    `Gmail thread: ${facts.threadId}`,
    'The body is not included here. It is in the aios index as a document (source aios.gmail) whose uri is the Ref above: ' +
      `read it with getDocumentText using source "aios.gmail" and source_id "${facts.messageId}" (an exact match, no search needed). ` +
      'Only if that finds no document, use the aios search tool with source "aios.gmail" and words from the subject (add the sender address), ' +
      'pick the hit whose uri is the Ref, and read it with getDocumentText by its id. Searching for the uri or the id itself finds nothing.'
  ].join('\n')
}
