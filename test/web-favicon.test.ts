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
  it('joins everything and returns it when within the limit', async () => {
    const { stream } = countingStream(3, 10)
    const bytes = await readBodyLimited(stream, 100)
    expect(bytes?.length).toBe(30)
  })

  it('cancels and returns null when the limit is exceeded (does not read the rest)', async () => {
    const { stream, pulled, cancelled } = countingStream(1000, 1024)
    const bytes = await readBodyLimited(stream, 4 * 1024)
    expect(bytes).toBeNull()
    expect(cancelled()).toBe(true)
    expect(pulled()).toBeLessThanOrEqual(6)
  })

  it('empty when body is null', async () => {
    expect((await readBodyLimited(null, 10))?.length).toBe(0)
  })
})

describe('readBodyPrefix (TODO 761, fix for 743)', () => {
  it('joins everything and returns it when within the limit', async () => {
    const { stream } = countingStream(3, 10)
    const bytes = await readBodyPrefix(stream, 100)
    expect(bytes.length).toBe(30)
  })

  it('returns only the leading prefix instead of null even when the limit is exceeded', async () => {
    const { stream, cancelled } = countingStream(1000, 1024)
    const bytes = await readBodyPrefix(stream, 4 * 1024)
    expect(bytes.length).toBe(4 * 1024)
    expect(cancelled()).toBe(true)
  })

  it('empty when body is null', async () => {
    expect((await readBodyPrefix(null, 10)).length).toBe(0)
  })

  it('stops even before the limit once </head> is seen', async () => {
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
  it('refuses a huge response with no content-length without reading it all', async () => {
    const { stream, pulled, cancelled } = countingStream(10_000, 1024)
    const image = await fetchFavicon(respond(stream, { 'content-type': 'image/png' }), ['https://example.com/f.ico'])
    expect(image).toBeNull()
    expect(cancelled()).toBe(true)
    expect(pulled()).toBeLessThan(MAX_FAVICON_BYTES / 1024 + 4)
  })

  it('a small image is a data URL', async () => {
    const image = await fetchFavicon(respond('abc', { 'content-type': 'image/x-icon; charset=binary' }), [
      'https://example.com/f.ico'
    ])
    expect(image).toBe(`data:image/x-icon;base64,${Buffer.from('abc').toString('base64')}`)
  })

  it('does not read when content-length exceeds the limit', async () => {
    const { stream, pulled } = countingStream(100, 1024)
    const image = await fetchFavicon(
      respond(stream, { 'content-type': 'image/png', 'content-length': String(MAX_FAVICON_BYTES + 1) }),
      ['https://example.com/f.ico']
    )
    expect(image).toBeNull()
    expect(pulled()).toBe(0)
  })

  it('null for something that is not an image, is empty, or is not http(s)', async () => {
    expect(await fetchFavicon(respond('x', { 'content-type': 'text/html' }), ['https://e.com/'])).toBeNull()
    expect(await fetchFavicon(respond('', { 'content-type': 'image/png' }), ['https://e.com/f'])).toBeNull()
    expect(await fetchFavicon(respond('x', { 'content-type': 'image/png' }), ['file:///etc/passwd'])).toBeNull()
    expect(await fetchFavicon(respond('x', { 'content-type': 'image/png' }), [])).toBeNull()
  })

  it('data:image/ is returned as is (null if too large)', async () => {
    const never: FaviconFetch = () => Promise.reject(new Error('no fetch'))
    expect(await fetchFavicon(never, ['data:image/png;base64,AAAA'])).toBe('data:image/png;base64,AAAA')
    expect(await fetchFavicon(never, [`data:image/png;base64,${'A'.repeat(MAX_FAVICON_BYTES * 2)}`])).toBeNull()
  })

  it('null on timeout', async () => {
    const hang: FaviconFetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    expect(await fetchFavicon(hang, ['https://e.com/f'], 10)).toBeNull()
  })
})

describe('extractIconHref (TODO 743)', () => {
  it('picks any of rel="icon" / "shortcut icon" / "apple-touch-icon" (the first in document order)', () => {
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

  it('ignores a <link> whose rel is not an icon form or that has no href', () => {
    expect(extractIconHref('<link rel="canonical" href="/x">')).toBeNull()
    expect(extractIconHref('<link rel="icon">')).toBeNull()
    expect(extractIconHref('<p>no link here</p>')).toBeNull()
  })
})

describe('extractBaseHref (TODO 761, fix for 743)', () => {
  it('picks up <base href> (the first in document order)', () => {
    expect(extractBaseHref('<head><base href="https://cdn.example.com/"></head>')).toBe('https://cdn.example.com/')
    expect(extractBaseHref('<base href="/sub/">')).toBe('/sub/')
    expect(extractBaseHref('<base target="_blank" href="/x/">')).toBe('/x/')
  })

  it('null when absent or when <base> has no href', () => {
    expect(extractBaseHref('<html></html>')).toBeNull()
    expect(extractBaseHref('<base target="_blank">')).toBeNull()
  })
})

describe('fetchFaviconFromHtml / fetchFaviconForHost (TODO 743)', () => {
  it('reads the HTML, resolves the href of <link rel=icon>, and fetches that image (relative path)', async () => {
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

  it('TODO 761: a relative href is resolved against the post-redirect response.url, not the requested URL', async () => {
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

  it('TODO 761: if there is a <base href>, it is the base for the relative href', async () => {
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

  it('TODO 761: even for a large page over 256 KB, finds the icon in <head> (does not fail entirely)', async () => {
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

  it('null when it is not HTML, there is no <link rel=icon>, or the image cannot be fetched', async () => {
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

  it('fetchFaviconForHost: uses /favicon.ico if obtained and does not read the HTML', async () => {
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

  it('fetchFaviconForHost: if /favicon.ico fails, falls back to the HTML <link rel=icon>', async () => {
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

  it('fetchFaviconForHost: null when neither can be obtained (settled by HTTP, networkError is false)', async () => {
    const fetch: FaviconFetch = async () => new Response(null, { status: 404 })
    const result = await fetchFaviconForHost(fetch, 'down.example')
    expect(result.image).toBeNull()
    expect(result.networkError).toBe(false)
  })

  it('TODO 761: when the fetch itself failed (network, timeout), networkError: true; not a definite absence', async () => {
    const fetch: FaviconFetch = async () => {
      throw new Error('network down')
    }
    const result = await fetchFaviconForHost(fetch, 'offline.example')
    expect(result.image).toBeNull()
    expect(result.networkError).toBe(true)
  })

  it('TODO 761: even if /favicon.ico was a network failure, when the HTML side is a definite absence, if either was a network failure the whole is treated as undecided (networkError: true)', async () => {
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

  it('does not send to a favicon that points at the literal text of a private / loopback IP', async () => {
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

  it('also does not send to a host whose name resolves to an internal address', async () => {
    const { fetch, sent } = setup(() => new Response('x', { status: 200, headers: PNG }))
    expect(await fetchFavicon(fetch, ['https://router.example/favicon.ico'])).toBeNull()
    expect(sent).toEqual([])
  })

  it('a public host can be fetched as before', async () => {
    const { fetch, sent } = setup(() => new Response('x', { status: 200, headers: PNG }))
    expect(await fetchFavicon(fetch, ['https://cdn.example/f.png'])).toBe(`data:image/png;base64,${btoa('x')}`)
    expect(sent).toEqual(['https://cdn.example/f.png'])
  })

  it('does not follow a redirect from a public host to an internal one', async () => {
    const { fetch, sent } = setup((url) =>
      url.startsWith('https://cdn.example/')
        ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/admin' } })
        : new Response('x', { status: 200, headers: PNG })
    )
    expect(await fetchFavicon(fetch, ['https://cdn.example/f.ico'])).toBeNull()
    expect(sent).toEqual(['https://cdn.example/f.ico'])
  })

  it('redirects between public hosts are checked at each hop and followed; a relative location is also resolved', async () => {
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

  it('stops redirect hops at a limit', async () => {
    const { fetch, sent } = setup(
      (url) => new Response(null, { status: 302, headers: { location: `${url}x` } })
    )
    expect(await fetchFavicon(fetch, ['https://cdn.example/f'])).toBeNull()
    expect(sent).toHaveLength(MAX_FAVICON_REDIRECTS + 1)
  })

  it('only the host of the page the user opened (a localhost dev server etc.) can be fetched even if internal; the port is not looked at', async () => {
    const { fetch, sent } = setup(() => new Response('x', { status: 200, headers: PNG }), 'localhost:3000')
    expect(await fetchFavicon(fetch, ['http://localhost:3000/favicon.ico'])).not.toBeNull()
    // Even if the same page points at a different inside host, it is not passed.
    expect(await fetchFavicon(fetch, ['http://192.168.1.1/f.ico'])).toBeNull()
    expect(sent).toEqual(['http://localhost:3000/favicon.ico'])
  })

  it('the <link rel=icon> path of fetchFaviconForHost goes through the same check (an internal href is not sent)', async () => {
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

  it('a name resolution failure is a network failure (networkError, not put into the 7-day hold)', async () => {
    const { fetch } = setup(() => new Response('x', { status: 200, headers: PNG }), null)
    expect(await fetchFaviconForHost(fetch, 'unknown.example')).toEqual({ image: null, networkError: true })
  })
})
