/**
 * Pure functions for the "smaller" of the two Drop entry points (item 258).
 *
 * A Drop on the conversation pane is an attachment (the URI list of `drop-uris.ts` -> `attach`), and a Drop on the prompt box's textarea
 * **inserts the full path string as plain text**. This file is the building block for the latter and depends on neither the DOM nor main.
 *
 * - `fileUriToPath`: turn a `file://` URI back into an absolute path. That the renderer may see paths is the decision of item 55
 *   (it is not a trust boundary). It does not touch main's revalidation (`assertAllowed`) or the Broker.
 * - `shellEscapePath`: the same notation as when a file is dropped on macOS Terminal. Shell special characters such as whitespace
 *   are escaped with `\` (not wrapped in quotes). Non-ASCII such as Japanese is left as it is.
 * - `insertPathsAtCursor`: insert at the cursor position (replacing the selection if any), separated by whitespace.
 */

/** `file://[localhost]/a/b%20c` -> `/a/b c`. Null for non-`file:`, malformed % notation, or anything containing NUL. */
export function fileUriToPath(uri: string): string | null {
  if (!/^file:/i.test(uri)) return null
  let rest = uri.slice('file:'.length)
  if (!rest.startsWith('//')) return null
  rest = rest.slice(2)
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  const host = rest.slice(0, slash)
  if (host !== '' && host.toLowerCase() !== 'localhost') return null
  const encoded = rest.slice(slash).split(/[?#]/, 1)[0] ?? ''
  let decoded: string
  try {
    decoded = decodeURIComponent(encoded)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  return decoded
}

/** Characters escaped with a backslash. Whitespace, quotes, parentheses, shell operators, globs, history expansion, etc. */
const SHELL_SPECIAL = /[ \t\n\\'"`()[\]{}<>&;|*?$!#^]/g

/** Produce the same form as when dropped on Terminal.app (`/Users/me/my file (1).png` -> `/Users/me/my\ file\ \(1\).png`). */
export function shellEscapePath(path: string): string {
  return path.replace(SHELL_SPECIAL, (char) => `\\${char}`)
}

/** URI list -> the string to insert (escaped paths separated by a single space). URIs that cannot be turned back into paths are dropped. */
export function pathsText(uris: readonly string[]): string {
  const paths: string[] = []
  for (const uri of uris) {
    const path = fileUriToPath(uri)
    if (path === null) continue
    const escaped = shellEscapePath(path)
    if (!paths.includes(escaped)) paths.push(escaped)
  }
  return paths.join(' ')
}

export interface PathInsertion {
  readonly text: string
  readonly caret: number
}

/**
 * Put `text` (escaped paths) at the cursor. If the character before is not whitespace, add one space before; if the character after is not
 * whitespace (including the end of the body), add one space after, so typing can continue just as in Terminal.
 * `text` is not trimmed (the trailing space of `\ ` is real). Does nothing if empty.
 */
export function insertPathsAtCursor(
  draft: string,
  start: number,
  end: number,
  text: string
): PathInsertion {
  const from = clampIndex(Math.min(start, end), draft.length)
  const to = clampIndex(Math.max(start, end), draft.length)
  if (text === '') return { text: draft, caret: to }
  const before = draft.slice(0, from)
  const after = draft.slice(to)
  const prev = before.at(-1)
  const next = after[0]
  const lead = prev !== undefined && !/\s/.test(prev) ? ' ' : ''
  const trail = next === undefined || !/\s/.test(next) ? ' ' : ''
  const piece = `${lead}${text}${trail}`
  return { text: `${before}${piece}${after}`, caret: before.length + piece.length }
}

function clampIndex(value: number, max: number): number {
  if (!Number.isFinite(value)) return max
  return Math.max(0, Math.min(Math.trunc(value), max))
}
