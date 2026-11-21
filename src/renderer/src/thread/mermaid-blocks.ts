/**
 * The part of drawing ```mermaid in an answer as a diagram (TODO 880) that does not touch mermaid itself (pure functions).
 *
 * - Only **mermaid** is drawn (owner decision 2026-10-18). The output of `renderMarkdown` wraps the `<pre><code>` of `language-mermaid` in
 *   `<div class="code-block" data-code="…">` (5.1.2). This only looks at that shape.
 * - Not drawn in the middle of the answer stream (`Streaming`); drawn after it closes. The decision is `shouldDrawDiagrams`.
 * - Export (PDF / HTML) builds a string of HTML, so the sources are gathered with `mermaidSources` and the drawn SVG replaces the
 *   `.code-block` with `inlineMermaidDiagrams`. `<script>` etc. are dropped by `sanitizeDiagramSvg`.
 */
import DOMPurify from 'dompurify'
import { decodeCodeBlock } from '@shared/markdown/render.js'

/** Do not draw: in the middle of the answer stream (an unclosed fence is possible), or the source is empty. */
export function shouldDrawDiagrams(input: { readonly streaming: boolean }): boolean {
  return !input.streaming
}

/** Whether a `.code-block` in the DOM is mermaid. */
export function isMermaidCodeBlock(node: Element): boolean {
  return node.querySelector(':scope > pre > code.language-mermaid') !== null
}

/** Takes the mermaid source from a `.code-block` in the DOM (from `data-code`; it is not restored from the syntax-highlighted HTML). */
export function mermaidSourceOf(node: HTMLElement): string {
  return decodeCodeBlock(node.dataset['code'])
}

const BLOCK_RE =
  /<div class="code-block" data-code="([^"]*)"><pre><code class="[^"]*\blanguage-mermaid\b[^"]*">[\s\S]*?<\/code><\/pre>\s*<\/div>/g

/** For export: the mermaid sources in an HTML string (no duplicates, in order of appearance). */
export function mermaidSources(html: string): string[] {
  const found = new Set<string>()
  for (const match of html.matchAll(BLOCK_RE)) {
    const code = decodeCodeBlock(match[1])
    if (code.trim() !== '') found.add(code)
  }
  return [...found]
}

/**
 * For export: replaces mermaid code blocks with the `<figure>` of the drawn diagram (SVG). Ones that could not be drawn (not in `svgs`)
 * stay as code blocks. The SVG is inserted after passing through `sanitizeDiagramSvg`.
 */
export function inlineMermaidDiagrams(html: string, svgs: ReadonlyMap<string, string>): string {
  if (svgs.size === 0) return html
  return html.replace(BLOCK_RE, (whole, encoded: string) => {
    const svg = svgs.get(decodeCodeBlock(encoded))
    if (svg === undefined) return whole
    const clean = sanitizeDiagramSvg(svg)
    return clean === '' ? whole : `<figure class="mermaid-diagram">${clean}</figure>`
  })
}

/**
 * Drops scripts, event attributes, and external references from a diagram's SVG. mermaid's `securityLevel: 'strict'` also goes through the same
 * DOMPurify, but an export remains as a file, so it is passed through once more right before insertion (a double safety net).
 */
export function sanitizeDiagramSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject', 'a', 'image', 'use'],
    FORBID_ATTR: ['href', 'xlink:href', 'onclick']
  })
}
