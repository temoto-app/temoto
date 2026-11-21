/**
 * The address bar in the heading of a file viewer (TODO 970, ARCHITECTURE 5.2.1). A pure function that sorts what was typed into "a URL to open on the Web" or "a
 * path to open in the viewer". **It only sorts**: a URL is re-checked by main's `web.newTab` / `web.load` with `isWebViewerUrl`, and a path by main's
 * `fs.resolveLink` against the choke point (`FsAccess.assertAllowed`) and existence (the renderer's decision is not trusted).
 *
 * The rules differ from the URL field of the Web pane (`normalizeAddress`, TODO 691): that one sends words that are not URLs to a Google search,
 * but the file viewer's field is **path first**, so anything that does not look like a URL is treated as a path (owner decision 2026-10-25).
 *
 * - `http://` / `https://` -> Web (refused if it does not pass `isWebViewerUrl`).
 * - `file:` / `~` / `~/…` / `/…` -> path.
 * - Other schemes (`javascript:` / `data:` / `mailto:` ...) -> refused (not opened). `host:port` and `main.ts:42:5` (line, column) are told apart by the digits, and a
 *   double colon such as `std::vector` is not taken as a scheme.
 * - No scheme, no whitespace, and the first element is a **dotted host name** (`example.com`, `docs.example.co.jp/path`), an IPv4 address, or
 *   `localhost` (with a port too) -> Web. `https://` is supplied (`http://` for `localhost` / `127.x` / `[::1]`).
 *   But the shape of a dotted host name **can also be a file name** (`README.md`, `App.vue`, `main.ts:42`), so it is not decided by an extension table;
 *   it is returned as `{ kind: 'hostOrPath' }`. The caller **resolves it as a path first** (the same `openLinkHref` as links in an answer, with line and anchor handled the same way),
 *   and opens the Web through `url` if it does not exist. `localhost` / IPv4 go straight to the Web.
 * - Anything else (`docs/a.md`, a name with spaces and non-ASCII characters, `foo`) -> path (if relative, the folder of the file being shown is the base; main resolves it).
 */
import { isWebViewerUrl } from './open-external.js'
import { isLocalPathInput } from './web-tabs.js'

export type ViewerAddressTarget =
  | { readonly kind: 'none' }
  | { readonly kind: 'web'; readonly url: string }
  | { readonly kind: 'path'; readonly href: string }
  /** The shape of a dotted host name without a scheme. Resolve it as a path first; if it does not exist, open the Web with `url` (https). */
  | { readonly kind: 'hostOrPath'; readonly href: string; readonly url: string }
  /** A scheme other than http(s), or a URL of a form that cannot be opened. Do not open; show the reason. */
  | { readonly kind: 'unsupported' }

const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/
/** A dotted host name (with a port too). The last label starts with a letter and has 2 or more characters. */
const DOTTED_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z][a-z0-9-]*[a-z0-9])(?::(\d+))?$/i

export function viewerAddressTarget(input: string): ViewerAddressTarget {
  const text = input.trim()
  if (text === '') return { kind: 'none' }
  if (/^https?:\/\//i.test(text)) return isWebViewerUrl(text) ? { kind: 'web', url: text } : { kind: 'unsupported' }
  if (/^file:/i.test(text) || isLocalPathInput(text)) return { kind: 'path', href: text }
  // Other schemes are not opened. `host:port` (`localhost:3000`) and `::` (`std::vector`) are not taken as schemes.
  if (/^[a-z][a-z0-9+.-]*:(?!:)/i.test(text) && !/^[^/:\s]+:\d+(?::\d+)?(?:[/?#]|$)/.test(text)) return { kind: 'unsupported' }
  if (!/\s/.test(text)) {
    const hostPart = text.split(/[/?#]/, 1)[0] ?? ''
    const local = LOCAL_HOST.test(hostPart)
    const dotted = DOTTED_HOST.test(hostPart)
    if (local || IPV4_HOST.test(hostPart) || dotted) {
      const url = `${local ? 'http' : 'https'}://${text}`
      if (!isWebViewerUrl(url)) return dotted && !local ? { kind: 'path', href: text } : { kind: 'unsupported' }
      return dotted && !local ? { kind: 'hostOrPath', href: text, url } : { kind: 'web', url }
    }
  }
  return { kind: 'path', href: text }
}
