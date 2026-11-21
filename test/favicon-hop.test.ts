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

describe('the faviconHop body stalls (wave 49 review, TODO 929)', () => {
  it('even for a server that stalls in the middle of the body, returns null within the timeout', async () => {
    made.mode = 'stall'
    const started = Date.now()
    const result = await fetchFavicon(hop, ['https://example.com/favicon.ico'], 50)
    expect(result).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
    const last = made.requests.at(-1) as FakeRequest
    expect(last.aborted).toBe(true)
  })

  it("when 'close' comes before 'end', the body fails (does not wait)", async () => {
    made.mode = 'close'
    const started = Date.now()
    // Keep the timeout long: we check that it returns on 'close'
    const result = await fetchFavicon(hop, ['https://example.com/favicon.ico'], 10_000)
    expect(result).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
