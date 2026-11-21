/**
 * Resolves a link in the body to the `file://` URI of a file that really exists (item 254, ARCHITECTURE.md 5.1 / 4.4.1).
 *
 * ```
 * href -> shape check (length, NUL, scheme) -> drop everything after # (a line if `#L42`) -> decode %
 *      -> candidates: for an absolute path only itself / for a relative one "the base (the cwd or the folder of the open .md)" -> auto memory
 *      -> check each candidate (and the form with the line-number tail dropped) against the gate (`assertAllowed(…, 'read')`) and existence
 *      -> the URI of the first one that passes (and the line of that candidate) / a reason code if none
 * ```
 *
 * - **The gate is main's `FsAccess.assertAllowed`** (12.7). It is a read, so `'read'` is passed, and the auto memory
 *   `.md` (the read exception of 4.4.1) also passes. The write path stays with no exceptions, so it can be opened but not saved.
 * - **A relative path that leaves the base with `..` is treated like an absolute path** (it opens if it passes the gate). The renderer can already
 *   open any `file://`, so a relative `..` does not widen the range. **But the auto memory candidates are
 *   limited to inside that memory directory** - a form like `../../.credentials.json` is not even a candidate
 *   (and it does not match the gate's exception shape either, so it is stopped twice).
 * - **Line numbers**: `foo.ts:42` / `foo.ts:3:1` / `foo.ts#L42` (`#L42C7` / `#L42-L50`) have the line (and column) split off and
 *   put in the result's `line` / `column` (item 273. The renderer jumps the ViewerPane to that line).
 *   If a file whose name really contains `:42` exists, that wins, and then `:42` is not taken as a line
 *   (the line comes only from `#L…`).
 * - **Folders** (TODO 586): if a candidate is a folder rather than a file, the gate is applied again as a folder (`asDirectory`),
 *   and it is returned with `directory: true` (no line). The renderer opens that folder in the Files tree, not the viewer.
 *   Previously only `isFile` was checked and the result was "file not found".
 * - It touches neither electron nor the DB, so `test/link-resolve.test.ts` tests it as is.
 */
import { statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  LINE_FRAGMENT,
  LINE_SUFFIX,
  MAX_LINK_CHOICES,
  MAX_LINK_HREF,
  MAX_LINK_TRIED,
  hasScheme,
  linePositionOf,
  type LinePosition,
  type LinkChoice,
  type LinkResolution
} from '@shared/link.js'
import { formatReason, parseReason } from '@shared/reason.js'
import { log } from '../../common/logger.js'
import { foldPath, pathToUri, uriToPath } from '../../common/uri.js'
import { insideRoots, pathDenialReason, type PathAccess } from '../../common/fs-policy.js'

/** The part of `FsAccess` that this file uses: only the gate. */
export interface LinkGate {
  assertAllowed(uri: string, asDirectory: boolean, access?: PathAccess): string
}

export interface LinkContext {
  /** The primary base for relative paths (the thread's cwd, or the folder of the open .md). null if none. */
  readonly baseDir: string | null
  /** The second candidate (the auto memory directories, the Adapter's `memoryDirs`). */
  readonly memoryDirs: readonly string[]
  /**
   * The third candidate (TODO 816): the places the shell `cd`-ed to in that conversation (newest first, the Adapter's `shellDirs`). Applies to relative paths only.
   * Omitted = none. **A function makes it lazy** - `resolveLink` calls it once, only when neither the base nor the auto memory candidates resolved it
   * (it reads saved tool calls synchronously in main, so it is not read for relative links resolved by the cwd or for images in answers. A code-review fix).
   */
  readonly shellDirs?: readonly string[] | (() => readonly string[])
  /** The home used to expand `~/`. */
  readonly home: string
}

/** Cap on the name attached to a reason code (chapter 7: only counts and short names). */
const MAX_NAME = 80

/** One candidate path and the line when it is chosen (item 273). */
export interface LinkTarget {
  readonly path: string
  /** The line. null if none. */
  readonly position: LinePosition | null
}

/**
 * `href` -> the shapes of the resolved path (absolute / relative) and the form with the line number dropped. null if the shape is bad.
 *
 * The first is the form as is (the line comes only from a `#L…` fragment); the second (if any) is the form with the `:42` / `:3:1` tail
 * dropped, and the line comes from that tail (or from the fragment if there is no tail).
 */
export function parseHref(href: unknown, home: string): { readonly paths: readonly LinkTarget[] } | null {
  if (typeof href !== 'string') return null
  const trimmed = href.trim()
  if (trimmed === '' || trimmed.length > MAX_LINK_HREF || trimmed.includes('\0')) return null
  const hash = trimmed.indexOf('#')
  const body = hash < 0 ? trimmed : trimmed.slice(0, hash)
  if (body === '') return null
  const fragment = hash < 0 ? null : linePositionOf(LINE_FRAGMENT.exec(trimmed.slice(hash + 1)))

  let path: string
  if (/^file:/i.test(body)) {
    try {
      path = uriToPath(body)
    } catch {
      return null
    }
    if (!isAbsolute(path)) return null
  } else {
    if (hasScheme(body)) return null
    try {
      path = decodeURIComponent(body)
    } catch {
      path = body
    }
    if (path.includes('\0')) return null
    if (path === '~' || path.startsWith('~/')) path = join(home, path.slice(1))
  }

  const paths: LinkTarget[] = [{ path, position: fragment }]
  const suffix = LINE_SUFFIX.exec(path)
  const stripped = suffix === null ? path : path.slice(0, suffix.index)
  if (stripped !== path && stripped !== '' && !stripped.endsWith('/')) {
    paths.push({ path: stripped, position: linePositionOf(suffix) ?? fragment })
  }
  return { paths }
}

/** The base (cwd / the open .md) and auto memory candidates (no duplicate paths; for a duplicate, the line from the earlier one is taken). */
function primaryCandidates(parsed: { readonly paths: readonly LinkTarget[] }, context: LinkContext): LinkTarget[] {
  const out: LinkTarget[] = []
  const push = (candidate: string, position: LinePosition | null): void => {
    if (!out.some((entry) => entry.path === candidate)) out.push({ path: candidate, position })
  }
  for (const { path, position } of parsed.paths) {
    if (isAbsolute(path)) push(resolve(path), position)
    else if (context.baseDir !== null) push(resolve(context.baseDir, path), position)
  }
  if (isRelative(parsed)) {
    for (const dir of context.memoryDirs) {
      for (const { path, position } of parsed.paths) {
        // `memory/x.md` is resolved from the project folder (the parent of memory), and `x.md` from memory.
        for (const candidate of [resolve(dirname(dir), path), resolve(dir, path)]) {
          if (candidate !== dir && insideRoots(candidate, [dir])) push(candidate, position)
        }
      }
    }
  }
  return out
}

/**
 * TODO 816: candidates from where the shell `cd`-ed (newest first). Only those that do not overlap `seen` (the earlier candidates). As with the cwd, a form that
 * leaves with `..` is treated like an absolute path. Empty if it is not a relative link (`shellDirs` is not called either).
 */
function shellCandidates(
  parsed: { readonly paths: readonly LinkTarget[] },
  context: LinkContext,
  seen: readonly LinkTarget[]
): LinkTarget[] {
  if (!isRelative(parsed) || context.shellDirs === undefined) return []
  const dirs = typeof context.shellDirs === 'function' ? context.shellDirs() : context.shellDirs
  const out: LinkTarget[] = []
  for (const dir of dirs) {
    for (const { path, position } of parsed.paths) {
      const candidate = resolve(dir, path)
      if (!seen.some((entry) => entry.path === candidate) && !out.some((entry) => entry.path === candidate)) {
        out.push({ path: candidate, position })
      }
    }
  }
  return out
}

function isRelative(parsed: { readonly paths: readonly LinkTarget[] }): boolean {
  return !isAbsolute(parsed.paths[0]?.path ?? '')
}

/** Candidates in the order to check (no duplicate paths; for a duplicate, the line from the earlier one is taken). Including the shell's `cd` places (called if lazy). */
export function linkCandidates(href: unknown, context: LinkContext): readonly LinkTarget[] | null {
  const parsed = parseHref(href, context.home)
  if (parsed === null) return null
  const primary = primaryCandidates(parsed, context)
  return [...primary, ...shellCandidates(parsed, context, primary)]
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

type PathKind = 'file' | 'directory' | 'other' | 'none'

/** Decides the kind with one stat (TODO 947 review: the same path used to be stat-ed 3 times per candidate). */
function pathKind(path: string): PathKind {
  try {
    const info = statSync(path)
    if (info.isFile()) return 'file'
    return info.isDirectory() ? 'directory' : 'other'
  } catch {
    return 'none'
  }
}

/** TODO 947: it exists but is neither a regular file nor a folder (FIFO, device, socket). Does not open it, only stat. */
function isOtherPath(path: string): boolean {
  try {
    const info = statSync(path)
    return !info.isFile() && !info.isDirectory()
  } catch {
    return false
  }
}

function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Checks the candidates in order and returns the URI of the first that "passes the gate and really exists as a regular file or folder"
 * (`directory: true` for a folder, TODO 586). If none, `link-not-found` (with the name and the paths checked).
 * **Only when all candidates fail at the gate**, the reason of the first refusal (such as `path-excluded`) is returned.
 *
 * TODO 808: if a candidate that failed the gate (`'read'`) **exists and passes the hand-out-only gate (`'handoff'`)** (an excluded location
 * that is not credentials), it returns `link-excluded` and `handoffUri` (the band shows "open in external editor / show in Finder").
 * It stays out of the index and the viewer (the exclusion is not loosened).
 */
export function resolveLink(
  href: unknown,
  context: LinkContext,
  gate: LinkGate,
  existsDep: (path: string) => boolean = isFile,
  isDirectoryDep: (path: string) => boolean = isDirectoryPath,
  isOtherDep: (path: string) => boolean = isOtherPath
): LinkResolution {
  // The default three (when not injected) share one stat per path during this call. Injected ones are called as is.
  const kinds = new Map<string, PathKind>()
  const kindOf = (path: string): PathKind => {
    let kind = kinds.get(path)
    if (kind === undefined) {
      kind = pathKind(path)
      kinds.set(path, kind)
    }
    return kind
  }
  const exists = existsDep === isFile ? (path: string): boolean => kindOf(path) === 'file' : existsDep
  const isDirectory = isDirectoryDep === isDirectoryPath ? (path: string): boolean => kindOf(path) === 'directory' : isDirectoryDep
  const isOther = isOtherDep === isOtherPath ? (path: string): boolean => kindOf(path) === 'other' : isOtherDep
  const parsed = parseHref(href, context.home)
  if (parsed === null) return { ok: false, reason: formatReason('invalid-value', { field: 'href' }) }
  let denial: string | null = null
  let denied = 0
  let checked = 0
  let nonRegular = false
  let handoff: { uri: string; directory: boolean } | null = null
  const tried: string[] = []
  /**
   * Whether a candidate that failed the gate (`'read'`) passes as hand-out-only and exists (TODO 808). **stat only after passing the `'handoff'` gate**,
   * so places that the read gate refused without any I/O (credentials, other users' homes, volumes not allowed,
   * autofs) are not touched (a code-review fix: before, exists / isDirectory ran first).
   */
  const noteHandoff = (uri: string, candidate: string): void => {
    if (handoff !== null) return
    try {
      gate.assertAllowed(uri, false, 'handoff')
    } catch {
      // Places such as credentials, TCC locations (TODO 881) and other users' homes are silently given up on without stat (the band stays link-excluded).
      log.info('link.handoff-denied', { path: candidate })
      return
    }
    if (exists(candidate)) {
      handoff = { uri, directory: false }
      return
    }
    if (!isDirectory(candidate)) return
    // A folder-name rule (the credentials folder) is applied again as a folder.
    try {
      gate.assertAllowed(uri, true, 'handoff')
    } catch {
      return
    }
    handoff = { uri, directory: true }
  }
  const check = (candidates: readonly LinkTarget[]): LinkResolution | null => {
    for (const { path: candidate, position } of candidates) {
      checked += 1
      const uri = pathToUri(candidate)
      try {
        gate.assertAllowed(uri, false, 'read')
      } catch (err) {
        denial ??= pathDenialReason(err)
        denied += 1
        noteHandoff(uri, candidate)
        continue
      }
      if (exists(candidate)) {
        if (position === null) return { ok: true, uri }
        return {
          ok: true,
          uri,
          line: position.line,
          ...(position.column === null ? {} : { column: position.column })
        }
      }
      if (isDirectory(candidate)) {
        // A folder-name rule (such as `node_modules`) does not hit unless it is applied as a folder.
        try {
          gate.assertAllowed(uri, true, 'read')
        } catch (err) {
          // If all candidates are excluded folders, return the refusal's reason rather than `link-not-found` (code-review).
          denial ??= pathDenialReason(err)
          denied += 1
          noteHandoff(uri, candidate)
          continue
        }
        return { ok: true, uri, directory: true }
      }
      // TODO 947: for a FIFO etc., say it is not a regular file rather than "not found".
      if (isOther(candidate)) nonRegular = true
      if (tried.length < MAX_LINK_TRIED) tried.push(candidate)
    }
    return null
  }
  const primary = primaryCandidates(parsed, context)
  const found = check(primary) ?? check(shellCandidates(parsed, context, primary))
  if (found !== null) return found
  const name = linkName(href, context.home)
  // A candidate that exists but was in an excluded location is the real link target (stronger than a candidate that did not exist).
  const handed = handoff as { uri: string; directory: boolean } | null
  if (handed !== null) {
    return {
      ok: false,
      reason: formatReason('link-excluded', { name }),
      handoffUri: handed.uri,
      ...(handed.directory ? { handoffDirectory: true as const } : {})
    }
  }
  if (denial !== null && denied === checked) return { ok: false, reason: denial }
  if (nonRegular) return { ok: false, reason: 'path-not-regular' }
  return {
    ok: false,
    reason: formatReason('link-not-found', { name }),
    ...(tried.length === 0 ? {} : { tried }),
    ...(name === '' ? {} : { searchName: name })
  }
}

/** The link target's name attached to a reason (the last name of the form with the line-number tail dropped, capped at `MAX_NAME`). */
function linkName(href: unknown, home: string): string {
  const shown = parseHref(href, home)?.paths.at(-1)?.path ?? ''
  return basename(shown).slice(0, MAX_NAME)
}

/** The base for relative paths, taken from the thread (SessionManager's `linkContext`). */
export interface ThreadLinkContext {
  readonly cwd: string
  readonly memoryDirs: readonly string[]
  /** TODO 816: the places the shell `cd`-ed to (newest first). Called only for relative links (lazy because it reads saved tool calls). */
  readonly shellDirs?: () => readonly string[]
}

export interface LinkRequestDeps {
  readonly gate: LinkGate
  readonly home: string
  /** null for a thread that vanished or is unknown. */
  readonly threadContext: (threadId: string) => ThreadLinkContext | null
  readonly exists?: (path: string) => boolean
  readonly isDirectory?: (path: string) => boolean
}

const invalid = (field: string): LinkResolution => ({
  ok: false,
  reason: formatReason('invalid-value', { field })
})

/**
 * The body of the IPC `fs.resolveLink` (item 254). **Re-validates from the type** the values from the renderer (the shape of item 86:
 * if the shape is wrong, `invalid-value` and the field name). Does not throw.
 *
 * Base: if there is a `baseUri` (the open .md), its folder (passed through the gate as read); otherwise
 * the thread's cwd. Auto memory is taken from the thread's cwd (it is the second candidate even if there is a `baseUri`).
 */
export function resolveLinkRequest(input: unknown, deps: LinkRequestDeps): LinkResolution {
  if (typeof input !== 'object' || input === null) return invalid('input')
  const record = input as Record<string, unknown>
  const href = record['href']
  const threadId = record['threadId'] ?? null
  const baseUri = record['baseUri'] ?? null
  if (typeof href !== 'string' || href.length > MAX_LINK_HREF) return invalid('href')
  if (threadId !== null && typeof threadId !== 'string') return invalid('threadId')
  if (baseUri !== null && typeof baseUri !== 'string') return invalid('baseUri')

  const thread = threadId === null ? null : deps.threadContext(threadId)
  let baseDir = thread?.cwd ?? null
  if (baseUri !== null) {
    try {
      baseDir = dirname(deps.gate.assertAllowed(baseUri, false, 'read'))
    } catch (err) {
      return { ok: false, reason: pathDenialReason(err) }
    }
  }
  // The shell's `cd` places (TODO 816) are passed on lazily: `resolveLink` reads them once, only for a relative link that neither the base nor
  // auto memory resolved.
  return resolveLink(
    href,
    {
      baseDir,
      memoryDirs: thread?.memoryDirs ?? [],
      ...(thread?.shellDirs === undefined ? {} : { shellDirs: thread.shellDirs }),
      home: deps.home
    },
    deps.gate,
    deps.exists,
    deps.isDirectory
  )
}

export interface LinkSearchDeps extends LinkRequestDeps {
  /**
   * File-name search of the index (TODO 816, a thin wrapper of `IndexClient.searchFiles`). A term -> the absolute paths of the **files** that matched
   * (in rank order). Empty if there is no index, it is down, or it was cut off. It may throw (treated as empty).
   */
  readonly searchByName?: (query: string) => Promise<readonly string[]>
}

/** The segments of a path split by `/` (empty segments are dropped). */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((part) => part !== '')
}

/** The number of leading segments shared with `anchor` (cwd). */
function sharedSegments(path: string, anchor: readonly string[]): number {
  const parts = segmentsOf(foldPath(path))
  let n = 0
  while (n < parts.length && n < anchor.length && parts[n] === anchor[n]) n++
  return n
}

/**
 * Sorts candidates by closeness to the cwd (TODO 816): the more leading segments shared with the cwd the earlier, then the shallower the earlier,
 * and finally string order (so the order is the same every time).
 */
export function rankByCwd(paths: readonly string[], cwd: string | null): string[] {
  const anchor = cwd === null ? [] : segmentsOf(foldPath(cwd))
  return [...paths].sort((a, b) => {
    const shared = sharedSegments(b, anchor) - sharedSegments(a, anchor)
    if (shared !== 0) return shared
    const depth = segmentsOf(a).length - segmentsOf(b).length
    if (depth !== 0) return depth
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/**
 * The form of a relative link used to search the index (TODO 816). The sequence of segments with `./` and everything up to the last `..` dropped. null if empty.
 * (`../x/y.c` is searched as "some `x/y.c`".)
 */
export function searchSegmentsOf(path: string): readonly string[] | null {
  const parts = segmentsOf(path).filter((part) => part !== '.')
  const lastUp = parts.lastIndexOf('..')
  const rest = lastUp < 0 ? parts : parts.slice(lastUp + 1)
  return rest.length === 0 ? null : rest
}

/**
 * The body of the IPC `fs.resolveLink` (made asynchronous in TODO 816). First resolve with `resolveLinkRequest` (cwd -> auto memory -> the shell's
 * `cd` places), and **only when a relative link was `link-not-found`** search with the index's file-name search:
 *
 * 1. If there are 2 or more segments, use that sequence (`uC3/Driver/.../x.S`) as the term, and take only those whose path end matches.
 * 2. If 1 gives 0 (or there is one segment), search by the name (`x.S`) and take those whose name matches.
 * 3. Either way, re-check with the gate (`assertAllowed(…, 'read')`) and existence (the index may be stale, or the exclusion rules may have changed).
 *
 * If there is one, open it; if two or more, `link-ambiguous` and `choices` in order of closeness to the cwd. If 0, keep the first result
 * (`link-not-found` + `tried` + `searchName`). Matching is case-insensitive (the term is passed in lowercase = smart case is
 * not triggered). Does not throw.
 */
export async function resolveLinkWithSearch(input: unknown, deps: LinkSearchDeps): Promise<LinkResolution> {
  const first = resolveLinkRequest(input, deps)
  if (first.ok || deps.searchByName === undefined) return first
  if (parseReason(first.reason)?.code !== 'link-not-found') return first
  const record = input as Record<string, unknown>
  const parsed = parseHref(record['href'], deps.home)
  const target = parsed?.paths.at(-1)
  if (parsed === null || target === undefined || isAbsolute(parsed.paths[0]?.path ?? '/')) return first
  const segments = searchSegmentsOf(target.path)
  if (segments === null) return first
  const name = segments.at(-1) ?? ''
  const search = deps.searchByName
  const ask = async (query: string): Promise<readonly string[]> => {
    try {
      return await search(query.toLowerCase())
    } catch {
      return []
    }
  }

  let hits: readonly string[] = []
  if (segments.length > 1) {
    const suffix = foldPath(`/${segments.join('/')}`)
    hits = (await ask(segments.join('/'))).filter((path) => foldPath(path).endsWith(suffix))
  }
  if (hits.length === 0) {
    const folded = foldPath(name)
    hits = (await ask(name)).filter((path) => foldPath(basename(path)) === folded)
  }
  const exists = deps.exists ?? isFile
  const usable: string[] = []
  for (const path of hits) {
    if (usable.includes(path)) continue
    try {
      deps.gate.assertAllowed(pathToUri(path), false, 'read')
    } catch {
      continue
    }
    if (exists(path)) usable.push(path)
  }
  if (usable.length === 0) return first

  const threadId = typeof record['threadId'] === 'string' ? record['threadId'] : null
  const cwd = threadId === null ? null : (deps.threadContext(threadId)?.cwd ?? null)
  const ranked = rankByCwd(usable, cwd)
  const position = target.position
  const choiceOf = (path: string): LinkChoice => ({
    uri: pathToUri(path),
    ...(position === null ? {} : { line: position.line }),
    ...(position === null || position.column === null ? {} : { column: position.column })
  })
  // Only the count (no paths are written, chapter 7).
  log.info('link.search', { hits: ranked.length })
  if (ranked.length === 1) return { ok: true, ...choiceOf(ranked[0]!) }
  return {
    ok: false,
    reason: formatReason('link-ambiguous', { name: name.slice(0, MAX_NAME), count: ranked.length }),
    choices: ranked.slice(0, MAX_LINK_CHOICES).map(choiceOf)
  }
}
