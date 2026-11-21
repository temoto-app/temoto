/**
 * Builds the material for interim reports (ARCHITECTURE.md 5.1.3 / TODO 15).
 *
 * **Tool names are backend-specific**, so the table mapping them to kinds lives only in `toolKinds` of
 * `compat/claude-code.json`, and this file reads it (constraint 6). What reaches the renderer and `shared/` is only
 * "kind (search / fetch / file / other) + a short display string + a destination".
 *
 * Decisions:
 * - **Only a destination that exactly matches what was actually read is clickable.** `href` is attached only to a
 *   URL / absolute path that could be taken straight from the arguments. Path shapes are not guessed.
 * - There is a rule that **paths do not go to the renderer**, so a file is shortened to "parent directory name/file name"
 *   and the destination is passed as a `file:` URI (the same treatment as search results).
 * - A tool not in the table is `other` with an empty label. The renderer folds these into "N other operations".
 */
import type { ToolProgressHint, ToolProgressKind } from '@shared/agent.js'
import { pathToUri } from '../../../common/uri.js'
import { loadCompatTable, type CompatTable } from './compat.js'

/** Upper bound on one display string's length. An interim report fits on one line. */
const MAX_LABEL_CHARS = 72

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** From a sequence of keys, returns the first non-empty string found (also used by `draft-conflicts.ts`). */
export function firstString(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

function clip(value: string, max = MAX_LABEL_CHARS): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/**
 * Shortens a URL to "host name + tail": `https://example.com/a/b/c.html` →
 * `example.com/…/c.html`. What cannot be parsed is just truncated as is.
 */
export function shortenUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return clip(url)
  }
  const segments = parsed.pathname.split('/').filter((s) => s !== '')
  const host = parsed.host
  if (segments.length === 0) return clip(host)
  const last = decodeURIComponent(segments[segments.length - 1] ?? '')
  const head = segments.length > 1 ? '/…' : ''
  return clip(`${host}${head}/${last}`)
}

/** Absolute path → "parent directory name/file name". A relative path gives only the file name. */
export function tailLabel(path: string): string {
  const segments = path.split('/').filter((s) => s !== '')
  const name = segments[segments.length - 1] ?? ''
  const parent = segments.length > 1 ? segments[segments.length - 2] : undefined
  return clip(parent === undefined ? name : `${parent}/${name}`)
}

/**
 * Keys used for arguments that read or write a file. **The first one found in this order is taken.**
 * `draft-conflicts.ts` (the second half of item 97) uses the same table: the shape of a tool's arguments is written in only one place.
 */
export const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const
const URL_KEYS = ['url'] as const
const QUERY_KEYS = ['query'] as const

/**
 * One `tool_use` → one line of interim report. `null` for what cannot be shown.
 *
 * A pure function that just consults the table (the table is JSON cached by `loadCompatTable`).
 */
export function toolProgressHint(name: string, rawInput: unknown): ToolProgressHint | null {
  const entry = loadCompatTable().toolKinds.map[name]
  const kind: ToolProgressKind = entry?.kind ?? 'other'
  const input = isRecord(rawInput) ? rawInput : {}

  if (kind === 'search') {
    const query = firstString(input, QUERY_KEYS)
    return query === null ? { kind, label: '' } : { kind, label: clip(query) }
  }

  if (kind === 'fetch') {
    const url = firstString(input, URL_KEYS)
    if (url === null) return { kind, label: '' }
    // Only http(s) becomes a destination. Anything else shows text only and is not clickable.
    const openable = /^https?:\/\//i.test(url)
    return openable ? { kind, label: shortenUrl(url), href: url } : { kind, label: clip(url) }
  }

  if (kind === 'file') {
    const path = firstString(input, PATH_KEYS)
    if (path === null) return { kind, label: '' }
    if (!path.startsWith('/')) {
      // A relative path cannot be opened without knowing the cwd. Show only the name, as a non-clickable row.
      return { kind, label: tailLabel(path) }
    }
    return { kind, label: tailLabel(path), href: pathToUri(path) }
  }

  // other: only tools for which the table has a fixed phrase become a row (for example, a subagent launch).
  return { kind: 'other', label: entry?.label === undefined ? '' : clip(entry.label) }
}

/**
 * Extracts the target path of a write-type tool call (the second half of item 97, the notice of a draft conflict).
 * Only tools whose `toolKinds.map[*].write` is true are covered. Null if no path can be taken, it is an empty string, or the
 * tool is not in the table. **A relative path is returned as is**: making it absolute is the caller's job (the caller of
 * `AgentAdapter`, which knows the cwd).
 */
export function writeToolTargetPath(table: CompatTable, toolName: string, input: unknown): string | null {
  const entry = table.toolKinds.map[toolName]
  if (entry?.write !== true) return null
  if (!isRecord(input)) return null
  return firstString(input, PATH_KEYS)
}
