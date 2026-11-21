/**
 * TODO 579: fetching the favicon counts while reading its size, and stops reading when the cap is exceeded (`src/main/web/favicon.ts`).
 * TODO 743: takes it from the `<link rel=icon>` of a page that has no `/favicon.ico` (`extractIconHref` / `fetchFaviconFromHtml` / `fetchFaviconForHost`).
 */
import { describe, expect, it } from 'vitest'
import {
  extractBaseHref,
  extractIconHref,
  FAVICON_HTML_LIMIT_BYTES,
  fetchFavicon,
  fetchFaviconForHost,
  fetchFaviconFromHtml,
  guardedFaviconFetch,
  MAX_FAVICON_REDIRECTS,
  readBodyLimited,
  readBodyPrefix,
  type FaviconFetch
} from '../src/main/web/favicon.js'

/** `.url` of `new Response(...)` is an empty string by default: in tests, pretend the URL after a redirect. */
function withUrl(response: Response, url: string): Response {
  Object.defineProperty(response, 'url', { value: url })
  return response
}
import { MAX_FAVICON_BYTES } from '../src/shared/web-tabs.js'

/** A stream that sends `chunks` pieces of `size` bytes each. It counts how many were read and whether it was cancelled. */
function countingStream(chunks: number, size: number): {
  stream: ReadableStream<Uint8Array>
  pulled: () => number
  cancelled: () => boolean
} {
  let pulled = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled >= chunks) {
          controller.close()
          return
        }
        pulled += 1
        controller.enqueue(new Uint8Array(size).fill(1))
      },
      cancel() {
        cancelled = true
      }
    },
    { highWaterMark: 0 }
  )
  return { stream, pulled: () => pulled, cancelled: () => cancelled }
}

function respond(body: ReadableStream<Uint8Array> | string | null, headers: Record<string, string>): FaviconFetch {
  return async () => new Response(body, { status: 200, headers })
}

describe('readBodyLimited (TODO 579)', () => {
  it('上限以内なら全部つなげて返す', async () => {
    const { stream } = countingStream(3, 10)
    const bytes = await readBodyLimited(stream, 100)
    expect(bytes?.length).toBe(30)
  })

  it('上限を超えたらそこで cancel して null (残りは読まない)', async () => {
    const { stream, pulled, cancelled } = countingStream(1000, 1024)
    const bytes = await readBodyLimited(stream, 4 * 1024)
    expect(bytes).toBeNull()
    expect(cancelled()).toBe(true)
    expect(pulled()).toBeLessThanOrEqual(6)
  })

  it('body が null なら空', async () => {
    expect((await readBodyLimited(null, 10))?.length).toBe(0)
  })
})

describe('readBodyPrefix (TODO 761、743 の直し)', () => {
  it('上限以内なら全部つなげて返す', async () => {
    const { stream } = countingStream(3, 10)
    const bytes = await readBodyPrefix(stream, 100)
    expect(bytes.length).toBe(30)
  })

  it('上限を超えても null ではなく、先頭だけの prefix を返す', async () => {
    const { stream, cancelled } = countingStream(1000, 1024)
    const bytes = await readBodyPrefix(stream, 4 * 1024)
    expect(bytes.length).toBe(4 * 1024)
    expect(cancelled()).toBe(true)
  })

  it('body が null なら空', async () => {
    expect((await readBodyPrefix(null, 10)).length).toBe(0)
  })

  it('</head> が見えたら上限前でも打ち切る', async () => {
    const html = `<html><head><link rel="icon" href="/a.png"></head>${'x'.repeat(10_000)}`
    const encoded = new TextEncoder().encode(html)
    // Sent in several chunks (if it could be read whole in one read() call, early stopping could not be checked).
    const chunkSize = 64
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < encoded.length; offset += chunkSize) {
          controller.enqueue(encoded.subarray(offset, offset + chunkSize))
        }
        controller.close()
      }
    })
    const bytes = await readBodyPrefix(stream, FAVICON_HTML_LIMIT_BYTES)
    expect(bytes.length).toBeLessThan(html.length)
    expect(Buffer.from(bytes).toString('utf8')).toContain('</head')
  })
})

describe('fetchFavicon (TODO 579)', () => {
  it('content-length の無い巨大な応答は読み切らずに断る', async () => {
    const { stream, pulled, cancelled } = countingStream(10_000, 1024)
    const image = await fetchFavicon(respond(stream, { 'content-type': 'image/png' }), ['https://example.com/f.ico'])
    expect(image).toBeNull()
    expect(cancelled()).toBe(true)
    expect(pulled()).toBeLessThan(MAX_FAVICON_BYTES / 1024 + 4)
  })

  it('小さな画像は data URL', async () => {
    const image = await fetchFavicon(respond('abc', { 'content-type': 'image/x-icon; charset=binary' }), [
      'https://example.com/f.ico'
    ])
    expect(image).toBe(`data:image/x-icon;base64,${Buffer.from('abc').toString('base64')}`)
  })

  it('content-length が上限を超えると読まない', async () => {
    const { stream, pulled } = countingStream(100, 1024)
    const image = await fetchFavicon(
      respond(stream, { 'content-type': 'image/png', 'content-length': String(MAX_FAVICON_BYTES + 1) }),
      ['https://example.com/f.ico']
    )
    expect(image).toBeNull()
    expect(pulled()).toBe(0)
  })

  it('画像でない・空・http(s) でないものは null', async () => {
    expect(await fetchFavicon(respond('x', { 'content-type': 'text/html' }), ['https://e.com/'])).toBeNull()
    expect(await fetchFavicon(respond('', { 'content-type': 'image/png' }), ['https://e.com/f'])).toBeNull()
    expect(await fetchFavicon(respond('x', { 'content-type': 'image/png' }), ['file:///etc/passwd'])).toBeNull()
    expect(await fetchFavicon(respond('x', { 'content-type': 'image/png' }), [])).toBeNull()
  })

  it('data:image/ はそのまま (大きすぎれば null)', async () => {
    const never: FaviconFetch = () => Promise.reject(new Error('no fetch'))
    expect(await fetchFavicon(never, ['data:image/png;base64,AAAA'])).toBe('data:image/png;base64,AAAA')
    expect(await fetchFavicon(never, [`data:image/png;base64,${'A'.repeat(MAX_FAVICON_BYTES * 2)}`])).toBeNull()
  })

  it('時間切れは null', async () => {
    const hang: FaviconFetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    expect(await fetchFavicon(hang, ['https://e.com/f'], 10)).toBeNull()
  })
})

describe('extractIconHref (TODO 743)', () => {
  it('rel="icon" / "shortcut icon" / "apple-touch-icon" のどれでも拾う (文書順で最初)', () => {
    expect(extractIconHref('<link rel="icon" href="/a.png">')).toBe('/a.png')
    expect(extractIconHref('<link rel="shortcut icon" href="/b.png">')).toBe('/b.png')
    expect(extractIconHref('<link rel="apple-touch-icon" href="/c.png">')).toBe('/c.png')
    // Ignores case, the kind of quotes, and the order of attributes.
    expect(extractIconHref(`<link href='/d.png' REL="Icon">`)).toBe('/d.png')
    expect(
      extractIconHref(
        '<head><link rel="stylesheet" href="/s.css"><link rel="icon" href="/first.png"></head><link rel="icon" href="/second.png">'
      )
    ).toBe('/first.png')
  })

  it('rel が icon の形でない <link> や href の無い <link> は無視する', () => {
    expect(extractIconHref('<link rel="canonical" href="/x">')).toBeNull()
    expect(extractIconHref('<link rel="icon">')).toBeNull()
    expect(extractIconHref('<p>no link here</p>')).toBeNull()
  })
})

describe('extractBaseHref (TODO 761、743 の直し)', () => {
  it('<base href> を拾う (文書順で最初)', () => {
    expect(extractBaseHref('<head><base href="https://cdn.example.com/"></head>')).toBe('https://cdn.example.com/')
    expect(extractBaseHref('<base href="/sub/">')).toBe('/sub/')
    expect(extractBaseHref('<base target="_blank" href="/x/">')).toBe('/x/')
  })

  it('無い・href の無い <base> は null', () => {
    expect(extractBaseHref('<html></html>')).toBeNull()
    expect(extractBaseHref('<base target="_blank">')).toBeNull()
  })
})

describe('fetchFaviconFromHtml / fetchFaviconForHost (TODO 743)', () => {
  it('HTML を読んで <link rel=icon> の href を解決し、その画像を取る (相対パス)', async () => {
    const html = '<html><head><link rel="shortcut icon" href="/assets/icon.png"></head></html>'
    const fetch: FaviconFetch = async (url) => {
      if (url === 'https://example.com/') {
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      if (url === 'https://example.com/assets/icon.png') {
        return new Response('abc', { status: 200, headers: { 'content-type': 'image/png' } })
      }
      return new Response(null, { status: 404 })
    }
    const image = await fetchFaviconFromHtml(fetch, 'https://example.com/')
    expect(image).toBe(`data:image/png;base64,${Buffer.from('abc').toString('base64')}`)
  })

  it('TODO 761: 相対の href は要求した URL ではなく、リダイレクト後の response.url を基準に解決する', async () => {
    const html = '<html><head><link rel="icon" href="/assets/icon.png"></head></html>'
    const fetch: FaviconFetch = async (url) => {
      if (url === 'https://old.example/') {
        // Pretends a redirect from old.example/ to redirected.example/.
        return withUrl(
          new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
          'https://redirected.example/'
        )
      }
      if (url === 'https://redirected.example/assets/icon.png') {
        return new Response('abc', { status: 200, headers: { 'content-type': 'image/png' } })
      }
      // If it had resolved from the old URL, it would get 404 here.
      return new Response(null, { status: 404 })
    }
    const image = await fetchFaviconFromHtml(fetch, 'https://old.example/')
    expect(image).toBe(`data:image/png;base64,${Buffer.from('abc').toString('base64')}`)
  })

  it('TODO 761: <base href> があればそれを相対 href の基準にする', async () => {
    const html = '<html><head><base href="https://cdn.example.com/static/"><link rel="icon" href="icon.png"></head></html>'
    const fetch: FaviconFetch = async (url) => {
      if (url === 'https://page.example/') {
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (url === 'https://cdn.example.com/static/icon.png') {
        return new Response('abc', { status: 200, headers: { 'content-type': 'image/png' } })
      }
      return new Response(null, { status: 404 })
    }
    const image = await fetchFaviconFromHtml(fetch, 'https://page.example/')
    expect(image).toBe(`data:image/png;base64,${Buffer.from('abc').toString('base64')}`)
  })

  it('TODO 761: 256 KB を超える大きなページでも <head> 内の icon を見つける (丸ごと失敗にしない)', async () => {
    const padding = 'x'.repeat(FAVICON_HTML_LIMIT_BYTES) // A large body after <head> (the whole page is over the cap)
    const html = `<html><head><link rel="icon" href="/big.png"></head><body>${padding}</body></html>`
    const fetch: FaviconFetch = async (url) => {
      if (url === 'https://big.example.com/') {
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (url === 'https://big.example.com/big.png') {
        return new Response('icon', { status: 200, headers: { 'content-type': 'image/png' } })
      }
      return new Response(null, { status: 404 })
    }
    const image = await fetchFaviconFromHtml(fetch, 'https://big.example.com/')
    expect(image).toBe(`data:image/png;base64,${Buffer.from('icon').toString('base64')}`)
  })

  it('HTML でない・<link rel=icon> が無い・画像が取れないときは null', async () => {
    expect(await fetchFaviconFromHtml(respond('{}', { 'content-type': 'application/json' }), 'https://e.com/')).toBeNull()
    expect(await fetchFaviconFromHtml(respond('<html></html>', { 'content-type': 'text/html' }), 'https://e.com/')).toBeNull()
    expect(
      await fetchFaviconFromHtml(
        respond('<link rel="icon" href="/missing.png">', { 'content-type': 'text/html' }),
        'https://e.com/'
      )
    ).toBeNull()
    // file: and the like are refused by isWebViewerUrl.
    expect(await fetchFaviconFromHtml(respond('x', { 'content-type': 'text/html' }), 'file:///etc/passwd')).toBeNull()
  })

  it('fetchFaviconForHost: /favicon.ico が取れればそれを使い、HTML は読まない', async () => {
    let htmlFetched = false
    const fetch: FaviconFetch = async (url) => {
      if (url === 'https://example.com/favicon.ico') {
        return new Response('ico', { status: 200, headers: { 'content-type': 'image/x-icon' } })
      }
      htmlFetched = true
      return new Response(null, { status: 404 })
    }
    const result = await fetchFaviconForHost(fetch, 'example.com')
    expect(result.image).toBe(`data:image/x-icon;base64,${Buffer.from('ico').toString('base64')}`)
    expect(result.networkError).toBe(false)
    expect(htmlFetched).toBe(false)
  })

  it('fetchFaviconForHost: /favicon.ico がだめなら HTML の <link rel=icon> にフォールバックする', async () => {
    const fetch: FaviconFetch = async (url) => {
      if (url === 'https://example.com/favicon.ico') return new Response(null, { status: 404 })
      if (url === 'https://example.com/') {
        return new Response('<link rel="icon" href="https://cdn.example.com/icon.png">', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        })
      }
      if (url === 'https://cdn.example.com/icon.png') {
        return new Response('icon-bytes', { status: 200, headers: { 'content-type': 'image/png' } })
      }
      return new Response(null, { status: 404 })
    }
    const result = await fetchFaviconForHost(fetch, 'example.com')
    expect(result.image).toBe(`data:image/png;base64,${Buffer.from('icon-bytes').toString('base64')}`)
    expect(result.networkError).toBe(false)
  })

  it('fetchFaviconForHost: どちらも取れなければ null (HTTP で確定、networkError は false)', async () => {
    const fetch: FaviconFetch = async () => new Response(null, { status: 404 })
    const result = await fetchFaviconForHost(fetch, 'down.example')
    expect(result.image).toBeNull()
    expect(result.networkError).toBe(false)
  })

  it('TODO 761: fetch 自体が失敗した (網・時間切れ) ときは networkError: true — 確定の「無い」ではない', async () => {
    const fetch: FaviconFetch = async () => {
      throw new Error('network down')
    }
    const result = await fetchFaviconForHost(fetch, 'offline.example')
    expect(result.image).toBeNull()
    expect(result.networkError).toBe(true)
  })

  it('TODO 761: /favicon.ico が網の失敗でも HTML 側が確定の「無い」なら、どちらかが網の失敗なら全体も不確定扱い (networkError: true)', async () => {
    const fetch: FaviconFetch = async (url) => {
      if (url === 'https://mixed.example/favicon.ico') throw new Error('timeout')
      return new Response(null, { status: 404 })
    }
    const result = await fetchFaviconForHost(fetch, 'mixed.example')
    expect(result.image).toBeNull()
    expect(result.networkError).toBe(true)
  })
})

/**
 * TODO 929: the favicon URL is decided by the page, so main does not send a GET to the inside (private / loopback).
 * A redirect is followed one hop at a time, and its destination is checked too. The only host passed on the inside is the page's own host (`trustedHost`).
 */
describe('guardedFaviconFetch (TODO 929)', () => {
  const PNG = { 'content-type': 'image/png' }
  const ADDRESSES: Record<string, string> = {
    'public.example': '93.184.215.14',
    'cdn.example': '151.101.1.1',
    'router.example': '192.168.1.1',
    'rebind.example': '10.0.0.5',
    localhost: '127.0.0.1'
  }
  function setup(respond: (url: string) => Response, trustedHost: string | null = 'public.example') {
    const sent: string[] = []
    const resolve = async (hostname: string) => {
      if (/^[\d.]+$/.test(hostname)) return [{ address: hostname, family: 4 }]
      if (hostname.includes(':')) return [{ address: hostname, family: 6 }]
      const address = ADDRESSES[hostname]
      if (address === undefined) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
      return [{ address, family: 4 }]
    }
    const fetch = guardedFaviconFetch(
      async (url) => {
        sent.push(url)
        return respond(url)
      },
      { resolve, trustedHost }
    )
    return { fetch, sent }
  }

  it('private / loopback の IP の字面を指す favicon には送らない', async () => {
    const { fetch, sent } = setup(() => new Response('x', { status: 200, headers: PNG }))
    for (const url of [
      'http://192.168.1.1/cgi-bin/reboot',
      'http://127.0.0.1:8080/api/x',
      'http://[::1]/f.ico',
      'http://169.254.169.254/latest/meta-data',
      'http://[::ffff:7f00:1]/f.ico'
    ]) {
      expect(await fetchFavicon(fetch, [url])).toBeNull()
    }
    expect(sent).toEqual([])
  })

  it('名前が内側に解決されるホストにも送らない', async () => {
    const { fetch, sent } = setup(() => new Response('x', { status: 200, headers: PNG }))
    expect(await fetchFavicon(fetch, ['https://router.example/favicon.ico'])).toBeNull()
    expect(sent).toEqual([])
  })

  it('公開のホストは今までどおり取れる', async () => {
    const { fetch, sent } = setup(() => new Response('x', { status: 200, headers: PNG }))
    expect(await fetchFavicon(fetch, ['https://cdn.example/f.png'])).toBe(`data:image/png;base64,${btoa('x')}`)
    expect(sent).toEqual(['https://cdn.example/f.png'])
  })

  it('公開のホストから内側へのリダイレクトは辿らない', async () => {
    const { fetch, sent } = setup((url) =>
      url.startsWith('https://cdn.example/')
        ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/admin' } })
        : new Response('x', { status: 200, headers: PNG })
    )
    expect(await fetchFavicon(fetch, ['https://cdn.example/f.ico'])).toBeNull()
    expect(sent).toEqual(['https://cdn.example/f.ico'])
  })

  it('公開のホストどうしのリダイレクトは段ごとに検めて辿る。相対の location も解く', async () => {
    const { fetch, sent } = setup((url) => {
      if (url === 'https://public.example/favicon.ico') {
        return new Response(null, { status: 301, headers: { location: 'https://cdn.example/a/f.ico' } })
      }
      if (url === 'https://cdn.example/a/f.ico') return new Response(null, { status: 302, headers: { location: '../b.ico' } })
      return new Response('x', { status: 200, headers: PNG })
    })
    expect(await fetchFavicon(fetch, ['https://public.example/favicon.ico'])).not.toBeNull()
    expect(sent).toEqual(['https://public.example/favicon.ico', 'https://cdn.example/a/f.ico', 'https://cdn.example/b.ico'])
  })

  it('リダイレクトの段は上限で止める', async () => {
    const { fetch, sent } = setup(
      (url) => new Response(null, { status: 302, headers: { location: `${url}x` } })
    )
    expect(await fetchFavicon(fetch, ['https://cdn.example/f'])).toBeNull()
    expect(sent).toHaveLength(MAX_FAVICON_REDIRECTS + 1)
  })

  it('利用者が開いたページ自身のホスト (localhost の開発サーバ等) だけは内側でも取れる。port は見ない', async () => {
    const { fetch, sent } = setup(() => new Response('x', { status: 200, headers: PNG }), 'localhost:3000')
    expect(await fetchFavicon(fetch, ['http://localhost:3000/favicon.ico'])).not.toBeNull()
    // Even if the same page points at a different inside host, it is not passed.
    expect(await fetchFavicon(fetch, ['http://192.168.1.1/f.ico'])).toBeNull()
    expect(sent).toEqual(['http://localhost:3000/favicon.ico'])
  })

  it('fetchFaviconForHost の <link rel=icon> の経路も同じ検査を通る (内側の href は送らない)', async () => {
    const { fetch, sent } = setup((url) => {
      if (url.endsWith('/favicon.ico')) return new Response(null, { status: 404 })
      return new Response('<head><link rel="icon" href="http://10.0.0.1/reboot"></head>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })
    })
    const result = await fetchFaviconForHost(fetch, 'public.example')
    expect(result).toEqual({ image: null, networkError: false })
    expect(sent).toEqual(['https://public.example/favicon.ico', 'https://public.example/'])
  })

  it('名前解決の失敗は網の失敗 (networkError、7 日の保留に入れない)', async () => {
    const { fetch } = setup(() => new Response('x', { status: 200, headers: PNG }), null)
    expect(await fetchFaviconForHost(fetch, 'unknown.example')).toEqual({ image: null, networkError: true })
  })
})
