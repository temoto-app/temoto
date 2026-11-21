/**
 * @vitest-environment jsdom
 *
 * viewer (sandboxed iframe) shortcuts of the app pressed inside it are sent back to the host (item 189, wave 14 bundle D).
 *
 * What to check:
 *  - a key that matches the table the host passed (`ViewerHostMessage.shortcuts`) is stopped in the **capture phase**
 *    (`preventDefault`, and it does not reach the listener below), and `{ type: 'shortcut', id }` goes out on the port
 *  - a key not in the table (the editor's ⌘F) passes through unstopped
 *  - before the table arrives, during IME composition, and for other modifier combinations, nothing is caught
 * The port is a fake, not a real MessageChannel (Node's port cannot be passed to jsdom's MessageEvent).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { ViewerGuestMessage, ViewerHostMessage, ViewerShortcut } from '../src/shared/plugin.js'
import { connect } from '../plugins/_shared/bridge.js'
import { matchViewerShortcut } from '../plugins/_shared/shortcuts.js'
import { viewerForwardedShortcuts } from '../src/renderer/src/shortcuts.js'

interface FakePort {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: ReturnType<typeof vi.fn>
  start: () => void
}

const TABLE: readonly ViewerShortcut[] = viewerForwardedShortcuts('mac')

let port: FakePort

function sent(): ViewerGuestMessage[] {
  return port.postMessage.mock.calls.map((call) => call[0] as ViewerGuestMessage)
}

function press(init: KeyboardEventInit): { event: KeyboardEvent; reachedBelow: boolean } {
  // Stands in for CodeMirror: a listener attached with bubble on an element in the document. If it is stopped in the capture phase, it does not arrive.
  const target = document.getElementById('editor') as HTMLElement
  let reachedBelow = false
  const below = (): void => {
    reachedBelow = true
  }
  target.addEventListener('keydown', below)
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  target.removeEventListener('keydown', below)
  return { event, reachedBelow }
}

function resource(shortcuts?: readonly ViewerShortcut[]): void {
  const message: ViewerHostMessage = {
    type: 'resource',
    uri: 'file:///x.md',
    label: 'x.md',
    resource: { kind: 'text', text: '', truncated: false, size: 0 },
    editable: true,
    theme: 'light',
    locale: 'en',
    ...(shortcuts === undefined ? {} : { shortcuts })
  }
  port.onmessage?.({ data: message } as MessageEvent)
}

beforeAll(() => {
  document.body.innerHTML = '<div id="editor" tabindex="0"></div>'
  connect('aios.test')
  port = { onmessage: null, postMessage: vi.fn(), start: () => undefined }
  const event = new MessageEvent('message')
  Object.defineProperty(event, 'ports', { value: [port] })
  Object.defineProperty(event, 'source', { value: window.parent })
  window.dispatchEvent(event)
})

describe('sending app shortcuts back from the viewer (item 189)', () => {
  it('picks up nothing before the table arrives', () => {
    port.postMessage.mockClear()
    const { event, reachedBelow } = press({ key: 'p', metaKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(reachedBelow).toBe(true)
    expect(sent().filter((m) => m.type === 'shortcut')).toEqual([])
  })

  it('stops keys in the table at the capture phase and sends the id to the port', () => {
    resource(TABLE)
    port.postMessage.mockClear()
    const cases: [KeyboardEventInit, string][] = [
      [{ key: 'p', metaKey: true }, 'names'],
      [{ key: 'F', metaKey: true, shiftKey: true }, 'files'],
      [{ key: 'k', metaKey: true }, 'conversation'],
      [{ key: 'p', ctrlKey: true }, 'names'],
      [{ key: 'f', ctrlKey: true }, 'files']
    ]
    for (const [init, id] of cases) {
      port.postMessage.mockClear()
      const { event, reachedBelow } = press(init)
      expect(event.defaultPrevented).toBe(true)
      expect(reachedBelow).toBe(false)
      expect(sent()).toEqual([{ type: 'shortcut', id }])
    }
  })

  it('lets editor keys (the ⌘F search panel) through without stopping them', () => {
    resource(TABLE)
    for (const init of [
      { key: 'f', metaKey: true },
      { key: 'p' },
      { key: 'p', metaKey: true, altKey: true }
    ]) {
      port.postMessage.mockClear()
      const { event, reachedBelow } = press(init)
      expect(event.defaultPrevented).toBe(false)
      expect(reachedBelow).toBe(true)
      expect(sent()).toEqual([])
    }
  })

  it('save (item 313): stops ⌘S / Ctrl+S and returns the save id to the parent; lets it through with Shift / Alt', () => {
    resource(TABLE)
    for (const init of [{ key: 's', metaKey: true }, { key: 's', ctrlKey: true }]) {
      port.postMessage.mockClear()
      const { event, reachedBelow } = press(init)
      expect(event.defaultPrevented).toBe(true)
      expect(reachedBelow).toBe(false)
      expect(sent()).toEqual([{ type: 'shortcut', id: 'save' }])
    }
    for (const init of [
      { key: 'S', metaKey: true, shiftKey: true },
      { key: 's', metaKey: true, altKey: true },
      { key: 's', metaKey: true, isComposing: true },
      { key: 's' }
    ]) {
      port.postMessage.mockClear()
      const { event, reachedBelow } = press(init)
      expect(event.defaultPrevented).toBe(false)
      expect(reachedBelow).toBe(true)
      expect(sent()).toEqual([])
    }
  })

  it('does not pick up during IME composition', () => {
    resource(TABLE)
    port.postMessage.mockClear()
    const { event } = press({ key: 'p', metaKey: true, isComposing: true })
    expect(event.defaultPrevented).toBe(false)
    expect(sent()).toEqual([])
  })

  it('back / forward (TODO 369): ⌃- / ⌃⇧- and the mouse back / forward buttons (sent on release; the press also stops the default)', () => {
    resource(TABLE)
    for (const [init, id] of [
      [{ key: '-', ctrlKey: true }, 'viewerBack'],
      [{ key: '_', ctrlKey: true, shiftKey: true }, 'viewerForward']
    ] as const) {
      port.postMessage.mockClear()
      const { event, reachedBelow } = press(init)
      expect(event.defaultPrevented).toBe(true)
      expect(reachedBelow).toBe(false)
      expect(sent()).toEqual([{ type: 'shortcut', id }])
    }
    const target = document.getElementById('editor') as HTMLElement
    for (const [button, id] of [
      [3, 'viewerBack'],
      [4, 'viewerForward']
    ] as const) {
      port.postMessage.mockClear()
      const down = new MouseEvent('mousedown', { button, bubbles: true, cancelable: true })
      target.dispatchEvent(down)
      expect(down.defaultPrevented).toBe(true)
      expect(sent()).toEqual([])
      const up = new MouseEvent('mouseup', { button, bubbles: true, cancelable: true })
      target.dispatchEvent(up)
      expect(up.defaultPrevented).toBe(true)
      expect(sent()).toEqual([{ type: 'shortcut', id }])
    }
    // A left click is not stopped.
    port.postMessage.mockClear()
    const left = new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true })
    target.dispatchEvent(left)
    expect(left.defaultPrevented).toBe(false)
    expect(sent()).toEqual([])
  })

  it('sending the table again empty stops picking up (the table is replaced per resource)', () => {
    resource([])
    port.postMessage.mockClear()
    const { event } = press({ key: 'k', metaKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(sent()).toEqual([])
    resource(TABLE)
  })
})

describe('matchViewerShortcut (modifiers match exactly)', () => {
  const base = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false }

  it('does not pick up ⌘⇧P with a ⌘P table', () => {
    expect(matchViewerShortcut({ ...base, key: 'P', metaKey: true, shiftKey: true }, TABLE)).toBeNull()
  })

  it('does not pick up ⌘ and Ctrl pressed together', () => {
    expect(matchViewerShortcut({ ...base, key: 'p', metaKey: true, ctrlKey: true }, TABLE)).toBeNull()
  })

  it('does not pick up without modifiers', () => {
    expect(matchViewerShortcut({ ...base, key: 'k' }, TABLE)).toBeNull()
  })

  it('picks up F keys even without modifiers (TODO 1132)', () => {
    const f5: ViewerShortcut = { id: 'search', key: 'F5', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false } as ViewerShortcut
    expect(matchViewerShortcut({ ...base, key: 'F5' }, [f5])).toBe('search')
    expect(matchViewerShortcut({ ...base, key: 'k' }, [f5])).toBeNull()
  })
})
