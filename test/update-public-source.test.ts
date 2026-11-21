/**
 * TODO 1275: the unauthenticated public Release source and the "public API first, `gh` on failure" order.
 * The network is replaced by `HttpGet` (no real request).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { stageRelease } from '../src/main/update/stage.js'
import { releaseZipName } from '../src/main/update/layout.js'
import {
  fallbackReleaseSource,
  publicReleaseSource,
  type HttpGet,
  type HttpResponse
} from '../src/main/update/public-release-source.js'
import { ghReleaseSource, type CommandRunner, type ReleaseSource } from '../src/main/update/release-source.js'
import { parseReason } from '../src/shared/reason.js'

const REPO = 'o/r'
const TAG = 'v1.2.3'
const ZIP = releaseZipName('1.2.3')
const ASSET_HOST = 'release-assets.githubusercontent.com'

function res(status: number, body: string | Buffer = '', headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, body: Readable.from([Buffer.from(body)]) }
}

function assetUrl(name: string): string {
  return `https://github.com/${REPO}/releases/download/${TAG}/${name}`
}

function releaseJson(over: Record<string, unknown> = {}, assets?: unknown[]): string {
  return JSON.stringify({
    tag_name: TAG,
    draft: false,
    prerelease: false,
    assets: assets ?? [
      { name: ZIP, size: 5, browser_download_url: assetUrl(ZIP) },
      { name: 'SHA256SUMS', size: 4, browser_download_url: assetUrl('SHA256SUMS') }
    ],
    ...over
  })
}

/** A fake network: api JSON, asset -> redirect -> bytes. `calls` records every requested URL. */
function fakeGet(opts: { json?: string; apiStatus?: number; redirectTo?: string; bytes?: Record<string, string> } = {}): { get: HttpGet; calls: string[] } {
  const calls: string[] = []
  const get: HttpGet = async (url) => {
    calls.push(`${url.hostname}${url.pathname}`)
    if (url.hostname === 'api.github.com') return res(opts.apiStatus ?? 200, opts.json ?? releaseJson())
    if (url.hostname === 'github.com') return res(302, '', { location: opts.redirectTo ?? `https://${ASSET_HOST}/x/${url.pathname.split('/').pop()}?sig=secret` })
    const name = url.pathname.split('/').pop() ?? ''
    return res(200, (opts.bytes ?? { [ZIP]: 'zip12', SHA256SUMS: 'sums' })[name] ?? '')
  }
  return { get, calls }
}

async function reasonOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p
    return null
  } catch (err) {
    return parseReason(err instanceof Error ? err.message : String(err))?.code ?? 'other'
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-public-src-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('public API source (publicReleaseSource)', () => {
  it('returns the latest tag, and refuses a draft, a pre-release, and an invalid tag', async () => {
    expect(await publicReleaseSource(REPO, fakeGet().get).latestTag()).toBe(TAG)
    expect(await reasonOf(publicReleaseSource(REPO, fakeGet({ json: releaseJson({ draft: true }) }).get).latestTag())).toBe('update-check-failed')
    expect(await reasonOf(publicReleaseSource(REPO, fakeGet({ json: releaseJson({ prerelease: true }) }).get).latestTag())).toBe('update-check-failed')
    expect(await reasonOf(publicReleaseSource(REPO, fakeGet({ json: releaseJson({ tag_name: '../x' }) }).get).latestTag())).toBe('update-check-failed')
  })

  it('turns HTTP failures into reason codes (404 / 403 / 429 / network)', async () => {
    expect(await reasonOf(publicReleaseSource(REPO, fakeGet({ apiStatus: 404 }).get).latestTag())).toBe('update-no-release')
    expect(await reasonOf(publicReleaseSource(REPO, fakeGet({ apiStatus: 403 }).get).latestTag())).toBe('update-rate-limited')
    expect(await reasonOf(publicReleaseSource(REPO, fakeGet({ apiStatus: 429 }).get).latestTag())).toBe('update-rate-limited')
    const down: HttpGet = async () => {
      throw Object.assign(new Error('x'), { code: 'ENOTFOUND' })
    }
    expect(await reasonOf(publicReleaseSource(REPO, down).latestTag())).toBe('update-network')
  })

  it('refuses an API response that is too large', async () => {
    const huge = releaseJson({ pad: 'x'.repeat(3 * 1024 * 1024) })
    expect(await reasonOf(publicReleaseSource(REPO, fakeGet({ json: huge }).get).latestTag())).toBe('update-check-failed')
  })

  it('cannot be created if the repo is invalid', () => {
    expect(() => publicReleaseSource('a/b/c')).toThrow()
    expect(() => publicReleaseSource('a b/c')).toThrow()
  })

  it('follows redirects only to allowed hosts and writes to a file', async () => {
    const { get, calls } = fakeGet()
    await publicReleaseSource(REPO, get).download(TAG, [ZIP, 'SHA256SUMS'], dir)
    expect(readFileSync(join(dir, ZIP), 'utf8')).toBe('zip12')
    expect(readFileSync(join(dir, 'SHA256SUMS'), 'utf8')).toBe('sums')
    expect(calls).toContain(`api.github.com/repos/${REPO}/releases/tags/${TAG}`)
    expect(calls.some((c) => c.startsWith(ASSET_HOST))).toBe(true)
  })

  it('refuses a redirect to a host that is not allowed or to http, and leaves no file', async () => {
    for (const redirectTo of ['https://evil.example.com/a', `http://${ASSET_HOST}/a`, 'https://github.com.evil.example/a']) {
      const src = publicReleaseSource(REPO, fakeGet({ redirectTo }).get)
      expect(await reasonOf(src.download(TAG, ['SHA256SUMS'], dir))).toBe('update-download-failed')
    }
    expect(readdirSync(dir)).toEqual([])
  })

  it('the number of redirects has a limit', async () => {
    const get: HttpGet = async (url) => {
      if (url.hostname === 'api.github.com') return res(200, releaseJson())
      return res(302, '', { location: `https://${ASSET_HOST}/loop` })
    }
    expect(await reasonOf(publicReleaseSource(REPO, get).download(TAG, ['SHA256SUMS'], dir))).toBe('update-download-failed')
  })

  it('refuses a browser_download_url that is on another host, another repo, or has a query', async () => {
    for (const url of [
      `https://evil.example.com/${REPO}/releases/download/${TAG}/SHA256SUMS`,
      `https://github.com/other/repo/releases/download/${TAG}/SHA256SUMS`,
      `https://github.com/${REPO}/releases/download/${TAG}/SHA256SUMS?x=1`,
      `http://github.com/${REPO}/releases/download/${TAG}/SHA256SUMS`
    ]) {
      const json = releaseJson({}, [{ name: 'SHA256SUMS', size: 4, browser_download_url: url }])
      expect(await reasonOf(publicReleaseSource(REPO, fakeGet({ json }).get).download(TAG, ['SHA256SUMS'], dir))).toBe('update-download-failed')
    }
  })

  it('asset names are exact match only, and refuses a name that does not exist or contains a path separator', async () => {
    const src = publicReleaseSource(REPO, fakeGet().get)
    expect(await reasonOf(src.download(TAG, ['SHA256SUMS.sig'], dir))).toBe('update-download-failed')
    expect(await reasonOf(src.download(TAG, [`${ZIP}x`], dir))).toBe('update-download-failed')
    expect(await reasonOf(src.download(TAG, ['../SHA256SUMS'], dir))).toBe('update-download-failed')
    expect(await reasonOf(src.download(TAG, ['a/b'], dir))).toBe('update-download-failed')
    expect(await reasonOf(src.download(TAG, ['..'], dir))).toBe('update-download-failed')
    expect(readdirSync(dir)).toEqual([])
  })

  it('skips an asset not in the Release (same as gh -p), and fails if none can be fetched, and the safety checks for those present are not loosened', async () => {
    const onlyZip = releaseJson({}, [{ name: ZIP, size: 5, browser_download_url: assetUrl(ZIP) }])
    await publicReleaseSource(REPO, fakeGet({ json: onlyZip }).get).download(TAG, [ZIP, 'SHA256SUMS'], dir)
    expect(readdirSync(dir)).toEqual([ZIP])
    const empty = mkdtempSync(join(tmpdir(), 'aios-public-src-'))
    try {
      expect(await reasonOf(publicReleaseSource(REPO, fakeGet({ json: onlyZip }).get).download(TAG, ['SHA256SUMS'], empty))).toBe('update-download-failed')
      // An existing asset with a bad URL still throws even if another asset is missing
      const badUrl = releaseJson({}, [{ name: ZIP, size: 5, browser_download_url: 'https://evil.example/x' }])
      expect(await reasonOf(publicReleaseSource(REPO, fakeGet({ json: badUrl }).get).download(TAG, ['SHA256SUMS', ZIP], empty))).toBe('update-download-failed')
      expect(readdirSync(empty)).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('a Release with only the main zip or without SHA256SUMS cannot proceed past verification on the caller side (stageRelease)', async () => {
    const versionsDir = join(dir, 'versions')
    mkdirSync(versionsDir)
    const layout = { root: dir, versionsDir, link: join(dir, 'link', 'Temoto.app'), repo: REPO, runningVersion: '1.2.2' }
    const noSums = releaseJson({}, [{ name: ZIP, size: 5, browser_download_url: assetUrl(ZIP) }])
    let ran = 0
    const run: CommandRunner = async () => {
      ran += 1
      return { code: 0, stdout: '', stderr: '' }
    }
    const source = publicReleaseSource(REPO, fakeGet({ json: noSums }).get)
    expect(await reasonOf(stageRelease(layout, TAG, '1.2.3', source, run))).toBe('update-download-failed')
    expect(ran).toBe(0)
    expect(existsSync(join(versionsDir, '1.2.3'))).toBe(false)
  })

  it('refuses a main file larger or smaller than declared and removes the partial write', async () => {
    for (const body of ['sums-too-long', 'su']) {
      const src = publicReleaseSource(REPO, fakeGet({ bytes: { SHA256SUMS: body } }).get)
      expect(await reasonOf(src.download(TAG, ['SHA256SUMS'], dir))).toBe('update-download-failed')
    }
    expect(readdirSync(dir)).toEqual([])
  })

  it('does not fetch an asset whose declared size exceeds the limit', async () => {
    const json = releaseJson({}, [{ name: 'SHA256SUMS', size: 10 * 1024 * 1024, browser_download_url: assetUrl('SHA256SUMS') }])
    const { get, calls } = fakeGet({ json })
    expect(await reasonOf(publicReleaseSource(REPO, get).download(TAG, ['SHA256SUMS'], dir))).toBe('update-download-failed')
    expect(calls.some((c) => c.startsWith('github.com'))).toBe(false)
  })

  it('refuses when the tag disagrees with the response', async () => {
    const src = publicReleaseSource(REPO, fakeGet({ json: releaseJson({ tag_name: 'v9.9.9' }) }).get)
    expect(await reasonOf(src.download(TAG, ['SHA256SUMS'], dir))).toBe('update-download-failed')
  })
})

describe('public API → gh order (fallbackReleaseSource)', () => {
  const failing = (code: 'update-no-release' | 'update-network'): ReleaseSource => ({
    latestTag: async () => {
      throw Object.assign(new Error(`aios-reason:${code}`), { name: 'ReasonError' })
    },
    download: async () => {
      throw Object.assign(new Error(`aios-reason:${code}`), { name: 'ReasonError' })
    }
  })

  it('does not call gh when the public API succeeds', async () => {
    let ghCalls = 0
    const run: CommandRunner = async () => {
      ghCalls += 1
      return { code: 0, stdout: 'v0.0.1\n', stderr: '' }
    }
    const src = fallbackReleaseSource(publicReleaseSource(REPO, fakeGet().get), ghReleaseSource(REPO, run))
    expect(await src.latestTag()).toBe(TAG)
    expect(ghCalls).toBe(0)
  })

  it('fetches with gh when the public API fails (both the query and the download)', async () => {
    const calls: string[][] = []
    const run: CommandRunner = async (_c, args) => {
      calls.push([...args])
      return { code: 0, stdout: 'v0.9.0\n', stderr: '' }
    }
    const src = fallbackReleaseSource(publicReleaseSource(REPO, fakeGet({ apiStatus: 403 }).get), ghReleaseSource(REPO, run))
    expect(await src.latestTag()).toBe('v0.9.0')
    await src.download(TAG, ['SHA256SUMS'], dir)
    expect(calls.map((a) => a[1])).toEqual(['view', 'download'])
  })

  it("shows the public API's reason when gh is missing (update-gh-missing does not appear)", async () => {
    const missing: CommandRunner = async () => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    }
    const src = fallbackReleaseSource(failing('update-network'), ghReleaseSource(REPO, missing))
    expect(await reasonOf(src.latestTag())).toBe('update-network')
    const srcPrivate = fallbackReleaseSource(failing('update-no-release'), ghReleaseSource(REPO, missing))
    expect(await reasonOf(srcPrivate.latestTag())).toBe('update-no-release')
  })

  it('gh not logged in: shows update-gh-auth only when the public API is 404', async () => {
    const auth: CommandRunner = async () => ({ code: 4, stdout: '', stderr: 'gh auth login' })
    expect(await reasonOf(fallbackReleaseSource(failing('update-no-release'), ghReleaseSource(REPO, auth)).latestTag())).toBe('update-gh-auth')
    expect(await reasonOf(fallbackReleaseSource(failing('update-network'), ghReleaseSource(REPO, auth)).latestTag())).toBe('update-network')
  })
})
