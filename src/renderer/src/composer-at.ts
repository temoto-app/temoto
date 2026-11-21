/**
 * Specify files with `@` in the prompt box (item 114, ARCHITECTURE.md 4.5.8). Pure functions that do not touch the DOM, and
 * `test/composer-at.test.ts` tests them as they are. The search itself (IPC) is in `composer-at-search.ts`.
 *
 * Rules for the decision:
 * - **Complete only when `@` is preceded by the start of a line, whitespace, or a Japanese sentence punctuation mark.** This is the same condition
 *   under which the backend picks up an `@` reference (a regular expression in the 2.1.280 binary).
 *   Nothing is shown for email addresses (`a@b.com`) or `foo@bar`.
 * - There is no whitespace between `@` and the input position (caret) (nothing is shown after a finished `@path `).
 * - `@"…"` started with a quote is not completed (the user is writing it by hand).
 * - As in item 100, candidates inside the working folder come first and the whole machine after (main's `searchFiles` returns them split into sections).
 * - The string inserted is a relative path inside the working folder and an absolute path outside it. If it contains whitespace it is wrapped as `@"…"`
 *   (the backend also picks up the quoted form).
 * - The search query is only the part after the last path separator (`/`). The part before it (`src` of `src/comp`) is used
 *   as a filter that keeps only candidates whose path contains it (file-name search looks only at names).
 */
import { atReferenceOrPlain, atReferenceText } from '@shared/at-reference.js'
import type { FileEntry } from '@shared/types.js'

/** The `@` reference being typed. `start` is the position of `@`, `end` is the end of the reference (just before the next whitespace). */
export interface AtToken {
  readonly start: number
  readonly end: number
  /** The string from after `@` to the input position (`src/comp`). */
  readonly query: string
}

/** Characters allowed immediately before `@` (besides line start). */
const BEFORE_AT = /[\s。、？！]/

/** The `@` reference being typed at the input position (caret). Null if none. */
export function atTokenAt(text: string, caret: number): AtToken | null {
  if (caret < 1 || caret > text.length) return null
  let at = -1
  for (let i = caret - 1; i >= 0; i -= 1) {
    const ch = text[i]!
    if (ch === '@') {
      at = i
      break
    }
    if (/\s/.test(ch)) return null
  }
  if (at === -1) return null
  if (at > 0 && !BEFORE_AT.test(text[at - 1]!)) return null
  const query = text.slice(at + 1, caret)
  if (query.startsWith('"')) return null
  let end = caret
  while (end < text.length && !/\s/.test(text[end]!)) end += 1
  return { start: at, end, query }
}

/** The query passed to file-name search (the part after the last path separator). */
export function atSearchTerm(query: string): string {
  return query.slice(query.lastIndexOf('/') + 1)
}

/** The directory part used to narrow candidates (`src/comp` -> `src`). Empty string if none. */
export function atDirectoryPart(query: string): string {
  const cut = query.lastIndexOf('/')
  return cut <= 0 ? '' : query.slice(0, cut)
}

/** Turn a `file://` URI back into a path. A malformed URI gives null. */
export function pathOfFileUri(uri: string): string | null {
  if (!uri.startsWith('file://')) return null
  try {
    return decodeURIComponent(uri.slice('file://'.length))
  } catch {
    return null
  }
}

function fold(value: string): string {
  return value.normalize('NFC').toLowerCase()
}

/**
 * Turn a candidate's path into the form to insert. Relative inside the working folder (compared ignoring
 * case and normalization differences, since APFS does not distinguish them), absolute outside. The working folder itself is `.`.
 */
export function atReferencePath(entryUri: string, cwdUri: string | null): string | null {
  const path = pathOfFileUri(entryUri)
  if (path === null) return null
  const cwd = cwdUri === null ? null : pathOfFileUri(cwdUri)
  if (cwd !== null && cwd !== '') {
    const base = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd
    const normalized = path.normalize('NFC')
    const folded = fold(normalized)
    const foldedBase = fold(base.normalize('NFC'))
    if (folded === foldedBase) return '.'
    if (folded.startsWith(`${foldedBase}/`)) {
      return normalized.slice(base.normalize('NFC').length + 1)
    }
  }
  return path
}

/** The string written after `@` (shared with main's attachments, TODO 917). */
export { atReferenceOrPlain, atReferenceText }

/** The input and input position after a candidate is chosen. One space is placed after it (so typing can continue). */
export function completeAt(
  text: string,
  token: AtToken,
  path: string
): { readonly text: string; readonly caret: number } {
  const inserted = atReferenceOrPlain(path)
  const after = text.slice(token.end)
  const spacer = after.startsWith(' ') || after.startsWith('\n') ? '' : ' '
  const head = `${text.slice(0, token.start)}${inserted}${spacer}`
  return { text: `${head}${after}`, caret: head.length + (spacer === '' ? 1 : 0) }
}

/**
 * The path to insert when a candidate is chosen (TODO 436). A folder gets a trailing `/` (`@src/`, the same form as the CLI's `@`).
 * The working folder itself (`.`) and anything already ending in `/` are left as they are.
 */
export function atInsertPath(candidate: Pick<AtCandidate, 'path' | 'isDirectory'>): string {
  const { path, isDirectory } = candidate
  if (!isDirectory || path === '.' || path.endsWith('/')) return path
  return `${path}/`
}

/** One completion candidate. */
export interface AtCandidate {
  readonly uri: string
  readonly name: string
  readonly isDirectory: boolean
  /** The path to insert (relative or absolute). */
  readonly path: string
  /** Whether it is inside the working folder (splits the headings). */
  readonly inCwd: boolean
}

/**
 * Wave 13 bundle F (a small observation from items 138 / 147: `.git/logs/…` and `venv/…` under hidden directories
 * rank above direct children). File-name search itself (`src/index-kernel/file-search.ts`, the same matching rules
 * as qlm) is unchanged; only the `@` candidates are reordered here. Paths through hidden directories (starting with `.`) or
 * dependency / generated directories (such as `node_modules`) go later, and those shallower from the cwd
 * go earlier. **The file name itself (after the last separator) is not looked at**: demoting a hidden file such as `.env`
 * by its own name would get in the way exactly when that is what is being looked for. On a tie the order main returned
 * (relevance) is kept as it is.
 */
const NOISY_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules',
  'venv',
  '.venv',
  'dist',
  'out',
  'build',
  '__pycache__'
])

/** Number of path separators (`.` and empty elements are not counted). Used to compare depth. */
function pathDepth(path: string): number {
  return path.split('/').filter((segment) => segment !== '' && segment !== '.').length
}

/**
 * How many hidden / generated directories the path goes through. A directory candidate itself is counted too
 * (choosing it means descending into it). The part after the last separator (the file name) is
 * not counted unless `isDirectory` is true.
 */
function noisySegmentCount(path: string, isDirectory: boolean): number {
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.')
  const dirSegments = isDirectory ? segments : segments.slice(0, -1)
  return dirSegments.filter((segment) => segment.startsWith('.') || NOISY_PATH_SEGMENTS.has(segment)).length
}

/**
 * Reordering of candidates (pure function, tested by `test/composer-at.test.ts`). The boundary between sections (inside the cwd / whole machine)
 * is kept by the caller (`mergeAtCandidates`), so only the inside of one section is reordered here.
 */
export function rankAtCandidates(candidates: readonly AtCandidate[]): readonly AtCandidate[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      noisy: noisySegmentCount(candidate.path, candidate.isDirectory),
      depth: pathDepth(candidate.path)
    }))
    .sort((a, b) => a.noisy - b.noisy || a.depth - b.depth || a.index - b.index)
    .map((entry) => entry.candidate)
}

/**
 * Order the working-folder section first, then the whole-machine section, make each URI unique, and drop those not containing `dirPart`.
 * The order between sections (inside first) is kept, but **inside a section candidates are reordered by `rankAtCandidates`**
 * (item 114 kept main's order, but the wave 11 proxy verification found that hidden directories / generated files
 * rank on top).
 */
export function mergeAtCandidates(
  cwdEntries: readonly FileEntry[],
  entries: readonly FileEntry[],
  cwdUri: string | null,
  dirPart: string,
  limit = 8
): readonly AtCandidate[] {
  const seen = new Set<string>()
  const wanted = fold(dirPart)
  const build = (list: readonly FileEntry[]): AtCandidate[] => {
    const out: AtCandidate[] = []
    for (const entry of list) {
      if (seen.has(entry.uri)) continue
      const path = atReferencePath(entry.uri, cwdUri)
      if (path === null) continue
      if (wanted !== '' && !fold(path).includes(wanted)) continue
      seen.add(entry.uri)
      // A response with no cwd section (the cwd is not in the index) still treats paths that came out relative as inside.
      out.push({ uri: entry.uri, name: entry.name, isDirectory: entry.isDirectory, path, inCwd: !path.startsWith('/') })
    }
    return out
  }
  const inCwd = rankAtCandidates(build(cwdEntries))
  const outside = rankAtCandidates(build(entries))
  return [...inCwd, ...outside].slice(0, limit)
}

/** No candidates. A constant so that the selector / useMemo does not create a new array. */
export const NO_AT_CANDIDATES: readonly AtCandidate[] = []

/** Key of a candidate fetch (TODO 942). Tells whether the candidates belong to this key or are left over from the previous query. */
export function atSearchKey(term: string, dirPart: string, cwdUri: string | null): string {
  return `${cwdUri ?? ''}\u0000${dirPart}\u0000${term}`
}

/**
 * TODO 999: candidates for a lone `@` = recent files (kept newest first, not reordered). Inside the working folder they are relative paths.
 * Paths that cannot be inserted (`atReferencePath` is null) are dropped.
 */
export function recentAtCandidates(
  files: readonly { readonly uri: string; readonly name: string }[],
  cwdUri: string | null,
  limit = 8
): readonly AtCandidate[] {
  const out: AtCandidate[] = []
  for (const file of files) {
    if (out.length >= limit) break
    const path = atReferencePath(file.uri, cwdUri)
    if (path === null) continue
    out.push({ uri: file.uri, name: file.name, isDirectory: false, path, inCwd: !path.startsWith('/') })
  }
  return out
}

/**
 * Initial selection of the `@` candidates (wave 53 review). The candidates for a lone `@` (no query) are recent files, not something
 * the user searched for and chose, so they are **shown without being selected** (-1). If one were selected, `@` + Enter would insert a recent file instead of sending. With a query the first is selected.
 */
export function atInitialCursor(query: string | null): number {
  return query === '' ? -1 : 0
}

/** Move to the next selection with up/down. When nothing is selected (-1), down picks the first and up the last. */
export function atCursorStep(cursor: number, step: 1 | -1, length: number): number {
  if (length <= 0) return -1
  if (cursor < 0) return step > 0 ? 0 : length - 1
  return (Math.min(cursor, length - 1) + step + length) % length
}

/** Position of the selected candidate (-1 if none). */
export function atActiveIndex(cursor: number, length: number): number {
  return cursor < 0 || length <= 0 ? -1 : Math.min(cursor, length - 1)
}
