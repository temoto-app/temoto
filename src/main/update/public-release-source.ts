/**
 * TODO 1275: find and fetch a new version from the public repo's GitHub Release over unauthenticated HTTPS (ARCHITECTURE 8.5).
 *
 * aios still does not read, hold, or pass a GitHub token: this entry point sends none. The order is "public API first, `gh` on any failure"
 * (`fallbackReleaseSource`), so a machine without `gh` can update from a public repo, while a private repo or a rate-limited IP still works
 * through the user's `gh`.
 *
 * Everything the API returns is untrusted input:
 * - The repo is only the validated `owner/name` of the install (never taken from a response or the Release body).
 * - An asset is chosen by exact name; its `browser_download_url` must be exactly `https://github.com/<repo>/releases/download/<tag>/<name>`.
 * - Redirects are followed by hand (limited count, https only, GitHub's asset hosts only).
 * - Sizes (JSON, small assets, zip) and time are capped, and the body is streamed to a file, never buffered for the zip.
 * Verification (SHA-256, codesign, Team ID, version) is done by the caller exactly as for the `gh` route.
 *
 * Logs carry host and path only (no query). The network entry is this file in main, separate from the plugin Broker.
 */
import { request } from 'node:https'
import { createWriteStream, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import type { Readable } from 'node:stream'
import { log } from '../../common/logger.js'
import { parseReason, reasonError, type ReasonCode } from '@shared/reason.js'
import type { ReleaseSource } from './release-source.js'

const API_HOST = 'api.github.com'
const WEB_HOST = 'github.com'
/** Hosts GitHub redirects a release asset to (confirmed 2026-11-20: `release-assets.githubusercontent.com`). */
export const ASSET_REDIRECT_HOSTS: readonly string[] = [
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com'
]
const MAX_REDIRECTS = 4
const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_SMALL_ASSET_BYTES = 4 * 1024 * 1024
const MAX_ZIP_BYTES = 1024 * 1024 * 1024
const API_TIMEOUT_MS = 30_000
/** Idle socket timeout while downloading; the total time of one asset is capped separately. */
const IDLE_TIMEOUT_MS = 60_000
const TOTAL_DOWNLOAD_TIMEOUT_MS = 20 * 60_000

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** One HTTP hop (no redirect following). Replaced in tests. */
export interface HttpResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: Readable
}
export type HttpGet = (url: URL, options: { readonly accept: string; readonly timeoutMs: number }) => Promise<HttpResponse>

export const httpsGet: HttpGet = (url, options) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        headers: { accept: options.accept, 'user-agent': 'aios-updater', 'x-github-api-version': '2022-11-28' },
        timeout: options.timeoutMs
      },
      (res) => {
        const headers: Record<string, string | undefined> = {}
        for (const [key, value] of Object.entries(res.headers)) headers[key] = Array.isArray(value) ? value[0] : value
        resolve({ status: res.statusCode ?? 0, headers, body: res })
      }
    )
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
    req.end()
  })

type Phase = 'update-check-failed' | 'update-download-failed'

function logHop(event: string, url: URL, extra: Record<string, string | number> = {}): void {
  // Host and path only: the query of a signed asset URL is never logged.
  log.info(event, { host: url.hostname, path: url.pathname, ...extra })
}

function codeOf(err: unknown): ReasonCode | null {
  return err instanceof Error && err.name === 'ReasonError' ? (parseReason(err.message)?.code ?? null) : null
}

function networkFailure(err: unknown, fallback: Phase): Error {
  if (codeOf(err) !== null) return err as Error
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return reasonError(fallback === 'update-check-failed' ? 'update-timeout' : fallback)
  if (typeof code === 'string' && /^(ENOTFOUND|ECONN|EAI_|ENETUNREACH|EHOSTUNREACH|EPIPE|CERT_|ERR_TLS|UNABLE_TO|DEPTH_ZERO|SELF_SIGNED)/.test(code)) {
    return reasonError('update-network')
  }
  return reasonError(fallback)
}

function statusFailure(status: number, fallback: Phase): Error {
  if (status === 403 || status === 429) return reasonError('update-rate-limited')
  if (status === 404) return reasonError(fallback === 'update-check-failed' ? 'update-no-release' : fallback)
  return reasonError(fallback)
}

/** Read a whole body, failing as soon as it exceeds `max` bytes. */
async function readLimited(body: Readable, max: number, fallback: Phase): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      total += buf.length
      if (total > max) {
        body.destroy()
        throw reasonError(fallback)
      }
      chunks.push(buf)
    }
  } catch (err) {
    throw networkFailure(err, fallback)
  }
  return Buffer.concat(chunks)
}

/** Fetch an API URL (https, `api.github.com`, no redirects) and parse the JSON, capped in size. */
async function getApiJson(get: HttpGet, path: string, fallback: Phase): Promise<unknown> {
  const url = new URL(`https://${API_HOST}${path}`)
  logHop('update.public.api', url)
  let res: HttpResponse
  try {
    res = await get(url, { accept: 'application/vnd.github+json', timeoutMs: API_TIMEOUT_MS })
  } catch (err) {
    throw networkFailure(err, fallback)
  }
  if (res.status !== 200) {
    res.body.destroy()
    throw statusFailure(res.status, fallback)
  }
  const text = (await readLimited(res.body, MAX_JSON_BYTES, fallback)).toString('utf8')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw reasonError(fallback)
  }
}

interface ReleaseAsset {
  readonly name: string
  readonly size: number
  readonly url: string
}
interface ReleaseInfo {
  readonly tag: string
  readonly assets: readonly ReleaseAsset[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Validate the release JSON. A draft or prerelease, or a malformed tag, is refused. */
export function parseRelease(json: unknown, fallback: Phase = 'update-check-failed'): ReleaseInfo {
  if (!isRecord(json) || json['draft'] !== false || json['prerelease'] !== false) throw reasonError(fallback)
  const tag = json['tag_name']
  if (typeof tag !== 'string' || !TAG_RE.test(tag)) throw reasonError(fallback)
  const raw = json['assets']
  const assets: ReleaseAsset[] = []
  if (Array.isArray(raw)) {
    for (const a of raw) {
      if (!isRecord(a)) continue
      const { name, size, browser_download_url: url } = a
      if (typeof name === 'string' && typeof size === 'number' && typeof url === 'string') assets.push({ name, size, url })
    }
  }
  return { tag, assets }
}

/** The only acceptable asset names: no path separators, no traversal, not empty. */
function isSafeAssetName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[\\/\0]/.test(name) && name.length <= 200
}

function sizeLimitOf(name: string): number {
  return name.endsWith('.zip') ? MAX_ZIP_BYTES : MAX_SMALL_ASSET_BYTES
}

/** Whether `url` is exactly the download URL this repo's Release asset must have. */
function isExpectedAssetUrl(url: string, repo: string, tag: string, name: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === WEB_HOST &&
      parsed.port === '' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      decodeURIComponent(parsed.pathname) === `/${repo}/releases/download/${tag}/${name}`
    )
  } catch {
    return false
  }
}

/** The unauthenticated source. `repo` must already be a validated `owner/name`. */
export function publicReleaseSource(repo: string, get: HttpGet = httpsGet): ReleaseSource {
  if (!REPO_RE.test(repo)) throw new Error('invalid repo')
  const apiRepo = `/repos/${repo}/releases`
  return {
    async latestTag() {
      return parseRelease(await getApiJson(get, `${apiRepo}/latest`, 'update-check-failed')).tag
    },

    async download(tag, names, dir) {
      if (!TAG_RE.test(tag)) throw reasonError('update-download-failed')
      for (const name of names) if (!isSafeAssetName(name)) throw reasonError('update-download-failed')
      const release = parseRelease(await getApiJson(get, `${apiRepo}/tags/${encodeURIComponent(tag)}`, 'update-download-failed'), 'update-download-failed')
      if (release.tag !== tag) throw reasonError('update-download-failed')
      // Same as `gh release download -p`: an asset the Release does not have is skipped (the caller checks `existsSync` and treats a
      // missing file in its own way), and only when nothing at all matched does it fail (gh exits non-zero then). Safety checks of the assets that exist stay strict.
      let fetched = 0
      for (const name of names) {
        const asset = release.assets.find((a) => a.name === name)
        if (asset === undefined) continue
        if (!isExpectedAssetUrl(asset.url, repo, tag, name)) throw reasonError('update-download-failed')
        const max = sizeLimitOf(name)
        if (!Number.isInteger(asset.size) || asset.size < 0 || asset.size > max) throw reasonError('update-download-failed')
        await downloadAsset(get, new URL(asset.url), join(dir, name), asset.size, max)
        fetched += 1
      }
      if (names.length > 0 && fetched === 0) throw reasonError('update-download-failed')
    }
  }
}

async function downloadAsset(get: HttpGet, first: URL, dest: string, expectedSize: number, max: number): Promise<void> {
  const deadline = Date.now() + TOTAL_DOWNLOAD_TIMEOUT_MS
  let url = first
  let res: HttpResponse | null = null
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    logHop('update.public.fetch', url, { hop })
    try {
      res = await get(url, { accept: 'application/octet-stream', timeoutMs: IDLE_TIMEOUT_MS })
    } catch (err) {
      throw networkFailure(err, 'update-download-failed')
    }
    if (res.status < 300 || res.status >= 400) break
    res.body.destroy()
    const location = res.headers['location']
    if (hop === MAX_REDIRECTS || location === undefined) throw reasonError('update-download-failed')
    let next: URL
    try {
      next = new URL(location, url)
    } catch {
      throw reasonError('update-download-failed')
    }
    if (next.protocol !== 'https:' || next.port !== '' || next.username !== '' || !ASSET_REDIRECT_HOSTS.includes(next.hostname)) {
      log.warn('update.public.redirect-refused', { host: next.hostname })
      throw reasonError('update-download-failed')
    }
    url = next
    res = null
  }
  if (res === null) throw reasonError('update-download-failed')
  if (res.status !== 200) {
    res.body.destroy()
    throw statusFailure(res.status, 'update-download-failed')
  }
  const declared = Number(res.headers['content-length'])
  if (Number.isFinite(declared) && declared > max) {
    res.body.destroy()
    throw reasonError('update-download-failed')
  }

  let received = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length
      if (received > max || received > expectedSize) cb(reasonError('update-download-failed'))
      else if (Date.now() > deadline) cb(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
      else cb(null, chunk)
    }
  })
  try {
    await pipeline(res.body, limiter, createWriteStream(dest, { flags: 'w', mode: 0o600 }))
    if (received !== expectedSize) throw reasonError('update-download-failed')
  } catch (err) {
    rmSync(dest, { force: true })
    throw networkFailure(err, 'update-download-failed')
  }
}

/**
 * Try `primary` (the public API), and on any failure try `secondary` (the user's `gh`). If both fail, the secondary's reason is reported,
 * except that "no `gh`" is never shown (the public route did not need it), and "`gh` login required" is shown only when the public API
 * answered 404 (a private repo, where `gh` is the way in). For a network or rate-limit failure the primary's reason is the useful one.
 */
export function fallbackReleaseSource(primary: ReleaseSource, secondary: ReleaseSource): ReleaseSource {
  const attempt = async <T>(run: (source: ReleaseSource) => Promise<T>): Promise<T> => {
    try {
      return await run(primary)
    } catch (primaryErr) {
      log.info('update.public.fallback-to-gh', { reason: codeOf(primaryErr) })
      try {
        return await run(secondary)
      } catch (secondaryErr) {
        const code = codeOf(secondaryErr)
        const ghOnly = code === 'update-gh-missing' || (code === 'update-gh-auth' && codeOf(primaryErr) !== 'update-no-release')
        throw ghOnly ? primaryErr : secondaryErr
      }
    }
  }
  return {
    latestTag: () => attempt((s) => s.latestTag()),
    download: (tag, names, dir) => attempt((s) => s.download(tag, names, dir))
  }
}
