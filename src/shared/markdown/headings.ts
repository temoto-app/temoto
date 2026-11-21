/**
 * Extracting Markdown headings (`aios.markdown` in ARCHITECTURE.md 7.4, item 318).
 *
 * Used by the heading list of `aios.markdown`. The plugin-host's `outline` command (the body re-read through the Broker) and the
 * viewer's draft headings (after editing in Source) **both go through this same function**, so the same body gives the same list.
 *
 * **The rules follow the rendering (markdown-it in `render.ts`, `html: false`)**: it picks up ATX (`## Title`) and setext (`===` / `---` underlines),
 * and does not look inside code fences or indented code blocks. `line` is a 1-based line number, and for setext it is **the first line of the paragraph**
 * (the same as markdown-it's `token.map[0]`). On the rendering side, `renderMarkdown(src, { headingLines: true })` puts
 * `data-line` on the heading elements, so the list and the body correspond **by line number** (not relying on the i-th matching the i-th, so a miss does not shift them).
 *
 * markdown-it itself is not used: the plugin-host bundle (vite's ssr build) leaves node_modules external, so this
 * has to be a pure function with no dependencies. It is not full CommonMark, but an approximation: ATX inside quotes (`>`) and lists is picked up,
 * and a `---` after a list or quote line is not regarded as an underline (as in markdown-it).
 * `test/markdown-outline.test.ts` checks the match with the rendering against markdown-it's output.
 *
 * It has no dependencies (readable from the plugin-host, the viewer and tests alike).
 */

export interface Heading {
  readonly level: number
  readonly text: string
  /** 1-based line number (for setext, the first line of the paragraph). */
  readonly line: number
}

/** Upper limit of extraction (the display shows at most 50 more - on the viewer side). */
export const MAX_HEADINGS = 200

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const THEMATIC = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const LIST_MARKER = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/
const INDENTED_CODE = /^(?: {4}|\t)/

/** Strips inline markup inside a heading to make the text shown in the list. */
export function headingText(raw: string): string {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1$2')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .trim()
}

/** Strips the quote markers (`>`) and returns the depth and the rest. */
function stripQuotes(line: string): { readonly depth: number; readonly rest: string } {
  let depth = 0
  let rest = line
  for (;;) {
    const match = /^ {0,3}> ?/.exec(rest)
    if (match === null) return { depth, rest }
    depth += 1
    rest = rest.slice(match[0].length)
  }
}

/** For an ATX line, `{ level, text }`; otherwise null. Drops the closing `#` (only when preceded by whitespace). */
function atx(line: string): { readonly level: number; readonly text: string } | null {
  const match = ATX.exec(line)
  if (match === null) return null
  const body = (match[2] ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '')
  return { level: match[1]?.length ?? 1, text: headingText(body) }
}

export function extractHeadings(markdown: string): readonly Heading[] {
  const out: Heading[] = []
  const lines = markdown.split(/\r?\n/)
  /** The current fence (the marker until it closes). */
  let fence: { readonly char: string; readonly length: number } | null = null
  /**
   * The block so far. `para` is a paragraph that can take a setext underline (depth and first line), `container` is the continuation of a paragraph
   * inside a list or quote (cannot become an underline), `none` is after a blank line, etc.
   */
  let block: { kind: 'none' } | { kind: 'container' } | { kind: 'para'; depth: number; start: number; text: string[] } = {
    kind: 'none'
  }

  for (let index = 0; index < lines.length; index += 1) {
    const { depth, rest } = stripQuotes(lines[index] ?? '')

    if (fence !== null) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(rest)
      if (close !== null && close[1]?.[0] === fence.char && (close[1]?.length ?? 0) >= fence.length) fence = null
      continue
    }
    if (rest.trim() === '') {
      block = { kind: 'none' }
      continue
    }
    const open = FENCE_OPEN.exec(rest)
    // The info string of a "```" fence cannot contain ` (CommonMark).
    if (open !== null && !(open[1]?.[0] === '`' && (open[2] ?? '').includes('`'))) {
      fence = { char: open[1]?.[0] ?? '`', length: open[1]?.length ?? 3 }
      block = { kind: 'none' }
      continue
    }
    // An indented code block cannot interrupt a paragraph (inside a paragraph it is a continuation line).
    if (block.kind === 'none' && INDENTED_CODE.test(rest)) continue

    const heading = atx(rest)
    if (heading !== null) {
      out.push({ ...heading, line: index + 1 })
      block = { kind: 'none' }
      if (out.length >= MAX_HEADINGS) break
      continue
    }
    const underline = SETEXT.exec(rest)
    if (underline !== null && block.kind === 'para' && block.depth === depth) {
      out.push({
        level: underline[1]?.[0] === '=' ? 1 : 2,
        text: headingText(block.text.join(' ')),
        line: block.start + 1
      })
      block = { kind: 'none' }
      if (out.length >= MAX_HEADINGS) break
      continue
    }
    if (THEMATIC.test(rest)) {
      block = { kind: 'none' }
      continue
    }
    const item = LIST_MARKER.exec(rest)
    if (item !== null) {
      // `- # Title` is a heading inside a list.
      const inner = atx(rest.slice(item[0].length))
      if (inner !== null) {
        out.push({ ...inner, line: index + 1 })
        block = { kind: 'none' }
        if (out.length >= MAX_HEADINGS) break
        continue
      }
      block = { kind: 'container' }
      continue
    }
    if (block.kind === 'para') {
      // A line with a shallower depth is a lazy continuation (the paragraph stays at the previous depth).
      block.text.push(rest.trim())
      continue
    }
    if (block.kind === 'container') continue
    block = { kind: 'para', depth, start: index, text: [rest.trim()] }
  }
  return out
}
