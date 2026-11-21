/**
 * TODO 929: one hop of a favicon fetch (`FaviconHop`) and the real name resolution. It makes no decisions — the per-hop checks and how redirects
 * are followed are in `guardedFaviconFetch` in `favicon.ts`.
 *
 * `session.fetch` with `redirect: 'manual'` does not return `location` and fails the whole request (a note in page-fetch.ts, TODO 848), so
 * use `net.request` of the same session and the same Cookies with `redirect: 'manual'`, stop on the `redirect` notification, and
 * return it as a 3xx + `location` response. The body is wrapped in a `Response` while still streaming (`favicon.ts` counts the size as it reads).
 */
import { net, type Session } from 'electron'
import { lookup as dnsLookup } from 'node:dns'
import type { FaviconGuard, FaviconHop } from './favicon.js'

export function faviconHop(getSession: () => Session): FaviconHop {
  return (url, { signal }) =>
    new Promise<Response>((resolvePromise, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'))
        return
      }
      const request = net.request({
        method: 'GET',
        url,
        session: getSession(),
        useSessionCookies: true,
        redirect: 'manual'
      })
      let settled = false
      // The body stream. After the response arrives, make it an error on abort / timeout / 'close' (before end) — with `request.abort()` alone
      // the `ReadableStream` we built is not closed, and with a server that stops mid-body the reader's `reader.read()` waits forever
      // (wave 49 review, TODO 929).
      let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null
      let bodyDone = false
      const failBody = (reason: string): void => {
        if (bodyController === null || bodyDone) return
        bodyDone = true
        try {
          bodyController.error(new Error(reason))
        } catch {
          // Already closed
        }
      }
      const onAbort = (): void => {
        request.abort()
        failBody('aborted')
        if (!settled) {
          settled = true
          reject(new Error('aborted'))
        }
      }
      signal.addEventListener('abort', onAbort, { once: true })
      const settle = (value: Response | Error): void => {
        if (settled) return
        settled = true
        if (value instanceof Error) {
          signal.removeEventListener('abort', onAbort)
          reject(value)
        } else {
          resolvePromise(value)
        }
      }
      request.on('redirect', (statusCode, _method, redirectUrl) => {
        // Do not follow (`followRedirect` is not called). Checking the destination and the next hop is `guardedFaviconFetch`.
        request.abort()
        signal.removeEventListener('abort', onAbort)
        settle(new Response(null, { status: statusCode, headers: { location: redirectUrl } }))
      })
      request.on('response', (response) => {
        const headers = new Headers()
        for (const name of ['content-type', 'content-length']) {
          const value = response.headers[name]
          const first = Array.isArray(value) ? value[0] : value
          if (typeof first === 'string') headers.set(name, first)
        }
        const status = response.statusCode
        const nullBody = status === 204 || status === 205 || status === 304
        if (nullBody) signal.removeEventListener('abort', onAbort)
        const body = nullBody
          ? null
          : new ReadableStream<Uint8Array>({
              start(controller) {
                bodyController = controller
                response.on('data', (chunk: Buffer) => {
                  if (!bodyDone) controller.enqueue(new Uint8Array(chunk))
                })
                response.on('end', () => {
                  signal.removeEventListener('abort', onAbort)
                  if (bodyDone) return
                  bodyDone = true
                  controller.close()
                })
                response.on('error', () => {
                  signal.removeEventListener('abort', onAbort)
                  failBody('response error')
                })
                // 'aborted' / 'close' before 'end' = the body was cut off partway. 'close' is not in the types (the implementation is a Readable), so
                // listen to it as an EventEmitter.
                const cut = (): void => {
                  signal.removeEventListener('abort', onAbort)
                  failBody('response closed')
                }
                response.on('aborted', cut)
                ;(response as unknown as NodeJS.EventEmitter).on('close', cut)
              },
              cancel() {
                bodyDone = true
                signal.removeEventListener('abort', onAbort)
                request.abort()
              }
            })
        // Response does not accept 1xx / out-of-range values, so map them to a definite "none" (502).
        settle(new Response(body, { status: status >= 200 && status <= 599 ? status : 502, headers }))
      })
      request.on('error', (err) => {
        failBody('request error')
        settle(err)
      })
      request.on('abort', () => {
        failBody('aborted')
        settle(new Error('aborted'))
      })
      request.end()
    })
}

/** The real name resolution (`dns.lookup`, all addresses). The brackets of `[::1]` are stripped before passing (`favicon.ts` strips them). */
export const faviconResolve: FaviconGuard['resolve'] = (hostname) =>
  new Promise((resolvePromise, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err !== null) reject(err)
      else resolvePromise(addresses.map((a) => ({ address: a.address, family: a.family })))
    })
  })
