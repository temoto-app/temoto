// @vitest-environment jsdom
/**
 * TODO 366 (wave 20 bundle E) / 407 (wave 21 bundle B), the host side: the host receives a Drop onto the viewer (iframe), and passes only what goes through the main choke point,
 * in the format for each plugin (`aios.markdown` is a Markdown link, `aios.text` is the raw full path), to the viewer with `insert-text`
 * (the insertion point is the viewer's caret; coordinates are not carried).
 *
 *  - pure functions: deciding a dragleave that leaves the window (`leftWindow`), counting the dropped items (`collectDrop`), and how the insert string is chosen (`planDropInsert`)
 *  - ViewerPane (jsdom): dragging a file shows an overlay on the iframe, and the iframe is taken out of pointer targets (`.viewer-dropping`). The signals are the window's dragenter and the viewer's `drag-files`.
 *    A drop on the overlay goes `drop.uriFor` -> `drop.checkLinks` -> `insert-text`. A `File` that dropped inside the viewer because the overlay was not in time (`drop-files`) takes the same route.
 *    Refused items are shown in the band (EN / JA). Viewers that do not accept edits show no overlay. The overlay disappears on a dragleave that leaves the window, on pointer movement, or when dragover stops.
 *    The trace log (`drop.trace`) has counts only.
 *
 * The iframe is not loaded, so `contentWindow` is replaced to receive the port (same as viewer-drafts.test.ts).
 * A real drop from Finder and hit testing on the OOPIF cannot be measured in jsdom (check on a real machine).
 * Neither the model nor main is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ViewerResource } from '../src/shared/types.js'
import type { ViewerHostMessage } from '../src/shared/plugin.js'
import type { DropLinkCheck, DropTrace } from '../src/shared/drop-link.js'
import {
  DRAG_IDLE_MS,
  LEAVE_GRACE_MS,
  acceptAcceptsEdits,
  collectDrop,
  dropInsertable,
  leftWindow,
  planDropInsert
} from '../src/renderer/src/viewer-drop.js'
import { useStore } from '../src/renderer/src/store.js'
import { useLocale } from '../src/renderer/src/localeStore.js'
import { en } from '../src/renderer/src/i18n/en.js'
import { ja } from '../src/renderer/src/i18n/ja.js'

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

describe('純関数', () => {
  it('leftWindow: relatedTarget があれば窓の中。null でも窓の内側の座標なら窓の中 (407)', () => {
    const viewport = { width: 800, height: 600 }
    const el = document.createElement('div')
    expect(leftWindow({ relatedTarget: el, clientX: 0, clientY: 0 }, viewport)).toBe(false)
    expect(leftWindow({ relatedTarget: null, clientX: 300, clientY: 200 }, viewport)).toBe(false)
    expect(leftWindow({ relatedTarget: null, clientX: 0, clientY: 0 }, viewport)).toBe(true)
    expect(leftWindow({ relatedTarget: null, clientX: -5, clientY: 200 }, viewport)).toBe(true)
    expect(leftWindow({ relatedTarget: null, clientX: 300, clientY: 600 }, viewport)).toBe(true)
    expect(leftWindow({ relatedTarget: null, clientX: Number.NaN, clientY: 1 }, viewport)).toBe(true)
  })

  it('collectDrop: URI の列と、uriFor が空を返した File の数 (Finder の File にパスが無い、の切り分け)', () => {
    const uriFor = (file: unknown): string => (file as { uri: string }).uri
    expect(
      collectDrop(
        {
          files: [{ uri: 'file:///a' }, { uri: '' }, { uri: 'file:///a' }],
          getData: (f) => (f === 'text/uri-list' ? 'file:///b\nhttps://x/' : '')
        },
        uriFor
      )
    ).toEqual({ uris: ['file:///a', 'file:///b'], files: 3, emptyPaths: 1 })
  })

  it('planDropInsert: ファイルがあれば関門の結果からリンク、無ければ text/plain をそのまま', async () => {
    const check = vi.fn(
      async (): Promise<DropLinkCheck> => ({
        allowed: [{ uri: 'file:///p/a.png', isDirectory: false }],
        denied: [{ uri: 'file:///p/.ssh/k', reason: 'path-excluded' }]
      })
    )
    expect(await planDropInsert(['file:///p/a.png', 'file:///p/.ssh/k'], '', check)).toEqual({
      text: '![a.png](file:///p/a.png)',
      denied: [{ uri: 'file:///p/.ssh/k', reason: 'path-excluded' }]
    })
    // aios.text format (407): the raw full path.
    check.mockResolvedValueOnce({
      allowed: [
        { uri: 'file:///Users/k/My%20Pics/a%20b.png', isDirectory: false },
        { uri: 'file:///Users/k/docs', isDirectory: true }
      ],
      denied: []
    })
    expect(await planDropInsert(['x'], '', check, 'path')).toEqual({
      text: '/Users/k/My Pics/a b.png\n/Users/k/docs',
      denied: []
    })
    check.mockClear()
    expect(await planDropInsert([], 'https://example.com/', check)).toEqual({ text: 'https://example.com/', denied: [] })
    expect(check).not.toHaveBeenCalled()
  })
})

describe('TODO 587: viewer の「いま編集を受けるか」', () => {
  it('dropInsertable: editable が偽なら挿さない。表示中のファイルの「受けない」だけが開くに倒す', () => {
    const md = 'file:///w/a.md'
    expect(dropInsertable(false, null, md)).toBe(false)
    expect(dropInsertable(false, { uri: md, accepts: true }, md)).toBe(false)
    expect(dropInsertable(true, null, md)).toBe(true)
    expect(dropInsertable(true, { uri: md, accepts: false }, md)).toBe(false)
    expect(dropInsertable(true, { uri: md, accepts: true }, md)).toBe(true)
    // A notice about the previous file (during a switch) has no effect
    expect(dropInsertable(true, { uri: 'file:///w/b.md', accepts: false }, md)).toBe(true)
    expect(dropInsertable(true, { uri: md, accepts: false }, null)).toBe(true)
  })

  it('acceptAcceptsEdits: viewer が描いているファイル宛てで真偽値のときだけ', () => {
    const md = 'file:///w/a.md'
    expect(acceptAcceptsEdits({ uri: md, accepts: false }, md)).toEqual({ uri: md, accepts: false })
    expect(acceptAcceptsEdits({ uri: md, accepts: false }, 'file:///w/b.md')).toBeNull()
    expect(acceptAcceptsEdits({ uri: md, accepts: 'no' }, md)).toBeNull()
    expect(acceptAcceptsEdits({ uri: 1, accepts: true }, md)).toBeNull()
    expect(acceptAcceptsEdits({ uri: md, accepts: true }, null)).toBeNull()
  })
})

// ---- ViewerPane (jsdom) ----

const MD = 'file:///work/notes.md'
const MARKDOWN = { pluginId: 'aios.markdown', name: 'Markdown', url: 'aios-plugin://aios.markdown/index.html', editable: true }
const TEXT = { pluginId: 'aios.text', name: 'Text', url: 'aios-plugin://aios.text/index.html', editable: true }

interface FakeFile {
  readonly uri: string
}

let container: HTMLDivElement
let root: Root
let guestPort: MessagePort | null
let received: ViewerHostMessage[]
let readOnly: boolean
let checkResult: DropLinkCheck
let viewerInfo: typeof MARKDOWN
const traces: DropTrace[] = []
const checkLinks = vi.fn<(uris: readonly string[]) => Promise<DropLinkCheck>>(async () => checkResult)

function fakeAios(): unknown {
  const viewer = {
    open: async () => viewerInfo,
    read: async (): Promise<ViewerResource> => ({
      kind: 'text',
      text: '# notes\n',
      truncated: false,
      size: 8,
      mtimeMs: 1,
      ...(readOnly ? { readOnly: true } : {})
    }),
    close: async () => undefined,
    untrackWatch: () => undefined,
    write: async () => ({ ok: true, mtimeMs: 2, size: 0, reason: null }),
    command: async () => ({ ok: true, result: [] })
  }
  const drop = {
    uriFor: (file: unknown) => (file as FakeFile).uri,
    checkLinks,
    trace: (trace: DropTrace) => traces.push(trace)
  }
  const noop = (): (() => void) => () => undefined
  const deep = (path: string): unknown =>
    new Proxy(() => Promise.resolve(undefined), {
      get: (_target, key) => (typeof key === 'string' ? deep(`${path}.${key}`) : undefined),
      apply: () => (path.includes('.on') ? noop() : Promise.resolve(undefined))
    })
  return new Proxy(
    { viewer, drop, app: { onMenuCommand: noop, openExternal: async () => undefined } },
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

const overlay = (): HTMLElement | null => container.querySelector('.viewer-drop-overlay')
const inserts = (): Extract<ViewerHostMessage, { type: 'insert-text' }>[] =>
  received.filter((m): m is Extract<ViewerHostMessage, { type: 'insert-text' }> => m.type === 'insert-text')

/** A drag event carrying a fake DataTransfer (jsdom has no DragEvent). */
function dragEvent(
  type: string,
  data: { types: readonly string[]; files?: readonly FakeFile[]; text?: Record<string, string> },
  extra: { clientX?: number; clientY?: number; relatedTarget?: EventTarget | null; altKey?: boolean } = {}
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: data.types,
      files: data.files ?? [],
      dropEffect: 'none',
      getData: (format: string) => data.text?.[format] ?? ''
    }
  })
  Object.defineProperty(event, 'clientX', { value: extra.clientX ?? 0 })
  Object.defineProperty(event, 'clientY', { value: extra.clientY ?? 0 })
  Object.defineProperty(event, 'relatedTarget', { value: extra.relatedTarget ?? null })
  Object.defineProperty(event, 'altKey', { value: extra.altKey ?? false })
  return event
}

async function connectFrame(): Promise<void> {
  await until(() => container.querySelector('iframe') !== null, 'iframe')
  const frame = container.querySelector('iframe') as HTMLIFrameElement
  frame.getBoundingClientRect = () => new DOMRect(100, 50, 400, 300)
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
  await until(() => received.some((m) => m.type === 'resource' && m.uri === MD), 'resource')
}

async function mount(): Promise<void> {
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
  await connectFrame()
}

async function startDrag(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(dragEvent('dragenter', { types: ['Files'] }))
  })
  await until(() => overlay() !== null, 'overlay')
}

describe('ViewerPane: viewer の上の Drop (TODO 366)', () => {
  beforeEach(() => {
    guestPort = null
    received = []
    readOnly = false
    checkResult = { allowed: [], denied: [] }
    viewerInfo = MARKDOWN
    traces.length = 0
    checkLinks.mockClear()
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
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    guestPort?.close()
  })

  it('ファイルのドラッグで覆いが出て (iframe は pointer の的から外れる)、drop で Markdown のリンクを送る (位置は viewer のキャレット)', async () => {
    await mount()
    expect(overlay()).toBeNull()
    expect(container.querySelector('.viewer-dropping')).toBeNull()
    await startDrag()
    expect(container.querySelector('.viewer-body.viewer-dropping .viewer-frame')).not.toBeNull()
    checkResult = {
      allowed: [
        { uri: 'file:///Users/k/My%20Pics/a%20b.png', isDirectory: false },
        { uri: 'file:///Users/k/spec.pdf', isDirectory: false }
      ],
      denied: []
    }
    const files = [{ uri: 'file:///Users/k/My%20Pics/a%20b.png' }, { uri: 'file:///Users/k/spec.pdf' }]
    await act(async () => {
      overlay()?.dispatchEvent(dragEvent('dragover', { types: ['Files'], files }))
      overlay()?.dispatchEvent(dragEvent('drop', { types: ['Files'], files }, { clientX: 130, clientY: 90 }))
    })
    await until(() => inserts().length === 1, 'insert-text')
    expect(checkLinks).toHaveBeenCalledWith(['file:///Users/k/My%20Pics/a%20b.png', 'file:///Users/k/spec.pdf'])
    expect(inserts()[0]).toEqual({
      type: 'insert-text',
      uri: MD,
      text: '![a b.png](file:///Users/k/My%20Pics/a%20b.png)\n[spec.pdf](file:///Users/k/spec.pdf)'
    })
    expect(overlay()).toBeNull()
    expect(container.querySelector('.viewer-dropping')).toBeNull()
    expect(container.querySelector('.viewer-drop-denied')).toBeNull()
    // Trace log: counts and whether it was accepted only (no paths).
    // 429: also keeps the host's first dragover (the element that received it, and the dropEffect before it was rewritten) and the caller that removed the overlay.
    expect(traces).toEqual([
      { stage: 'drag-seen', source: 'window' },
      { stage: 'overlay-dragover', target: 'overlay', dropEffect: 'none' },
      { stage: 'end', reason: 'drop' },
      { stage: 'overlay-drop', target: 'overlay', files: 2, uris: 2, emptyPaths: 0, action: 'insert' },
      { stage: 'insert', format: 'markdown-link', lines: 2, sent: true }
    ])
    expect(JSON.stringify(traces)).not.toContain('/Users')
  })

  it('aios.text では生のフルパスを 1 行に 1 つ (引用符も escape も無し、フォルダもそのまま) (407)', async () => {
    viewerInfo = TEXT
    await mount()
    await startDrag()
    checkResult = {
      allowed: [
        { uri: 'file:///Users/k/My%20Pics/a%20b.png', isDirectory: false },
        { uri: 'file:///Users/k/%E8%B3%87%E6%96%99', isDirectory: true }
      ],
      denied: []
    }
    const files = [{ uri: 'file:///Users/k/My%20Pics/a%20b.png' }, { uri: 'file:///Users/k/%E8%B3%87%E6%96%99' }]
    await act(async () => {
      overlay()?.dispatchEvent(dragEvent('drop', { types: ['Files'], files }, { clientX: 130, clientY: 90 }))
    })
    await until(() => inserts().length === 1, 'insert-text')
    expect(inserts()[0]).toEqual({ type: 'insert-text', uri: MD, text: '/Users/k/My Pics/a b.png\n/Users/k/資料' })
    expect(traces.at(-1)).toEqual({ stage: 'insert', format: 'path', lines: 2, sent: true })
  })

  it('Finder の File のパスが取れない (uriFor が空) ときは何も挿さず、ログに emptyPaths が残る', async () => {
    await mount()
    await startDrag()
    await act(async () => {
      overlay()?.dispatchEvent(dragEvent('drop', { types: ['Files'], files: [{ uri: '' }] }))
    })
    await flush()
    expect(inserts()).toEqual([])
    expect(checkLinks).not.toHaveBeenCalled()
    expect(traces).toContainEqual({ stage: 'overlay-drop', target: 'overlay', files: 1, uris: 0, emptyPaths: 1, action: 'insert' })
  })

  it('覆いが間に合わず viewer の中に落ちた File (drop-files) も同じ道で挿す。ドラッグ中でなければ受けない (407)', async () => {
    await mount()
    checkResult = { allowed: [{ uri: 'file:///Users/k/x.png', isDirectory: false }], denied: [] }
    // A drop-files without a drag signal (drag-files) is discarded
    guestPort?.postMessage({ type: 'drop-files', files: [{ uri: 'file:///Users/k/x.png' }], count: 1 })
    await flush()
    expect(inserts()).toEqual([])
    expect(checkLinks).not.toHaveBeenCalled()
    // 429: records the reason for discarding (407 discarded silently)
    expect(traces).toEqual([{ stage: 'guest-drop-skipped', reason: 'stale', files: 1 }])
    traces.length = 0

    guestPort?.postMessage({ type: 'drag-files' })
    await until(() => overlay() !== null, 'overlay from guest')
    guestPort?.postMessage({ type: 'drop-files', files: [{ uri: 'file:///Users/k/x.png' }], count: 1 })
    await until(() => inserts().length === 1, 'insert from guest drop')
    expect(inserts()[0]).toEqual({ type: 'insert-text', uri: MD, text: '![x.png](file:///Users/k/x.png)' })
    expect(overlay()).toBeNull()
    expect(traces).toEqual([
      { stage: 'drag-seen', source: 'guest' },
      { stage: 'end', reason: 'guest-drop' },
      { stage: 'guest-drop', files: 1, uris: 1, emptyPaths: 0 },
      { stage: 'insert', format: 'markdown-link', lines: 1, sent: true }
    ])
  })

  it('drop-files の files が配列でない / 複製に失敗して数だけ、も理由をログに残す (429)', async () => {
    await mount()
    guestPort?.postMessage({ type: 'drag-files' })
    await until(() => overlay() !== null, 'overlay from guest')
    guestPort?.postMessage({ type: 'drop-files', files: 'nope', count: 1 })
    await until(() => traces.some((t) => t.stage === 'guest-drop-skipped'), 'skipped')
    expect(traces).toContainEqual({ stage: 'guest-drop-skipped', reason: 'not-array', files: 1 })

    traces.length = 0
    guestPort?.postMessage({ type: 'drag-files' })
    await until(() => overlay() !== null, 'overlay from guest again')
    guestPort?.postMessage({ type: 'drop-files', files: [], count: 2, cloneFailed: true })
    await until(() => traces.some((t) => t.stage === 'guest-drop'), 'guest-drop')
    expect(traces).toContainEqual({ stage: 'guest-drop', files: 2, uris: 0, emptyPaths: 0, cloneFailed: true })
    expect(inserts()).toEqual([])
    expect(checkLinks).not.toHaveBeenCalled()
  })

  it('TODO 443 / 677: Files ツリー発のドラッグ (host が覚えた URI) が iframe の中に落ちても、bridge の File を読まず host の URI を挿す', async () => {
    const { beginFilesDrag, endFilesDrag } = await import('../src/renderer/src/files-drag.js')
    await mount()
    checkResult = { allowed: [{ uri: 'file:///Users/k/tree-file.ts', isDirectory: false }], denied: [] }
    beginFilesDrag(['file:///Users/k/tree-file.ts'])
    guestPort?.postMessage({ type: 'drag-files' })
    await until(() => overlay() !== null, 'overlay from guest (files-tree drag)')
    // Whatever `File` the bridge sends (or even if it sends nothing), it is ignored and only the remembered URIs are used
    guestPort?.postMessage({ type: 'drop-files', files: 'nope' })
    await until(() => inserts().length === 1, 'insert from remembered files-tree drag')
    expect(checkLinks).toHaveBeenCalledWith(['file:///Users/k/tree-file.ts'])
    expect(inserts()[0]).toEqual({
      type: 'insert-text',
      uri: MD,
      text: '[tree-file.ts](file:///Users/k/tree-file.ts)'
    })
    expect(traces).toContainEqual({ stage: 'guest-drop', files: 0, uris: 1, emptyPaths: 0 })
    endFilesDrag()
  })

  it('関門に断られたものは挿さず、帯に理由を出す (EN / JA)。閉じるで消える', async () => {
    await mount()
    await startDrag()
    checkResult = {
      allowed: [],
      denied: [
        { uri: 'file:///Users/k/.ssh/id_rsa', reason: 'path-excluded' },
        { uri: 'file:///Users/k/.aws/credentials', reason: 'path-excluded' }
      ]
    }
    const files = [{ uri: 'file:///Users/k/.ssh/id_rsa' }, { uri: 'file:///Users/k/.aws/credentials' }]
    await act(async () => {
      overlay()?.dispatchEvent(dragEvent('drop', { types: ['Files'], files }, { clientX: 120, clientY: 60 }))
    })
    await until(() => container.querySelector('.viewer-drop-denied') !== null, 'banner')
    expect(inserts()).toEqual([])
    const banner = container.querySelector('.viewer-drop-denied') as HTMLElement
    expect(banner.textContent).toContain(
      en['viewer.drop.denied'].replace('{name}', 'id_rsa').replace('{reason}', en['reason.path-excluded'])
    )
    expect(banner.textContent).toContain(en['viewer.drop.deniedMore'].replace('{count}', '1'))
    await act(async () => useLocale.setState({ resolved: 'ja' }))
    expect(container.querySelector('.viewer-drop-denied')?.textContent).toContain(
      ja['viewer.drop.denied'].replace('{name}', 'id_rsa').replace('{reason}', ja['reason.path-excluded'])
    )
    await act(async () => (container.querySelector('.viewer-drop-denied button') as HTMLButtonElement).click())
    expect(container.querySelector('.viewer-drop-denied')).toBeNull()
  })

  it('ファイルでない Drop (ブラウザの URL) は text/plain をそのまま挿し、関門は呼ばない', async () => {
    await mount()
    await startDrag()
    await act(async () => {
      overlay()?.dispatchEvent(
        dragEvent(
          'drop',
          { types: ['text/uri-list', 'text/plain'], text: { 'text/uri-list': 'https://example.com/', 'text/plain': 'https://example.com/' } },
          { clientX: 110, clientY: 55 }
        )
      )
    })
    await until(() => inserts().length === 1, 'insert-text')
    expect(inserts()[0]).toEqual({ type: 'insert-text', uri: MD, text: 'https://example.com/' })
    expect(checkLinks).not.toHaveBeenCalled()
  })

  it('窓の外から直に viewer の上へ入ったドラッグ (viewer の drag-files) でも覆いが出る', async () => {
    await mount()
    guestPort?.postMessage({ type: 'drag-files' })
    await until(() => overlay() !== null, 'overlay from guest')
  })

  it('覆いは窓の外への dragleave で (猶予の後に) 消える。窓の中の dragleave では消えない (407 / 429)', async () => {
    await mount()
    await startDrag()
    // A dragleave moving from child to child has window-inner coordinates even when relatedTarget is null, so the overlay stays
    await act(async () => {
      window.dispatchEvent(dragEvent('dragleave', { types: ['Files'] }, { clientX: 200, clientY: 100, relatedTarget: null }))
      overlay()?.dispatchEvent(dragEvent('dragleave', { types: ['Files'] }, { clientX: 200, clientY: 100, relatedTarget: null }))
    })
    expect(overlay()).not.toBeNull()
    await act(async () => {
      window.dispatchEvent(dragEvent('dragleave', { types: ['Files'] }, { relatedTarget: null }))
    })
    // 429: do not remove it at once (even if (0, 0) is attached to a dragleave that only moved into the iframe, the overlay is kept)
    expect(overlay()).not.toBeNull()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, LEAVE_GRACE_MS + 50))
    })
    expect(overlay()).toBeNull()
    expect(traces).toContainEqual({ stage: 'end', reason: 'leave' })
  })

  it('窓の外への dragleave の後でも、猶予の間に dragover が来れば覆いを残す (429)', async () => {
    await mount()
    await startDrag()
    await act(async () => {
      window.dispatchEvent(dragEvent('dragleave', { types: ['Files'] }, { relatedTarget: null }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      // Signal that the drag moved over the viewer (iframe)
      guestPort?.postMessage({ type: 'drag-files' })
      await new Promise((resolve) => setTimeout(resolve, LEAVE_GRACE_MS + 50))
    })
    expect(overlay()).not.toBeNull()
    expect(traces.filter((t) => t.stage === 'end')).toEqual([])
  })

  it('ドラッグ中 (dragover が続いている) の pointermove / pointerdown では覆いを消さない。dragover が止んだら消える (429)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await mount()
      await startDrag()
      // macOS Chromium can emit pointermove even during a drag from outside. 407 removed the overlay here
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          overlay()?.dispatchEvent(dragEvent('dragover', { types: ['Files'] }))
          overlay()?.dispatchEvent(new Event('pointermove', { bubbles: true }))
          overlay()?.dispatchEvent(new Event('pointerdown', { bubbles: true }))
          vi.advanceTimersByTime(DRAG_IDLE_MS / 4)
        })
        expect(overlay()).not.toBeNull()
      }
      expect(traces.filter((t) => t.stage === 'end')).toEqual([])
      expect(traces.filter((t) => t.stage === 'drag-seen')).toHaveLength(1)
      // dragover stopped (e.g. cancelled with Esc) -> removed by the watch or by the pointer path
      await act(async () => {
        vi.advanceTimersByTime(DRAG_IDLE_MS + 600)
      })
      await act(async () => {
        overlay()?.dispatchEvent(new Event('pointermove', { bubbles: true }))
      })
      expect(overlay()).toBeNull()
      expect(traces.filter((t) => t.stage === 'end')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('覆いが無い瞬間に .viewer-body へ落ちた drop も同じ道 (overlay-drop) で挿す (429)', async () => {
    viewerInfo = TEXT
    await mount()
    expect(overlay()).toBeNull()
    checkResult = { allowed: [{ uri: 'file:///Users/k/a.jpg', isDirectory: false }], denied: [] }
    const files = [{ uri: 'file:///Users/k/a.jpg' }]
    const body = container.querySelector('.viewer-body') as HTMLElement
    const over = dragEvent('dragover', { types: ['Files'], files })
    const dropped = dragEvent('drop', { types: ['Files'], files })
    await act(async () => {
      // The capture-phase dragover on the window shows the overlay first (state), but a drop at the same moment is received by .viewer-body
      body.dispatchEvent(over)
      body.dispatchEvent(dropped)
    })
    expect(over.defaultPrevented).toBe(true)
    expect(dropped.defaultPrevented).toBe(true)
    await until(() => inserts().length === 1, 'insert-text from body')
    expect(inserts()[0]).toEqual({ type: 'insert-text', uri: MD, text: '/Users/k/a.jpg' })
    expect(traces).toContainEqual({ stage: 'overlay-dragover', target: 'body', dropEffect: 'none' })
    expect(traces).toContainEqual({ stage: 'overlay-drop', target: 'body', files: 1, uris: 1, emptyPaths: 0, action: 'insert' })
    expect(overlay()).toBeNull()
  })

  it('TODO 563: 編集を受けない viewer (読み取り専用) への drop は、関門を通ったファイルを viewer で開く (挿さない)', async () => {
    readOnly = true
    checkResult = {
      allowed: [
        { uri: 'file:///Users/k/docs', isDirectory: true },
        { uri: 'file:///Users/k/b.png', isDirectory: false }
      ],
      denied: []
    }
    await mount()
    await startDrag()
    const files = [{ uri: 'file:///Users/k/docs' }, { uri: 'file:///Users/k/b.png' }]
    await act(async () => {
      overlay()?.dispatchEvent(dragEvent('dragover', { types: ['Files'], files }))
      overlay()?.dispatchEvent(dragEvent('drop', { types: ['Files'], files }))
    })
    await until(() => useStore.getState().selectedUri === 'file:///Users/k/b.png', 'opened')
    expect(checkLinks).toHaveBeenCalledWith(['file:///Users/k/docs', 'file:///Users/k/b.png'])
    expect(inserts()).toEqual([])
    expect(traces).toContainEqual({ stage: 'overlay-drop', target: 'overlay', files: 2, uris: 2, emptyPaths: 0, action: 'open' })
  })

  it('TODO 563: 編集中の viewer でも ⌥ を押して落とせば開く (オーナー決定)', async () => {
    checkResult = { allowed: [{ uri: 'file:///Users/k/c.md', isDirectory: false }], denied: [] }
    await mount()
    await startDrag()
    const files = [{ uri: 'file:///Users/k/c.md' }]
    await act(async () => {
      overlay()?.dispatchEvent(dragEvent('dragover', { types: ['Files'], files }))
      overlay()?.dispatchEvent(dragEvent('drop', { types: ['Files'], files }, { altKey: true }))
    })
    await until(() => useStore.getState().selectedUri === 'file:///Users/k/c.md', 'opened')
    expect(inserts()).toEqual([])
  })

  it('TODO 587: aios.markdown が Preview (accepts-edits: false) と知らせている間の drop は開く。Source に戻れば挿す', async () => {
    checkResult = { allowed: [{ uri: 'file:///Users/k/d.md', isDirectory: false }], denied: [] }
    await mount()
    guestPort?.postMessage({ type: 'accepts-edits', uri: MD, accepts: false })
    await flush()
    await startDrag()
    const files = [{ uri: 'file:///Users/k/d.md' }]
    await act(async () => {
      overlay()?.dispatchEvent(dragEvent('drop', { types: ['Files'], files }))
    })
    await until(() => useStore.getState().selectedUri === 'file:///Users/k/d.md', 'opened from preview')
    expect(inserts()).toEqual([])
    expect(traces).toContainEqual({ stage: 'overlay-drop', target: 'overlay', files: 1, uris: 1, emptyPaths: 0, action: 'open' })
  })

  it('TODO 587: Source (accepts-edits: true) なら今までどおり挿す。別のファイル宛ての知らせは捨てる', async () => {
    checkResult = { allowed: [{ uri: 'file:///Users/k/e.png', isDirectory: false }], denied: [] }
    await mount()
    // A notice for a file that is not displayed (a crossed switch) is not accepted -> it stays an insertion
    guestPort?.postMessage({ type: 'accepts-edits', uri: 'file:///Users/k/other.md', accepts: false })
    guestPort?.postMessage({ type: 'accepts-edits', uri: MD, accepts: 'no' })
    await flush()
    await startDrag()
    const files = [{ uri: 'file:///Users/k/e.png' }]
    await act(async () => {
      overlay()?.dispatchEvent(dragEvent('drop', { types: ['Files'], files }))
    })
    await until(() => inserts().length === 1, 'insert while stale report')
    guestPort?.postMessage({ type: 'accepts-edits', uri: MD, accepts: false })
    guestPort?.postMessage({ type: 'accepts-edits', uri: MD, accepts: true })
    await flush()
    await startDrag()
    await act(async () => {
      overlay()?.dispatchEvent(dragEvent('drop', { types: ['Files'], files }))
    })
    await until(() => inserts().length === 2, 'insert in source')
    expect(useStore.getState().selectedUri).toBe(MD)
  })

  it('dragover が途絶えたら (Esc で取り消した等) 覆いを外す', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await mount()
      await startDrag()
      await act(async () => {
        vi.advanceTimersByTime(DRAG_IDLE_MS / 2)
      })
      expect(overlay()).not.toBeNull()
      await act(async () => {
        vi.advanceTimersByTime(DRAG_IDLE_MS)
      })
      expect(overlay()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('TODO 563: 編集を受けない viewer (読み取り専用) でも覆いを出す (落とせば開く)', async () => {
    readOnly = true
    await mount()
    await act(async () => {
      window.dispatchEvent(dragEvent('dragenter', { types: ['Files'] }))
    })
    await flush()
    expect(overlay()).not.toBeNull()
  })

  it('テキストのドラッグでは覆いを出さない', async () => {
    await mount()
    await act(async () => {
      window.dispatchEvent(dragEvent('dragenter', { types: ['text/plain'] }))
    })
    await flush()
    expect(overlay()).toBeNull()
  })
})
