// @vitest-environment jsdom
/**
 * TODO 907: 'open with another viewer' in ViewerPane (jsdom).
 *
 * - Opening `.patch` in aios.diff (read-only) shows the entry point in the heading. Choosing Text in the menu sends `viewer.choose` to main, and the same URI is reopened in aios.text (it becomes editable).
 * - While there is a draft, it is not switched to a viewer that cannot edit (aios.diff): the reason is shown in the band, and `choose` is not sent either.
 * - If there is no draft, it can be switched back. No entry point is shown for files without an extension.
 *
 * The iframe is not loaded, so `contentWindow` is replaced to receive the port (same manner as viewer-reselect.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ViewerResource } from '../src/shared/types.js'
import type { ResolvedViewer, ViewerChoices, ViewerHostMessage } from '../src/shared/plugin.js'
import { useStore } from '../src/renderer/src/store.js'
import { useLocale } from '../src/renderer/src/localeStore.js'
import { showReopenWith } from '../src/renderer/src/viewer-reopen.js'
import { en } from '../src/renderer/src/i18n/en.js'

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

const PATCH = 'file:///work/fix.patch'
const MAKEFILE = 'file:///work/Makefile'
const DIFF: ResolvedViewer = {
  pluginId: 'aios.diff',
  name: 'Diff',
  url: 'aios-plugin://aios.diff/viewer/index.html',
  editable: false,
  delivery: 'text'
}
const TEXT: ResolvedViewer = {
  pluginId: 'aios.text',
  name: 'Text',
  url: 'aios-plugin://aios.text/index.html',
  editable: true,
  delivery: 'text'
}

let association: string | null
let refuse = false
let chosen: string[]
let container: HTMLDivElement
let root: Root
let guestPort: MessagePort | null
let received: ViewerHostMessage[]

function choicesFor(uri: string): ViewerChoices {
  if (!uri.endsWith('.patch')) {
    return {
      ext: '',
      choices: [{ pluginId: 'aios.text', name: 'Text', editable: true, builtinDefault: true }],
      current: 'aios.text',
      associated: false
    }
  }
  return {
    ext: 'patch',
    choices: [
      { pluginId: 'aios.diff', name: 'Diff', editable: false, builtinDefault: true },
      { pluginId: 'aios.text', name: 'Text', editable: true, builtinDefault: false }
    ],
    current: association ?? 'aios.diff',
    associated: association !== null
  }
}

function fakeAios(): unknown {
  const viewer = {
    open: async (uri: string) => (uri.endsWith('.patch') && association !== 'aios.text' ? DIFF : TEXT),
    close: async () => undefined,
    untrackWatch: () => undefined,
    read: async (): Promise<ViewerResource> => ({ kind: 'text', text: '-a\n+b\n', truncated: false, size: 6, mtimeMs: 100 }),
    write: async () => ({ ok: true, mtimeMs: 101, size: 0, reason: null }),
    command: async () => ({ ok: true, result: null }),
    choices: async (uri: string) => choicesFor(uri),
    choose: async (uri: string, pluginId: string) => {
      chosen.push(pluginId)
      if (refuse) return false
      const hit = choicesFor(uri).choices.find((choice) => choice.pluginId === pluginId)
      if (hit === undefined) return false
      association = hit.builtinDefault ? null : pluginId
      return true
    }
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

const frameSrc = (): string | null => container.querySelector('iframe')?.getAttribute('src') ?? null
const reopenButton = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('.viewer-reopen-with')
const lastResource = (): Extract<ViewerHostMessage, { type: 'resource' }> | undefined =>
  [...received].reverse().find((m): m is Extract<ViewerHostMessage, { type: 'resource' }> => m.type === 'resource')
// TODO 969: the save button appears only when there are changes (dirty). Undefined when there are no changes.
const saveButton = (): HTMLButtonElement | undefined =>
  container.querySelector<HTMLButtonElement>('.viewer-header button.viewer-save') ?? undefined

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

/** Presses the entry point and picks the row with the name. */
async function pick(label: string): Promise<void> {
  await until(() => reopenButton() !== null, 'reopen button')
  await act(async () => {
    reopenButton()?.click()
  })
  const item = [...document.querySelectorAll<HTMLButtonElement>('.context-menu-item')].find((button) =>
    button.textContent?.includes(label)
  )
  if (item === undefined) throw new Error(`no menu item ${label}`)
  await act(async () => {
    item.click()
  })
  await flush()
}

describe('ViewerPane: 別の viewer で開く (TODO 907)', () => {
  beforeEach(async () => {
    association = null
    refuse = false
    chosen = []
    guestPort = null
    received = []
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
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    guestPort?.close()
  })

  it('.patch を Text で開き直すと編集できる viewer になり、既定に覚えられる', async () => {
    await act(async () => {
      useStore.getState().select(PATCH)
    })
    await connectFrame(DIFF.url)
    await until(() => lastResource()?.uri === PATCH, 'diff resource')
    expect(lastResource()?.editable).toBe(false)
    // The top of the menu has '(default)', and the current viewer has a check mark.
    await until(() => reopenButton() !== null, 'reopen button')
    await act(async () => {
      reopenButton()?.click()
    })
    const labels = [...document.querySelectorAll('.context-menu-item')].map((item) => item.textContent)
    expect(labels).toEqual([`✓${en['viewer.reopenWith.default'].replace('{name}', 'Diff')}`, 'Text'])
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    await pick('Text')
    expect(chosen).toEqual(['aios.text'])
    await connectFrame(TEXT.url)
    await until(() => lastResource()?.uri === PATCH, 'text resource')
    expect(container.querySelector('.viewer-id')?.textContent).toBe('aios.text')
    expect(lastResource()?.editable).toBe(true)
    // Until there are changes, the save button does not appear (TODO 969). Typing makes it appear = a viewer that can be edited.
    expect(saveButton()).toBeUndefined()
    guestPort?.postMessage({ type: 'draft', uri: PATCH, text: '-a\n+c\n' })
    await until(() => saveButton() !== undefined, 'dirty')
  })

  it('下書きがあるうちは編集できない viewer へ替えず、理由を出す。無ければ戻せる', async () => {
    association = 'aios.text'
    await act(async () => {
      useStore.getState().select(PATCH)
    })
    await connectFrame(TEXT.url)
    await until(() => lastResource()?.uri === PATCH, 'text resource')
    guestPort?.postMessage({ type: 'draft', uri: PATCH, text: '-a\n+c\n' })
    await until(() => saveButton()?.textContent === en['viewer.save'], 'dirty')

    await pick('Diff')
    expect(chosen).toEqual([])
    expect(container.querySelector('.viewer-reopen-blocked')?.textContent).toContain(en['viewer.reopenWith.blocked'])
    expect(frameSrc()).toBe(TEXT.url)

    // Restoring the draft allows the viewer to be replaced again.
    guestPort?.postMessage({ type: 'draft', uri: PATCH, text: '-a\n+b\n' })
    await until(() => saveButton() === undefined, 'clean')
    await pick('Diff')
    expect(chosen).toEqual(['aios.diff'])
    expect(association).toBeNull()
    await connectFrame(DIFF.url)
    expect(container.querySelector('.viewer-id')?.textContent).toBe('aios.diff')
  })

  it('拡張子の無いファイル (候補が受け皿だけ) では入口を出さない', async () => {
    await act(async () => {
      useStore.getState().select(MAKEFILE)
    })
    await connectFrame(TEXT.url)
    await until(() => lastResource()?.uri === MAKEFILE, 'makefile resource')
    await flush()
    expect(reopenButton()).toBeNull()
  })

  it('main が選び直しを断った (choose が false) ら黙らず帯で理由を出し、開き直さない', async () => {
    await act(async () => {
      useStore.getState().select(PATCH)
    })
    await connectFrame(DIFF.url)
    await until(() => lastResource()?.uri === PATCH, 'diff resource')
    refuse = true
    await pick('Text')
    await until(() => container.querySelector('.viewer-reopen-failed') !== null, 'failed band')
    expect(container.querySelector('.viewer-reopen-failed')?.textContent).toContain(en['viewer.reopenWith.failed'])
    expect(frameSrc()).toBe(DIFF.url)
  })
})

describe('showReopenWith: 既定を覚えられる拡張子だけ入口を出す (main の isAssociationExt と同じ規則)', () => {
  const two = [
    { pluginId: 'a', name: 'A', editable: true, builtinDefault: true },
    { pluginId: 'b', name: 'B', editable: true, builtinDefault: false }
  ]
  const of = (ext: string): ViewerChoices => ({ ext, choices: two, current: 'a', associated: false })
  it('合う拡張子は出し、日本語・記号・長すぎ・空は出さない', () => {
    expect(showReopenWith(of('patch'))).toBe(true)
    expect(showReopenWith(of('c++'))).toBe(true)
    expect(showReopenWith(of('a'.repeat(32)))).toBe(true)
    for (const ext of ['', '日本語', 'c~', 'a'.repeat(33), 'A', '__proto__']) expect(showReopenWith(of(ext))).toBe(false)
    expect(showReopenWith(null)).toBe(false)
  })
})
