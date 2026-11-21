/**
 * Markdown renderer. ARCHITECTURE.md 5.1 / 7.4.
 *
 * **Shared by ThreadPane (Phase 2) and the `aios.markdown` plugin. There are not two systems.**
 *
 * Moved in Phase 4 from `src/renderer/src/markdown/` to `src/shared/`.
 * This is so that `plugins/` need not import `src/renderer/` (the boundary check in the completion criteria),
 * and because this is the only place to put it that keeps 5.1's "the renderer is shared".
 * **This module has no privileges**: it takes a string and returns a string, so it is
 * unrelated to constraint 8 (plugin code does not run in main).
 * Raw HTML is not allowed (`html: false`), and the output always goes through DOMPurify.
 */
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { EXTERNAL_PROTOCOLS } from '../open-external.js'
import { hasScheme } from '../link.js'
import { highlightCode } from './highlight.js'
import { cjkEmphasisPlugin } from './cjk-emphasis.js'
import { linkPathsPlugin } from './link-paths.js'
import { linkRedminePlugin } from './link-redmine.js'
import { normalizeRedmineBase } from '../redmine-link.js'

/**
 * markdown-it's default `validateLink` rejects `file:` and `data:` together.
 * ARCHITECTURE.md 5.1 requires file paths and `@path` to become links that open in the ViewerPane,
 * so only `file:` and `thread:` are let through, while
 * `javascript:` / `vbscript:` / `data:` are still rejected.
 */
const BAD_PROTO = /^(?:javascript|vbscript|data):/i

function createMarkdownIt(highlight: boolean): InstanceType<typeof MarkdownIt> {
  const md = new MarkdownIt({
    // Do not allow embedding raw HTML (5.1). A double defense together with DOMPurify.
    // markdown-it puts the return value of `highlight` into `<pre><code>` as is,
    // but that is a separate matter from allowing raw HTML: hljs returns an already escaped string (5.1.2).
    html: false,
    linkify: true,
    breaks: false,
    highlight: highlight ? highlightCode : null
  })
  md.validateLink = (url: string): boolean => !BAD_PROTO.test(url.trim())
  // TODO 892: emphasis that ends / starts with full-width symbols does not become bold next to Japanese (flanking is relaxed next to CJK).
  cjkEmphasisPlugin(md)
  wrapCodeBlocks(md)
  markHeadingLines(md)
  // TODO 548: make absolute paths in the body and paths / URLs inside inline code into links (only for renders with `env.linkPaths`).
  linkPathsPlugin(md)
  // TODO 811: make Redmine ticket numbers (`#22955`, and numbers in a `#` / ticket column) into links (only when `env.redmineBase` is set).
  linkRedminePlugin(md)
  return md
}

/** The env of `md.render`. `headingLines` carries `RenderOptions.headingLines`. */
interface RenderEnv {
  readonly headingLines?: boolean
  /** Carries `RenderOptions.linkPaths` (TODO 548, `link-paths.ts`). */
  readonly linkPaths?: boolean
  /** The validated `RenderOptions.redmineBase` (TODO 811, `link-redmine.ts`). */
  readonly redmineBase?: string
}

/**
 * Puts the original line number (1-based) on heading elements as `data-line` (item 318, the heading list of `aios.markdown`).
 * Only with `RenderOptions.headingLines`, so ThreadPane output does not change. The line is markdown-it's `token.map[0]`
 * (for setext, the first line of the paragraph), counted the same way as `line` of `extractHeadings` in `headings.ts`. DOMPurify
 * lets `data-*` through by default (as with `data-code`).
 */
function markHeadingLines(md: InstanceType<typeof MarkdownIt>): void {
  const inner = md.renderer.rules.heading_open
  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    if ((env as RenderEnv | undefined)?.headingLines === true && token?.map !== null && token?.map !== undefined) {
      token.attrSet('data-line', String(token.map[0] + 1))
    }
    return inner === undefined ? self.renderToken(tokens, idx, options) : inner(tokens, idx, options, env, self)
  }
}

/**
 * Wraps both fences (```` ``` ````) and **indented code** (4 spaces / tab) in
 * `<div class="code-block" data-code="…">` (5.1.2, T17 / T25).
 * markdown-it's rule names differ (`fence` / `code_block`), but both
 * emit `<pre><code>` and hold the original text before highlighting in `token.content`, so they are handled the same.
 * **The button is not filled in here**: the output of `renderMarkdown` is stripped by DOMPurify because
 * its `FORBID_TAGS` includes `button`, and in any case it is safer not to
 * mix UI into the body HTML. The host side (ThreadPane via a React portal,
 * `aios.markdown` via `@pluginshared/copy.ts`) overlays a `position: absolute`
 * button on this `.code-block` (5.1.2.1).
 *
 * What goes into `data-code` is the **plain text before highlighting** (`token.content`) passed through
 * `encodeURIComponent`. Copying takes it from this attribute and does not
 * reconstruct it from the highlighted HTML (stripping `<span>` and undoing entities by hand always goes wrong).
 *
 * **It must not be put in raw**: DOMPurify **trims leading and trailing whitespace of attribute values**
 * (measured; the T17 fact in the repository guide), so code whose first line is indented and trailing
 * newlines would be silently lost. The output of `encodeURIComponent` contains neither whitespace nor `&` / `<` / `>` / `"`,
 * so it is not trimmed and needs no HTML escaping. Reading goes through
 * `decodeCodeBlock`.
 */
function wrapCodeBlocks(md: InstanceType<typeof MarkdownIt>): void {
  for (const rule of ['fence', 'code_block'] as const) {
    const inner = md.renderer.rules[rule]
    md.renderer.rules[rule] = (tokens, idx, options, env, self) => {
      const rendered =
        inner === undefined
          ? self.renderToken(tokens, idx, options)
          : inner(tokens, idx, options, env, self)
      const code = encodeURIComponent(tokens[idx]?.content ?? '')
      return `<div class="code-block" data-code="${code}">${rendered}</div>\n`
    }
  }
}

/** Turns the `data-code` of `.code-block` back into the original code (5.1.2). An empty string if it is broken. */
export function decodeCodeBlock(value: string | undefined): string {
  if (value === undefined) return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return ''
  }
}

/**
 * Two instances, with and without highlighting. Rather than switching with `md.set` on every render,
 * both are held from the start. Highlighting stays on while streaming (`Streaming`) too: in the 5.1.2 measurement,
 * re-rendering on every delta was p90 1 ms for a 240-line block and 3.4 ms even for 720 lines,
 * below the target (5 ms). If it turns out to be heavy, passing `highlight: false`
 * on the `Streaming` side is enough to turn it off.
 */
const renderers = {
  plain: createMarkdownIt(false),
  highlighted: createMarkdownIt(true)
} as const

/**
 * Schemes allowed in `href`. `file:` and `thread:` are interpreted on the ViewerPane side, and only
 * `EXTERNAL_PROTOCOLS` (`http:` / `https:` / `mailto:`) is handed to the external browser;
 * this table and main's re-validation look at the same constant (5.1 "external links").
 */
const SAFE_PROTOCOLS = [...EXTERNAL_PROTOCOLS, 'file:', 'thread:']

/**
 * DOMPurify's default URI allow rule has neither `file:` nor `thread:`, so it is widened.
 * What was widened is checked again in the `afterSanitizeAttributes` hook above.
 */
const ALLOWED_URI_REGEXP =
  /^(?:(?:https?|mailto|file|thread):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$)|[^:/?#]+:\d+(?::\d+)?(?:#.*)?$)/i

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (!(node instanceof HTMLAnchorElement)) return
  const href = node.getAttribute('href')
  if (href === null) return
  let protocol: string | null = null
  const trimmed = href.trim()
  if (BAD_PROTO.test(trimmed)) {
    node.removeAttribute('href')
  } else if (!hasScheme(trimmed)) {
    // Relative (`memory/x.md`, `src/a.ts:42`) and the `name.extension:line` form (`README.md:42`, item 280-1).
    // `new URL('note.txt:2', 'file:///')` reads `note.txt:` as a scheme, so it is not let through; it is kept as "no scheme"
    // by the same decision as `linkAction` / `hasScheme` on the click side (main's `fs.resolveLink` does the opening).
  } else {
    try {
      const url = new URL(href, 'file:///')
      if (SAFE_PROTOCOLS.includes(url.protocol)) protocol = url.protocol
      else node.removeAttribute('href')
    } catch {
      node.removeAttribute('href')
    }
  }
  // An external link is handed to main by the host on click, and main re-validates it and passes it to the OS browser
  // (5.1 "external links"). `rel` is insurance in case `target` is added; DOMPurify's default
  // allowed attributes include `rel` / `title` (test/markdown.test.ts checks this).
  node.setAttribute('rel', 'noopener noreferrer')
  // It is an outward action, so the href is shown in `title` so the destination is visible before clicking.
  // The Markdown title (`[x](url "title")`) is overwritten: if the author could decide both the displayed text and the title,
  // the destination could be disguised.
  if (protocol !== null && EXTERNAL_PROTOCOLS.includes(protocol)) {
    node.setAttribute('title', href)
  }
})

export interface RenderedMarkdown {
  readonly html: string
}

export interface RenderOptions {
  /**
   * Whether to syntax-highlight code blocks (default true, 5.1.2).
   * If false, markdown-it only escapes the contents of fences.
   */
  readonly highlight?: boolean
  /**
   * Whether to put the original line number on heading elements as `data-line` (default false, item 318). Used by the `aios.markdown`
   * heading list to jump to the heading in the body.
   */
  readonly headingLines?: boolean
  /**
   * Whether to also link absolute paths that are not Markdown links (`/Users/…`, `~/…`, `file:///…`) and paths / URLs inside inline `` `code` ``
   * (default false, TODO 548). Only ThreadPane answers turn it on. Inside code blocks is out of scope.
   */
  readonly linkPaths?: boolean
  /**
   * The Redmine base URL (setting `web.redmineBaseUrl`, TODO 811). Only when it is a usable https value, `#22955` in the body and the numbers in a table's
   * `#` / ticket column become `<base>/issues/<n>` links. Nothing happens if it is unset or unusable.
   */
  readonly redmineBase?: string | null
}

export function renderMarkdown(source: string, options: RenderOptions = {}): RenderedMarkdown {
  const md = options.highlight === false ? renderers.plain : renderers.highlighted
  const redmineBase = normalizeRedmineBase(options.redmineBase)
  const env: RenderEnv = {
    headingLines: options.headingLines === true,
    linkPaths: options.linkPaths === true,
    ...(redmineBase === null ? {} : { redmineBase })
  }
  const raw = md.render(source, { ...env })
  const html = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP,
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style', 'srcset']
  })
  return { html }
}

/**
 * For rendering while streaming (5.1). Closes an unfinished code fence at the end before rendering.
 * ThreadPane of Phase 2 uses this. The same function is passed through in Phase 1 as well.
 */
export function closeOpenFences(source: string): string {
  const fences = source.match(/^```/gm)
  if (fences !== null && fences.length % 2 === 1) return `${source}\n\`\`\``
  return source
}
