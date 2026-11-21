/**
 * The Gmail API entry point (TODO 952 stage 2). **Every request goes through `api.net.fetch` (CapabilityBroker)** — the allowed host is
 * `network.hosts` in the manifest (`gmail.googleapis.com`), and the Broker attaches the token when given the credential name (`auth`) (7.7).
 * The plugin never sees the token value.
 *
 * Fetching messages one by one with `messages.get` is too slow under the Broker limit (60 per minute per plugin), so they are bundled into one request using
 * multipart/mixed on `/batch/gmail/v1` (the one outer credential applies to everything inside). If the response is cut at the limit (8 MB), split in half and ask again.
 */
import type { PluginApi } from '@shared/plugin.js'
import type { GmailMessage } from './message.js'

export const GMAIL_CREDENTIAL = 'google:gmail.modify'
export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
export const GMAIL_BATCH = 'https://gmail.googleapis.com/batch/gmail/v1'
/** The path inside a batch (from the leading `/`). */
const BATCH_PATH = '/gmail/v1/users/me'

/** Hit a rate limit of Google or the Broker. Wait before retrying. */
export class RateLimited extends Error {
  constructor(readonly local: boolean) {
    super(local ? 'rate-limited (aios)' : 'rate-limited (gmail)')
    this.name = 'RateLimited'
  }
}
/** No credentials, or they do not work (the user has to sign out and back in). */
export class NotSignedIn extends Error {
  constructor() {
    super('not signed in')
    this.name = 'NotSignedIn'
  }
}
/** The start position of `history.list` is too old (404). Fetch everything again. */
export class HistoryExpired extends Error {
  constructor() {
    super('history expired')
    this.name = 'HistoryExpired'
  }
}
/** A temporary failure on Google's side (5xx). */
export class Transient extends Error {
  constructor(readonly status: number) {
    super(`gmail ${status}`)
    this.name = 'Transient'
  }
}

/** The number of requests one call may use. Counted here (the Broker's limit applies separately). */
export class Budget {
  used = 0
  constructor(readonly limit: number) {}
  get left(): number {
    return this.limit - this.used
  }
  take(): void {
    this.used += 1
  }
}

const decoder = new TextDecoder('utf-8')

function isRateLimitBody(text: string): boolean {
  return /rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED|quotaExceeded/i.test(text)
}

/** Classify a failure from the status (the body is an already-read string). */
function classify(status: number, text: string, notFound: () => Error): Error | null {
  if (status >= 200 && status < 300) return null
  if (status === 429 || (status === 403 && isRateLimitBody(text))) return new RateLimited(false)
  if (status === 401) return new NotSignedIn()
  if (status === 404) return notFound()
  if (status >= 500) return new Transient(status)
  return new Error(`gmail ${status}`)
}

/** Classify the Broker's rejection message (`rate-limited` / `no-credential` …). */
function brokerError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('rate-limited')) return new RateLimited(true)
  if (message.includes('no-credential') || message.includes('not-consented')) return new NotSignedIn()
  return err instanceof Error ? err : new Error(message)
}

async function send(
  api: PluginApi,
  budget: Budget,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; headers: Readonly<Record<string, string>>; text: string; truncated: boolean }> {
  budget.take()
  let response
  try {
    response = await api.net.fetch(url, { ...init, auth: GMAIL_CREDENTIAL })
  } catch (err) {
    throw brokerError(err)
  }
  return { status: response.status, headers: response.headers, text: decoder.decode(response.body), truncated: response.truncated }
}

/** GET and return JSON. A 404 throws the `notFound` exception. */
export async function getJson<T>(api: PluginApi, budget: Budget, url: string, notFound: () => Error = () => new Error('gmail 404')): Promise<T> {
  const response = await send(api, budget, url)
  const error = classify(response.status, response.text, notFound)
  if (error !== null) throw error
  if (response.truncated) throw new Error('gmail response too large')
  return JSON.parse(response.text) as T
}

export interface Profile {
  readonly emailAddress?: string
  readonly historyId?: string
}

export interface MessageList {
  readonly messages?: readonly { readonly id?: string; readonly threadId?: string }[]
  readonly nextPageToken?: string
}

export interface HistoryRecord {
  readonly id?: string
  readonly messagesAdded?: readonly { readonly message?: { readonly id?: string; readonly labelIds?: readonly string[] } }[]
  readonly messagesDeleted?: readonly { readonly message?: { readonly id?: string } }[]
  /** `labelIds` (directly in the record) are the labels added / removed; `message.labelIds` are the labels after the change. */
  readonly labelsAdded?: readonly {
    readonly message?: { readonly id?: string; readonly labelIds?: readonly string[] }
    readonly labelIds?: readonly string[]
  }[]
  readonly labelsRemoved?: readonly {
    readonly message?: { readonly id?: string; readonly labelIds?: readonly string[] }
    readonly labelIds?: readonly string[]
  }[]
}

export interface HistoryList {
  readonly history?: readonly HistoryRecord[]
  readonly nextPageToken?: string
  readonly historyId?: string
}

export function profileUrl(): string {
  return `${GMAIL_API}/profile`
}

/** One page of the newest-first list (spam and trash are not included). */
export function listUrl(pageToken: string | null, maxResults: number): string {
  const url = new URL(`${GMAIL_API}/messages`)
  url.searchParams.set('maxResults', String(maxResults))
  url.searchParams.set('includeSpamTrash', 'false')
  if (pageToken !== null) url.searchParams.set('pageToken', pageToken)
  return url.toString()
}

export function historyUrl(startHistoryId: string, pageToken: string | null): string {
  const url = new URL(`${GMAIL_API}/history`)
  url.searchParams.set('startHistoryId', startHistoryId)
  url.searchParams.set('maxResults', '500')
  for (const type of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']) {
    url.searchParams.append('historyTypes', type)
  }
  if (pageToken !== null) url.searchParams.set('pageToken', pageToken)
  return url.toString()
}

/** Only characters allowed in a message id (it is spliced into the batch body, so newlines and spaces must not pass). */
export function isMessageId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id)
}

/** The body of a batch request. `format` is `full` (through the body) or `metadata` (headers only, an escape hatch for one oversized message). */
export function batchBody(ids: readonly string[], boundary: string, format: 'full' | 'metadata'): string {
  const parts = ids.map(
    (id, index) =>
      `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item-${index}>\r\n\r\n` +
      `GET ${BATCH_PATH}/messages/${id}?format=${format}\r\n\r\n`
  )
  return `${parts.join('')}--${boundary}--\r\n`
}

/** One response in a batch. `index` is the order of the request (from Content-ID). */
export interface BatchItem {
  readonly index: number
  readonly status: number
  readonly body: string
}

/** Parse a multipart/mixed response. Parts whose shape cannot be read are dropped (that id is tried again next time). */
export function parseBatchResponse(contentType: string, text: string): readonly BatchItem[] {
  const match = /boundary="?([^";]+)"?/i.exec(contentType)
  const boundary = match?.[1]
  if (boundary === undefined) return []
  const items: BatchItem[] = []
  for (const raw of text.split(`--${boundary}`)) {
    const part = raw.replace(/^\r?\n/, '')
    if (part.startsWith('--') || part.trim() === '') continue
    const split = /\r?\n\r?\n/.exec(part)
    if (split === null) continue
    const outer = part.slice(0, split.index)
    const http = part.slice(split.index + split[0].length)
    const id = /content-id:\s*<?response-item-(\d+)>?/i.exec(outer)
    const statusLine = /^HTTP\/[\d.]+\s+(\d{3})/.exec(http)
    if (id === null || statusLine === null) continue
    const inner = /\r?\n\r?\n/.exec(http)
    const body = inner === null ? '' : http.slice(inner.index + inner[0].length).trim()
    items.push({ index: Number(id[1]), status: Number(statusLine[1]), body })
  }
  return items
}

/** One message that was fetched, or one that is missing (gone). */
export type FetchedMessage = { readonly id: string; readonly message: GmailMessage } | { readonly id: string; readonly missing: true }

let boundarySeq = 0

/**
 * Fetch in bulk. If the response is cut at the limit, split in half and ask again; if even a single message is cut, fetch only the headers with `metadata`.
 * If one of the parts hits the rate limit, stop the whole thing with `RateLimited` (what was fetched is not returned — the caller keeps this round's ids and fetches them again next time).
 */
export async function fetchMessages(
  api: PluginApi,
  budget: Budget,
  ids: readonly string[],
  format: 'full' | 'metadata' = 'full'
): Promise<readonly FetchedMessage[]> {
  const safe = ids.filter(isMessageId)
  if (safe.length === 0) return []
  boundarySeq += 1
  const boundary = `aios_gmail_${boundarySeq}`
  const response = await send(api, budget, GMAIL_BATCH, {
    method: 'POST',
    headers: { 'content-type': `multipart/mixed; boundary=${boundary}` },
    body: batchBody(safe, boundary, format)
  })
  const error = classify(response.status, response.text, () => new Error('gmail batch 404'))
  if (error !== null) throw error
  if (response.truncated) {
    if (safe.length === 1) {
      if (format === 'metadata') return [{ id: safe[0] ?? '', missing: true }]
      return fetchMessages(api, budget, safe, 'metadata')
    }
    const half = Math.ceil(safe.length / 2)
    const first = await fetchMessages(api, budget, safe.slice(0, half), format)
    const second = await fetchMessages(api, budget, safe.slice(half), format)
    return [...first, ...second]
  }
  const out: FetchedMessage[] = []
  for (const item of parseBatchResponse(response.headers['content-type'] ?? '', response.text)) {
    const id = safe[item.index]
    if (id === undefined) continue
    if (item.status === 404) {
      out.push({ id, missing: true })
      continue
    }
    const itemError = classify(item.status, item.body, () => new Error('unreachable'))
    if (itemError instanceof RateLimited || itemError instanceof NotSignedIn) throw itemError
    if (itemError !== null) continue
    try {
      out.push({ id, message: JSON.parse(item.body) as GmailMessage })
    } catch {
      // Skip a message that cannot be read (picked up by the next diff or refetch).
    }
  }
  return out
}
