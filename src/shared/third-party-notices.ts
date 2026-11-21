/**
 * A pure function that splits `THIRD_PARTY_NOTICES.md` (directly under the repository) by heading (TODO 438).
 *
 * The source of truth is that one file - the settings About's "third-party material licenses" is not duplicated here;
 * the Markdown embedded at build time is split with this function and assembled (`src/renderer/src/third-party-notices.ts`).
 * It only reads the convention of `THIRD_PARTY_NOTICES.md` itself, "one heading (`## `) = one library", so
 * it depends on neither electron nor the renderer's DOM (tests can call it as is in a node environment).
 */
import type { Locale } from './locale.js'

/** One heading's worth. `license` is taken from the Japanese license / permission line (the one starting with a `- ` bullet) in the body, and if there is none, the first line of `text`. */
export interface ThirdPartyNotice {
  /** The line right after `## ` (e.g. `pdf.js (pdfjs-dist 6.4.299)` followed by a dash and a Japanese note on what it is used for: PDF display). */
  readonly heading: string
  /**
   * The English version of the heading (TODO 622). Taken from the description line `- English:`. If absent, the same as `heading`
   * (a heading that never contained Japanese needs no translation). Used by `localizedHeading` only for EN display.
   */
  readonly headingEn: string
  /** The license name (e.g. `MIT`). */
  readonly license: string
  /** The description lines starting with `- ` right under the heading (the source, where it is used, etc.). */
  readonly meta: readonly string[]
  /** The contents of the first fenced code block (the full license text). Empty string if none. */
  readonly text: string
  /**
   * Ids of the extensions that bundle this library in their bundle (TODO 459). The `` `aios.xxx` `` entries inside the description line
   * for "extensions that use it" (the Japanese label) lined up. Empty if there is no such line or it says "none (…)" (only the main app uses it).
   */
  readonly extensions: readonly string[]
}

const LICENSE_LINE = /^-\s*(?:ライセンス|許諾)\s*[:：]\s*(.+?)\s*$/
const EXTENSIONS_LINE = /^-\s*使う拡張\s*[:：]\s*(.*)$/
const EXTENSION_ID = /`([a-z0-9][a-z0-9._-]*)`/gi
const HEADING_EN_LINE = /^-\s*English\s*[:：]\s*(.+?)\s*$/

function extensionsOf(meta: readonly string[]): string[] {
  for (const line of meta) {
    const match = EXTENSIONS_LINE.exec(line)
    if (match) return [...(match[1] ?? '').matchAll(EXTENSION_ID)].map((m) => m[1] ?? '').filter((id) => id !== '')
  }
  return []
}

function extractCodeBlock(lines: readonly string[]): string {
  const start = lines.findIndex((line) => line.trim().startsWith('```'))
  if (start === -1) return ''
  const end = lines.findIndex((line, i) => i > start && line.trim().startsWith('```'))
  if (end === -1) return ''
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim()
}

/**
 * Collects the description lines (TODO 455-1). Looks only before the full-text code block (so `- ` bullets inside the full text are not picked up),
 * and joins an indented continuation line to the preceding `- ` line (pdf.js's license line spans 4 lines).
 */
function collectMeta(lines: readonly string[]): string[] {
  const fence = lines.findIndex((line) => line.trim().startsWith('```'))
  const head = fence === -1 ? lines : lines.slice(0, fence)
  const meta: string[] = []
  for (const line of head) {
    const trimmed = line.trim()
    if (trimmed.startsWith('- ')) meta.push(trimmed)
    else if (trimmed !== '' && /^\s/.test(line) && meta.length > 0) {
      const prev = meta[meta.length - 1] ?? ''
      // Wrapped Japanese text is joined tightly; wrapped Latin text is joined with a single space
      const sep = /[\x21-\x7e]$/.test(prev) && /^[\x21-\x7e]/.test(trimmed) ? ' ' : ''
      meta[meta.length - 1] = `${prev}${sep}${trimmed}`
    }
  }
  return meta
}

function finishEntry(heading: string, lines: readonly string[]): ThirdPartyNotice {
  const text = extractCodeBlock(lines)
  const collected = collectMeta(lines)
  // `- English:` is the English translation of the heading, so it is not shown in the ordinary description bullets (TODO 622)
  let headingEn = heading
  const meta: string[] = []
  for (const line of collected) {
    const match = HEADING_EN_LINE.exec(line)
    if (match) headingEn = match[1] ?? heading
    else meta.push(line)
  }
  let license = ''
  for (const line of meta) {
    const match = LICENSE_LINE.exec(line)
    if (match) {
      // The collapsed heading shows only the name - a supplement after the Japanese full stop (such as the license of a bundled glyph shape) stays in the description lines (455-1)
      license = (match[1] ?? '').split('。', 1)[0]?.trim() ?? ''
      break
    }
  }
  if (license === '') license = text.split('\n', 1)[0] ?? ''
  return { heading, headingEn, license, meta, text, extensions: extensionsOf(meta) }
}

/**
 * A small tokenizer for drawing the Markdown symbols inside headings and description lines (TODO 453, observation of 455).
 * Neither About nor the extension details (TODO 459) **inserts the body as HTML** (they build it with React elements), so
 * this only returns "where is code / bold / a link". It handles just the 3 that `THIRD_PARTY_NOTICES.md` uses:
 * `` `code` ``, bold with double asterisks, and a Markdown link of the form text-in-brackets followed by a URL in parentheses. A symbol that is not closed is left as plain text.
 */
export type InlineSpan =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string }

const INLINE_TOKEN = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g

export function parseInlineMarkdown(source: string): readonly InlineSpan[] {
  const spans: InlineSpan[] = []
  let last = 0
  const pushText = (text: string): void => {
    if (text === '') return
    const prev = spans[spans.length - 1]
    if (prev?.kind === 'text') spans[spans.length - 1] = { kind: 'text', text: prev.text + text }
    else spans.push({ kind: 'text', text })
  }
  for (const match of source.matchAll(INLINE_TOKEN)) {
    const index = match.index ?? 0
    pushText(source.slice(last, index))
    if (match[1] !== undefined) spans.push({ kind: 'code', text: match[1] })
    else if (match[2] !== undefined) spans.push({ kind: 'strong', text: match[2] })
    else spans.push({ kind: 'link', text: match[3] ?? '', href: match[4] ?? '' })
    last = index + match[0].length
  }
  pushText(source.slice(last))
  return spans
}

/** Drops the leading `- ` of a description line (About and the extension details draw the bullet symbol with their own row). */
export function metaBody(line: string): string {
  return line.replace(/^-\s+/, '')
}

/** The heading matched to the display language (TODO 622). `headingEn` for `en`, `heading` (Japanese) otherwise. */
export function localizedHeading(notice: ThirdPartyNotice, locale: Locale): string {
  return locale === 'en' ? notice.headingEn : notice.heading
}

/** Only the libraries that extension bundles (TODO 459, the field to the right of "Overview" in the extension details). The order is the file's order. */
export function noticesForExtension(
  notices: readonly ThirdPartyNotice[],
  pluginId: string
): readonly ThirdPartyNotice[] {
  return notices.filter((notice) => notice.extensions.includes(pluginId))
}

/** Splits by `## <heading>`. Line breaks are normalized to `\n` (so the result is the same even if saved with CRLF). */
export function parseThirdPartyNotices(markdown: string): readonly ThirdPartyNotice[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const notices: ThirdPartyNotice[] = []
  let heading: string | null = null
  let body: string[] = []
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (match) {
      if (heading !== null) notices.push(finishEntry(heading, body))
      heading = match[1] ?? ''
      body = []
      continue
    }
    if (heading !== null) body.push(line)
  }
  if (heading !== null) notices.push(finishEntry(heading, body))
  return notices
}
