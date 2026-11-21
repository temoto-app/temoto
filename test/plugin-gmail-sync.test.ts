/**
 * TODO 952 stage 2 (wave 56 bundle A): the import of `aios.gmail` (`plugins/aios.gmail/host/`). A fake Gmail is put inside a fake `api` (standing in for the Broker).
 * It does not connect to the real Google. Full import (newest first, resuming from the next page), differences (history and tombstones), 429, and splitting of batches.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { BrokerNetFetchResult, PluginApi, PluginDocumentInput, PluginTaskResult } from '../src/shared/plugin.js'
import { isDeclaredExport, parseManifest } from '../src/main/plugin/manifest.js'
import plugin from '../plugins/aios.gmail/host/index.js'
import { runSync, MAX_BACKOFF_MS, MIN_BACKOFF_MS } from '../plugins/aios.gmail/host/sync.js'
import { batchBody, parseBatchResponse } from '../plugins/aios.gmail/host/gmail.js'
import { decodePart, htmlToText, messageToDocument, type GmailMessage } from '../plugins/aios.gmail/host/message.js'

vi.mock('electron', () => ({ utilityProcess: { fork: () => undefined } }))

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64url')

function mail(id: string, subject: string, labels: string[] = ['INBOX'], extra: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: labels,
    internalDate: '1761600000000',
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'Subject', value: subject },
        { name: 'From', value: 'Alice <alice@example.com>' },
        { name: 'To', value: 'me@example.com' },
        { name: 'Date', value: 'Tue, 28 Oct 2026 09:00:00 +0900' }
      ],
      parts: [
        { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }], body: { data: b64(`body of ${subject}`) } },
        { mimeType: 'text/html', body: { data: b64(`<p>html of ${subject}</p>`) } }
      ]
    },
    ...extra
  }
}

const encoder = new TextEncoder()
const json = (status: number, value: unknown): BrokerNetFetchResult => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: encoder.encode(JSON.stringify(value)),
  truncated: false
})

/** A fake Gmail. `messages` is newest first. */
class FakeGmail {
  messages: GmailMessage[] = []
  historyId = '1000'
  history: unknown[] = []
  historyExpired = false
  rateLimitNext = 0
  truncateBatchOver = Infinity
  requests: string[] = []
  docs = new Map<string, PluginDocumentInput>()
  removed: string[] = []
  signedIn = true
  /** Returns 500 only for this id within a batch. */
  failIds = new Set<string>()

  api(): PluginApi {
    return {
      fs: { read: async () => { throw new Error('no fs') } },
      browser: { fetchPage: async () => { throw new Error('no browser') } },
      triggers: { emit: async () => ({ accepted: false, reason: 'disabled' }) },
      settings: { get: async () => ({}) },
      ui: { notify: async () => undefined },
      sidebar: { setRows: async () => undefined },
      status: { report: async () => undefined },
      credentials: { status: async (name) => ({ present: this.signedIn && name === 'google:gmail.modify', host: 'gmail.googleapis.com' }) },
      index: {
        put: async (doc) => {
          this.docs.set(doc.sourceId, doc)
        },
        remove: async (source, id) => {
          expect(source).toBe('aios.gmail')
          this.removed.push(id)
          this.docs.delete(id)
        }
      },
      net: { fetch: async (url, init) => this.fetch(url, init ?? {}) }
    }
  }

  async fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; auth?: string }): Promise<BrokerNetFetchResult> {
    expect(init.auth).toBe('google:gmail.modify')
    const u = new URL(url)
    expect(u.hostname).toBe('gmail.googleapis.com')
    this.requests.push(`${init.method ?? 'GET'} ${u.pathname}`)
    if (this.rateLimitNext > 0) {
      this.rateLimitNext -= 1
      return json(429, { error: { code: 429 } })
    }
    if (u.pathname.endsWith('/profile')) return json(200, { emailAddress: 'me@example.com', historyId: this.historyId })
    if (u.pathname.endsWith('/messages')) {
      const size = Number(u.searchParams.get('maxResults'))
      const start = Number(u.searchParams.get('pageToken') ?? '0')
      const page = this.messages.slice(start, start + size)
      return json(200, {
        messages: page.map((m) => ({ id: m.id, threadId: m.threadId })),
        ...(start + size < this.messages.length ? { nextPageToken: String(start + size) } : {})
      })
    }
    if (u.pathname.endsWith('/history')) {
      if (this.historyExpired) return json(404, { error: { code: 404 } })
      const start = Number(u.searchParams.get('startHistoryId') ?? '0')
      const records = (this.history as { id: string }[]).filter((record) => Number(record.id) > start)
      return json(200, { history: records, historyId: this.historyId })
    }
    if (u.pathname === '/batch/gmail/v1') {
      const boundary = /boundary=(\S+)/.exec(init.headers?.['content-type'] ?? '')![1]!
      const ids = [...String(init.body).matchAll(/GET \/gmail\/v1\/users\/me\/messages\/([^?]+)\?format=(\w+)/g)].map((m) => m[1]!)
      if (ids.length > this.truncateBatchOver) {
        return { status: 200, headers: { 'content-type': 'multipart/mixed; boundary=x' }, body: new Uint8Array(0), truncated: true }
      }
      const out = 'batch_resp'
      const parts = ids.map((id, i) => {
        const m = this.messages.find((candidate) => candidate.id === id)
        const failing = this.failIds.has(id)
        const status = failing ? '500 Internal Server Error' : m === undefined ? '404 Not Found' : '200 OK'
        const body = failing ? '{"error":{"code":500}}' : m === undefined ? '{"error":{"code":404}}' : JSON.stringify(m)
        return `--${out}\r\nContent-Type: application/http\r\nContent-ID: <response-item-${i}>\r\n\r\nHTTP/1.1 ${status}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n`
      })
      expect(boundary).toMatch(/^aios_gmail_/)
      return {
        status: 200,
        headers: { 'content-type': `multipart/mixed; boundary=${out}` },
        body: encoder.encode(`${parts.join('')}--${out}--\r\n`),
        truncated: false
      }
    }
    return json(400, {})
  }
}

/** Runs the task until `more` runs out (carries the state around, standing in for main). */
async function drain(gmail: FakeGmail, state: Record<string, unknown> | null, limit = 50): Promise<{ state: Record<string, unknown> | null; results: PluginTaskResult[] }> {
  const results: PluginTaskResult[] = []
  let current = state
  for (let i = 0; i < limit; i += 1) {
    const result = await runSync({ state: current, reason: 'idle' }, gmail.api())
    results.push(result)
    if (result.state !== undefined) current = result.state as Record<string, unknown> | null
    if (result.more !== true) break
  }
  return { state: current, results }
}

describe('manifest and export of aios.gmail', () => {
  it('declares gmail.modify, gmail.googleapis.com, its own index and an idle sync, and the export is complete', () => {
    const manifest = parseManifest(JSON.parse(readFileSync(join(__dirname, '../plugins/aios.gmail/manifest.json'), 'utf8')))
    expect(manifest.capabilities).toEqual({
      credentials: { oauth: ['google:gmail.modify'] },
      network: { hosts: ['gmail.googleapis.com'] },
      index: { write: ['aios.gmail'] }
    })
    expect(manifest.scheduledTasks).toEqual([{ id: 'sync', name: 'Gmail を取り込む', defaultInterval: 15, idle: true }])
    expect(isDeclaredExport(manifest, 'task', 'sync')).toBe(true)
    expect(typeof plugin.tasks?.['sync']).toBe('function')
  })
})

describe('one message to a document', () => {
  it('heading and text/plain; null for drafts, spam and trash', () => {
    const doc = messageToDocument(mail('m1', '会議の件'))!
    expect(doc).toMatchObject({ source: 'aios.gmail', sourceId: 'm1', title: '会議の件', uri: 'gmail://t-m1/m1', updatedAt: 1761600000000 })
    expect(doc.body).toContain('Subject: 会議の件\nFrom: Alice <alice@example.com>\nTo: me@example.com')
    expect(doc.body).toContain('Labels: INBOX')
    expect(doc.body.endsWith('body of 会議の件')).toBe(true)
    expect(messageToDocument(mail('d', 'x', ['DRAFT']))).toBeNull()
    expect(messageToDocument(mail('t', 'x', ['TRASH']))).toBeNull()
  })

  it("an HTML-only message is converted to text; attachments only by name, the character set is the part's charset", () => {
    const html: GmailMessage = {
      id: 'h1',
      threadId: 't',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [{ name: 'Subject', value: 'HTML' }],
        parts: [
          { mimeType: 'text/html', body: { data: b64('<style>p{}</style><p>Hello&nbsp;<b>world</b> &amp; &#x3042;</p><br>next') } },
          { mimeType: 'application/pdf', filename: 'a.pdf', body: { attachmentId: 'att' } }
        ]
      }
    }
    const doc = messageToDocument(html)!
    expect(doc.body).toContain('Attachments: a.pdf')
    expect(doc.body).toMatch(/Hello world & あ\n+next$/)
    // The Shift_JIS part is read via its charset (the hiragana for a = 0x82 0xA0).
    const sjis = Buffer.from([0x82, 0xa0]).toString('base64url')
    expect(
      decodePart({ mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="Shift_JIS"' }], body: { data: sjis } })
    ).toBe('あ')
    expect(htmlToText('<head><title>x</title></head><ul><li>a<li>b</ul>')).toBe('- a\n- b')
  })
})

describe('batch body and response', () => {
  it('the request is CRLF multipart and the response is returned in order by Content-ID', () => {
    const body = batchBody(['a1', 'b2'], 'B', 'full')
    expect(body).toBe(
      '--B\r\nContent-Type: application/http\r\nContent-ID: <item-0>\r\n\r\nGET /gmail/v1/users/me/messages/a1?format=full\r\n\r\n' +
        '--B\r\nContent-Type: application/http\r\nContent-ID: <item-1>\r\n\r\nGET /gmail/v1/users/me/messages/b2?format=full\r\n\r\n--B--\r\n'
    )
    const response =
      '--R\r\nContent-Type: application/http\r\nContent-ID: <response-item-1>\r\n\r\nHTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{}\r\n' +
      '--R\r\nContent-Type: application/http\r\nContent-ID: <response-item-0>\r\n\r\nHTTP/1.1 200 OK\r\n\r\n{"id":"a1"}\r\n--R--'
    expect(parseBatchResponse('multipart/mixed; boundary=R', response)).toEqual([
      { index: 1, status: 404, body: '{}' },
      { index: 0, status: 200, body: '{"id":"a1"}' }
    ])
  })
})

describe('ingestion (runSync)', () => {
  it('does nothing when not logged in', async () => {
    const gmail = new FakeGmail()
    gmail.signedIn = false
    expect(await runSync({ state: null, reason: 'idle' }, gmail.api())).toEqual({ more: false })
    expect(gmail.requests).toEqual([])
  })

  it('the first time takes everything newest first; up to 30 sends per round, and even if stopped continues from the page; the last has more: false', async () => {
    const gmail = new FakeGmail()
    gmail.messages = Array.from({ length: 750 }, (_, i) => mail(`m${i}`, `S${i}`))
    const first = await runSync({ state: null, reason: 'idle' }, gmail.api())
    expect(first.more).toBe(true)
    expect(gmail.requests.length).toBeLessThanOrEqual(30)
    // Spaces the gaps by the number of requests sent (so it does not hit the Broker's 60 per minute).
    expect(first.retryAfterMs).toBe(gmail.requests.length * 1250)
    expect(gmail.requests[0]).toBe('GET /gmail/v1/users/me/profile')
    // Newest first: the first page goes in first.
    expect(gmail.docs.has('m0')).toBe(true)
    expect(gmail.docs.has('m749')).toBe(false)
    const state = first.state as Record<string, unknown>
    expect(state).toMatchObject({ v: 1, account: 'me@example.com', historyId: '1000', fullDone: false })
    const { state: done, results } = await drain(gmail, state)
    expect(results.at(-1)?.more).toBe(false)
    expect(gmail.docs.size).toBe(750)
    expect(done).toMatchObject({ fullDone: true, fetched: 750, fullPageToken: null })
  })

  it('diff: takes added and label-changed ids and removes deleted and trashed ones from the index (tombstone)', async () => {
    const gmail = new FakeGmail()
    gmail.messages = [mail('a', 'A'), mail('b', 'B'), mail('c', 'C')]
    const { state } = await drain(gmail, null)
    expect(gmail.docs.size).toBe(3)
    gmail.messages = [mail('n', 'New'), mail('a', 'A', ['INBOX', 'STARRED']), mail('c', 'C', ['TRASH'])]
    gmail.history = [
      { id: '1001', messagesAdded: [{ message: { id: 'n', labelIds: ['INBOX'] } }] },
      { id: '1002', labelsAdded: [{ message: { id: 'a', labelIds: ['INBOX', 'STARRED'] }, labelIds: ['STARRED'] }] },
      { id: '1003', messagesDeleted: [{ message: { id: 'b' } }] },
      { id: '1004', labelsAdded: [{ message: { id: 'c', labelIds: ['TRASH'] }, labelIds: ['TRASH'] }] },
      { id: '1005', messagesAdded: [{ message: { id: 'd', labelIds: ['DRAFT'] } }] }
    ]
    gmail.historyId = '1005'
    gmail.requests = []
    const result = await runSync({ state, reason: 'scheduled' }, gmail.api())
    expect(result.more).toBe(false)
    expect([...gmail.docs.keys()].sort()).toEqual(['a', 'n'])
    expect(gmail.docs.get('a')?.body).toContain('Labels: INBOX, STARRED')
    expect(gmail.removed).toEqual(expect.arrayContaining(['b', 'c', 'd']))
    expect(result.state).toMatchObject({ historyId: '1005', pendingIds: [] })
    expect(gmail.requests).toEqual(['GET /gmail/v1/users/me/history', 'POST /batch/gmail/v1'])
  })

  it('historyId too old (404): re-fetches everything from the new position', async () => {
    const gmail = new FakeGmail()
    gmail.messages = [mail('a', 'A')]
    const { state } = await drain(gmail, null)
    gmail.historyExpired = true
    gmail.historyId = '2000'
    gmail.messages = [mail('z', 'Z'), mail('a', 'A')]
    const result = await runSync({ state, reason: 'idle' }, gmail.api())
    expect(result.state).toMatchObject({ historyId: '2000', fullDone: true })
    expect(gmail.docs.has('z')).toBe(true)
  })

  it('429: keeps the state and waits (doubling from 30 seconds, up to 15 minutes); resets the wait when it recovers', async () => {
    const gmail = new FakeGmail()
    gmail.messages = Array.from({ length: 150 }, (_, i) => mail(`m${i}`, `S${i}`))
    gmail.rateLimitNext = 1
    const first = await runSync({ state: null, reason: 'idle' }, gmail.api())
    expect(first).toMatchObject({ more: true, retryAfterMs: MIN_BACKOFF_MS })
    gmail.rateLimitNext = 1
    const second = await runSync({ state: first.state as Record<string, unknown> | null, reason: 'idle' }, gmail.api())
    expect(second.retryAfterMs).toBe(MIN_BACKOFF_MS * 2)
    const capped = await runSync(
      { state: { ...(second.state as Record<string, unknown>), backoffMs: MAX_BACKOFF_MS }, reason: 'idle' },
      (() => {
        gmail.rateLimitNext = 1
        return gmail.api()
      })()
    )
    expect(capped.retryAfterMs).toBe(MAX_BACKOFF_MS)
    const { state } = await drain(gmail, capped.state as Record<string, unknown>)
    expect(state).toMatchObject({ fullDone: true, backoffMs: 0 })
    expect(gmail.docs.size).toBe(150)
  })

  it("distinguishes the Broker's limit (rate-limited) from credential expiry", async () => {
    const gmail = new FakeGmail()
    gmail.messages = [mail('a', 'A')]
    const api = gmail.api()
    const limited = await runSync(
      { state: null, reason: 'idle' },
      { ...api, net: { fetch: async () => { throw new Error('rate-limited') } } }
    )
    expect(limited).toMatchObject({ more: true, retryAfterMs: 60_000 })
    const revoked = await runSync(
      { state: null, reason: 'idle' },
      { ...api, net: { fetch: async () => { throw new Error('no-credential') } } }
    )
    expect(revoked.more).toBe(false)
  })

  it('when a batch response is cut at the limit, splits and re-fetches', async () => {
    const gmail = new FakeGmail()
    gmail.messages = Array.from({ length: 30 }, (_, i) => mail(`m${i}`, `S${i}`))
    gmail.truncateBatchOver = 7
    await drain(gmail, null)
    expect(gmail.docs.size).toBe(30)
  })

  it('does not drop the id even if one message in a batch cannot be fetched (failures are counted and given up at the limit)', async () => {
    const gmail = new FakeGmail()
    const { state } = await drain(gmail, null)
    gmail.messages = [mail('a', 'A'), mail('b', 'B'), mail('c', 'C')]
    gmail.history = [{ id: '1001', messagesAdded: ['a', 'b', 'c'].map((id) => ({ message: { id, labelIds: ['INBOX'] } })) }]
    gmail.historyId = '1001'
    gmail.failIds.add('b')
    let current = state as Record<string, unknown>
    const first = await runSync({ state: current, reason: 'idle' }, gmail.api())
    expect([...gmail.docs.keys()].sort()).toEqual(['a', 'c'])
    expect(first.more).toBe(true)
    expect(first.state).toMatchObject({ pendingIds: ['b'], failures: { b: 1 } })
    // Once fixed, it can be fetched on the next run.
    gmail.failIds.clear()
    const second = await runSync({ state: first.state as Record<string, unknown>, reason: 'idle' }, gmail.api())
    expect(gmail.docs.has('b')).toBe(true)
    expect(second.state).toMatchObject({ pendingIds: [], failures: {} })
    // If it stays unfixed, it gives up when the failures reach the limit (it does not stay forever).
    gmail.failIds.add('b')
    gmail.docs.delete('b')
    current = { ...(second.state as Record<string, unknown>), pendingIds: ['b'], failures: { b: 2 } }
    const last = await runSync({ state: current, reason: 'idle' }, gmail.api())
    expect(last.state).toMatchObject({ pendingIds: [], failures: {} })
    expect(last.more).toBe(false)
  })

  it('when pending exceeds the limit in one record, stops historyId before that record and continues in the next round', async () => {
    const gmail = new FakeGmail()
    const { state } = await drain(gmail, null)
    const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`)
    const small = ids('s', 10)
    const big = ids('g', 450)
    gmail.messages = [...small, ...big].map((id) => mail(id, id))
    gmail.history = [
      { id: '1001', messagesAdded: small.map((id) => ({ message: { id, labelIds: ['INBOX'] } })) },
      { id: '1002', labelsAdded: big.map((id) => ({ message: { id, labelIds: ['INBOX'] }, labelIds: ['STARRED'] })) }
    ]
    gmail.historyId = '1002'
    const first = await runSync({ state, reason: 'idle' }, gmail.api())
    expect(first.more).toBe(true)
    expect(first.state).toMatchObject({ historyId: '1001' })
    expect(gmail.docs.size).toBe(10)
    const { results } = await drain(gmail, first.state as Record<string, unknown>)
    expect(results.at(-1)?.more).toBe(false)
    expect(gmail.docs.size).toBe(460)
  })
})
