// @vitest-environment jsdom
/**
 * Fix from the code-review of TODO 673 (critical 4, data loss): the `reloadIfExternallyChanged` effect of `ViewerPane` did not remember that it had consumed
 * `externalReload` (the store's one-time instruction, TODO 673). Each time the identity of `viewer` / `reloadFromDisk` changed (e.g. the reselect of 471), this effect ran again
 * and re-read **the same** `externalReload` as a 'new instruction' any number of times (`reloadFromDisk` discards drafts without asking: `setDraft(null)` / `forgetDraft` / `setDraftConflict(null)`).
 *
 * Here it is checked by the call count of `window.aios.viewer.read`: after one re-read of the outside rewrite, even when the reopen of 471 happens
 * (the uri does not change, but the identity of `viewer` / `reloadFromDisk` does), `read` is not called again. Before the fix, this was called one extra time here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ViewerResource } from '../src/shared/types.js'
import type { ResolvedViewer, ViewerHostMessage } from '../src/shared/plugin.js'
import { useStore } from '../src/renderer/src/store.js'
import { useLocale } from '../src/renderer/src/localeStore.js'

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

const text = (body: string, mtimeMs: number): ViewerResource => ({
  kind: 'text',
  text: body,
  truncated: false,
  size: body.length,
  mtimeMs
})

const MD = 'file:///work/notes.md'
const MARKDOWN: ResolvedViewer = {
  pluginId: 'aios.markdown',
  name: 'Markdown',
  url: 'aios-plugin://aios.markdown/index.html',
  editable: true,
  delivery: 'text'
}
const TEXT: ResolvedViewer = {
  pluginId: 'aios.text',
  name: 'Text',
  url: 'aios-plugin://aios.text/index.html',
  editable: true,
  delivery: 'text'
}

let disk: { text: string; mtimeMs: number }
let markdownEnabled: boolean
let container: HTMLDivElement
let root: Root
let guestPort: MessagePort | null
let received: ViewerHostMessage[]
let pluginListeners: Array<() => void>
let reads: string[]

function fakeAios(): unknown {
  const viewer = {
    open: async (uri: string) => (markdownEnabled && uri.endsWith('.md') ? MARKDOWN : TEXT),
    close: async () => undefined,
    untrackWatch: () => undefined,
    read: async (pluginId: string): Promise<ViewerResource> => {
      reads.push(pluginId)
      return text(disk.text, disk.mtimeMs)
    },
    write: async () => ({ ok: true, mtimeMs: disk.mtimeMs + 1, size: 0, reason: null }),
    command: async () => ({ ok: true, result: null })
  }
  const plugins = {
    onChanged: (listener: () => void) => {
      pluginListeners.push(listener)
      return () => {
        pluginListeners = pluginListeners.filter((item) => item !== listener)
      }
    }
  }
  const noop = (): (() => void) => () => undefined
  const deep = (path: string): unknown =>
    new Proxy(() => Promise.resolve(undefined), {
      get: (_target, key) => (typeof key === 'string' ? deep(`${path}.${key}`) : undefined),
      apply: () => (path.includes('.on') ? noop() : Promise.resolve(undefined))
    })
  return new Proxy(
    { viewer, plugins, app: { onMenuCommand: noop, openExternal: async () => undefined } },
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

const frameSrc = (): string | null => container.querySelector('iframe')?.getAttribute('src') ?? null

/** Receives a port instead of the iframe (jsdom does not load `aios-plugin://`). */
async function connectFrame(src: string): Promise<void> {
  await until(() => frameSrc() === src, `iframe ${src}`)
  guestPort?.close()
  guestPort = null
  received = []
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

async function pluginsChanged(): Promise<void> {
  await act(async () => {
    for (const listener of pluginListeners) listener()
  })
  await flush()
}

describe('ViewerPane: externalReload is consumed only once (TODO 673, code-review fix, severe 4)', () => {
  beforeEach(async () => {
    disk = { text: '# Notes\n', mtimeMs: 100 }
    markdownEnabled = true
    guestPort = null
    received = []
    pluginListeners = []
    reads = []
    ;(window as unknown as { aios: unknown }).aios = fakeAios()
    useLocale.setState({ resolved: 'en' })
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
      useStore.getState().select(MD)
    })
    await connectFrame(MARKDOWN.url)
    await until(() => reads.length === 1, 'first read')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    guestPort?.close()
  })

  it('after one reload, does not read twice on the reopen of 471 (same uri)', async () => {
    // Outside rewrite (TODO 673): there is no draft, so it is silently re-read
    disk = { text: '# Notes\nv2\n', mtimeMs: 200 }
    await act(async () => {
      useStore.getState().requestExternalReload(MD)
    })
    await until(() => reads.length === 2, 'external reload read')

    // 471: disable the extension and reopen. The uri (MD) does not change, but the identity of `viewer` / `reloadFromDisk` does. Before the fix, `reloadIfExternallyChanged`
    // here also re-read again (taking the old `externalReload` to still be a new instruction), and reads.length became 4.
    markdownEnabled = false
    await pluginsChanged()
    await connectFrame(TEXT.url)
    await until(() => reads.length >= 3, 'reopen read')

    // Only the reopen's own read (one) happens; no extra read from externalReload
    await flush()
    expect(reads.length).toBe(3)
  })

  it('shows the conflict band instead of silently reloading when a draft was born by the time of reload', async () => {
    // Make a draft
    guestPort?.postMessage({ type: 'draft', uri: MD, text: '# Notes\n\nmine\n' })
    await until(() => useStore.getState().viewerDrafts[MD] !== undefined, 'draft stored')

    await act(async () => {
      useStore.getState().requestExternalReload(MD)
    })
    await flush()

    // With a draft present, externalReload does not re-read; it becomes a conflict band
    expect(reads.length).toBe(1)
    expect(useStore.getState().draftConflict).toEqual({ uri: MD, toolName: null })
  })
})
