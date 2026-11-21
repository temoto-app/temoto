/**
 * Loads mermaid lazily and turns code into SVG (TODO 880).
 *
 * - `import('mermaid')` does not run until the first diagram is drawn (mermaid is large; vite splits it into a separate chunk).
 * - `securityLevel: 'strict'` (no HTML, clicks, or scripts inside a diagram). `htmlLabels: false` keeps it from using
 *   `foreignObject`, so labels are also SVG `<text>` (aligned with the export safety net `sanitizeDiagramSvg`).
 * - No colors are written (7.4.1). On screen, the `:root` CSS variables are read at run time and passed to the variables of mermaid's `base` theme
 *   (switching light / dark redraws when the theme name changes). Export is fixed to light, so mermaid's own
 *   `default` theme is used (there are no colors in our source).
 * - If it cannot be drawn (syntax error, exception) the result is `null`, and the caller shows the code block as is. An error does not break the screen.
 */
import type { Mermaid } from 'mermaid'

export type DiagramTheme = 'screen' | 'light'

let loading: Promise<Mermaid> | null = null
/** Draw one at a time (mermaid creates temporary elements in `document.body`, so running in parallel would tangle the ids). */
let queue: Promise<unknown> = Promise.resolve()
let counter = 0

function loadMermaid(): Promise<Mermaid> {
  loading ??= import('mermaid').then((m) => m.default)
  return loading
}

/** `:root` CSS variables -> variables of the mermaid `base` theme. Empty variables are not passed. */
export function themeVariablesFrom(read: (name: string) => string): Record<string, string> {
  const map: Record<string, string> = {
    background: '--bg',
    primaryColor: '--bg-raised',
    primaryTextColor: '--fg',
    primaryBorderColor: '--line',
    secondaryColor: '--accent-bg',
    secondaryTextColor: '--fg',
    tertiaryColor: '--bg',
    lineColor: '--fg-dim',
    textColor: '--fg',
    noteBkgColor: '--warn-bg',
    noteTextColor: '--fg',
    noteBorderColor: '--line',
    fontFamily: '--font-mono'
  }
  const out: Record<string, string> = {}
  for (const [key, cssVar] of Object.entries(map)) {
    const value = read(cssVar).trim()
    if (value !== '') out[key] = value
  }
  return out
}

function readRootVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name)
}

/** The current theme name on screen (`<html data-theme>`). Also used as part of the cache key. */
export function currentThemeName(): string {
  return document.documentElement.dataset['theme'] === 'dark' ? 'dark' : 'light'
}

/**
 * mermaid's default (`useMaxWidth: true`) puts `width="100%"` and `style="max-width: Npx"` on the root `<svg>`.
 * In a container where `max-width` has no effect (flex, a diagram wrapper), a small diagram is enlarged to the full width (TODO 884).
 * Sets `width` to the `viewBox` width in px and removes the `max-width` from `style`, so the diagram's natural size is the upper bound
 * (with `max-width: 100%` on the CSS side only diagrams wider than the container shrink). If the `viewBox` cannot be read, returns it as is.
 */
export function fitSvgToNaturalSize(svg: string): string {
  const open = /^\s*<svg\b[^>]*>/i.exec(svg)
  if (open === null) return svg
  const tag = open[0]
  const box = /\bviewBox\s*=\s*"\s*[-\d.eE+]+[\s,]+[-\d.eE+]+[\s,]+([\d.eE+]+)[\s,]+[\d.eE+]+\s*"/i.exec(tag)
  const width = box === null ? NaN : Number(box[1])
  if (!Number.isFinite(width) || width <= 0) return svg
  let next = tag
    .replace(/\swidth\s*=\s*"[^"]*"/i, '')
    .replace(/\sstyle\s*=\s*"([^"]*)"/i, (_m, style: string) => {
      const kept = style
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part !== '' && !/^max-width\s*:/i.test(part))
        .join('; ')
      return kept === '' ? '' : ` style="${kept}"`
    })
  next = next.replace(/^(\s*<svg\b)/i, `$1 width="${Math.ceil(width)}"`)
  return next + svg.slice(tag.length)
}

async function draw(code: string, theme: DiagramTheme): Promise<string | null> {
  const mermaid = await loadMermaid()
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    ...(theme === 'screen'
      ? { theme: 'base' as const, themeVariables: themeVariablesFrom(readRootVar) }
      : { theme: 'default' as const })
  })
  // Parse first, alone: so that on a syntax error mermaid does not insert a "Syntax error" diagram into the body.
  const ok = await mermaid.parse(code, { suppressErrors: true })
  if (ok === false) return null
  const id = `aios-mermaid-${++counter}`
  try {
    const { svg } = await mermaid.render(id, code)
    return fitSvgToNaturalSize(svg)
  } finally {
    // Clean up the temporary element that is left behind on failure.
    document.getElementById(id)?.remove()
    document.getElementById(`d${id}`)?.remove()
  }
}

/** A small cache to avoid redrawing on screen (source + theme name -> SVG). */
const cache = new Map<string, string>()
const CACHE_MAX = 64

/** The first half of the cache key. The screen (base theme + CSS variable colors) and export (default theme) are different pictures, so they are not mixed. */
export function diagramCacheScope(theme: DiagramTheme, screenTheme: string = currentThemeName()): string {
  return theme === 'screen' ? `screen:${screenTheme}` : 'export'
}

/** `null` if it cannot be drawn (it does not throw). */
export function renderDiagram(code: string, theme: DiagramTheme): Promise<string | null> {
  const key = `${diagramCacheScope(theme)}\u0000${code}`
  const hit = cache.get(key)
  if (hit !== undefined) return Promise.resolve(hit)
  const run = queue.then(async () => {
    try {
      const svg = await draw(code, theme)
      if (svg !== null) {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
        cache.set(key, svg)
      }
      return svg
    } catch {
      return null
    }
  })
  queue = run
  return run
}
