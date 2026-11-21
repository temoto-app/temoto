/**
 * Save a conversation as a PDF (TODO 818, ARCHITECTURE.md 5.1.8). Pure functions shared by main and the renderer.
 *
 * - Only **the bodies of the user's messages and the answers** are output (owner decision 2026-10-17). Tool calls, thinking and
 *   subagents (with `parentToolUseId` / `actor: 'subagent'`) are not output. Images the user sent are output (TODO 1273, owner decision 2026-11-20).
 * - 1 turn = "one question, one answer": one `user_text` and the parent's answers up to just before the next `user_text`.
 *   Answers before the first message (such as the head of a transcript) are grouped into a turn with no question.
 * - The body is built from saved rows (which went through `ThreadStore.toPersistable`), but the past part of a transcript (item 111) did not
 *   go through it, so main applies `redactText` to everything before passing it to the renderer.
 */
import type { AiosEvent, SentAttachment } from './agent.js'

export interface ExportQuestion {
  /** The id of the `user_text` row (the same as `ev-<id>` in the timeline). */
  readonly id: string
  readonly ts: number
  readonly text: string
  /**
   * Images sent with the message (TODO 1273). `uri` is the file the sender attached and `thumbnail` the persisted small data URL of a paste;
   * main reads / re-checks them when it embeds the images (`embed-images.ts`). Absent when nothing was attached.
   */
  readonly attachments?: readonly SentAttachment[]
}

export interface ExportTurn {
  /** Which question it is (1-based). 0 for the leading turn with no question. */
  readonly number: number
  readonly question: ExportQuestion | null
  /** The bodies of the parent's answers (Markdown). In the order they arrived. */
  readonly answers: readonly string[]
}

/** The return value of `threads.exportTurns`. */
export interface ConversationExport {
  readonly threadId: string
  readonly turns: readonly ExportTurn[]
}

/** The range of `threads.savePdf`. `turn` is which question (`ExportTurn.number`). */
export type ExportScope = { readonly kind: 'all' } | { readonly kind: 'turn'; readonly number: number }

/** The result of `threads.savePdf`. `canceled` means the dialog was closed. A failure comes as an exception with a reason code. */
export type SavePdfResult = { readonly saved: true; readonly uri: string } | { readonly saved: false }

/** Upper limit of the assembled HTML (bytes). It is a value coming from the renderer, so main validates it. */
export const EXPORT_HTML_MAX_BYTES = 64 * 1024 * 1024

/**
 * The export format (TODO 866). `pdf` = print in a hidden window (818), `html` = a single HTML file with images embedded as `data:`,
 * `md` = Markdown (TODO 1014, images only as the `[image]` mark).
 * The assembly (the renderer's `exportDocumentHtml`) is common; only the CSP and the save exit differ.
 */
export type ExportFormat = 'pdf' | 'html' | 'md'

/** The formats that build HTML (`md` does not go through HTML and is built directly by `exportMarkdown`, TODO 1014). */
export type HtmlExportFormat = Exclude<ExportFormat, 'md'>

/**
 * Limits for embedding images in an HTML export (TODO 866, owner decision 2026-10-18): 5 MB per image, 25 MB in total.
 * An image over the limit is replaced by a note saying the image was omitted, and the export does not fail.
 */
export const EXPORT_IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const EXPORT_IMAGES_TOTAL_MAX_BYTES = 25 * 1024 * 1024

/** Whether it is a parent's message (excluding subagent rows and rows nested under a tool call). */
function isTopLevel(event: AiosEvent): boolean {
  return event.actor !== 'subagent' && event.parentToolUseId === undefined
}

/**
 * Splits a sequence of events (oldest first) into turns. `text` can be freely changed before passing it in (main's redaction).
 * Turns with an empty body (such as a head with no answer) are dropped. A turn with only a question and no answer (interrupted) is kept.
 */
export function buildExportTurns(
  events: readonly AiosEvent[],
  mapText: (text: string) => string = (text) => text
): ExportTurn[] {
  const turns: { number: number; question: ExportQuestion | null; answers: string[] }[] = []
  let count = 0
  for (const event of events) {
    if (!isTopLevel(event)) continue
    if (event.kind === 'user_text') {
      count += 1
      const attachments = event.payload.attachments
      const question: ExportQuestion = {
        id: event.id,
        ts: event.ts,
        text: mapText(event.payload.text),
        ...(attachments === undefined || attachments.length === 0
          ? {}
          : { attachments: attachments.map((a) => ({ ...a, name: mapText(a.name) })) })
      }
      turns.push({ number: count, question, answers: [] })
    } else if (event.kind === 'assistant_text') {
      const text = event.payload.text
      if (text.trim() === '') continue
      let current = turns[turns.length - 1]
      if (current === undefined) {
        current = { number: 0, question: null, answers: [] }
        turns.push(current)
      }
      current.answers.push(mapText(text))
    }
  }
  return turns.filter((turn) => turn.question !== null || turn.answers.length > 0)
}

/** The turn for a message row id. Null if none. */
export function turnOfQuestion(turns: readonly ExportTurn[], eventId: string): ExportTurn | null {
  return turns.find((turn) => turn.question?.id === eventId) ?? null
}

/** The turns in the range. Empty if the `turn` number does not exist. */
export function turnsInScope(turns: readonly ExportTurn[], scope: ExportScope): readonly ExportTurn[] {
  if (scope.kind === 'all') return turns
  return turns.filter((turn) => turn.number === scope.number && turn.question !== null)
}

/** Validation of a range value (it comes from the renderer). Null if the shape is wrong. */
export function asExportScope(value: unknown): ExportScope | null {
  if (typeof value !== 'object' || value === null) return null
  const kind = (value as { kind?: unknown }).kind
  if (kind === 'all') return { kind: 'all' }
  const number = (value as { number?: unknown }).number
  if (kind === 'turn' && typeof number === 'number' && Number.isSafeInteger(number) && number >= 1) {
    return { kind: 'turn', number }
  }
  return null
}

/** Characters that cannot be used or are confusing in a file name (macOS `:` `/` and control characters, and Windows reserved characters too). */
// eslint-disable-next-line no-control-regex -- regex to drop control characters
const UNSAFE_NAME = /[\\/:*?"<>|\u0000-\u001f\u007f]+/g
const MAX_NAME = 80

/** `YYYY-MM-DD` of the date (local time). */
export function exportDate(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * The default file name of the save dialog (owner decision 2026-10-17): "thread name YYYY-MM-DD.pdf",
 * and for one turn "thread name YYYY-MM-DD - N.pdf" (N is which question). If the title is empty, `fallback`.
 * For HTML (TODO 866) only the extension is `.html`.
 */
export function exportFileName(
  title: string,
  at: Date,
  fallback: string,
  turnNumber?: number,
  format: ExportFormat = 'pdf'
): string {
  let base = title.replace(UNSAFE_NAME, ' ').replace(/\s+/g, ' ').trim()
  // A leading `.` makes it a hidden file.
  base = base.replace(/^\.+/, '').trim()
  if (base === '') base = fallback
  if ([...base].length > MAX_NAME) base = [...base].slice(0, MAX_NAME).join('').trim()
  const suffix = turnNumber === undefined ? '' : ` - ${turnNumber}`
  return `${base} ${exportDate(at)}${suffix}.${format}`
}
