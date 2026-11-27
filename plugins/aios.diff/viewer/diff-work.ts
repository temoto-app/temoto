/**
 * The diff work that is too slow for the iframe's UI thread, as one plain job (TODO 1341 item 4, ARCHITECTURE 7.4.6).
 *
 * `diffJobFor` says whether two sides need it: above `LINE_DIFF_THRESHOLD` characters the merge views take a precomputed character diff
 * (`chars`), and above `MAX_DIFF_BYTES` the plain mode takes the line chunks (`lines`). `runDiffJob` does it with a given set of limits:
 * `diff-worker.ts` runs it in a Web Worker with `WORKER_LIMITS`, and the viewer runs it on its own thread with `UI_THREAD_LIMITS` when no
 * worker is available. No DOM and no CodeMirror view in here, so the worker bundle stays small.
 */
import { exceedsDiffLimit } from '@shared/plugin.js'
import { coarseLineDiff, refinedCharChanges, type CharChange, type DiffLimits, type LineChunk } from './coarse-diff.js'

/**
 * Above this many characters on either side the line-level diff replaces the library's character diff (`diffConfig.override`).
 * The library gives up beyond a few thousand changed characters and then reports one chunk for everything between the first
 * and last change, and with a larger `scanLimit` it can stall for seconds (numbers in docs/notes/wave106.md).
 */
export const LINE_DIFF_THRESHOLD = 32 * 1024

export type DiffJobKind = 'chars' | 'lines'

export interface DiffJob {
  readonly kind: DiffJobKind
  readonly a: string
  readonly b: string
}

export type DiffJobResult =
  | { readonly kind: 'chars'; readonly changes: readonly CharChange[] | null }
  | { readonly kind: 'lines'; readonly chunks: readonly LineChunk[] | null }

/**
 * The text as an `EditorState` holds it: CodeMirror splits lines on `\r\n`, `\r` and `\n` and joins them with `\n`, and the merge views
 * call `diffConfig.override` with that joined text (`Text.toString()`), not with the string they were given (wave 109 fix X1).
 * The same string comes back when there is no `\r`, so the common case costs one scan.
 */
export function editorText(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text
}

/**
 * The work two sides need before they can be drawn, or null when the library's own diff (small inputs) is enough. A `chars` job is
 * made from `editorText`, so its result matches what the merge views ask `override` about (with CRLF the raw text never would, and the
 * worker's result would be thrown away). A `lines` job (the plain mode) keeps the raw text, as the plain mode's own line diff does.
 */
export function diffJobFor(a: string, b: string): DiffJob | null {
  if (exceedsDiffLimit(a) || exceedsDiffLimit(b)) return { kind: 'lines', a, b }
  if (a.length > LINE_DIFF_THRESHOLD || b.length > LINE_DIFF_THRESHOLD) return { kind: 'chars', a: editorText(a), b: editorText(b) }
  return null
}

export function runDiffJob(job: DiffJob, limits: DiffLimits): DiffJobResult {
  return job.kind === 'lines'
    ? { kind: 'lines', chunks: coarseLineDiff(job.a, job.b, limits) }
    : { kind: 'chars', changes: refinedCharChanges(job.a, job.b, limits) }
}

export function sameJob(x: DiffJob, y: DiffJob): boolean {
  return x.kind === y.kind && x.a === y.a && x.b === y.b
}

/** Whether a value that came over a port is a result of the given kind (the worker is ours, but a message is still checked before use). */
export function isDiffJobResult(value: unknown, kind: DiffJobKind): value is DiffJobResult {
  if (typeof value !== 'object' || value === null) return false
  const result = value as { kind?: unknown; changes?: unknown; chunks?: unknown }
  if (result.kind !== kind) return false
  const list = kind === 'chars' ? result.changes : result.chunks
  return list === null || Array.isArray(list)
}
