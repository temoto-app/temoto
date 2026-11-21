/**
 * A fix for `**…**` not becoming bold next to Japanese (TODO 892). A markdown-it plugin (our own, no dependencies).
 *
 * CommonMark's flanking rule does not accept a closing `**` as a closer when the character right before it is punctuation
 * (full-width closing parentheses and brackets, etc.) and the character right after it is neither whitespace nor punctuation
 * (kana, kanji). Japanese puts no spaces between words, so a bold run that ends with a full-width closing parenthesis
 * and is immediately followed by more Japanese text does not become bold.
 *
 * The fix: if either side of a run of `*` is CJK (kana, kanji, hangul, full-width symbols), it may both open and close
 * as long as the opposite side is not whitespace (`can_open` / `can_close` are only relaxed;
 * a value that was true is never made false). `_` and `~` are left alone. Code and inline code are processed
 * before the emphasis rule, so they are unaffected.
 */
import type MarkdownIt from 'markdown-it'

/** Whether the character is kana, a CJK ideograph or symbol, hangul, or a full-width form (including full-width brackets and punctuation). */
const CJK = new RegExp(
  '[\\u1100-\\u11FF\\u2E80-\\u2FFF\\u3000-\\u30FF\\u3100-\\u318F\\u31A0-\\u31FF\\u3200-\\u4DBF\\u4E00-\\u9FFF' +
    '\\uA960-\\uA97F\\uAC00-\\uD7FF\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFFEF]',
  'u'
)

const WHITESPACE = new RegExp('[\\s\\u00A0\\u3000]', 'u')

function charAt(src: string, index: number): string {
  if (index < 0 || index >= src.length) return ''
  const code = src.codePointAt(index)
  if (code === undefined) return ''
  return String.fromCodePoint(code)
}

/** Returns the one character before (a surrogate pair counts as one character). */
function charBefore(src: string, index: number): string {
  if (index <= 0) return ''
  const low = src.charCodeAt(index - 1)
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) return src.slice(index - 2, index)
  return src.slice(index - 1, index)
}

export function cjkEmphasisPlugin(md: InstanceType<typeof MarkdownIt>): void {
  // Swaps `state.scanDelims` only for the state of this parse (the StateInline class is shared by all instances, so it is not touched).
  md.inline.ruler.before('emphasis', 'aios_cjk_emphasis', (state) => {
    const marker = state.src.charCodeAt(state.pos)
    if (marker !== 0x2a) return false
    if ((state as { __aiosCjk?: boolean }).__aiosCjk !== true) {
      ;(state as { __aiosCjk?: boolean }).__aiosCjk = true
      const original = state.scanDelims.bind(state)
      state.scanDelims = (start: number, canSplitWord: boolean) => {
        const result = original(start, canSplitWord)
        if (state.src.charCodeAt(start) !== 0x2a || (result.can_open && result.can_close)) return result
        const prev = charBefore(state.src, start)
        const next = charAt(state.src, start + result.length)
        const nearCjk = CJK.test(prev) || CJK.test(next)
        if (!nearCjk) return result
        const prevSpace = prev === '' || WHITESPACE.test(prev)
        const nextSpace = next === '' || WHITESPACE.test(next)
        return {
          can_open: result.can_open || !nextSpace,
          can_close: result.can_close || !prevSpace,
          length: result.length
        }
      }
    }
    return false
  })
}
