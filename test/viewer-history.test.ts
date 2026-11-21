// @vitest-environment jsdom
/**
 * TODO 369 (wave 20 bundle D): ViewerPane's 'back' and 'forward'.
 *
 * - pure functions (`viewer-history.ts`): how to push, the same URI, discarding the steps ahead, the cap, grouping ↑↓ within 1 second, back / forward.
 * - jsdom (ViewerPane + `useViewerHistory`): button disabled / enabled, press to go back / forward, keys (⌃- / ⌃⇧-), the mouse back / forward buttons, gestures from main,
 *   grouping within 1 second, not pushing `aios.diff`, per thread, and a balloon appears even on a disabled button.
 *   Neither the model nor main is used (`window.aios` is a fake).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ViewerResource } from '../src/shared/types.js'
import type { MenuCommand } from '../src/shared/ipc.js'
import {
  EMPTY_HISTORY,
  HISTORY_COALESCE_MS,
  HISTORY_LIMIT,
  canStep,
  recordVisit,
  stepHistory,
  type ViewerHistory
} from '../src/renderer/src/viewer-history.js'
import { useStore } from '../src/renderer/src/store.js'
import { useThreads } from '../src/renderer/src/threadStore.js'
import { useLocale } from '../src/renderer/src/localeStore.js'
import { en } from '../src/renderer/src/i18n/en.js'
import { ja } from '../src/renderer/src/i18n/ja.js'
import {
  isSaveShortcut,
  searchShortcut,
  viewerForwardedShortcuts,
  viewerNavMouseButton,
  viewerNavShortcut
} from '../src/renderer/src/shortcuts.js'
import { matchViewerMouseButton, matchViewerShortcut } from '../plugins/_shared/shortcuts.js'
import { navFromAppCommand, navFromSwipe } from '../src/main/navigation-gesture.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// The key convention is decided once at startup from `navigator.platform`.
// mac's ⌃- / ⌃⇧- are tested, so the wiring modules (`viewerHistory.ts` / ViewerPane) are loaded below after setting mac.
Object.defineProperty(window.navigator, 'platform', { configurable: true, value: 'MacIntel' })
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

const A = 'file:///work/a.ts'
const B = 'file:///work/b.ts'
const C = 'file:///work/c.ts'
const D = 'file:///work/d.ts'

const visit = (
  history: ViewerHistory,
  uri: string,
  now: number,
  byKeys = false,
  highlight: string | null = null
): ViewerHistory => recordVisit(history, { uri, highlight, now, byKeys })

const uris = (history: ViewerHistory): string[] => history.entries.map((entry) => entry.uri)

describe('recordVisit (積み方)', () => {
  it('開くたびに 1 歩。いまの位置は最後', () => {
    const h = visit(visit(EMPTY_HISTORY, A, 0), B, 10_000)
    expect(uris(h)).toEqual([A, B])
    expect(h.index).toBe(1)
  })

  it('同じ URI は歩を増やさず同じ値を返す。検索語だけ変われば差し替える', () => {
    const h = visit(EMPTY_HISTORY, A, 0)
    expect(visit(h, A, 5_000)).toBe(h)
    const highlighted = visit(h, A, 5_000, false, 'needle')
    expect(uris(highlighted)).toEqual([A])
    expect(highlighted.entries[0]?.highlight).toBe('needle')
  })

  it('戻った位置から開いたら先の歩を捨てる', () => {
    let h = visit(visit(visit(EMPTY_HISTORY, A, 0), B, 10_000), C, 20_000)
    h = stepHistory(h, C, 'back')!.history
    h = stepHistory(h, B, 'back')!.history
    h = visit(h, D, 30_000)
    expect(uris(h)).toEqual([A, D])
    expect(h.index).toBe(1)
    expect(canStep(h, D, 'forward')).toBe(false)
  })

  it(`上限 (${HISTORY_LIMIT}) を超えたら古いほうから捨てる`, () => {
    let h = EMPTY_HISTORY
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) h = visit(h, `file:///work/${i}.ts`, i * 10_000)
    expect(h.entries).toHaveLength(HISTORY_LIMIT)
    expect(h.entries[0]?.uri).toBe('file:///work/5.ts')
    expect(h.index).toBe(HISTORY_LIMIT - 1)
  })
})

describe('↑↓ の 1 秒のまとめ (TODO 378 の既定)', () => {
  it('↑↓ で続けて開いたら 1 秒以内は置き換える。押す前のファイル (クリックで開いた歩) は残る', () => {
    let h = visit(EMPTY_HISTORY, A, 0) // click
    h = visit(h, B, 100, true)
    h = visit(h, C, 400, true)
    h = visit(h, D, 1_300, true) // 900 ms after the previous one (C)
    expect(uris(h)).toEqual([A, D])
  })

  it('1 秒空いたら別の歩', () => {
    let h = visit(EMPTY_HISTORY, A, 0)
    h = visit(h, B, 100, true)
    h = visit(h, C, 100 + HISTORY_COALESCE_MS, true)
    expect(uris(h)).toEqual([A, B, C])
  })

  it('直前がクリック (byKeys でない) なら 1 秒以内でもまとめない', () => {
    let h = visit(EMPTY_HISTORY, A, 0)
    h = visit(h, B, 100)
    h = visit(h, C, 200, true)
    expect(uris(h)).toEqual([A, B, C])
  })

  it('↓ → ↑ で 1 つ前のファイルに戻ってきたら、同じファイルを 2 歩並べず畳む', () => {
    let h = visit(EMPTY_HISTORY, A, 0, true)
    h = visit(h, B, 2_000, true)
    h = visit(h, A, 2_300, true)
    expect(uris(h)).toEqual([A])
    expect(h.index).toBe(0)
  })

  it('↑↓ の後のクリックはまとめない', () => {
    let h = visit(EMPTY_HISTORY, A, 0)
    h = visit(h, B, 100, true)
    h = visit(h, C, 200)
    expect(uris(h)).toEqual([A, B, C])
  })
})

describe('stepHistory / canStep (戻る / 進む)', () => {
  const h = visit(visit(visit(EMPTY_HISTORY, A, 0), B, 10_000, false, 'q'), C, 20_000)

  it('戻る → 進む で行き来し、行き先の検索語も返す', () => {
    const back = stepHistory(h, C, 'back')
    expect(back?.entry).toMatchObject({ uri: B, highlight: 'q' })
    expect(back?.history.index).toBe(1)
    const forward = stepHistory(back!.history, B, 'forward')
    expect(forward?.entry.uri).toBe(C)
  })

  it('端では動けない。viewer が閉じている (null) ときも動かない', () => {
    expect(canStep(h, C, 'forward')).toBe(false)
    expect(canStep(EMPTY_HISTORY, A, 'back')).toBe(false)
    expect(stepHistory(h, null, 'back')).toBeNull()
    const first = stepHistory(stepHistory(h, C, 'back')!.history, B, 'back')!
    expect(canStep(first.history, A, 'back')).toBe(false)
  })

  it('表示中のファイルが履歴に無い (行き違い) ときは、それを 1 歩として積んでから戻る', () => {
    const back = stepHistory(h, D, 'back')
    expect(back?.entry.uri).toBe(C)
    expect(uris(back!.history)).toEqual([A, B, C, D])
  })
})

describe('キー・マウス・ジェスチャーの表 (純関数)', () => {
  it('viewerNavShortcut: mac は ⌃- / ⌃⇧-、その他は Alt+← / Alt+→', () => {
    const k = (init: Partial<{ key: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }>) => ({
      key: '',
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      isComposing: false,
      ...init
    })
    expect(viewerNavShortcut(k({ key: '-', ctrlKey: true }), 'mac')).toBe('viewerBack')
    expect(viewerNavShortcut(k({ key: '_', ctrlKey: true, shiftKey: true }), 'mac')).toBe('viewerForward')
    expect(viewerNavShortcut(k({ key: '=', code: 'Minus', ctrlKey: true, shiftKey: true }), 'mac')).toBe('viewerForward')
    expect(viewerNavShortcut(k({ key: '-', metaKey: true }), 'mac')).toBeNull() // ⌘- is zoom out of the display
    expect(viewerNavShortcut(k({ key: '=', ctrlKey: true }), 'mac')).toBeNull() // ⌃= has no assignment
    expect(viewerNavShortcut(k({ key: 'ArrowLeft', altKey: true }), 'mac')).toBeNull()
    expect(viewerNavShortcut(k({ key: 'ArrowLeft', altKey: true }), 'other')).toBe('viewerBack')
    expect(viewerNavShortcut(k({ key: 'ArrowRight', altKey: true }), 'other')).toBe('viewerForward')
    expect(viewerNavShortcut(k({ key: '-', ctrlKey: true }), 'other')).toBeNull() // Ctrl+- zooms out
  })

  it('検索・保存のキーとぶつからない', () => {
    for (const platform of ['mac', 'other'] as const) {
      for (const entry of viewerForwardedShortcuts(platform)) {
        if (entry.id !== 'viewerBack' && entry.id !== 'viewerForward') continue
        if (entry.button !== undefined) continue
        const event = { ...entry, isComposing: false }
        expect(searchShortcut(event)).toBeNull()
        expect(isSaveShortcut(event)).toBe(false)
        expect(viewerNavShortcut(event, platform)).toBe(entry.id)
      }
    }
  })

  it('viewer への送り返しの表: キーは matchViewerShortcut、マウスのボタン (mac だけ) は matchViewerMouseButton', () => {
    const mac = viewerForwardedShortcuts('mac')
    const press = { metaKey: false, shiftKey: false, altKey: false, isComposing: false }
    expect(matchViewerShortcut({ ...press, key: '-', ctrlKey: true }, mac)).toBe('viewerBack')
    expect(matchViewerShortcut({ ...press, key: '_', ctrlKey: true, shiftKey: true }, mac)).toBe('viewerForward')
    expect(matchViewerShortcut({ ...press, key: '', ctrlKey: false }, mac)).toBeNull() // Mouse rows are not matched against keys.
    expect(matchViewerMouseButton(3, mac)).toBe('viewerBack')
    expect(matchViewerMouseButton(4, mac)).toBe('viewerForward')
    expect(matchViewerMouseButton(0, mac)).toBeNull()
    const other = viewerForwardedShortcuts('other')
    expect(matchViewerMouseButton(3, other)).toBeNull() // Windows / Linux use main's app-command
    expect(matchViewerShortcut({ ...press, key: 'ArrowLeft', ctrlKey: false, altKey: true }, other)).toBe('viewerBack')
    expect(viewerNavMouseButton(3, 'mac')).toBe('viewerBack')
    expect(viewerNavMouseButton(3, 'other')).toBeNull()
  })

  it('main のジェスチャー: スワイプ (指を右へ = 戻る) と app-command', () => {
    expect(navFromSwipe('right')).toBe('viewerBack')
    expect(navFromSwipe('left')).toBe('viewerForward')
    expect(navFromSwipe('up')).toBeNull()
    expect(navFromAppCommand('browser-backward')).toBe('viewerBack')
    expect(navFromAppCommand('browser-forward')).toBe('viewerForward')
    expect(navFromAppCommand('media-play-pause')).toBeNull()
  })
})

// ---- ViewerPane + useViewerHistory (jsdom) ----

const PLUGIN = { pluginId: 'aios.text', name: 'Text', url: 'aios-plugin://aios.text/index.html', editable: true }

let container: HTMLDivElement
let root: Root
let menuListeners: ((command: MenuCommand) => void)[]

function fakeAios(): unknown {
  const viewer = {
    open: async () => PLUGIN,
    read: async (): Promise<ViewerResource> => ({ kind: 'text', text: 'x', truncated: false, size: 1, mtimeMs: 1 }),
    close: async () => undefined,
    untrackWatch: () => undefined,
    // A transient view (aios.diff) viewer. It need not be drawn, so it returns nothing
    openPayload: async () => null,
    write: async () => ({ ok: true, mtimeMs: 2, size: 1, reason: null }),
    command: async () => ({ ok: true, result: null }),
    reportDraft: async () => undefined
  }
  const noop = (): (() => void) => () => undefined
  const deep = (path: string): unknown =>
    new Proxy(() => Promise.resolve(undefined), {
      get: (_target, key) => (typeof key === 'string' ? deep(`${path}.${key}`) : undefined),
      apply: () => (path.includes('.on') ? noop() : Promise.resolve(undefined))
    })
  const app = {
    onMenuCommand: (listener: (command: MenuCommand) => void) => {
      menuListeners.push(listener)
      return () => {
        menuListeners = menuListeners.filter((l) => l !== listener)
      }
    },
    openExternal: async () => undefined
  }
  return new Proxy(
    { viewer, app },
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

const backButton = (): HTMLButtonElement | null => container.querySelector('button.viewer-back')
const forwardButton = (): HTMLButtonElement | null => container.querySelector('button.viewer-forward')

async function open(uri: string, options?: { byKeys?: boolean }): Promise<void> {
  await act(async () => {
    useStore.getState().select(uri, options)
  })
  await flush()
}

async function key(init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  })
  await flush()
}

const selected = (): string | null => useStore.getState().selectedUri

describe('ViewerPane: 戻る / 進む (TODO 369)', () => {
  let Harness: () => React.JSX.Element

  beforeAll(async () => {
    const { ViewerPane } = await import('../src/renderer/src/components/ViewerPane.js')
    const { useViewerHistory } = await import('../src/renderer/src/viewerHistory.js')
    Harness = () => {
      useViewerHistory()
      return createElement(ViewerPane)
    }
  })

  beforeEach(async () => {
    menuListeners = []
    ;(window as unknown as { aios: unknown }).aios = fakeAios()
    useLocale.setState({ resolved: 'en' })
    useThreads.setState({ activeThreadId: 't1' })
    useStore.setState({
      selectedUri: null,
      highlightQuery: null,
      viewerDirty: false,
      draftConflict: null,
      viewerDrafts: {},
      viewerHistories: {},
      selectByKeys: false,
      transient: null,
      roots: []
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(createElement(Harness))
    })
    await open(A)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('最初は両方とも無効。開くと「戻る」が有効、押すと戻って「進む」が有効', async () => {
    expect(backButton()?.disabled).toBe(true)
    expect(forwardButton()?.disabled).toBe(true)
    await open(B)
    expect(backButton()?.disabled).toBe(false)
    expect(forwardButton()?.disabled).toBe(true)

    await act(async () => backButton()?.click())
    await flush()
    expect(selected()).toBe(A)
    expect(backButton()?.disabled).toBe(true)
    expect(forwardButton()?.disabled).toBe(false)
    // Opened by going back, so nothing is pushed (stays A, B)
    expect(useStore.getState().viewerHistories['t1']?.entries.map((e) => e.uri)).toEqual([A, B])

    await act(async () => forwardButton()?.click())
    await flush()
    expect(selected()).toBe(B)
  })

  it('ボタンの名前は辞書から (EN / JA)、title は書かない', async () => {
    expect(backButton()?.getAttribute('aria-label')).toBe(en['viewer.back'])
    expect(forwardButton()?.getAttribute('aria-label')).toBe(en['viewer.forward'])
    expect(backButton()?.hasAttribute('title')).toBe(false)
    await act(async () => useLocale.setState({ resolved: 'ja' }))
    expect(backButton()?.getAttribute('aria-label')).toBe(ja['viewer.back'])
    expect(forwardButton()?.getAttribute('aria-label')).toBe(ja['viewer.forward'])
  })

  it('⌃- で戻り、⌃⇧- (US は _、JIS は =) で進む。⌘- (表示の縮小) と IME の合成中は拾わない', async () => {
    await open(B)
    await key({ key: '-', metaKey: true })
    expect(selected()).toBe(B)
    await key({ key: '-', ctrlKey: true, isComposing: true })
    expect(selected()).toBe(B)
    await key({ key: '-', code: 'Minus', ctrlKey: true })
    expect(selected()).toBe(A)
    await key({ key: '_', code: 'Minus', ctrlKey: true, shiftKey: true })
    expect(selected()).toBe(B)
    await key({ key: '-', ctrlKey: true })
    expect(selected()).toBe(A)
    await key({ key: '=', ctrlKey: true, shiftKey: true })
    expect(selected()).toBe(B)
  })

  it('マウスの戻る / 進むボタン (mouseup の 3 / 4) と main のジェスチャー (viewerBack / viewerForward)', async () => {
    await open(B)
    const down = new MouseEvent('mousedown', { button: 3, bubbles: true, cancelable: true })
    await act(async () => {
      window.dispatchEvent(down)
    })
    expect(down.defaultPrevented).toBe(true)
    expect(selected()).toBe(B) // Pressing down does not move it
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mouseup', { button: 3, bubbles: true, cancelable: true }))
    })
    await flush()
    expect(selected()).toBe(A)
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mouseup', { button: 4, bubbles: true, cancelable: true }))
    })
    await flush()
    expect(selected()).toBe(B)

    await act(async () => {
      for (const listener of menuListeners) listener('viewerBack')
    })
    await flush()
    expect(selected()).toBe(A)
    await act(async () => {
      for (const listener of menuListeners) listener('viewerForward')
    })
    await flush()
    expect(selected()).toBe(B)
  })

  it('↑↓ (byKeys) の 1 秒以内の連続は 1 歩: 戻ると押す前のファイルへ', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    await open(B) // click
    now += 100
    await open(C, { byKeys: true })
    now += 300
    await open(D, { byKeys: true })
    expect(useStore.getState().viewerHistories['t1']?.entries.map((e) => e.uri)).toEqual([A, B, D])
    await act(async () => backButton()?.click())
    await flush()
    expect(selected()).toBe(B)

    // ↑↓ after a 1-second gap is a separate step
    now += 5_000
    await open(C, { byKeys: true })
    now += HISTORY_COALESCE_MS + 1
    await open(D, { byKeys: true })
    expect(useStore.getState().viewerHistories['t1']?.entries.map((e) => e.uri)).toEqual([A, B, C, D])
  })

  it('aios.diff の一時表示は積まない。前に出ている間の「戻る」は diff を閉じて裏のファイルに戻る', async () => {
    await open(B)
    await act(async () => {
      useStore.getState().openDiff({ before: { name: 'x', text: 'a' }, after: { name: 'x', text: 'b' } })
    })
    await flush()
    expect(useStore.getState().viewerHistories['t1']?.entries.map((e) => e.uri)).toEqual([A, B])
    await key({ key: '-', ctrlKey: true })
    expect(useStore.getState().transient).toBeNull()
    expect(selected()).toBe(B)
    await key({ key: '-', ctrlKey: true })
    expect(selected()).toBe(A)
  })

  it('閉じた (select(null)) は積まない。履歴はスレッドごと', async () => {
    await open(B)
    await act(async () => useStore.getState().select(null))
    await flush()
    expect(useStore.getState().viewerHistories['t1']?.entries.map((e) => e.uri)).toEqual([A, B])

    // To another thread (opens C instead of restoring memory). The t1 history is not touched
    await act(async () => useThreads.setState({ activeThreadId: 't2' }))
    await open(C)
    expect(useStore.getState().viewerHistories['t2']?.entries.map((e) => e.uri)).toEqual([C])
    expect(backButton()?.disabled).toBe(true)
    expect(useStore.getState().viewerHistories['t1']?.entries.map((e) => e.uri)).toEqual([A, B])

    // Back to t1. t1's memory is 'closed', so restoring memory (`viewerMemory.ts`) calls select(null).
    // Reopening B makes back go to A.
    await act(async () => {
      useThreads.setState({ activeThreadId: 't1' })
      useStore.getState().select(null)
    })
    await open(B)
    expect(backButton()?.disabled).toBe(false)
    await act(async () => backButton()?.click())
    await flush()
    expect(selected()).toBe(A)
  })

  it('無効のボタンでも外側の span で吹き出しが出る (キーの表記つき)', async () => {
    const slot = backButton()?.parentElement as HTMLElement
    expect(backButton()?.disabled).toBe(true)
    expect(slot.classList.contains('viewer-nav-slot')).toBe(true)
    await act(async () => {
      slot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450))
    })
    const tip = document.querySelector('[role="tooltip"]')
    expect(tip?.textContent).toBe(`${en['viewer.back']} (⌃-)`)
  })
})
