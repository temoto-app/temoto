/**
 * The pure part of Help (TODO 1174, ARCHITECTURE.md 7.4.13) shared by main and the renderer.
 *
 * - **The `help://` URI** (`help://index?lang=ja`). The renderer has no paths and passes only this URI to main. main validates it with
 *   `parseHelpUri` and resolves only the names of known pages to bundled files (`src/main/help.ts`).
 * - **Preparation before display** (`prepareHelpDocument`). Help's HTML is drawn by the Preview of `aios.html`, but Preview does not run
 *   scripts (the triple guard of 7.4.10). So the initial values that the document's JS would decide (language, color scheme, version) are written first by the host
 *   with string replacement. Switching the language itself is CSS (radio and `:checked`), so it works without script.
 *
 * It uses neither electron nor the DOM (vitest reads it directly).
 */
import { isLocale, type Locale } from './locale.js'
import type { Theme } from './theme.js'
import type { ResolvedViewer } from './plugin.js'
import { PRODUCT_NAME } from './product.js'

export const HELP_SCHEME = 'help:'

/** Page name -> file name inside the bundled folder (`resources/help/`). **A name not here is not resolved.** */
export const HELP_PAGES: Readonly<Record<string, string>> = { index: 'index.html' }

/** The limit of the bundled Help HTML (bytes). 2 MB, the same as the limit of text in the temporary view (`MAX_TRANSIENT_TEXT_BYTES`). */
export const MAX_HELP_BYTES = 2 * 1024 * 1024

export interface HelpTarget {
  /** The key of `HELP_PAGES`. */
  readonly page: string
  readonly lang: Locale
}

/** The URI that opens Help. */
export function helpUri(lang: Locale, page = 'index'): string {
  return `help://${page}?lang=${lang}`
}

/**
 * Reads `help://<page>?lang=<language>`. A different scheme, an unknown page, a path, credentials, a port, or an unknown language gives null.
 * If `lang` is missing, `fallback`.
 */
export function parseHelpUri(uri: unknown, fallback: Locale = 'en'): HelpTarget | null {
  if (typeof uri !== 'string' || uri.length > 256) return null
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return null
  }
  if (url.protocol !== HELP_SCHEME) return null
  if (url.username !== '' || url.password !== '' || url.port !== '') return null
  // It is a non-standard scheme, so the `index` of `help://index` is the host and `pathname` is empty (`/` is also allowed).
  if (url.pathname !== '' && url.pathname !== '/') return null
  const page = url.hostname
  if (!Object.hasOwn(HELP_PAGES, page)) return null
  const raw = url.searchParams.get('lang')
  if (raw === null) return { page, lang: fallback }
  return isLocale(raw) ? { page, lang: raw } : null
}

/** The Help document main returns to the renderer (`help.open`). */
export interface HelpDocument {
  /** The body of the bundled HTML (before preparation). */
  readonly text: string
  /** The language the URI pointed to (the initial display). */
  readonly lang: Locale
  /**
   * The viewer that draws it (`aios.html`). Null if it has been disabled: the body is returned but cannot be drawn (the host shows "enable the HTML extension").
   */
  readonly viewer: ResolvedViewer | null
}

export interface HelpPrepareOptions {
  readonly lang: Locale
  readonly theme: Theme
  /** The version shown at the top (`BuildInfo.version`). If empty, the bundled document's default text stays. */
  readonly version: string
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

/** Rewrites an attribute inside a start tag (adds it if missing). */
function withAttribute(tag: string, name: string, value: string): string {
  const pattern = new RegExp(`\\s${name}="[^"]*"`)
  const attr = ` ${name}="${escapeHtml(value)}"`
  if (pattern.test(tag)) return tag.replace(pattern, attr)
  return tag.replace(/\s*>$/, `${attr}>`)
}

/** The language radio. The bundled document is written in this form (`test/help-document.test.ts` checks it). */
const LANG_RADIO = /<input class="lang-radio" type="radio" name="help-lang" id="lang-([a-z]+)"(?: checked)?>/g
/** The box that holds the version. Its contents are the bundled default (shown when opened in a standalone browser). */
const VERSION_SLOT = /(<span class="help-version" data-help-version>)[^<]*(<\/span>)/g

/**
 * Writes the initial language, color scheme and version into the bundled Help HTML.
 *
 * - `lang` / `data-lang` / `data-theme` of `<html>` (the color scheme switches two sets of CSS variables with `data-theme`).
 * - Of the language radios, only the one for `lang` is made `checked` (scripts do not run inside Preview, so the initial value is decided here).
 * - Puts the version into the version box (escaped).
 */
export function prepareHelpDocument(html: string, options: HelpPrepareOptions): string {
  let out = html.replace(/<html\b[^>]*>/i, (tag) => {
    let next = withAttribute(tag, 'lang', options.lang)
    next = withAttribute(next, 'data-lang', options.lang)
    return withAttribute(next, 'data-theme', options.theme)
  })
  out = out.replace(LANG_RADIO, (_all, lang: string) =>
    `<input class="lang-radio" type="radio" name="help-lang" id="lang-${lang}"${lang === options.lang ? ' checked' : ''}>`
  )
  if (options.version !== '') {
    out = out.replace(VERSION_SLOT, (_all, open: string, close: string) => `${open}${escapeHtml(options.version)}${close}`)
  }
  return out
}

/**
 * TODO 1254: substitution of the product name in bundled documents. A document does not hard-code the product name but writes `{{app.name}}`, and the host fills it with `PRODUCT_NAME`
 * (`shared/product.json`) (the same convention as `{app}` in the renderer's dictionary).
 */
export const PRODUCT_NAME_SLOT = '{{app.name}}'

/** Fills `{{app.name}}` in a document with the product name. */
export function fillProductName(text: string): string {
  return text.replaceAll(PRODUCT_NAME_SLOT, escapeHtml(PRODUCT_NAME))
}

/**
 * TODO 1263: the machine's data name (`Temoto`, or `aios` on a machine that kept the legacy userData). Documents write it where a location or the
 * keychain item depends on it (`~/Library/Logs/{{app.dataName}}/`, `{{app.dataName}} Safe Storage`). Filled by main, which knows the identity.
 */
export const DATA_NAME_SLOT = '{{app.dataName}}'

/**
 * Fills all substitutions in a bundled document (the product name, the data name and the backend's names). Used when opening Help and when
 * writing out to `~/<data name>/help/`.
 */
export function fillHelpNames(text: string, names: BackendNames, dataName: string): string {
  return fillProductName(fillBackendNames(text, names)).replaceAll(DATA_NAME_SLOT, escapeHtml(dataName))
}

/** The table of backend names (`compat/backend-names.json`). It fills `{{backend.<key>}}` in documents. */
export type BackendNames = Readonly<Record<string, string | readonly string[]>>

/**
 * Fills `{{backend.<key>}}` in a bundled document with the table's values (constraint 6: do not hard-code a backend name in a document).
 * A key not in the table is left as it is (so the gap is visible). Replacement happens once, and a `{{…}}` inside a value is not expanded again.
 */
export function fillBackendNames(html: string, names: BackendNames): string {
  return html.replace(/\{\{backend\.([A-Za-z]+)\}\}/g, (all, key: string) => {
    const value = Object.hasOwn(names, key) ? names[key] : undefined
    return typeof value === 'string' ? escapeHtml(value) : all
  })
}
