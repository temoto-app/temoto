/**
 * @vitest-environment jsdom
 *
 * TODO 574 (full review 2026-10-09, strengthening the guard): `connect()` in `plugins/_shared/bridge.ts` did not check the sender when it received a port
 * through `window.addEventListener('message', …)` (any sender whose `event.ports[0]` was present was accepted). Only the parent (host) should pass a port,
 * so `event.source === window.parent` was added as a condition. The iframe is an opaque origin, so `event.origin` cannot be compared.
 *
 * Neither the model nor Electron is started.
 */
import { describe, expect, it, vi } from 'vitest'
import { connect } from '../plugins/_shared/bridge.js'

interface FakePort {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: ReturnType<typeof vi.fn>
  start: () => void
}

function makePort(): FakePort {
  return { onmessage: null, postMessage: vi.fn(), start: () => undefined }
}

/** Sends a message with a port to `window.addEventListener('message', …)` (the source can be specified). */
function postPort(port: FakePort, source: unknown): void {
  const event = new MessageEvent('message')
  Object.defineProperty(event, 'ports', { value: [port] })
  Object.defineProperty(event, 'source', { value: source })
  window.dispatchEvent(event)
}

// **Call `connect()` only once in one `describe`.** Each call of `connect` leaves a `message` listener on `window` (the viewer calls connect once per iframe,
// and if a test calls it several times, earlier listeners steal the ports of later tests). Here only the listener of one `connect` is used,
// and the senders are checked in order.
describe('bridge: connect ignores a port from anything other than the parent (window.parent) (TODO 574)', () => {
  it('ignores a port pretending to be from other than the parent and accepts only a port from the parent (window.parent), and does not replace it afterwards', () => {
    const bridge = connect('aios.test')

    // A nested document does not pose as the parent: it sends a port with null or another window as the source, and it is ignored
    const impostor1 = makePort()
    postPort(impostor1, null)
    expect(impostor1.postMessage).not.toHaveBeenCalled()

    const impostor2 = makePort()
    postPort(impostor2, {})
    expect(impostor2.postMessage).not.toHaveBeenCalled()

    // A port from the parent (window.parent) is accepted, and ready is sent
    const real = makePort()
    postPort(real, window.parent)
    expect(real.postMessage.mock.calls.map((call) => call[0])).toEqual([{ type: 'ready', pluginId: 'aios.test' }])

    // After the first valid port is received, a later message does not replace the port (even from the parent)
    const second = makePort()
    postPort(second, window.parent)
    expect(second.postMessage).not.toHaveBeenCalled()

    // TODO 587: 'whether the current view accepts edits' is not re-sent with the same value (it is called on each redraw of Source / Preview)
    real.postMessage.mockClear()
    bridge.reportAcceptsEdits('file:///w/a.md', false)
    bridge.reportAcceptsEdits('file:///w/a.md', false)
    bridge.reportAcceptsEdits('file:///w/a.md', true)
    bridge.reportAcceptsEdits('file:///w/b.md', true)
    expect(real.postMessage.mock.calls.map((call) => call[0])).toEqual([
      { type: 'accepts-edits', uri: 'file:///w/a.md', accepts: false },
      { type: 'accepts-edits', uri: 'file:///w/a.md', accepts: true },
      { type: 'accepts-edits', uri: 'file:///w/b.md', accepts: true }
    ])
  })
})
