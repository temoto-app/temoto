/**
 * The `aios-res://` scheme. An internal route for handing binaries (images, PDFs) to a viewer.
 *
 * It keeps the renderer / viewer from reading `file://` directly. webSecurity does not have to be turned off, and since the Broker's permission check
 * is passed before serving, files outside the allowed range do not get out.
 *
 * **The URL carries a token** (`aios-res://local/<token>/<name>`, review A-4). It used to carry the path
 * as is (`aios-res://local/Users/…`), and the serving side only looked at the exclusion list, so
 * a viewer could read even images it had not opened with `<img>`. Now the Broker (`openResource`) looks up token -> (pluginId, path)
 * and checks **whether that plugin still has that URI open**. The side that builds URLs (`resourceUrlFor`) and the serving side's check
 * are now in one place, the Broker.
 */
import { closeSync, createReadStream, realpathSync } from 'node:fs'
import { extname, join, normalize, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { app, protocol } from 'electron'
import { RESOURCE_SCHEME, resourceTokenOf } from '@shared/uri.js'
import { PLUGIN_REVISION_PREFIX, PLUGIN_SCHEME } from '@shared/plugin.js'
import { log, errorFields } from '../common/logger.js'
import { parseRange, resourceHeaders, type OpenedResource } from './capability/resource.js'
import { VIEWER_CSP_CEILING } from './capability/viewer-csp.js'
import type { PluginHost } from './plugin/host.js'
import { conversionResponse, convertForDisplay, needsDisplayConversion } from './image/display.js'

const SCHEME = RESOURCE_SCHEME.slice(0, -1)
const PLUGIN = PLUGIN_SCHEME.slice(0, -1)

/** Must be called before app.whenReady(). */
export function registerResourceScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        // The viewer reads from the sandbox's **opaque origin** (origin: null), so
        // even an image cannot be fetched unless CORS passes. The response side adds ACAO.
        corsEnabled: true
      }
    },
    {
      // Serve plugin viewers (7.8).
      // - `standard`: needed to resolve relative URLs and module scripts
      // - **`corsEnabled`: without it Chromium says "this scheme cannot handle
      //   cross-origin requests" and does not even load the page's own JS and CSS**
      //   (every request from the sandbox's opaque origin is cross-origin).
      //   We actually hit this in Phase 4: only the HTML came back 200 and the content stayed blank.
      scheme: PLUGIN,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    }
  ])
}

/** The source of `aios-res://`. The real thing is `CapabilityBroker` (the check is made there, in one place). */
export interface ResourceSource {
  openResource(token: string): OpenedResource
}

/**
 * Call after app.whenReady().
 *
 * **The body is not read** (review D-5). It used to read up to 2 MB with `readResource` and throw it away before serving.
 * Now it streams the fd the Broker inspected and opened (O_NOFOLLOW + fstat done) as is. Only one Range is accepted
 * (the PDF viewer fetches by range).
 */
export function handleResourceScheme(source: ResourceSource): void {
  protocol.handle(SCHEME, async (request) => {
    const token = resourceTokenOf(request.url)
    // The token is itself the permission (a capability), so the URL is not logged.
    if (token === null) return new Response(null, { status: 400 })
    let opened: OpenedResource
    try {
      opened = source.openResource(token)
    } catch (err) {
      log.warn('protocol.denied', errorFields(err))
      return new Response(null, { status: 403 })
    }
    // Chromium cannot read HEIC / HEIF: convert to JPEG with macOS sips and return that (TODO 1154). Not cached.
    // Pass the inspected fd (passing a path would convert a different file if it is swapped between the check and the conversion). The other side closes the fd.
    if (needsDisplayConversion(opened.path)) {
      return conversionResponse(await convertForDisplay(opened, { tempDir: app.getPath('temp') }))
    }
    try {
      const range = parseRange(request.headers.get('range'), opened.size)
      if (range === 'unsatisfiable') {
        closeSync(opened.fd)
        return new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${opened.size}`, 'access-control-allow-origin': '*' }
        })
      }
      const headers = resourceHeaders(opened.path, opened.size, range)
      if (opened.size === 0) {
        closeSync(opened.fd)
        return new Response(null, { status: 200, headers })
      }
      // When an fd is passed, path is not read. autoClose closes it when reading ends or is aborted.
      const stream = createReadStream(opened.path, {
        fd: opened.fd,
        autoClose: true,
        start: range?.start ?? 0,
        end: range?.end ?? opened.size - 1
      })
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: range === null ? 200 : 206,
        headers
      })
    } catch (err) {
      try {
        closeSync(opened.fd)
      } catch {
        // Already closed (an exception after the stream closed).
      }
      log.warn('protocol.failed', errorFields(err))
      return new Response(null, { status: 500 })
    }
  })
}

/**
 * `aios-plugin://<pluginId>/<path>` (7.8).
 *
 * **Not one byte outside the plugin's directory is served.** The host is always
 * the plugin ID, and the path is normalized and then checked down to realpath
 * (stopping escapes with `..` and symlinks).
 *
 * A viewer's URL has a version segment (`aios-plugin://<id>/@<version>/<entry>`, TODO 1144 stage 3). Even after an extension is updated, chunks that a viewer
 * left open loads lazily are served from the directory of the version it was opened with (`PluginHost` decides which version to serve).
 *
 * A viewer runs in an iframe with `sandbox="allow-scripts"`, so it has an **opaque origin**.
 * As a consequence:
 *  - `'self'` cannot be written in the HTML's CSP (it matches no origin). Write it by scheme.
 *  - Module scripts are fetched with CORS, so `access-control-allow-origin` is needed.
 */
export function handlePluginScheme(plugins: PluginHost): void {
  protocol.handle(PLUGIN, async (request) => {
    try {
      const file = pluginFileOf(plugins, request.url)
      if (typeof file === 'number') return new Response(null, { status: file })
      const stream = Readable.toWeb(createReadStream(file)) as ReadableStream
      return new Response(stream, {
        headers: {
          'content-type': pluginContentType(file),
          'access-control-allow-origin': '*',
          // TODO 919: send the ceiling CSP as a header (it takes effect as an intersection with the meta CSP). A third-party viewer that writes no meta cannot read or write outside either.
          'content-security-policy': VIEWER_CSP_CEILING
        }
      })
    } catch (err) {
      log.warn('protocol.plugin.denied', { url: request.url, ...errorFields(err) })
      return new Response(null, { status: 403 })
    }
  })
}

/** The source of `aios-plugin://` (a part of `PluginHost`). */
export interface PluginDirectorySource {
  /**
   * For an enabled plugin, the directory. For a disabled plugin, only when `relativePath` is the icon (TODO 524).
   * `revision` (TODO 1144 stage 3) is the version in the URL's `@<version>/` segment. If given, that version's directory (the current version, or a version
   * read earlier by this process; null if disabled); if not, the current version.
   */
  servingDirectoryOf(pluginId: string, relativePath: string, revision: string | null): string | null
}

/**
 * Split a URL path into the version segment (`/@<version>/`, TODO 1144 stage 3) and the rest. Without the segment, `revision` is null.
 * null (not served) if the encoding of the version is broken.
 */
export function splitPluginRevision(pathname: string): { readonly revision: string | null; readonly rest: string } | null {
  const match = /^\/([^/]*)(\/.*)?$/.exec(pathname)
  const first = match?.[1] ?? ''
  if (!first.startsWith(PLUGIN_REVISION_PREFIX)) return { revision: null, rest: pathname }
  let revision: string
  try {
    revision = decodeURIComponent(first.slice(PLUGIN_REVISION_PREFIX.length))
  } catch {
    return null
  }
  if (revision === '') return null
  return { revision, rest: match?.[2] ?? '/' }
}

function relativePathOf(rest: string): string | null {
  try {
    return normalize(decodeURIComponent(rest)).replace(/^[/\\]+/, '')
  } catch {
    return null
  }
}

/**
 * `aios-plugin://<id>/<path>` (and `aios-plugin://<id>/@<version>/<path>`) -> the path of the real file that may be served (realpath done).
 * If not allowed, an HTTP status (403 / 404). After collapsing `..`, check again, also collapsing symlinks, that it is inside the directory.
 */
export function pluginFileOf(plugins: PluginDirectorySource, requestUrl: string): string | 403 | 404 {
  const url = new URL(requestUrl)
  const split = splitPluginRevision(url.pathname)
  if (split === null) return 404
  let relativePath = relativePathOf(split.rest)
  if (relativePath === null) return 404
  if (relativePath === '' || relativePath.startsWith('..')) return 403
  let dir = plugins.servingDirectoryOf(url.hostname, relativePath, split.revision)
  if (dir === null && split.revision !== null) {
    // An `@…` of an unknown version (one this process has not read) is not a version but an ordinary path such as a plugin's top-level `@scope/lib.js`.
    relativePath = relativePathOf(url.pathname)
    if (relativePath === null) return 404
    if (relativePath === '' || relativePath.startsWith('..')) return 403
    dir = plugins.servingDirectoryOf(url.hostname, relativePath, null)
  }
  if (dir === null) return 404
  const root = realpathSync.native(dir)
  let real: string
  try {
    real = realpathSync.native(join(dir, relativePath))
  } catch {
    return 404
  }
  const inside = relative(root, real)
  if (inside === '' || inside.startsWith('..') || inside.startsWith(`..${sep}`)) return 403
  return real
}

const PLUGIN_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}

function pluginContentType(path: string): string {
  return PLUGIN_MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}
