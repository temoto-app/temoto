/**
 * TODO 919: the ceiling of the CSP applied to plugin viewers, and the decision on navigation of viewer frames (ARCHITECTURE 7.8). **Does not import electron**.
 *
 * The earlier CSP was only the `<meta>` a plugin writes in its own `index.html`, so a third-party viewer that wrote none could send the contents of an opened file out with `fetch` / `<img>` /
 * `sendBeacon` (even though the permission screen shows no network). Now **every response** of `aios-plugin://` **gets the ceiling CSP as a header** (`handlePluginScheme`). The header CSP and the meta CSP **both apply** (an intersection), so
 * the strict meta of a bundled viewer stays as it is, and the ceiling also applies to viewers that write none. A worker's script runs under the CSP in
 * its own response header, so it is attached to JS responses too.
 *
 * The ceiling is the union of the bundled viewers' metas (collected from `plugins/*\/viewer/index.html` on 2026-10-24):
 * - `aios.pdf`: `script-src 'wasm-unsafe-eval'`, `worker-src data:`, `img-src blob: data:`, `font-src aios-plugin: data: blob:`,
 *   `connect-src aios-res: aios-plugin: blob:`
 * - `aios.image`: `img-src aios-res: blob:` / `aios.video`: `media-src aios-res: blob:` / `aios.office`, `aios.zip`: `connect-src aios-res: blob:`
 * - the rest (`text` / `markdown` / `diff` / `html`): `script-src aios-plugin:`, `style-src aios-plugin: 'unsafe-inline'`, `img-src data:`
 * None of them needs a single http(s) source. `test/viewer-csp.test.ts` checks that "every source of the bundled metas is inside the ceiling".
 */
import { PLUGIN_SCHEME } from '@shared/plugin.js'

/** The CSP (ceiling) attached as a header. Nothing can be loaded from or sent to the outside (http(s), ws, file). */
export const VIEWER_CSP_CEILING = [
  "default-src 'none'",
  "script-src aios-plugin: 'wasm-unsafe-eval'",
  'worker-src aios-plugin: blob: data:',
  "style-src aios-plugin: 'unsafe-inline'",
  'img-src aios-plugin: aios-res: blob: data:',
  'media-src aios-res: blob: data:',
  'font-src aios-plugin: blob: data:',
  'connect-src aios-plugin: aios-res: blob: data:',
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

/** Turns the ceiling CSP into a set of sources per directive (for matching against tests). */
export function parseCsp(policy: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name === undefined || name === '') continue
    out.set(name.toLowerCase(), new Set(sources))
  }
  return out
}

function pluginIdOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === PLUGIN_SCHEME ? parsed.hostname : null
  } catch {
    return null
  }
}

export interface FrameNavigation {
  /** Where it is going. */
  readonly url: string
  /** The current URL of the frame being navigated (`WebFrameMain.url`; empty if unknown). */
  readonly frameUrl: string
  /** The URL of the frame that started the navigation (null if unknown). */
  readonly initiatorUrl: string | null
  /** Whether the initiator is the main window's top-level frame (= the renderer itself changed the iframe's `src`). */
  readonly initiatorIsTop: boolean
}

/**
 * TODO 919: whether to allow navigation of a **child frame** inside the main window (`will-frame-navigate`). Navigation of the main window itself is still stopped entirely by `will-navigate`, as before.
 *
 * - `about:blank` / `about:srcdoc` (the nesting of `aios.html`'s Preview) pass.
 * - Otherwise only `aios-plugin://`. A navigation started by the renderer itself (the top-level frame; switching viewers) passes to any plugin.
 * - A navigation started by a plugin's frame is allowed **only within the same plugin**. Moving to another plugin's viewer would let the port the host passes at every `load` and
 *   the current file's contents reach that plugin's document.
 * - No navigation to http(s) / data: / blob: / file: and the like (the renderer's CSP `frame-src aios-plugin:` also stops it, giving two layers).
 *   This keeps a viewer frame from moving to an external page to phish, and keeps a data: document, which inherits no CSP, from receiving the contents.
 */
export function allowViewerFrameNavigation(nav: FrameNavigation): boolean {
  if (nav.url === 'about:blank' || nav.url === 'about:srcdoc') return true
  const target = pluginIdOf(nav.url)
  if (target === null) return false
  if (nav.initiatorIsTop) return true
  // Whoever started the frame is unknown, and the frame has not loaded anything yet (a freshly created iframe): there is no plugin document there yet.
  if (nav.initiatorUrl === null && nav.frameUrl === '') return true
  const from = (nav.initiatorUrl === null ? null : pluginIdOf(nav.initiatorUrl)) ?? pluginIdOf(nav.frameUrl)
  return from === target
}
