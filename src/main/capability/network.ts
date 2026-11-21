/**
 * The sending part of the network capability (ARCHITECTURE.md 7.7).
 *
 * The decisions belong to the pure functions in `net-policy.ts`; this file only **connects pinned to the resolved IP**,
 * follows redirects itself, and cuts the response size.
 * `lookup` and `request` can be swapped out so that
 * unit tests can run the whole path without using a real network.
 */
import { lookup as dnsLookup } from 'node:dns'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { BrokerNetFetchResult } from '@shared/plugin.js'
import {
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  NetDenied,
  checkRedirect,
  checkRequest,
  pickAddress
} from './net-policy.js'

export interface Address {
  readonly address: string
  readonly family: number
}

export interface NetTransport {
  /** Host name -> list of addresses. Every entry is checked, so return the equivalent of all: true. */
  resolve(hostname: string): Promise<readonly Address[]>
  /** Sending for one hop. The caller follows redirects. */
  send(
    url: URL,
    options: {
      method: string
      headers: Record<string, string>
      body: string | Uint8Array | null
      /** The resolved address. Connect pinned to it (DNS rebinding defense). */
      address: string
    }
  ): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array; truncated: boolean }>
}

export interface FetchInput {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | Uint8Array | null
  readonly allowedHosts: readonly string[]
  /** The credential header. Passed paired with the host it may be attached to. **The value does not leave here.** */
  readonly credential: { readonly host: string; readonly header: string; readonly value: string } | null
  /**
   * TODO 1264 review: an extra condition on the credential, checked **again at every hop** (method and URL of that hop). A redirect that
   * leaves it drops the credential, exactly like a redirect to another host. Absent = only the host decides (Gmail and the others).
   */
  readonly credentialAllowed?: (method: string, url: string) => boolean
}

/**
 * HTTP to allowed hosts.
 *
 * At every redirect it follows, the allowlist and the resolved IP are checked again,
 * and when the host changes the credential header is stripped (7.7). With `credentialAllowed`, a hop it refuses is sent without it too.
 */
export async function brokeredFetch(
  input: FetchInput,
  transport: NetTransport
): Promise<BrokerNetFetchResult> {
  let url = new URL(input.url)
  const credentialHost = input.credential?.host ?? null
  let keepCredentials = credentialHost !== null && url.hostname.toLowerCase() === credentialHost.toLowerCase()
  let method = input.method
  let body = input.body

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    checkRequest({ url, allowedHosts: input.allowedHosts })
    const addresses = await transport.resolve(url.hostname)
    const picked = pickAddress(addresses)

    const headers: Record<string, string> = { ...stripAuthHeaders(input.headers) }
    if (keepCredentials && input.credential !== null) {
      headers[input.credential.header] = input.credential.value
    }

    const response = await transport.send(url, {
      method,
      headers,
      body,
      address: picked.address
    })

    const location = response.headers['location']
    const isRedirect = response.status >= 300 && response.status < 400 && location !== undefined
    if (!isRedirect) {
      return {
        status: response.status,
        headers: response.headers,
        // The limit is counted in bytes (C-3). Even if the transport does not honor the limit, it is cut here.
        body: standaloneBytes(response.body, MAX_RESPONSE_BYTES),
        truncated: response.truncated || response.body.byteLength > MAX_RESPONSE_BYTES
      }
    }

    const decision = checkRedirect(url, location, input.allowedHosts, credentialHost)
    url = decision.next
    // 303, and 301 / 302 for a POST, fall back to GET (RFC 9110).
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET')) {
      method = 'GET'
      body = null
    }
    keepCredentials = decision.keepCredentials && (input.credentialAllowed?.(method, url.href) ?? true)
  }
  throw new NetDenied('too-many-redirects')
}

/**
 * A copy of the backing ArrayBuffer holding **only those bytes** (C-3).
 *
 * `postMessage` to the utility process uses structured clone, which sends **the whole backing ArrayBuffer**
 * rather than the `Uint8Array` view. Node's small Buffers are slices of a shared pool (8 KB), so
 * passing one as is could expose other values of main (such as the string that built a credential header) to the plugin.
 */
export function standaloneBytes(bytes: Uint8Array, limit: number = Number.MAX_SAFE_INTEGER): Uint8Array {
  const length = Math.min(bytes.byteLength, limit)
  const out = new Uint8Array(length)
  out.set(bytes.subarray(0, length))
  return out
}

/**
 * Drops authentication headers the plugin attached itself.
 * Only the Broker attaches credentials; a plugin holds just the **name** (7.7).
 */
function stripAuthHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (lower === 'authorization' || lower === 'cookie' || lower === 'proxy-authorization') continue
    if (lower === 'host' || lower === 'content-length') continue
    out[key] = value
  }
  return out
}

/** The real transport. Connects to the resolved address and keeps the TLS verification name as the host name. */
export const nodeTransport: NetTransport = {
  resolve(hostname) {
    return new Promise((resolvePromise, reject) => {
      dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
        if (err !== null) reject(err)
        else resolvePromise(addresses.map((a) => ({ address: a.address, family: a.family })))
      })
    })
  },
  send(url, options) {
    return new Promise((resolvePromise, reject) => {
      const requestOptions: RequestOptions = {
        method: options.method,
        // **Connect pinned to the resolved address.** Reconnecting by host name could
        // go to a different IP from the one that was checked (DNS rebinding).
        host: options.address,
        servername: url.hostname,
        port: url.port === '' ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        headers: { ...options.headers, host: url.host },
        // The caller follows redirects, checking as it goes.
        timeout: 30_000
      }
      const req = httpsRequest(requestOptions, (res: IncomingMessage) => {
        const chunks: Buffer[] = []
        let size = 0
        let truncated = false
        let done = false
        res.on('data', (chunk: Buffer) => {
          if (truncated) return
          // **Cut exactly at the limit** (it used to discard the whole chunk that went over the limit).
          const room = MAX_RESPONSE_BYTES - size
          if (chunk.byteLength > room) {
            chunks.push(chunk.subarray(0, room))
            size += room
            truncated = true
            res.destroy()
            return
          }
          chunks.push(chunk)
          size += chunk.byteLength
        })
        const finish = (): void => {
          // Both `end` and `close` arrive. The second does nothing.
          if (done) return
          done = true
          const headers: Record<string, string> = {}
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') headers[key] = value
            else if (Array.isArray(value)) headers[key] = value.join(', ')
          }
          // Copy into a dedicated region that does not use the shared pool (the reason for `standaloneBytes`).
          const body = new Uint8Array(size)
          let at = 0
          for (const chunk of chunks) {
            body.set(chunk, at)
            at += chunk.byteLength
          }
          resolvePromise({
            status: res.statusCode ?? 0,
            headers,
            body,
            truncated
          })
        }
        res.on('end', finish)
        res.on('close', finish)
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', reject)
      if (options.body !== null) req.write(options.body)
      req.end()
    })
  }
}
