/**
 * Makes a tool call's arguments readable (item 286, wave 16 bundle A). Pure functions only.
 *
 * **Decided by the argument keys, not by the tool name.** The one-line summary (`summarizeToolInput` in `adapter/parse.ts`) is built so that
 * "the name the backend decided arrives as is, so instead of listing proper names it picks by the priority order of argument keys",
 * and the renderer does not look at tool names either (the promise at the top of `ApprovalPrompt`). If we made a separate place that looks up a formatting table by tool name,
 * "knowledge of tools" would be split into two places, the summary and the formatting. Looking up by keys means nothing needs to be added to compat/ or the adapter,
 * it also works for plugin / MCP tools that use the same keys, and it works for old saved rows (whose payload has no new fields).
 *
 * - `command` (a string) -> code (monospace, wrapping, copy). `description` goes below it, in a pale color.
 * - `file_path` / `notebook_path` / `path` / `pattern` / `glob` / `url` / `offset` / `limit` -> rows with headings.
 * - An input with none of the "anchor" keys above (`command` / `file_path` / `notebook_path` / `path` / `pattern` / `url`), and
 *   an input that is not an object, stay JSON as before.
 * - **Fields not shown in the table are kept below as JSON** (no information is dropped). Edit's `old_string` / `new_string`, Bash's `timeout`, etc.
 *
 * `redactJson` / `redactText` are applied before display: events being received (not saved yet) and approval requests are sent by main
 * without masking (only the persistence entry point `ThreadStore.toPersistable` applies it). Saved rows are already masked,
 * and applying the mask twice does not change the shape.
 */
import type { JsonValue } from '@shared/agent.js'
import { redactJson, redactText } from '@shared/redact.js'

export interface ToolInputField {
  readonly key: string
  readonly value: string
  /** path = a path (monospace) / code = a search expression (monospace) / text = numbers, URLs, etc. */
  readonly kind: 'path' | 'code' | 'text'
}

export type ToolInputView =
  | { readonly kind: 'json'; readonly json: string }
  | {
      readonly kind: 'formatted'
      /** The command to run (the actual string with escapes undone). null if none. */
      readonly command: string | null
      /** The command's description (one line written by the model). Only when there is a command. */
      readonly description: string | null
      readonly fields: readonly ToolInputField[]
      /** The JSON of the fields not shown in the table. null if none. */
      readonly rest: string | null
    }

const COMMAND_KEY = 'command'
const DESCRIPTION_KEY = 'description'

/** The keys that decide whether to format. If there are none, it stays JSON. */
const ANCHOR_KEYS: ReadonlySet<string> = new Set([
  COMMAND_KEY,
  'file_path',
  'notebook_path',
  'path',
  'pattern',
  'url'
])

/** The keys that become rows with headings, and their order (Read -> file_path / offset / limit, Grep -> pattern / path / glob ...). */
const FIELD_KEYS: readonly { readonly key: string; readonly kind: ToolInputField['kind']; readonly numeric?: true }[] = [
  { key: 'file_path', kind: 'path' },
  { key: 'notebook_path', kind: 'path' },
  { key: 'pattern', kind: 'code' },
  { key: 'path', kind: 'path' },
  { key: 'glob', kind: 'code' },
  { key: 'url', kind: 'text' },
  { key: 'offset', kind: 'text', numeric: true },
  { key: 'limit', kind: 'text', numeric: true }
]

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonBlank(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Turns the arguments into a display shape. `input` is `item.input` as is (null is handled by the caller as "summary only"). */
export function toolInputView(input: JsonValue): ToolInputView {
  const value = redactJson(input).value
  if (!isRecord(value) || !Object.keys(value).some((key) => ANCHOR_KEYS.has(key) && nonBlank(value[key]))) {
    return { kind: 'json', json: JSON.stringify(value, null, 2) }
  }
  const used = new Set<string>()
  const commandValue = value[COMMAND_KEY]
  const command = nonBlank(commandValue) ? commandValue : null
  if (command !== null) used.add(COMMAND_KEY)
  const descriptionValue = value[DESCRIPTION_KEY]
  const description = command !== null && nonBlank(descriptionValue) ? descriptionValue : null
  if (description !== null) used.add(DESCRIPTION_KEY)

  const fields: ToolInputField[] = []
  for (const spec of FIELD_KEYS) {
    const raw = value[spec.key]
    let text: string | null = null
    if (spec.numeric === true) {
      if (typeof raw === 'number' && Number.isFinite(raw)) text = String(raw)
    } else if (nonBlank(raw)) {
      text = raw
    }
    if (text === null) continue
    used.add(spec.key)
    fields.push({ key: spec.key, value: text, kind: spec.kind })
  }

  const restEntries = Object.entries(value).filter(([key]) => !used.has(key))
  const rest = restEntries.length === 0 ? null : JSON.stringify(Object.fromEntries(restEntries), null, 2)
  return { kind: 'formatted', command, description, fields, rest }
}

/**
 * The full text shown in the hover bubble of a folded row. Picked with **the same key priority** as the summary (`summarizeToolInput`) and returned without cutting.
 * The summary is on the main side (the adapter) and cannot be imported from the renderer, so the order is copied here
 * (`test/tool-input.test.ts` compares it with `SUMMARY_KEYS` and catches any mismatch).
 * Item 321 put `description` before `prompt` (so a subagent's heading becomes a short title).
 */
export const HOVER_KEYS: readonly string[] = [
  'command',
  'file_path',
  'path',
  'url',
  'pattern',
  'query',
  'description',
  'prompt',
  'notebook_path',
  'subagent_type'
]

/** The keys for prose (a copy of main's `PROSE_SUMMARY_KEYS`). The summary drops the emphasis marks `**` (item 321). */
const PROSE_KEYS: ReadonlySet<string> = new Set(['description', 'prompt'])

/** The cap when the heading's summary can be rebuilt from the arguments (same as main's `MAX_SUMMARY_CHARS`). */
const MAX_DISPLAY_SUMMARY_CHARS = 200

/** One line of the summary (a copy of main's `summaryLine`). */
function summaryLine(key: string, value: string): string {
  const text = PROSE_KEYS.has(key) ? value.replace(/\*\*/g, '') : value
  return text.replace(/\s+/g, ' ').trim()
}

/** The first key hit in key priority order, and its value. null if none. */
function firstHoverKey(input: JsonValue | null): { key: string; value: string } | null {
  if (input === null || !isRecord(input)) return null
  for (const key of HOVER_KEYS) {
    const value = input[key]
    if (nonBlank(value)) return { key, value }
  }
  return null
}

/**
 * The summary shown in the heading of a folded row (item 321). Normally just the saved `summary`. But **a row decided by a prose key
 * is rebuilt from the arguments**: a subagent call saved before item 321 still has the `prompt` (a long
 * instruction) as its summary, so the `description` left in the arguments is used to make the heading a short title. A row without arguments
 * (a child's tool call has `input: null`, item 257) keeps the saved summary. The mask is not applied here
 * (the caller applies `redactText`).
 */
export function displayToolSummary(input: JsonValue | null, summary: string): string {
  const first = firstHoverKey(input)
  if (first === null || !PROSE_KEYS.has(first.key)) return summary
  const line = summaryLine(first.key, first.value)
  if (line === '') return summary
  return line.length > MAX_DISPLAY_SUMMARY_CHARS ? `${line.slice(0, MAX_DISPLAY_SUMMARY_CHARS)}…` : line
}

/** The cap of the bubble. A command of several KB scrolls inside the bubble, and what exceeds this is cut. */
export const MAX_HOVER_CHARS = 8000

export interface ToolHover {
  /** The full text shown in the bubble (masked, cut at the cap). */
  readonly text: string
  /** Whether there is something the summary (one line, truncated) does not show. If not, no bubble is needed as long as the summary fits the field. */
  readonly more: boolean
}

/**
 * The contents of the hover bubble of a folded row. When there are no arguments (a child's call, item 257), it is the summary itself.
 * If a row whose heading was decided by a key other than `prompt` also has a `prompt`, it is appended after a blank line (item 321: a subagent's
 * heading becomes the title (`description`), and the long instruction is read here and in the expanded view).
 */
export function toolHover(input: JsonValue | null, summary: string): ToolHover {
  const first = firstHoverKey(input)
  const shown = displayToolSummary(input, summary)
  const redactedSummary = redactText(shown).text
  if (first === null) return { text: redactedSummary, more: false }
  let full = first.value.trim()
  const prompt = first.key !== 'prompt' && input !== null && isRecord(input) ? input['prompt'] : undefined
  if (nonBlank(prompt)) full = `${full}\n\n${prompt.trim()}`
  let text = redactText(full).text
  if (text.length > MAX_HOVER_CHARS) text = `${text.slice(0, MAX_HOVER_CHARS)}…`
  return { text, more: nonBlank(prompt) || summaryLine(first.key, text) !== redactedSummary }
}
