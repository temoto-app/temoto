/**
 * The sending part of `browser.fetchPage` (TODO 848, ARCHITECTURE 7.7). Sends one GET step using the cookies of the web view's session (`persist:aios-web`).
 * **It makes no decisions** - declarations, per-step checks and limits are in `brokeredPageFetch` of `src/main/capability/browser.ts`.
 * This only returns `location` without following redirects.
 *
 * - Owner decision (2026-10-19): the only way to fetch is the session's network fetch (no entry point that renders and reads the DOM).
 *   `session.fetch` uses `redirect: 'manual'` and does not return `location` (each request fails), and `Response.url` is also wrong
 *   (Limitations in Electron's docs), so per-step checks are impossible. We use `net.request` (`session` + `useSessionCookies`) with the same session,
 *   the same Chromium network and the same cookies, with `redirect: 'manual'`, and stop on the `redirect` event.
 * - The body is counted while read and cut at the limit. No body or URL query goes to the log (host only).
 */
import { net, type Session } from 'electron'
import { lookup as dnsLookup } from 'node:dns'
import type { BrowserHop, BrowserTransport } from '../capability/browser.js'

export function webPageTransport(getSession: () => Session): BrowserTransport {
  return {
    resolve(hostname) {
      return new Promise((resolvePromise, reject) => {
        dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
          if (err !== null) reject(err)
          else resolvePromise(addresses.map((a) => ({ address: a.address, family: a.family })))
        })
      })
    },
    send(url, { maxBytes, signal }) {
      return new Promise<BrowserHop>((resolvePromise, reject) => {
        if (signal.aborted) {
          reject(new Error('aborted'))
          return
        }
        const request = net.request({
          method: 'GET',
          url: url.toString(),
          session: getSession(),
          useSessionCookies: true,
          credentials: 'include',
          redirect: 'manual'
        })
        request.setHeader('Accept', 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.1')
        let settled = false
        const finish = (hop: BrowserHop | Error): void => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          if (hop instanceof Error) reject(hop)
          else resolvePromise(hop)
        }
        const onAbort = (): void => {
          request.abort()
          finish(new Error('aborted'))
        }
        signal.addEventListener('abort', onAbort)
        request.on('redirect', (statusCode, _method, redirectUrl) => {
          // Do not follow (`followRedirect` is not called). Checking the destination and the next step is up to the caller.
          request.abort()
          finish({ kind: 'redirect', status: statusCode, location: redirectUrl })
        })
        request.on('response', (response) => {
          const chunks: Buffer[] = []
          let size = 0
          let truncated = false
          const header = response.headers['content-type']
          const contentType = Array.isArray(header) ? (header[0] ?? '') : (header ?? '')
          const done = (): void => {
            const body = new Uint8Array(size)
            let at = 0
            for (const chunk of chunks) {
              body.set(chunk, at)
              at += chunk.byteLength
            }
            finish({ kind: 'response', status: response.statusCode, contentType, body, truncated })
          }
          response.on('data', (chunk: Buffer) => {
            if (truncated) return
            const room = maxBytes - size
            if (chunk.byteLength > room) {
              chunks.push(chunk.subarray(0, room))
              size += room
              truncated = true
              request.abort()
              done()
              return
            }
            chunks.push(chunk)
            size += chunk.byteLength
          })
          response.on('end', done)
          response.on('error', () => finish(new Error('response error')))
        })
        request.on('error', (err) => finish(err))
        request.on('abort', () => finish(new Error('aborted')))
        request.end()
      })
    }
  }
}
