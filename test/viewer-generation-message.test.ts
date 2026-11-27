// @vitest-environment jsdom
/**
 * The host side of TODO 1337 item 12 (wave 107 fix X; TODO 1344 item 7): `ViewerPane` hands the viewer the conversation's opaque token
 * with `resource.generation`, and when only the conversation changes (the same file stays on screen, so no `resource` is resent) it posts
 * a `{ type: 'generation' }` message on the same port. The bridge side (`createPositionReporter`) is tested in `viewer-bridge.test.ts`;
 * this checks the wiring in the component, which had no unit test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ViewerResource } from '../src/shared/types.js'
import type { ResolvedViewer, ViewerHostMessage } from '../src/shared/plugin.js'
import { useStore } from '../src/renderer/src/store.js'
import { useLocale } from '../src/renderer/src/localeStore.js'
import { useThreads } from '../src/renderer/src/threadStore.js'
import { viewerGenerationFor } from '../src/renderer/src/viewerHistory.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

const FILE = 'file:///work/notes.txt'
const TEXT: ResolvedViewer = {
  pluginId: 'aios.text',
  name: 'Text',
  url: 'aios-plugin://aios.text/index.html',
  editable: true,
  delivery: 'text'
}

let container: HTMLDivElement
let root: Root
let guestPort: MessagePort | null
let received: ViewerHostMessage[]

function fakeAios(): unknown {
  const viewer = {
    open: async () => TEXT,
    close: async () => undefined,
    untrackWatch: () => undefined,
    read: async (): Promise<ViewerResource> => ({ kind: 'text', text: 'hello\n', truncated: false, size: 6, mtimeMs: 100 }),
    write: async () => ({ ok: true, mtimeMs: 101, size: 0, reason: null }),
    command: async () => ({ ok: true, result: null })
  }
  const noop = (): (() => void) => () => undefined
  const deep = (path: string): unknown =>
    new Proxy(() => Promise.resolve(undefined), {
      get: (_target, key) => (typeof key === 'string' ? deep(`${path}.${key}`) : undefined),
      apply: () => (path.includes('.on') ? noop() : Promise.resolve(undefined))
    })
  return new Proxy(
    { viewer, plugins: { onChanged: noop }, app: { onMenuCommand: noop, openExternal: async () => undefined } },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : deep(String(key))) }
  )
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (check()) return
    await flush()
  }
  throw new Error(`timed out: ${label}`)
}

/** Receives a port instead of the iframe (jsdom does not load `aios-plugin://`). */
async function connectFrame(): Promise<void> {
  await until(() => container.querySelector('iframe')?.getAttribute('src') === TEXT.url, 'iframe')
  const frame = container.querySelector('iframe') as HTMLIFrameElement
  Object.defineProperty(frame, 'contentWindow', {
    configurable: true,
    get: () => ({
      postMessage: (_message: unknown, _origin: string, transfer: MessagePort[]) => {
        guestPort = transfer[0] ?? null
        guestPort?.addEventListener('message', (event: MessageEvent) => {
          received.push(event.data as ViewerHostMessage)
        })
        guestPort?.start()
      }
    })
  })
  await act(async () => {
    frame.dispatchEvent(new Event('load'))
  })
  await until(() => guestPort !== null, 'port')
}

const generations = (): string[] =>
  received.flatMap((message) => (message.type === 'generation' ? [message.generation] : []))

describe('ViewerPane: the conversation token reaches the viewer (TODO 1337 item 12, TODO 1344 item 7)', () => {
  beforeEach(async () => {
    guestPort = null
    received = []
    ;(window as unknown as { aios: unknown }).aios = fakeAios()
    useLocale.setState({ resolved: 'en' })
    useThreads.setState({ activeThreadId: 'thread-a' })
    useStore.setState({
      selectedUri: null,
      viewerDirty: false,
      draftConflict: null,
      viewerDrafts: {},
      transient: null,
      externalReload: null,
      roots: []
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const { ViewerPane } = await import('../src/renderer/src/components/ViewerPane.js')
    await act(async () => {
      root.render(createElement(ViewerPane))
    })
    await act(async () => {
      useStore.getState().select(FILE)
    })
    await connectFrame()
    await until(() => received.some((message) => message.type === 'resource'), 'resource')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    guestPort?.close()
    useThreads.setState({ activeThreadId: null })
  })

  it('stamps the resource with the token of the conversation on screen', () => {
    const resource = received.find((message) => message.type === 'resource')
    expect(resource).toMatchObject({ type: 'resource', uri: FILE, generation: viewerGenerationFor('thread-a') })
  })

  it('posts the new token when only the conversation changes, and posts nothing when there is no conversation', async () => {
    received.length = 0
    await act(async () => {
      useThreads.setState({ activeThreadId: 'thread-b' })
    })
    await until(() => generations().length > 0, 'generation message')
    expect(generations()).toEqual([viewerGenerationFor('thread-b')])
    // The tokens are opaque and differ per conversation (a viewer cannot name a conversation it was never shown).
    expect(viewerGenerationFor('thread-b')).not.toBe(viewerGenerationFor('thread-a'))
    // The file did not change, so the body is not resent for the switch.
    expect(received.some((message) => message.type === 'resource')).toBe(false)

    received.length = 0
    await act(async () => {
      useThreads.setState({ activeThreadId: null })
    })
    await flush()
    expect(generations()).toEqual([])
  })
})
