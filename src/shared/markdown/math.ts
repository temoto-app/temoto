/**
 * Math (LaTeX) in Markdown (TODO 1342, ARCHITECTURE 5.1.10). Only for renders with `env.math` (ThreadPane answers and the conversation export);
 * everything else (the Markdown viewer plugin, plans) leaves `$` and `\(` as plain text.
 *
 * Four delimiters are accepted: `$…$` and `\(…\)` (inline), `$$…$$` and `\[…\]` (block).
 *
 * **Safety.** The text is untrusted (model output). Two layers:
 * 1. KaTeX runs with `trust: false` and `throwOnError: true`, finite `maxExpand` / `maxSize`, and a hard length cap. Anything that throws
 *    (bad LaTeX, `\href`, `\url`, `\includegraphics`, `\htmlClass`, …) is shown as the original characters, never as KaTeX's red error.
 * 2. KaTeX's output needs `style` attributes and MathML, which the answer sanitizer (`render.ts`) forbids on purpose. So the markdown rules
 *    emit an empty **slot** element; the answer is sanitized with the slot in it; then the slots are replaced by KaTeX output that went through
 *    its **own** DOMPurify pass (`sanitizeMath`). The answer sanitizer's allow list is never widened, and text written by the model
 *    (raw HTML is off, so it cannot produce a slot element) never reaches the second pass's wider allow list.
 *
 * Unterminated input (`$$` still open while streaming, `\[` alone, `$x` cut off) matches no rule, so it stays as the original characters
 * until the closing delimiter arrives.
 */
import katex from 'katex'
import DOMPurify from 'dompurify'
import type MarkdownIt from 'markdown-it'

type StateBlock = Parameters<Parameters<InstanceType<typeof MarkdownIt>['block']['ruler']['push']>[1]>[0]
type StateInline = Parameters<Parameters<InstanceType<typeof MarkdownIt>['inline']['ruler']['push']>[1]>[0]

/** The longest LaTeX source (characters) drawn. Longer stays as plain text, so one huge input cannot freeze the renderer. */
export const MAX_MATH_LENGTH = 10_000
/** Memo of source -> KaTeX HTML (streaming re-renders the whole answer on every delta). */
const CACHE_LIMIT = 500

/** Not a valid CSS color, so it cannot come from `\color{…}` in a source; it only marks KaTeX's error rendering. */
const ERROR_COLOR = 'aiosKatexError'

const cache = new Map<string, string | null>()

/** Attribute name of the slot element. Not producible by the model (raw HTML is off, `<` is escaped). */
const SLOT_ATTR = 'data-math-slot'
const SLOT_RE = /<(span|div) data-math-slot="(\d+)"><\/\1>/g

/** `env` slice that this module reads and writes. */
export interface MathEnv {
  math?: boolean
  /** KaTeX HTML per slot, in the order the rules ran. */
  mathSlots?: string[]
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** KaTeX output re-sanitized for the one place it is allowed to use `style` / SVG / MathML. */
function sanitizeMath(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    // KaTeX positions everything with inline `style`. Only here, only on its own subtree.
    ADD_TAGS: ['semantics', 'annotation'],
    ADD_ATTR: ['style', 'encoding'],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'a', 'img', 'foreignObject'],
    FORBID_ATTR: ['href', 'xlink:href', 'src', 'srcset']
  })
}

/** Renders one source to KaTeX HTML, or null when it cannot be drawn (the caller shows the original characters). */
export function renderTex(tex: string, display: boolean): string | null {
  if (tex.length === 0 || tex.length > MAX_MATH_LENGTH) return null
  const key = `${display ? 'D' : 'I'}${tex}`
  const hit = cache.get(key)
  if (hit !== undefined) {
    // Refresh the position (Map keeps insertion order).
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  let out: string | null
  try {
    const rendered = katex.renderToString(tex, {
        displayMode: display,
        throwOnError: true,
        trust: false,
        strict: 'ignore',
        output: 'htmlAndMathml',
        maxExpand: 500,
        maxSize: 50,
        errorColor: ERROR_COLOR
      })
    // KaTeX draws unsupported commands (`\href` with trust off, `\url`, `\htmlClass`, …) in the error color instead of throwing,
    // even with `throwOnError`. The sentinel color tells us, and the source then stays as the original characters.
    out = rendered.includes(ERROR_COLOR) ? null : sanitizeMath(rendered)
    if (out === '') out = null
  } catch {
    out = null
  }
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done !== true) cache.delete(oldest.value)
  }
  cache.set(key, out)
  return out
}

function slotFor(env: MathEnv, tex: string, display: boolean, raw: string, tag: 'span' | 'div'): string {
  const html = renderTex(tex, display)
  if (html === null) {
    return tag === 'div'
      ? `<div class="math-raw">${escapeHtml(raw)}</div>\n`
      : `<span class="math-raw">${escapeHtml(raw)}</span>`
  }
  const slots = (env.mathSlots ??= [])
  slots.push(html)
  const slot = `<${tag} ${SLOT_ATTR}="${slots.length - 1}"></${tag}>`
  return tag === 'div' ? `${slot}\n` : slot
}

/** Replaces the slots left in the sanitized answer HTML with the KaTeX output. */
export function fillMathSlots(html: string, env: MathEnv): string {
  const slots = env.mathSlots
  if (slots === undefined || slots.length === 0) return html
  return html.replace(SLOT_RE, (whole, _tag: string, n: string) => slots[Number(n)] ?? whole)
}

const DOLLAR = 0x24
const BACKSLASH = 0x5c
const BACKTICK = 0x60

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x3000
}
function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39
}
function isAsciiAlnum(code: number): boolean {
  return isDigit(code) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
}

/**
 * Finds the end of an inline `$…$` / `$$…$$` that opens at `start`. Returns the index of the closing delimiter, or -1.
 * The currency guards (`$5 and $10`, `$5-$10`, `US$100`, `$20, $30`): the char after the opener is not a space, the char before the closer
 * is not a space, the char after the closer is not a digit / ASCII letter / `_` / `{` / `(`, and the first unescaped `$` after the opener must be that closer.
 */
function findDollarClose(src: string, start: number, width: 1 | 2, max: number): number {
  const first = start + width
  if (first >= max) return -1
  if (isSpace(src.charCodeAt(first))) return -1
  for (let i = first; i < max && i - first <= MAX_MATH_LENGTH; i++) {
    const c = src.charCodeAt(i)
    if (c === BACKSLASH) {
      i++
      continue
    }
    if (c === BACKTICK) return -1
    if (c !== DOLLAR) continue
    if (width === 2) {
      if (src.charCodeAt(i + 1) !== DOLLAR) return -1
      return i > first ? i : -1
    }
    if (i === first || isSpace(src.charCodeAt(i - 1))) return -1
    // A closer glued to a following letter, `_`, `{` or `(` is the next variable of `$HOME/bin:$PATH` / `$a+$b` / `${A}:${B}`, not a closer.
    const after = src.charCodeAt(i + 1)
    if (isDigit(after) || isAsciiAlnum(after) || after === 0x5f || after === 0x7b || after === 0x28) return -1
    return i
  }
  return -1
}

function inlineRule(state: StateInline, silent: boolean): boolean {
  if ((state.env as MathEnv).math !== true) return false
  const src = state.src
  const pos = state.pos
  const max = state.posMax
  const code = src.charCodeAt(pos)
  let open: number
  let close: number
  let display = false
  if (code === DOLLAR) {
    // `US$100`, `a$x$`: a `$` glued to a preceding ASCII letter or digit is a price / unit, not an opener.
    if (pos > 0 && isAsciiAlnum(src.charCodeAt(pos - 1))) return false
    const width = src.charCodeAt(pos + 1) === DOLLAR ? 2 : 1
    close = findDollarClose(src, pos, width, max)
    if (close < 0) return false
    open = pos + width
    display = width === 2
  } else if (code === BACKSLASH && src.charCodeAt(pos + 1) === 0x28) {
    // `\(`: must be ahead of markdown-it's escape rule, which would eat the backslash.
    open = pos + 2
    close = -1
    for (let i = open; i < max && i - open <= MAX_MATH_LENGTH; i++) {
      const c = src.charCodeAt(i)
      if (c === BACKSLASH) {
        if (src.charCodeAt(i + 1) === 0x29) {
          close = i
          break
        }
        i++
      } else if (c === BACKTICK) {
        break
      }
    }
    if (close < 0) return false
  } else {
    return false
  }
  const tex = src.slice(open, close)
  if (tex.trim() === '' || tex.length > MAX_MATH_LENGTH) return false
  const end = code === DOLLAR ? close + (display ? 2 : 1) : close + 2
  if (!silent) {
    const token = state.push('math_inline', '', 0)
    token.content = tex
    token.markup = src.slice(pos, end)
    token.meta = { display }
  }
  state.pos = end
  return true
}

function blockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if ((state.env as MathEnv).math !== true) return false
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false
  let pos = state.bMarks[startLine]! + state.tShift[startLine]!
  const lineMax = state.eMarks[startLine]!
  const src = state.src
  let closer: string
  if (src.startsWith('$$', pos)) closer = '$$'
  else if (src.startsWith('\\[', pos)) closer = '\\]'
  else return false
  pos += 2
  let content = ''
  let next = startLine
  let found = false
  // Same line: `$$ x $$` (the closer must end the line). A closer earlier in the line followed by more text (`$$a$$ is …`) is not a
  // block: the inline rule takes it, and an opener line with no closer at all is scanned only to the next blank line.
  const first = src.slice(pos, lineMax)
  const same = first.trimEnd()
  if (same.length > closer.length && same.endsWith(closer)) {
    content = same.slice(0, same.length - closer.length)
    found = true
  } else if (first.includes(closer)) {
    return false
  } else {
    content = first
    for (next = startLine + 1; next < endLine; next++) {
      // A line below the container's indent ends it (lazy lines do not continue a math block); so does a blank line (the block is
      // one paragraph's worth, so a still-open `$$` while streaming never swallows the paragraphs after it).
      if (state.sCount[next]! < state.blkIndent) break
      const lineStart = state.bMarks[next]! + state.tShift[next]!
      if (lineStart >= state.eMarks[next]!) break
      const line = src.slice(lineStart, state.eMarks[next]!)
      const trimmed = line.trimEnd()
      if (trimmed.endsWith(closer)) {
        content += `\n${trimmed.slice(0, trimmed.length - closer.length)}`
        found = true
        break
      }
      content += `\n${line}`
      if (content.length > MAX_MATH_LENGTH) return false
    }
  }
  if (!found || content.trim() === '' || content.length > MAX_MATH_LENGTH) return false
  if (silent) return true
  state.line = next + 1
  const token = state.push('math_block', '', 0)
  token.content = content.trim()
  token.markup = closer === '$$' ? '$$' : '\\['
  token.map = [startLine, state.line]
  token.block = true
  return true
}

export function mathPlugin(md: InstanceType<typeof MarkdownIt>): void {
  // Ahead of `escape` (so `\(` is seen before the backslash is eaten as an escape) and ahead of `fence` / paragraph interruption.
  md.inline.ruler.before('escape', 'math_inline', inlineRule)
  md.block.ruler.before('fence', 'math_block', blockRule, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
  md.renderer.rules['math_inline'] = (tokens, idx, _options, env) => {
    const token = tokens[idx]!
    const display = (token.meta as { display: boolean }).display
    return slotFor(env as MathEnv, token.content, display, token.markup, 'span')
  }
  md.renderer.rules['math_block'] = (tokens, idx, _options, env) => {
    const token = tokens[idx]!
    const closer = token.markup === '$$' ? '$$' : '\\]'
    return slotFor(env as MathEnv, token.content, true, `${token.markup}${token.content}${closer}`, 'div')
  }
}
