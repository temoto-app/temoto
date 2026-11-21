// Wave 49 review (TODO 929): the first stage of the favicon lookup (`faviconHop`) returns on timeout even from a server that stops in the middle of the body.
// Calling only `request.abort()` without closing one's own ReadableStream left `reader.read()` waiting forever.
// Does not touch the real network: `net.request` is a fake that emits only the response headers and the start of the body, then stops.
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

interface FakeRequest extends EventEmitter {
  aborted: boolean
  response: EventEmitter | null
  abort(): void
  end(): void
}

const made = vi.hoisted(() => ({ requests: [] as unknown[], mode: 'stall' as 'stall' | 'close' }))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return {
    net: {
      request: () => {
        const request = new Emitter() as FakeRequest
        request.aborted = false
        request.response = null
        request.abort = () => {
          // As in real Electron, 'end' is not emitted for the response body after abort.
          request.aborted = true
        }
        request.end = () => {
          setTimeout(() => {
            const response = Object.assign(new Emitter(), {
              statusCode: 200,
              headers: { 'content-type': 'image/png' }
            })
            request.response = response
            request.emit('response', response)
            setTimeout(() => {
              response.emit('data', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
              if (made.mode === 'close') response.emit('close')
              // 'stall': stops without emitting 'end'
            }, 1)
          }, 1)
        }
        made.requests.push(request)
        return request
      }
    }
  }
})

const { faviconHop } = await import('../src/main/web/favicon-hop.js')
const { fetchFavicon } = await import('../src/main/web/favicon.js')

const hop = faviconHop(() => ({}) as never)

describe('faviconHop の本文が止まる (第 49 波 review、TODO 929)', () => {
  it('本文の途中で止まるサーバでも時間切れの内に null で返る', async () => {
    made.mode = 'stall'
    const started = Date.now()
    const result = await fetchFavicon(hop, ['https://example.com/favicon.ico'], 50)
    expect(result).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
    const last = made.requests.at(-1) as FakeRequest
    expect(last.aborted).toBe(true)
  })

  it("'end' の前に 'close' が来たら本文は失敗になる (待たない)", async () => {
    made.mode = 'close'
    const started = Date.now()
    // Keep the timeout long: we check that it returns on 'close'
    const result = await fetchFavicon(hop, ['https://example.com/favicon.ico'], 10_000)
    expect(result).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
