/**
 * Build the document passed to `aios.html` Preview (TODO 401, ARCHITECTURE 7.4.10).
 *
 * **Draw only what is inside this one HTML. Do not load a single external or other file** (owner decision 2026-10-04).
 * There are three layers of defense, and if any one fails the others still stop it:
 *
 *  1. A nested `<iframe sandbox="">` (`PREVIEW_SANDBOX`). Scripts do not run (no `allow-scripts`), the
 *     origin is opaque (no `allow-same-origin`), and there is no form submission, popup or top-level navigation.
 *     The plugin's own iframe is also `sandbox="allow-scripts"`, so the nested one cannot be wider than that.
 *  2. A CSP put at the top (`PREVIEW_CSP`): `default-src 'none'` blocks images (other than data:), CSS `@import` / `url()`,
 *     fonts, video, frames and fetch. Only inline `<style>` and `style` attributes are allowed.
 *     In addition, a srcdoc document **inherits the CSP of its parent (the plugin's iframe)** (the HTML policy container),
 *     so the CSP of the plugin's `index.html` applies at the same time.
 *  3. DOMPurify (`PURIFY_CONFIG`): drops `<script>`, event attributes (such as `onerror`) and `javascript:`, and
 *     also drops whole `<iframe>` / `<object>` / `<embed>` / `<link>` / `<meta>` (including `refresh`) / `<base>` elements.
 *
 * Links (`<a href>` / `<area href>`) cannot be followed: a script inside the nested document cannot intercept them (a different origin as seen from the parent),
 * and a plain click would try to navigate the nested frame itself to that URL, be stopped by the plugin's CSP (`frame-src` -> `default-src 'none'`),
 * and be replaced by a Chromium error page. So anything other than `#…` gets `target="_blank"`, and because the sandbox has no
 * `allow-popups`, the click does **nothing** (the link still looks like a link).
 *
 * `main.ts` is an entry script that imports `@pluginshared` and cannot be loaded from vitest, so this part is split out here
 * (same shape as `aios.markdown`'s `reveal-mode.ts`).
 */
import DOMPurify, { type DOMPurify as Purifier } from 'dompurify'

/** The `sandbox` attribute of the nested iframe. Empty = every permission removed. */
export const PREVIEW_SANDBOX = ''

/** The CSP put at the start of the srcdoc `<head>`. */
export const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"

/**
 * Draw the nested document in the same "light scheme" as a plain browser (the default of TODO 401). `:where()` makes the specificity 0.
 * **No background color is set here** — putting a background on html stops the body color from propagating to the whole view when the HTML
 * writes a background only on body (it stays inside the body box). The white background is laid on the nested iframe element side (`background: Canvas` of `.html-preview` in `html.css`).
 * The nested document is transparent by default, so without that the dark background of the dark theme shows through and
 * the default black text gets buried (confirmed on Electron 44, bundle A of docs/notes/wave22.md).
 */
export const PREVIEW_BASE_STYLE = ':where(html){color-scheme:light}'

/** Elements dropped in addition to DOMPurify's defaults. All are dropped by default too, but they are listed explicitly to pin down the intent. */
export const FORBID_TAGS = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'portal',
  'link',
  'meta',
  'base'
] as const

export const PURIFY_CONFIG = {
  // Keep `<html>` / `<head>` / `<style>` / `<title>` (as a fragment, the `<style>` of head would move into body).
  WHOLE_DOCUMENT: true,
  FORBID_TAGS: [...FORBID_TAGS],
  // `srcdoc` is an attribute that can create a nested-nested document. `<iframe>` is dropped, but drop the attribute too just in case.
  FORBID_ATTR: ['srcdoc', 'ping'],
  RETURN_TRUSTED_TYPE: false
}

/**
 * Make links "do nothing when pressed" (the explanation is at the top). `#…` (inside the same document) is rewritten to `about:srcdoc#…` —
 * the base URL of a srcdoc document is the URL of the parent (the plugin's `index.html`), so a bare `#sec2` would become
 * a navigation to `aios-plugin://…/index.html#sec2`, be stopped by the plugin's CSP and show an error page
 * (the 27th proxy verification, 455-2). The document's URL is `about:srcdoc`, so writing it this way only scrolls inside the document.
 */
function neuterLinks(node: Element): void {
  const tag = node.nodeName.toLowerCase()
  if (tag !== 'a' && tag !== 'area') return
  const href = node.getAttribute('href')
  if (href === null) return
  if (href.trim().startsWith('#')) {
    node.setAttribute('href', `about:srcdoc${href.trim()}`)
    return
  }
  node.setAttribute('target', '_blank')
  node.setAttribute('rel', 'noopener noreferrer')
}

/**
 * A DOMPurify dedicated to this plugin. The default instance gets its own hook added by the shared Markdown renderer (`@shared/markdown/render.ts`),
 * so a separate instance is made to keep hooks from mixing (once, on first use).
 */
let purifier: Purifier | null = null

function purify(): Purifier {
  if (purifier === null) {
    purifier = DOMPurify(window)
    purifier.addHook('afterSanitizeAttributes', neuterLinks)
  }
  return purifier
}

/** Turn the HTML body into the string that goes into Preview's `srcdoc`. */
export function buildPreviewDocument(source: string): string {
  // WHOLE_DOCUMENT + RETURN_DOM returns the `<html>` element (DOMParser always supplies `<head>`). Instead of cutting and pasting the string,
  // insert at the top via the DOM (so things like `<head>` inside an attribute do not mislead it).
  const root = purify().sanitize(source, { ...PURIFY_CONFIG, RETURN_DOM: true }) as Element
  const doc = root.ownerDocument
  let head = root.querySelector(':scope > head')
  if (head === null) {
    head = doc.createElement('head')
    root.prepend(head)
  }
  const meta = doc.createElement('meta')
  meta.setAttribute('http-equiv', 'Content-Security-Policy')
  meta.setAttribute('content', PREVIEW_CSP)
  const style = doc.createElement('style')
  style.textContent = PREVIEW_BASE_STYLE
  head.prepend(meta, style)
  return root.outerHTML
}
