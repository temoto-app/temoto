/**
 * Host-side pure functions for temporarily viewed files (TODO 905, files inside a zip, ARCHITECTURE.md 7.4.6 / 7.4.11).
 *
 * The viewer (`aios.zip`) sends the extracted contents with `open-entry`. The host **does not trust the values** and re-checks them
 * (type, name length, size, whether it is the archive being shown), then shows them as a temporary view with no URI. The contents are
 * held in memory only for display and are never saved or indexed (constraints 9 / 10). Main resolves which viewer draws them from the
 * file name's extension (`viewer.openTransientFile`); here the shape of the contents is built to match that viewer's way of
 * receiving data (`delivery`).
 */
import {
  MAX_GUEST_DIFF_CHARS,
  MAX_TRANSIENT_FILE_BYTES,
  MAX_TRANSIENT_FILE_NAME,
  type DiffLayout,
  type DiffSide,
  type ResolvedViewer,
  type ViewerWirePayload
} from '@shared/plugin.js'
import { transientFileBaseName, transientFileMime } from '@shared/transient-file.js'

/** Upper limit (bytes) for passing contents as text. Same as the file viewer's limit (main's `MAX_TEXT_BYTES`). */
export const MAX_TRANSIENT_TEXT_BYTES = 2 * 1024 * 1024
/** How many leading bytes to scan for NUL (8 KB, same as main's sniffing). */
const SNIFF_BYTES = 8 * 1024

/** A temporarily viewed file. Held in `store.transient`. */
export interface TransientFileView {
  readonly kind: 'file'
  /** The path inside the archive as is (for display; `../` is kept too). */
  readonly name: string
  /** The archive name (last path segment) shown at the start of the heading. */
  readonly source: string
  readonly data: Uint8Array
  /** A number that advances on every open. Lets the viewer (bridge) tell a resend of the same contents from a re-open of another entry. */
  readonly nonce: number
}

/**
 * Validates the viewer's `open-entry`. Returns null (drops it) when the archive differs from the one being shown (`currentUri`), the name is
 * empty or too long, there is no last segment, the contents are not a `Uint8Array`, or the size exceeds the limit.
 */
export function acceptOpenEntry(
  message: { readonly uri?: unknown; readonly name?: unknown; readonly data?: unknown },
  currentUri: string | null
): { readonly name: string; readonly data: Uint8Array } | null {
  if (typeof message.uri !== 'string' || currentUri === null || message.uri !== currentUri) return null
  const name = message.name
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_TRANSIENT_FILE_NAME) return null
  if (transientFileBaseName(name) === '') return null
  const data = message.data
  if (!(data instanceof Uint8Array) || data.byteLength > MAX_TRANSIENT_FILE_BYTES) return null
  return { name, data }
}

/** Upper bound on a diff side's display name / language hint from a viewer (characters, TODO 834). */
const MAX_GUEST_DIFF_NAME = 1024
const MAX_GUEST_DIFF_LANGUAGE = 64

function acceptDiffSide(raw: unknown): DiffSide | null {
  if (typeof raw !== 'object' || raw === null) return null
  const side = raw as { name?: unknown; text?: unknown; language?: unknown }
  if (typeof side.name !== 'string' || side.name.length > MAX_GUEST_DIFF_NAME) return null
  if (typeof side.text !== 'string' || side.text.length > MAX_GUEST_DIFF_CHARS) return null
  const language = side.language
  if (language !== null && language !== undefined && (typeof language !== 'string' || language.length > MAX_GUEST_DIFF_LANGUAGE)) return null
  return { name: side.name, text: side.text, language: typeof language === 'string' && language !== '' ? language : null }
}

/** What the host knows (never what the viewer claims) when a viewer asks for a temporary diff. */
export interface OpenDiffGate {
  /** The extension that sent it declares the `git` capability (from the host's own extension list). */
  readonly declaresGit: boolean
  /** Some temporary display (a diff the AI opened, an approval's diff, a zip entry, help...) is in front now. */
  readonly transientShown: boolean
  /** That temporary display is the one this same viewer opened with an earlier `open-diff`. */
  readonly ownedBySender: boolean
}

/**
 * A viewer may open a diff only when it is a git extension, and only over nothing or over its own earlier diff: it never takes over a temporary
 * display the user is looking at (the AI's `openDiff`, an approval's diff). The viewer's own claims are not consulted.
 */
export function mayOpenDiff(gate: OpenDiffGate): boolean {
  return gate.declaresGit && (!gate.transientShown || gate.ownedBySender)
}

/**
 * Re-validates a viewer's "please show these two texts as a diff" (`open-diff`, TODO 834 stage 1). Only for the URI the viewer is displaying (a mismatch
 * during a switch is dropped), and only sides of the right shape and size. A request, not a permission: the texts are what the viewer already holds.
 */
export function acceptOpenDiff(
  message: { readonly uri?: unknown; readonly before?: unknown; readonly after?: unknown; readonly layout?: unknown },
  currentUri: string | null,
  gate: OpenDiffGate
): { readonly before: DiffSide; readonly after: DiffSide; readonly layout?: DiffLayout } | null {
  if (!mayOpenDiff(gate)) return null
  if (typeof message.uri !== 'string' || currentUri === null || message.uri !== currentUri) return null
  const before = acceptDiffSide(message.before)
  const after = acceptDiffSide(message.after)
  if (before === null || after === null) return null
  const layout = message.layout
  if (layout !== undefined && layout !== 'unified' && layout !== 'split') return null
  return layout === undefined ? { before, after } : { before, after, layout }
}

/** The last segment of the URI (the archive's display name). Empty if it cannot be read. */
export function archiveLabelOf(uri: string | null): string {
  if (uri === null) return ''
  try {
    const path = new URL(uri).pathname
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
  } catch {
    return ''
  }
}

/** The name shown in the heading (`archive.zip › docs/a.txt`). */
export function transientFileLabel(view: TransientFileView): string {
  return view.source === '' ? view.name : `${view.source} › ${view.name}`
}

function hasNul(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.byteLength, SNIFF_BYTES)
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true
  return false
}

/** When cutting at `limit` bytes, backs up to a position that does not split a UTF-8 character. */
function utf8Boundary(bytes: Uint8Array, limit: number): number {
  if (bytes.byteLength <= limit) return bytes.byteLength
  let end = limit
  // Do not cut on a continuation byte (10xxxxxx).
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return end
}

/**
 * The contents put on the port (code review of TODO 905). The byte array (up to 64 MB) is sent over the same port only once; after that it
 * becomes a `bytes-ref` carrying just the size (the bridge reuses the previous `blob:`). Avoids duplicating everything on each theme / language resend.
 */
export function wireResource(resource: ViewerWirePayload, alreadySent: boolean): ViewerWirePayload {
  if (resource.kind === 'bytes' && alreadySent) return { kind: 'bytes-ref', size: resource.size }
  return resource
}

/**
 * The contents handed to the resolved viewer. With `delivery: 'url'` (image, PDF, video, Office, zip) they stay a byte array (the bridge turns
 * it into a blob:); otherwise (text viewers) they are "binary" if a NUL is found, else a string read as UTF-8 (cut at 2 MB).
 */
export function transientFilePayload(view: TransientFileView, viewer: Pick<ResolvedViewer, 'delivery'>): ViewerWirePayload {
  if (viewer.delivery === 'url') {
    return { kind: 'bytes', data: view.data, size: view.data.byteLength, mime: transientFileMime(view.name) }
  }
  if (hasNul(view.data)) return { kind: 'error', message: 'binary' }
  const end = utf8Boundary(view.data, MAX_TRANSIENT_TEXT_BYTES)
  return {
    kind: 'text',
    text: new TextDecoder('utf-8').decode(view.data.subarray(0, end)),
    truncated: end < view.data.byteLength,
    size: view.data.byteLength
  }
}
