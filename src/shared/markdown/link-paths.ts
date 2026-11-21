/**
 * Turns "paths / URLs that are not Markdown links" in an answer body into links (TODO 548, ARCHITECTURE.md 5.1).
 *
 * markdown-it's linkify picks up only raw `http(s)://…` URLs, so paths inside the PC (`/Users/…`, `/tmp/…`, `~/…`,
 * `file:///…`) and paths / URLs inside inline `` `code` `` could not be clicked (table for bundle D in `docs/notes/wave27.md`).
 * This is a markdown-it core rule that fills that gap, plus pure functions that look only at the shape.
 *
 * - **Decided by shape only. Existence is not checked** (no stat on every render). When clicked, main's `fs.resolveLink` checks the choke point
 *   (`FsAccess.assertAllowed`) and existence, and if missing the reason appears in the band (item 254).
 * - **Nothing inside a code block (```` ``` ````, indented) becomes a link** (owner decision 2026-10-09: it gets in the way of copying).
 *   A fence is a block token and this walks only the children of inline tokens, so it structurally cannot touch it.
 * - **Anything already inside a link (`[…](…)`, a linkify URL) is left alone.** It does not descend into an image's alt (the image's children) either.
 * - In the body (text) it picks up **absolute paths only**: those starting with a known top-level folder (`/Users`, `/tmp`, ... `ROOTS`),
 *   `~/…`, and `file:///…`. This avoids picking up slash commands like `/compact` or `GET /api/v1`. Relative paths are
 *   not picked up in the body (`and/or`, `text/plain`). Paths containing spaces cannot be picked up in the body either (the shape does not say where they end).
 * - Inline `` `code` `` becomes a link **only when the whole content is one path / URL**. Its delimiters are clear, so
 *   it also picks up absolute paths with spaces (when the last name has an extension) and relative paths that contain `/` and end with an extension (`src/a.ts:42`).
 * - A line-number tail (`:42` / `:3:1` / `#L42`) is kept in the href (item 273; main cuts it out).
 *
 * Only pure functions and markdown-it rules. It depends on neither the DOM nor Node (called from `render.ts`, shared by the renderer and plugins).
 */
import type MarkdownIt from 'markdown-it'
import type { Token } from 'markdown-it'

/** The top-level folders regarded as the start of an absolute path in the body (macOS and generic Unix). */
export const PATH_ROOTS = [
  'Users',
  'Volumes',
  'Applications',
  'Library',
  'System',
  'private',
  'tmp',
  'var',
  'etc',
  'opt',
  'usr',
  'home',
  'mnt',
  'srv',
  'bin',
  'sbin',
  'dev',
  'cores',
  'nix'
] as const

/**
 * Characters allowed in a path in the body. It cuts at whitespace, quotes, brackets, Markdown symbols, `,` `;` `:`, and full-width punctuation and brackets.
 * `:` is added only in the line-number tail (`LINE_TAIL`).
 */
const PATH_CHAR = String.raw`[^\s<>"'\x60|()\[\]{},;:、。，．：；！？「」『』（）【】〈〉《》“”‘’]`

/** The line-number tail (the form of item 273). */
const LINE_TAIL = String.raw`(?::\d+(?::\d+)?)?(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)?`

const ROOT_ALT = PATH_ROOTS.join('|')

/**
 * An absolute path / `~/` / `file:///` in the body. It does not start when the previous character is an ASCII word character or a path character
 * (it does not pick up from the middle of `km/h`, `and/or`, `a/tmp/x`). It does pick up a path right after Japanese text (for example "output is /tmp/a.png" written without a space).
 */
const PROSE_PATH = new RegExp(
  String.raw`(?<![A-Za-z0-9_.~/\\%-])(?:file:\/\/(?=\/)|~(?=\/))?\/(?:(?<=~\/)|(?<=file:\/\/\/)|(?:${ROOT_ALT})(?![A-Za-z0-9_.-]))${PATH_CHAR}*${LINE_TAIL}`,
  'g'
)

/** If non-ASCII such as Japanese follows an extension immediately, cut there (for example "a.png" followed directly by Japanese text). */
const EXT_THEN_NON_ASCII = /\.[A-Za-z][A-Za-z0-9]{0,9}(?=\P{ASCII})/u

/** Trailing sentence punctuation (English `.`, `!`, `?`) and emphasis marks are dropped. */
const TRAILING_CHARS = '.!?*_~'

/** After whitespace (other than newline / tab) comes a word that does not start with `/` or `~` and contains `/` (the middle of a path with spaces). */
const CONTINUES_WITH_SPACE = /^[^\S\r\n\t][^\s/~]\S*\//

/** One path found in the body. `start` / `end` are positions in `text`, and `href` is the value put on the `<a>`. */
export interface PathMatch {
  readonly start: number
  readonly end: number
  readonly href: string
}

/** `file:///…` / `~/…` / absolute path -> href. The path part is encoded as a URL, and the line fragment (`#L…`) is kept as is. */
export function pathHref(raw: string): string | null {
  let text = raw
  let fragment = ''
  const hash = /#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/.exec(text)
  if (hash !== null) {
    fragment = hash[0]
    text = text.slice(0, hash.index)
  }
  if (/^file:\/\//i.test(text)) {
    try {
      text = decodeURIComponent(text.slice('file://'.length))
    } catch {
      text = text.slice('file://'.length)
    }
  }
  if (text === '' || text.includes('\0')) return null
  // Main's `parseHref` cuts the fragment at `#` and runs `decodeURIComponent` on the rest, so `%`, `#` and `?` are also encoded.
  return encodeURI(text).replace(/#/g, '%23').replace(/\?/g, '%3F') + fragment
}

/** Tidies one match (cut before Japanese, drop trailing punctuation). null if it becomes empty. */
function trimMatch(text: string): string | null {
  let out = text
  const cut = EXT_THEN_NON_ASCII.exec(out)
  if (cut !== null) out = out.slice(0, cut.index + cut[0].length)
  // A regex (/[.!?*_~]+$/) is O(n^2) on long runs, so this is a loop counting from the end (TODO 862).
  let end = out.length
  while (end > 0 && TRAILING_CHARS.includes(out[end - 1]!)) end--
  out = out.slice(0, end)
  // A bare top-level folder name (`/Users`) or just `~/` is too weak as a path, so it is not picked up.
  if (/^(?:file:\/\/)?\/[^/]*$/.test(out) || /^~\/?$/.test(out) || /^file:\/\/\/?$/.test(out)) return null
  return out
}

/** Finds all paths in the body (the text token of Markdown). */
export function findPaths(text: string): PathMatch[] {
  const out: PathMatch[] = []
  if (!text.includes('/')) return out
  PROSE_PATH.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = PROSE_PATH.exec(text)) !== null) {
    const trimmed = trimMatch(match[0])
    if (trimmed === null) continue
    // If something that looks like a continuation of the path (a word containing `/`) follows the whitespace, the match was cut in the middle of a path
    // with spaces (`/Users/a/My Docs/x.md`). Linking only the head would search for something else (`My`) when clicked, so it is not linked.
    if (trimmed.length === match[0].length && CONTINUES_WITH_SPACE.test(text.slice(match.index + trimmed.length))) continue
    const href = pathHref(trimmed)
    if (href === null) continue
    out.push({ start: match.index, end: match.index + trimmed.length, href })
  }
  return out
}

/** Whether the content of inline code is a single http(s) URL. */
const CODE_URL = /^https?:\/\/[^\s<>"'\x60]+$/i

/** Inline code: an absolute path (a known top-level folder) / `~/` / `file:///`. Spaces are allowed (the extension is required below). */
const CODE_ABSOLUTE = new RegExp(String.raw`^(?:file:\/\/)?(?:~|\/(?:${ROOT_ALT}))(?:\/[^\0<>"|\x60\n]*)?$`)

/** The last name has an extension (and a line-number tail). */
const ENDS_WITH_EXT = new RegExp(String.raw`\.[A-Za-z0-9]{1,10}${LINE_TAIL}$`)

/** One name of a relative path (no whitespace, separators or shell symbols). */
const SEGMENT = String.raw`[^\s/\\<>"'\x60|:*?()\[\]{}$&;=,]+`

/** Inline code: a relative path that contains `/` and ends with an extension (starting with a letter) (`src/a.ts:42`, `./x.md`). */
const CODE_RELATIVE = new RegExp(
  String.raw`^(?:\.{1,2}\/)?(?:${SEGMENT}\/)+${SEGMENT}\.[A-Za-z][A-Za-z0-9]{0,9}${LINE_TAIL}$|^\.{1,2}\/${SEGMENT}\.[A-Za-z][A-Za-z0-9]{0,9}${LINE_TAIL}$`
)

/**
 * The content of inline code -> the href if it should become a link, null if not.
 * `normalizeUrl` is markdown-it's `normalizeLink` (URL encoding).
 */
export function inlineCodeHref(content: string, normalizeUrl: (url: string) => string = (url) => url): string | null {
  const text = content.trim()
  if (text === '' || text.length > 4096 || text.includes('\n')) return null
  if (CODE_URL.test(text)) return normalizeUrl(text)
  if (CODE_ABSOLUTE.test(text)) {
    const trimmed = trimMatch(text)
    if (trimmed === null || trimmed !== text) return null
    // If it contains spaces, only a shape that can be called a file name rather than a command (`/usr/bin/env node`) (ends with an extension, no options).
    if (/\s/.test(text) && (!ENDS_WITH_EXT.test(text) || /\s-/.test(text))) return null
    return pathHref(text)
  }
  if (CODE_RELATIVE.test(text)) return pathHref(text)
  return null
}

/** The keys of the `md.render` env that this looks at. */
interface LinkPathsEnv {
  readonly linkPaths?: boolean
}

/**
 * Adds markdown-it core rules. It works only for renders with `env.linkPaths === true` (the answers in ThreadPane)
 * (the `aios.markdown` viewer stays as before).
 */
export function linkPathsPlugin(md: InstanceType<typeof MarkdownIt>): void {
  md.core.ruler.push('aios_link_paths', (state) => {
    if ((state.env as LinkPathsEnv | undefined)?.linkPaths !== true) return
    const makeLink = (href: string, level: number): [Token, Token] => {
      const open = new state.Token('link_open', 'a', 1)
      open.attrs = [['href', href]]
      open.markup = 'aios-path'
      open.info = 'auto'
      open.level = level
      const close = new state.Token('link_close', 'a', -1)
      close.markup = 'aios-path'
      close.info = 'auto'
      close.level = level
      return [open, close]
    }
    for (const block of state.tokens) {
      if (block.type !== 'inline' || block.children === null) continue
      const children: Token[] = []
      let depth = 0
      for (const token of block.children) {
        if (token.type === 'link_open') depth += 1
        else if (token.type === 'link_close') depth -= 1
        if (depth > 0 || token.type === 'link_close') {
          children.push(token)
          continue
        }
        if (token.type === 'code_inline') {
          const href = inlineCodeHref(token.content, (url) => md.normalizeLink(url))
          if (href !== null && md.validateLink(href)) {
            const [open, close] = makeLink(href, token.level)
            token.level += 1
            children.push(open, token, close)
            continue
          }
        } else if (token.type === 'text') {
          const found = findPaths(token.content)
          if (found.length > 0) {
            let at = 0
            for (const hit of found) {
              if (hit.start > at) {
                const before = new state.Token('text', '', 0)
                before.content = token.content.slice(at, hit.start)
                before.level = token.level
                children.push(before)
              }
              const [open, close] = makeLink(hit.href, token.level)
              const label = new state.Token('text', '', 0)
              label.content = token.content.slice(hit.start, hit.end)
              label.level = token.level + 1
              children.push(open, label, close)
              at = hit.end
            }
            if (at < token.content.length) {
              const after = new state.Token('text', '', 0)
              after.content = token.content.slice(at)
              after.level = token.level
              children.push(after)
            }
            continue
          }
        }
        children.push(token)
      }
      block.children = children
    }
  })
}
