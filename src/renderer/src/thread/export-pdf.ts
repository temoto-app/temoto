/**
 * The pure function that builds the HTML for saving a conversation as a PDF / single-file HTML (TODO 818 / 866, ARCHITECTURE.md 5.1.8).
 *
 * - The body comes from main's `threads.exportTurns` (all items, already redacted). Answers use the same
 *   `renderMarkdown` as ThreadPane (markdown-it + DOMPurify, no second pipeline); the user's own messages are,
 *   like `UserMessage`, plain text exactly as typed (escaped, with `pre-wrap`).
 * - No colors are written (7.4.1). The app's `styles.css` is embedded as is and `<html data-theme>` is not set,
 *   so it is drawn with the light values (`:root`). Only the layout on paper (height, overflow, page breaks) is added here.
 * - No JS runs inside (main's window has JS disabled). The CSP also blocks external loads (main also blocks every request).
 * - HTML export (TODO 866): the same document, with a CSP that allows only `img-src data:`, plus a screen-reading layout (centered width).
 *   No `<script>` is included. `<img src>` in the body is left alone here; main reads it and embeds it as `data:`
 *   (unreadable ones become "image omitted", `main/export/embed-images.ts`). Fixed to light (owner decision 2026-10-18).
 */
import { renderMarkdown } from '@shared/markdown/render.js'
import type { HtmlExportFormat, ExportTurn } from '@shared/conversation-export.js'
import { inlineMermaidDiagrams, mermaidSources } from './mermaid-blocks.js'

export interface ExportDocumentInput {
  /** The display title (a provisional title is already replaced by the dictionary's "untitled"). */
  readonly title: string
  /** The one line under the heading (working folder name and save time). */
  readonly meta: string
  readonly turns: readonly ExportTurn[]
  /** `<html lang>`. */
  readonly lang: string
  /** The contents of the app's `styles.css`. */
  readonly appCss: string
  /** Defaults to `pdf` (for printing). `html` is a single-file HTML (TODO 866). */
  readonly format?: HtmlExportFormat
  /** Converts the attachment mark of the user's own messages (the Japanese word for "attachment" plus the name, in parentheses) into the display language (same as ThreadPane). */
  readonly relabel?: (text: string) => string
  /**
   * Drawn mermaid diagrams (source -> SVG, TODO 880). If present, replaces the ```mermaid code blocks with the diagram (inline SVG, no `<script>`).
   * Ones that are missing or could not be drawn stay as code blocks. The renderer draws them (the sources are gathered with `collectMermaidSources`).
   */
  readonly diagrams?: ReadonlyMap<string, string>
  /**
   * KaTeX's stylesheet with its fonts as `data:` URLs (TODO 1342). Present only when an answer has math (`collectHasMath`); it adds `font-src data:` to the CSP.
   */
  readonly mathCss?: string
}

/** Cache of answer -> HTML (so `collectMermaidSources` and `turnHtml` do not render the same answer twice). Emptied for each export. */
const answerHtmlCache = new Map<string, string>()

function answerHtml(answer: string): string {
  let html = answerHtmlCache.get(answer)
  if (html === undefined) {
    html = renderMarkdown(answer, { math: true }).html
    answerHtmlCache.set(answer, html)
  }
  return html
}

/** The mermaid sources in the answers to export (no duplicates). Preparation before drawing. */
export function collectMermaidSources(turns: readonly ExportTurn[]): string[] {
  const found = new Set<string>()
  for (const turn of turns) {
    for (const answer of turn.answers) {
      if (!answer.includes('mermaid')) continue
      for (const code of mermaidSources(answerHtml(answer))) found.add(code)
    }
  }
  return [...found]
}

/** Whether any answer to export has drawn math. Preparation before loading the math stylesheet. */
export function collectHasMath(turns: readonly ExportTurn[]): boolean {
  return turns.some((turn) => turn.answers.some((answer) => answerHtml(answer).includes('class="katex"')))
}

/** Only the layout on paper. Colors use the variables of `styles.css`. */
const PRINT_CSS = `
html, body { height: auto; overflow: visible; }
body.export-pdf { font-size: 12px; }
.export-head { padding: 0 16px 10px; margin-bottom: 8px; border-bottom: 1px solid var(--line); }
.export-head h1 { font-size: 18px; line-height: 1.3; margin: 0 0 4px; overflow-wrap: anywhere; }
.export-meta { color: var(--fg-dim); font-size: 11px; }
.export-turn { padding: 8px 0; }
.export-turn + .export-turn { border-top: 1px solid var(--line); }
.export-turn .message { padding: 4px 16px; }
.export-turn .message.user { break-inside: avoid; }
.export-turn .message .markdown pre { white-space: pre-wrap; overflow-wrap: anywhere; overflow: visible; }
.export-turn .message .markdown img { max-width: 100%; }
.export-attachments { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.export-attachments img { max-width: 100%; max-height: 9cm; object-fit: contain; border: 1px solid var(--line); border-radius: 4px; break-inside: avoid; }
`

/** The on-screen layout of the HTML read in a browser (TODO 866). Colors are variables only (7.4.1). */
const SCREEN_CSS = `
body.export-html { max-width: 920px; margin: 0 auto; padding: 24px 0 48px; font-size: 14px; }
body.export-html .export-head h1 { font-size: 22px; }
.export-image-omitted { color: var(--fg-dim); font-style: italic; }
`

/** The CSP of the export, with `font-src data:` only when the math stylesheet is embedded. */
function cspFor(format: HtmlExportFormat, withFonts: boolean): string {
  return withFonts ? `${CSP[format]}; font-src data:` : CSP[format]
}

const CSP: Readonly<Record<HtmlExportFormat, string>> = {
  // TODO 1273: `img-src data:` in both formats. Main embeds the images as `data:` before printing (`embed-images.ts`); nothing else loads.
  pdf: "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
  html: "default-src 'none'; img-src data:; style-src 'unsafe-inline'"
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** So the style element cannot be exited with `</style>` (the CSS is our own, but just in case). */
function safeCss(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style')
}

function turnHtml(
  turn: ExportTurn,
  relabel: (text: string) => string,
  diagrams: ReadonlyMap<string, string>
): string {
  const parts: string[] = []
  if (turn.question !== null) {
    const images = (turn.question.attachments ?? []).map((a) => {
      // A pasted image keeps only its thumbnail; an attached file is read by main from its uri when embedding (it re-checks the path).
      const src = a.thumbnail ?? a.uri
      return src === undefined
        ? `<span class="export-image-omitted">[${escapeHtml(a.name)}]</span>`
        : `<img src="${escapeHtml(src)}" alt="${escapeHtml(a.name)}" title="${escapeHtml(a.name)}">`
    })
    const gallery = images.length === 0 ? '' : `<div class="export-attachments">${images.join('')}</div>`
    parts.push(
      `<div class="message user"><div class="user-text">${escapeHtml(relabel(turn.question.text))}</div>${gallery}</div>`
    )
  }
  for (const answer of turn.answers) {
    parts.push(`<div class="message assistant"><div class="markdown">${inlineMermaidDiagrams(answerHtml(answer), diagrams)}</div></div>`)
  }
  return `<section class="export-turn">${parts.join('')}</section>`
}

export function exportDocumentHtml(input: ExportDocumentInput): string {
  const relabel = input.relabel ?? ((text: string) => text)
  const format = input.format ?? 'pdf'
  const body = input.turns.map((turn) => turnHtml(turn, relabel, input.diagrams ?? new Map()))
  answerHtmlCache.clear()
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(input.lang)}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${cspFor(format, input.mathCss !== undefined)}">`,
    ...(format === 'html' ? ['<meta name="viewport" content="width=device-width, initial-scale=1">'] : []),
    `<title>${escapeHtml(input.title)}</title>`,
    ...(input.mathCss === undefined ? [] : [`<style>${safeCss(input.mathCss)}</style>`]),
    `<style>${safeCss(input.appCss)}</style>`,
    `<style>${PRINT_CSS}</style>`,
    ...(format === 'html' ? [`<style>${SCREEN_CSS}</style>`] : []),
    '</head>',
    format === 'html' ? '<body class="export-pdf export-html">' : '<body class="export-pdf">',
    `<header class="export-head"><h1>${escapeHtml(input.title)}</h1><div class="export-meta">${escapeHtml(input.meta)}</div></header>`,
    ...body,
    '</body>',
    '</html>'
  ].join('\n')
}
