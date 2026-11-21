/**
 * The pure part of what connects the ViewerPane and the conversation (item 97, ARCHITECTURE.md 4.5 / 7.6.2).
 *
 *   - Validating the selection attached to a send (renderer -> main) and embedding it in the prompt
 *   - How to resolve the paths of the gateway's `openFile` / `closeFile` (model -> main)
 *
 * Both **do not trust values from outside**: the selection's URI and the path the model passes
 * are used only after going through `FsAccess.assertAllowed` (12.7). It touches neither electron nor the DB, so
 * `test/viewer-selection.test.ts` checks it as is.
 */
import { isAbsolute, relative, resolve } from 'node:path'
import { MAX_SELECTION_TEXT } from '@shared/plugin.js'
import type { ViewerSelection } from '@shared/thread.js'
import { reasonError } from '@shared/reason.js'
import { pathToUri, uriToPath } from '../../common/uri.js'
import type { PathAccess } from '../../common/fs-policy.js'

/**
 * Upper limit on the in-file search term remembered per thread (item 63). Well longer than the practical length of the search field. Both `SessionManager.setViewerState` and
 * the gateway's `openFile` (`gateway-requests.ts`, the `highlight` of the `ViewerCommand` sent to the window) cut at this value
 * (code-review fix: before, there were copies of the same value in two files).
 */
export const MAX_VIEWER_HIGHLIGHT = 200

/** Upper limit (characters) on the path the model passes. Anything longer is refused without resolving. */
export const MAX_TOOL_PATH = 4096

/** Only the choke point from `FsAccess` that is used here. */
export interface SelectionGate {
  assertAllowed(uri: string, asDirectory: boolean, access?: PathAccess): string
}

function isLine(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= 1)
}

/**
 * Validates a selection that came from the renderer (item 97). The URI goes through the choke point (`invalid-value` if it hits an exclusion rule),
 * lines are integers of 1 or more with `from <= to`, and the body is cut at `MAX_SELECTION_TEXT`.
 * A body of only whitespace is not attached (null).
 */
export function checkSelection(
  selection: ViewerSelection,
  gate: SelectionGate
): ViewerSelection | null {
  const { fromLine, toLine } = selection
  if (!isLine(fromLine) || !isLine(toLine) || (fromLine === null) !== (toLine === null)) {
    throw reasonError('invalid-value', { field: 'selection' })
  }
  if (fromLine !== null && toLine !== null && toLine < fromLine) {
    throw reasonError('invalid-value', { field: 'selection' })
  }
  let path: string
  try {
    // A selection is a copy of what was read, so the read check applies (`.md` of auto memory passes too, item 254).
    path = gate.assertAllowed(selection.uri, false, 'read')
  } catch {
    throw reasonError('invalid-value', { field: 'selection' })
  }
  if (selection.text.trim() === '') return null
  const over = selection.text.length > MAX_SELECTION_TEXT
  return {
    uri: pathToUri(path),
    text: over ? selection.text.slice(0, MAX_SELECTION_TEXT) : selection.text,
    fromLine,
    toLine,
    truncated: over || selection.truncated
  }
}

/** A fence longer than the longest run of backticks in the body (at least 3). */
export function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * Turns the selection into a form to embed in the prompt (item 97). One heading line (the path relative to the cwd and the lines), and
 * a code fence wrapping the body. **It is text for the model, so it is a fixed English sentence** (main does not know the display language).
 * The `@path` notation is not used because that is an instruction to read the whole file.
 */
export function formatSelection(selection: ViewerSelection, cwd: string): string {
  const path = uriToPath(selection.uri)
  const rel = relative(cwd, path)
  const shown = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path
  const lines =
    selection.fromLine === null || selection.toLine === null
      ? ''
      : selection.fromLine === selection.toLine
        ? ` (line ${selection.fromLine})`
        : ` (lines ${selection.fromLine}-${selection.toLine})`
  const note = selection.truncated ? ' [truncated]' : ''
  const fence = fenceFor(selection.text)
  const body = selection.text.endsWith('\n') ? selection.text : `${selection.text}\n`
  return `Selected in ${shown}${lines}${note}:\n${fence}\n${body}${fence}`
}

/**
 * Turns a path passed by a gateway tool into an absolute path (item 97). Accepts a `file:` URI, an absolute path, and
 * a path relative to the thread's cwd. null for empty, too long, containing NUL, an unreadable URI, or
 * a URI other than `file:`.
 * **The choke point is not applied here** - the caller runs it through `assertAllowed`.
 */
export function resolveToolPath(raw: unknown, cwd: string): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.length > MAX_TOOL_PATH || trimmed.includes('\0')) return null
  if (trimmed.startsWith('file:')) {
    try {
      const path = uriToPath(trimmed)
      return isAbsolute(path) ? resolve(path) : null
    } catch {
      return null
    }
  }
  // Do not resolve a URI that is not a file, such as `thread://` or `https://`, as a relative path.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed)
}
