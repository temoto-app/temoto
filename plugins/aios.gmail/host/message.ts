/**
 * One message from the Gmail API `messages.get?format=full` -> a document to put in the index (TODO 952 stage 2).
 *
 * **This code does not run in main** (constraint 8). It takes strings and returns strings, with no I/O.
 * main keeps exactly one canonical copy of the body in `plugin_documents` (the encrypted DB) (constraints 9 / 11). This code decides which string becomes the canonical copy.
 *
 * Shape of the document (the stage 3 viewer is assumed to read it too):
 *   source   = `aios.gmail` (TODO 920: only the namespace of its own id)
 *   sourceId = message id
 *   uri      = `gmail://<threadId>/<messageId>`
 *   title    = subject (`(no subject)` if none)
 *   body     = a few header lines (Subject / From / To / Cc / Date / Labels / Attachments) + a blank line + the body text
 *   updatedAt = `internalDate` (the time it was received)
 * The body prefers text/plain; if there is none, text/html is converted to text. Attachments are not stored (only their names go in the headers).
 */
import type { PluginDocumentInput } from '@shared/plugin.js'

export const GMAIL_SOURCE = 'aios.gmail'
/** Upper limit of the body text (characters). Keeps a long notification mail from making the index and tokenization heavy. */
export const MAX_TEXT_CHARS = 60_000
/** Labels that are not ingested (the canonical copy of drafts is aios, 1027; spam and trash are dropped from the index). */
export const SKIPPED_LABELS: readonly string[] = ['DRAFT', 'SPAM', 'TRASH']

export interface GmailHeader {
  readonly name?: string
  readonly value?: string
}

export interface GmailPart {
  readonly partId?: string
  readonly mimeType?: string
  readonly filename?: string
  readonly headers?: readonly GmailHeader[]
  readonly body?: { readonly size?: number; readonly data?: string; readonly attachmentId?: string }
  readonly parts?: readonly GmailPart[]
}

export interface GmailMessage {
  readonly id?: string
  readonly threadId?: string
  readonly labelIds?: readonly string[]
  readonly snippet?: string
  readonly internalDate?: string
  readonly payload?: GmailPart
}

export function messageUri(threadId: string, messageId: string): string {
  return `gmail://${encodeURIComponent(threadId)}/${encodeURIComponent(messageId)}`
}

/** Whether a label that is not ingested is present. */
export function isSkipped(labelIds: readonly string[] | undefined): boolean {
  return (labelIds ?? []).some((label) => SKIPPED_LABELS.includes(label))
}

function headerOf(headers: readonly GmailHeader[] | undefined, name: string): string {
  const lower = name.toLowerCase()
  const hit = (headers ?? []).find((header) => header.name?.toLowerCase() === lower)
  return (hit?.value ?? '').replace(/\s+/g, ' ').trim()
}

/** base64url -> bytes. Empty if broken. */
export function decodeBase64Url(data: string): Uint8Array {
  try {
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return new Uint8Array(0)
  }
}

function charsetOf(part: GmailPart): string {
  const contentType = headerOf(part.headers, 'content-type')
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)
  return match?.[1]?.toLowerCase() ?? 'utf-8'
}

/** Read a part's body according to its charset. An unknown charset is read as UTF-8. */
export function decodePart(part: GmailPart): string {
  const data = part.body?.data
  if (data === undefined || data === '') return ''
  const bytes = decodeBase64Url(data)
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(charsetOf(part))
  } catch {
    decoder = new TextDecoder('utf-8')
  }
  return decoder.decode(bytes)
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  yen: '¥'
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** Convert an HTML mail to text (for the index and snippets; for display, the stage 3 viewer handles the HTML canonical copy separately). */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|ul|ol|section|article|header|footer)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return normalizeText(decodeEntities(text))
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isAttachment(part: GmailPart): boolean {
  return (part.filename ?? '') !== '' || part.body?.attachmentId !== undefined
}

function walk(part: GmailPart | undefined, visit: (part: GmailPart) => void): void {
  if (part === undefined) return
  visit(part)
  for (const child of part.parts ?? []) walk(child, visit)
}

/** The body text and the attachment names. If there is even one text/plain, only that is used; otherwise text/html is converted. */
export function bodyText(payload: GmailPart | undefined): { readonly text: string; readonly attachments: readonly string[] } {
  const plain: string[] = []
  const html: string[] = []
  const attachments: string[] = []
  walk(payload, (part) => {
    if (isAttachment(part)) {
      if ((part.filename ?? '') !== '') attachments.push(part.filename ?? '')
      return
    }
    const type = (part.mimeType ?? '').toLowerCase()
    if (type === 'text/plain') plain.push(decodePart(part))
    else if (type === 'text/html') html.push(decodePart(part))
  })
  const text = plain.length > 0 ? normalizeText(plain.join('\n\n')) : htmlToText(html.join('\n'))
  return { text, attachments }
}

/** Turn one message into a document. Null if it is not ingested (draft, spam, trash, or no id). */
export function messageToDocument(message: GmailMessage): PluginDocumentInput | null {
  const id = message.id
  const threadId = message.threadId ?? id
  if (id === undefined || id === '' || threadId === undefined || isSkipped(message.labelIds)) return null
  const headers = message.payload?.headers
  const subject = headerOf(headers, 'subject')
  const { text, attachments } = bodyText(message.payload)
  const lines = [
    `Subject: ${subject}`,
    `From: ${headerOf(headers, 'from')}`,
    `To: ${headerOf(headers, 'to')}`
  ]
  const cc = headerOf(headers, 'cc')
  if (cc !== '') lines.push(`Cc: ${cc}`)
  lines.push(`Date: ${headerOf(headers, 'date')}`)
  const labels = (message.labelIds ?? []).filter((label) => label !== '')
  if (labels.length > 0) lines.push(`Labels: ${labels.join(', ')}`)
  if (attachments.length > 0) lines.push(`Attachments: ${attachments.join(', ')}`)
  const fallback = text === '' ? normalizeText(decodeEntities(message.snippet ?? '')) : text
  const clipped = fallback.length > MAX_TEXT_CHARS ? `${fallback.slice(0, MAX_TEXT_CHARS)}\n…` : fallback
  const internal = Number(message.internalDate)
  return {
    source: GMAIL_SOURCE,
    sourceId: id,
    title: (subject === '' ? '(no subject)' : subject).slice(0, 1000),
    uri: messageUri(threadId, id),
    body: `${lines.join('\n')}\n\n${clipped}`,
    ...(Number.isSafeInteger(internal) && internal > 0 ? { updatedAt: internal } : {})
  }
}
