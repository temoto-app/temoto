// @vitest-environment jsdom
/**
 * TODO 471 (wave 25 bundle B): when an extension is disabled, reopen the file that is open in that viewer.
 *
 * - pure functions (`viewer-reselect.ts`): whether the display has settled (`shownViewer`), and whether to reopen from the trial resolution (`reselectDecision`).
 * - ViewerPane (jsdom): a `.md` opened with `aios.markdown` that has a draft; `plugins.onChanged` (markdown disabled) reopens it in the fallback `aios.text`, and the draft is handed over as is,
 *   in a `resource` with `draft`. Turning it back on returns to markdown.
 *   When `onChanged` does not change the resolved target (e.g. a change of consent), it is not re-read. The trial permission is returned (net zero).
 *   The iframe is not loaded, so `contentWindow` is replaced to receive the port. Neither the model nor main is used.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ViewerResource } from '../src/shared/types.js'
import type { ResolvedViewer, ViewerHostMessage } from '../src/shared/plugin.js'
import { reselectDecision, shownViewer } from '../src/renderer/src/viewer-reselect.js'
import type { LoadedResource } from '../src/renderer/src/viewer-route.js'
import { useStore } from '../src/renderer/src/store.js'
import { useLocale } from '../src/renderer/src/localeStore.js'
import { en } from '../src/renderer/src/i18n/en.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// themeStore looks up `matchMedia` when it loads (jsdom does not have it).
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

describe('shownViewer (表示が落ち着いているか)', () => {
  const loaded = (uri: string, pluginId: string): LoadedResource => ({ uri, pluginId, resource: text('x', 1) })

  it('表示中の URI を読み終え、出所といまの viewer が揃っていれば返す', () => {
    expect(shownViewer(MD, MARKDOWN, loaded(MD, 'aios.markdown'))).toEqual({ uri: MD, pluginId: 'aios.markdown' })
  })

  it('切り替え・開き直しの途中は null', () => {
    expect(shownViewer(null, MARKDOWN, loaded(MD, 'aios.markdown'))).toBeNull()
    expect(shownViewer(MD, MARKDOWN, null)).toBeNull()
    expect(shownViewer('file:///work/other.md', MARKDOWN, loaded(MD, 'aios.markdown'))).toBeNull()
    // Resolved, but waiting for the read (mid-reopen).
    expect(shownViewer(MD, TEXT, loaded(MD, 'aios.markdown'))).toBeNull()
  })

  it('どの viewer も名乗り出なかったファイル (`no-viewer`) は pluginId null で返す', () => {
    expect(shownViewer(MD, null, loaded(MD, ''))).toEqual({ uri: MD, pluginId: null })
    expect(shownViewer(MD, null, loaded(MD, 'aios.markdown'))).toBeNull()
  })
})

describe('reselectDecision (試しの解決から開き直すか)', () => {
  const asked = { uri: MD, pluginId: 'aios.markdown' }

  it('解決先が変わったら開き直す (無効にした → 受け皿へ / 有効にした → 名乗り出る拡張へ)', () => {
    expect(reselectDecision(asked, asked, MD, TEXT)).toBe('reopen')
    const onText = { uri: MD, pluginId: 'aios.text' }
    expect(reselectDecision(onText, onText, MD, MARKDOWN)).toBe('reopen')
  })

  it('解決先が同じなら何もしない (同意の変更・クラッシュの onChanged)', () => {
    expect(reselectDecision(asked, asked, MD, MARKDOWN)).toBe('keep')
  })

  it('どの viewer も名乗り出なくなったら開き直す / 名乗り出るようになったら開き直す', () => {
    expect(reselectDecision(asked, asked, MD, null)).toBe('reopen')
    const none = { uri: MD, pluginId: null }
    expect(reselectDecision(none, none, MD, TEXT)).toBe('reopen')
    expect(reselectDecision(none, none, MD, null)).toBe('keep')
  })

  it('待つ間に別のファイルへ移った・開き直した・表示が追い付いていないなら何もしない', () => {
    expect(reselectDecision(asked, null, MD, TEXT)).toBe('keep')
    expect(reselectDecision(asked, { uri: 'file:///work/b.md', pluginId: 'aios.markdown' }, MD, TEXT)).toBe('keep')
    expect(reselectDecision(asked, { uri: MD, pluginId: 'aios.text' }, MD, TEXT)).toBe('keep')
    expect(reselectDecision(asked, asked, 'file:///work/b.md', TEXT)).toBe('keep')
  })
})

// ---- ViewerPane (jsdom) ----

let disk: { text: string; mtimeMs: number }
let markdownEnabled: boolean
let container: HTMLDivElement
let root: Root
let guestPort: MessagePort | null
let received: ViewerHostMessage[]
let pluginListeners: Array<() => void>
/** pluginId → number of grants (in place of Broker's `refs`). */
let grants: Map<string, number>
let reads: string[]

function fakeAios(): unknown {
  const viewer = {
    open: async (uri: string) => {
      const resolved = markdownEnabled && uri.endsWith('.md') ? MARKDOWN : TEXT
      grants.set(resolved.pluginId, (grants.get(resolved.pluginId) ?? 0) + 1)
      return resolved
    },
    close: async (pluginId: string) => {
      grants.set(pluginId, (grants.get(pluginId) ?? 0) - 1)
    },
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

// TODO 969: the save button appears only when there are changes (dirty). Undefined when there are no changes.
const saveButton = (): HTMLButtonElement | undefined =>
  container.querySelector<HTMLButtonElement>('.viewer-header button.viewer-save') ?? undefined

const lastResource = (): Extract<ViewerHostMessage, { type: 'resource' }> | undefined =>
  [...received].reverse().find((m): m is Extract<ViewerHostMessage, { type: 'resource' }> => m.type === 'resource')

const frameSrc = (): string | null => container.querySelector('iframe')?.getAttribute('src') ?? null

/** Receives a port instead of the iframe (jsdom does not load `aios-plugin://`). Called each time src changes. */
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

describe('ViewerPane: 拡張の有効 / 無効で開き直す (TODO 471)', () => {
  beforeEach(async () => {
    disk = { text: '# Notes\n', mtimeMs: 100 }
    markdownEnabled = true
    guestPort = null
    received = []
    pluginListeners = []
    grants = new Map()
    reads = []
    ;(window as unknown as { aios: unknown }).aios = fakeAios()
    useLocale.setState({ resolved: 'en' })
    useStore.setState({
      selectedUri: null,
      viewerDirty: false,
      draftConflict: null,
      viewerDrafts: {},
      transient: null,
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
    await until(() => lastResource()?.uri === MD, 'first resource')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    guestPort?.close()
  })

  it('無効にすると受け皿で開き直し、未保存の下書きをそのまま渡す', async () => {
    guestPort?.postMessage({ type: 'draft', uri: lastResource()?.uri, text: '# Notes\n\nmine\n' })
    await until(() => saveButton()?.textContent === en['viewer.save'], 'dirty')

    markdownEnabled = false
    await pluginsChanged()
    await connectFrame(TEXT.url)
    await until(() => lastResource()?.uri === MD, 'reopened resource')

    expect(container.querySelector('.viewer-id')?.textContent).toBe('aios.text')
    const pushed = lastResource()
    expect(pushed?.draft).toBe('# Notes\n\nmine\n')
    // The body stays as it is on disk; the draft is handed over separately (same form as on return, TODO 312).
    expect(pushed?.resource).toMatchObject({ kind: 'text', text: '# Notes\n' })
    expect(pushed?.editable).toBe(true)
    await until(() => saveButton()?.textContent === en['viewer.save'], 'still dirty')
    expect(useStore.getState().viewerDrafts[MD]).toEqual({ text: '# Notes\n\nmine\n', baseMtimeMs: 100 })
    expect(useStore.getState().draftConflict).toBeNull()
    // The permission of the disabled extension is returned, and one permission for the fallback remains (the trial's part nets to zero).
    expect(grants.get('aios.markdown')).toBe(0)
    expect(grants.get('aios.text')).toBe(1)
  })

  it('有効に戻すと名乗り出る拡張 (markdown) へ戻る', async () => {
    markdownEnabled = false
    await pluginsChanged()
    await connectFrame(TEXT.url)
    await until(() => lastResource()?.uri === MD, 'on text')

    markdownEnabled = true
    await pluginsChanged()
    await connectFrame(MARKDOWN.url)
    await until(() => lastResource()?.uri === MD, 'back on markdown')
    expect(container.querySelector('.viewer-id')?.textContent).toBe('aios.markdown')
    expect(grants.get('aios.markdown')).toBe(1)
    expect(grants.get('aios.text')).toBe(0)
  })

  it('解決先が変わらない onChanged (同意の変更・クラッシュ) では読み直さない', async () => {
    const before = reads.length
    await pluginsChanged()
    expect(reads.length).toBe(before)
    expect(frameSrc()).toBe(MARKDOWN.url)
    expect(grants.get('aios.markdown')).toBe(1)
    expect(grants.get('aios.text') ?? 0).toBe(0)
  })
})
