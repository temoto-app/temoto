/**
 * TODO 1221 (ARCHITECTURE 5.2.1 "fullscreen"): the contents and placement of the bubble shown over the page for a few seconds when the Web content is made fullscreen
 * (Chrome's "Press Esc to exit full screen").
 *
 * During fullscreen the page's view covers the whole window, so it cannot be drawn in the renderer's DOM (it would be under the view). Main creates the bubble as a small
 * `WebContentsView` (no JS, sandboxed, no preload) layered over the page (`register.ts`).
 * This file has only **electron-independent** pure functions (`test/web-fullscreen.test.ts`).
 *
 * Colors are not written as literals (7.4.1): the CSS system colors (`Canvas` / `CanvasText`) are used inverted. `color-scheme` is set to
 * light dark, so it becomes a dark bubble / a light bubble matching the brightness of `nativeTheme` (which follows aios's theme).
 */

/** The bubble's size (DIP). The text is short enough to fit on one line (in both ja / en). */
export const FULLSCREEN_HINT_WIDTH = 460
export const FULLSCREEN_HINT_HEIGHT = 48
/** The gap from the top edge of the window (shown at the top center, as Chrome does). */
export const FULLSCREEN_HINT_TOP = 24

/** The bubble's rectangle. At the top center of the window's content-area width `contentWidth`. If the window is narrow, the width is reduced. */
export function fullscreenHintBounds(contentWidth: number): { x: number; y: number; width: number; height: number } {
  const available = Math.max(1, Math.floor(contentWidth) - 16)
  const width = Math.min(FULLSCREEN_HINT_WIDTH, available)
  return {
    x: Math.max(0, Math.round((Math.floor(contentWidth) - width) / 2)),
    y: FULLSCREEN_HINT_TOP,
    width,
    height: FULLSCREEN_HINT_HEIGHT
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

/** The bubble's HTML. Only the word `Esc` (the first one) is made key-shaped (`<kbd>`). */
export function fullscreenHintHtml(text: string): string {
  const body = escapeHtml(text).replace('Esc', '<kbd>Esc</kbd>')
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">",
    '<style>',
    ':root{color-scheme:light dark}',
    'html,body{margin:0;height:100%;overflow:hidden;cursor:default;user-select:none}',
    'body{display:flex;align-items:center;justify-content:center;background:CanvasText;color:Canvas;',
    'font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    'kbd{font:inherit;border:1px solid currentColor;border-radius:4px;padding:1px 6px;margin:0 4px}',
    '</style></head><body>',
    body,
    '</body></html>'
  ].join('')
}

/** The `data:` URL that has the bubble loaded. */
export function fullscreenHintUrl(text: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(fullscreenHintHtml(text))}`
}
