// @vitest-environment jsdom
/**
 * TODO 801 (wave 38 bundle B): back and forward across aios as a whole.
 *
 * - Pure functions (`nav-history.ts`): pushing, rewriting the viewer, collapsing within 1 second, back / forward, dropping the entries ahead, the limit, and skipping destinations that no longer exist.
 * - jsdom (`useNavHistory` + `NavButtons`): only switching conversations becomes an entry (TODO 1257: the mode and the selection in Files / Search do not become entries, and going back keeps the mode as it is);
 *   the buttons and keys; a move opened by going back is not pushed; a deleted conversation is skipped; a viewer file that is gone is closed and only the conversation is restored; EN / JA names.
 *   Neither the model nor main is used (`window.aios` is a fake).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  EMPTY_NAV,
  NAV_COALESCE_MS,
  NAV_LIMIT,
  canStepNav,
  followViewer,
  recordStep,
  stepNav,
  type NavEntry,
  type NavHistory,
  type NavPosition
} from '../src/renderer/src/nav-history.js'
import { useStore } from '../src/renderer/src/store.js'
import { useThreads } from '../src/renderer/src/threadStore.js'
import { useLocale } from '../src/renderer/src/localeStore.js'
import { en } from '../src/renderer/src/i18n/en.js'
import { ja } from '../src/renderer/src/i18n/ja.js'
import { globalNavShortcut, setKeybindings } from '../src/renderer/src/shortcuts.js'
import { KEYBINDING_COMMANDS } from '../src/shared/keybindings.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Object.defineProperty(window.navigator, 'platform', { configurable: true, value: 'MacIntel' })
// import is hoisted and runs before navigator.platform is replaced, so the key convention is fixed to mac here.
setKeybindings({}, 'mac')
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

const pos = (threadId: string | null, viewerUri: string | null = null): NavPosition => ({ threadId, viewerUri })
const none = (): boolean => false
const T0 = 1_000_000

function stepsOf(history: NavHistory): string[] {
  return history.entries.map((e) => `${e.threadId ?? '-'}:${e.viewerUri ?? '-'}`)
}

describe('nav-history: 純関数', () => {
  it('最初の位置は followViewer が最初の歩にする。同じなら同じ値', () => {
    const h = followViewer(EMPTY_NAV, pos('a', 'f1'), T0)
    expect(stepsOf(h)).toEqual(['a:f1'])
    expect(h.index).toBe(0)
    expect(followViewer(h, pos('a', 'f1'), T0 + 5)).toBe(h)
  })

  it('同じ会話の中の viewer の切り替えは歩にならず、いまの歩の viewer を書き換える', () => {
    let h = followViewer(EMPTY_NAV, pos('a', 'f1'), T0)
    h = followViewer(h, pos('a', 'f2'), T0 + 10)
    expect(stepsOf(h)).toEqual(['a:f2'])
    // recordStep with the same conversation is not a step either (TODO 1257).
    h = recordStep(h, pos('a', 'f3'), T0 + 5000)
    expect(stepsOf(h)).toEqual(['a:f3'])
  })

  it('会話 A → B: A の歩には A の viewer が残り、戻ると A の viewer が分かる', () => {
    let h = followViewer(EMPTY_NAV, pos('a', 'fa'), T0)
    h = recordStep(h, pos('b', 'fa'), T0 + 5000)
    h = followViewer(h, pos('b', 'fb'), T0 + 5001)
    expect(stepsOf(h)).toEqual(['a:fa', 'b:fb'])
    const back = stepNav(h, 'back', none)
    expect(back?.entry.threadId).toBe('a')
    expect(back?.entry.viewerUri).toBe('fa')
    expect(back?.history.index).toBe(0)
  })

  it('TODO 1257: 歩はモードを持たない (NavPosition は会話と viewer だけ)', () => {
    const h = followViewer(EMPTY_NAV, pos('a'), T0)
    expect(Object.keys(h.entries[0]!).sort()).toEqual(['at', 'rapid', 'threadId', 'viewerUri'])
  })

  it('会話の無い位置 (起動直後) は歩として残さず、最初の会話の歩で置き換える', () => {
    let h = followViewer(EMPTY_NAV, pos(null, 'f0'), T0)
    h = recordStep(h, pos('a', 'f0'), T0 + 5000)
    expect(stepsOf(h)).toEqual(['a:f0'])
    expect(canStepNav(h, 'back', none)).toBe(false)
  })

  it('会話の無い歩には戻らない', () => {
    const h: NavHistory = {
      entries: [
        { threadId: null, viewerUri: null, at: T0, rapid: false },
        { threadId: 'a', viewerUri: null, at: T0 + 5000, rapid: true }
      ],
      index: 1
    }
    expect(stepNav(h, 'back', none)).toBeNull()
  })

  it('連打 (1 秒以内の会話の切り替え) は 1 歩にまとめ、押す前の位置は残る', () => {
    let h = followViewer(EMPTY_NAV, pos('a'), T0)
    h = recordStep(h, pos('b'), T0 + 5000)
    h = recordStep(h, pos('c'), T0 + 5300)
    h = recordStep(h, pos('d'), T0 + 5600)
    expect(stepsOf(h)).toEqual(['a:-', 'd:-'])
    expect(h.index).toBe(1)
  })

  it('1 秒空ければ別の歩', () => {
    let h = followViewer(EMPTY_NAV, pos('a'), T0)
    h = recordStep(h, pos('b'), T0 + 5000)
    h = recordStep(h, pos('c'), T0 + 5000 + NAV_COALESCE_MS)
    expect(stepsOf(h)).toEqual(['a:-', 'b:-', 'c:-'])
  })

  it('連打で 1 つ前に戻ってきたら畳む (同じ会話を 2 歩並べない)', () => {
    let h = followViewer(EMPTY_NAV, pos('a', 'fa'), T0)
    h = recordStep(h, pos('b', 'fa'), T0 + 5000)
    h = recordStep(h, pos('a', 'fb'), T0 + 5200)
    expect(stepsOf(h)).toEqual(['a:fa'])
    expect(h.index).toBe(0)
  })

  it('最初の歩 (initial) はまとめの対象にならない', () => {
    let h = followViewer(EMPTY_NAV, pos('a'), T0)
    h = recordStep(h, pos('b'), T0 + 10)
    expect(stepsOf(h)).toEqual(['a:-', 'b:-'])
  })

  it('戻る / 進む。端では null', () => {
    let h = followViewer(EMPTY_NAV, pos('a'), T0)
    h = recordStep(h, pos('b'), T0 + 5000)
    expect(stepNav(h, 'forward', none)).toBeNull()
    const back = stepNav(h, 'back', none)
    expect(back?.entry.threadId).toBe('a')
    expect(stepNav(back!.history, 'back', none)).toBeNull()
    const forward = stepNav(back!.history, 'forward', none)
    expect(forward?.entry.threadId).toBe('b')
    expect(canStepNav(h, 'back', none)).toBe(true)
    expect(canStepNav(EMPTY_NAV, 'back', none)).toBe(false)
  })

  it('戻った位置から動いたら先の歩を捨てる', () => {
    let h = followViewer(EMPTY_NAV, pos('a'), T0)
    h = recordStep(h, pos('b'), T0 + 5000)
    h = recordStep(h, pos('c'), T0 + 9000)
    h = stepNav(h, 'back', none)!.history
    h = stepNav(h, 'back', none)!.history
    h = recordStep(h, pos('z'), T0 + 20000)
    expect(stepsOf(h)).toEqual(['a:-', 'z:-'])
  })

  it('上限 (50 歩) を超えたら古いほうから捨てる', () => {
    let h = followViewer(EMPTY_NAV, pos('t0'), T0)
    for (let i = 1; i <= NAV_LIMIT + 10; i++) h = recordStep(h, pos(`t${i}`), T0 + i * 5000)
    expect(h.entries).toHaveLength(NAV_LIMIT)
    expect(h.entries[0]?.threadId).toBe('t11')
    expect(h.index).toBe(NAV_LIMIT - 1)
  })

  it('消えた先は黙って飛ばし、次の有効な歩まで動く (飛ばした歩は列に残る)', () => {
    let h = followViewer(EMPTY_NAV, pos('a'), T0)
    h = recordStep(h, pos('b'), T0 + 5000)
    h = recordStep(h, pos('c'), T0 + 9000)
    const dead = (e: NavEntry): boolean => e.threadId === 'b'
    const back = stepNav(h, 'back', dead)
    expect(back?.entry.threadId).toBe('a')
    expect(back?.history.index).toBe(0)
    expect(back?.history.entries).toHaveLength(3)
    const forward = stepNav(back!.history, 'forward', dead)
    expect(forward?.entry.threadId).toBe('c')
    expect(stepNav(h, 'back', () => true)).toBeNull()
    expect(canStepNav(h, 'back', () => true)).toBe(false)
  })
})

describe('キー割り当て', () => {
  it('nav.back / nav.forward は表にあり、viewer 用 (viewer.back) と別の既定', () => {
    const table = new Map(KEYBINDING_COMMANDS.map((c) => [c.id, c]))
    expect(table.get('nav.back')?.defaults).toEqual({ mac: 'Cmd+[', other: 'Alt+Shift+Left' })
    expect(table.get('nav.forward')?.defaults).toEqual({ mac: 'Cmd+]', other: 'Alt+Shift+Right' })
    expect(table.get('nav.back')?.defaults.mac).not.toBe(table.get('viewer.back')?.defaults.mac)
  })

  it('mac は ⌘[ / ⌘]、viewer 用の ⌃- では動かない', () => {
    const k = (init: Partial<Parameters<typeof globalNavShortcut>[0]>): Parameters<typeof globalNavShortcut>[0] => ({
      key: '',
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      isComposing: false,
      ...init
    })
    expect(globalNavShortcut(k({ key: '[', metaKey: true }))).toBe('navBack')
    expect(globalNavShortcut(k({ key: ']', metaKey: true }))).toBe('navForward')
    expect(globalNavShortcut(k({ key: '-', ctrlKey: true }))).toBeNull()
    expect(globalNavShortcut(k({ key: '[', metaKey: true, isComposing: true }))).toBeNull()
  })
})

// ---- useNavHistory + NavButtons (jsdom) ----

let container: HTMLDivElement
let root: Root

function fakeAios(missing: ReadonlySet<string>): unknown {
  const fs = { stat: async (uri: string) => (missing.has(uri) ? null : { uri }) }
  const noop = (): (() => void) => () => undefined
  const deep = (path: string): unknown =>
    new Proxy(() => Promise.resolve(undefined), {
      get: (_target, key) => (typeof key === 'string' ? deep(`${path}.${key}`) : undefined),
      apply: () => (path.includes('.on') ? noop() : Promise.resolve(undefined))
    })
  return new Proxy({ fs }, { get: (target, key) => (key in target ? target[key as keyof typeof target] : deep(String(key))) })
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const backButton = (): HTMLButtonElement | null => container.querySelector('button.nav-back')
const forwardButton = (): HTMLButtonElement | null => container.querySelector('button.nav-forward')
const selected = (): string | null => useStore.getState().selectedUri

function row(id: string): never {
  return { id, title: id } as never
}

describe('useNavHistory + NavButtons', () => {
  let Harness: () => React.JSX.Element
  let useNav: typeof import('../src/renderer/src/navHistory.js').useNav
  let missing: Set<string>
  let now = 1_000_000

  /** Selects a conversation (the real `selectThread` calls IPC, so it is replaced with a fake that only does the same `set`). */
  async function openThread(id: string): Promise<void> {
    await act(async () => {
      await useThreads.getState().selectThread(id)
    })
    await flush()
  }

  async function click(el: HTMLButtonElement | null): Promise<void> {
    await act(async () => el?.click())
    await flush()
  }

  beforeAll(async () => {
    const mod = await import('../src/renderer/src/navHistory.js')
    useNav = mod.useNav
    const { NavButtons } = await import('../src/renderer/src/components/NavButtons.js')
    Harness = () => {
      mod.useNavHistory()
      return createElement(NavButtons)
    }
  })

  beforeEach(async () => {
    missing = new Set()
    ;(window as unknown as { aios: unknown }).aios = fakeAios(missing)
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    useLocale.setState({ resolved: 'en' })
    useNav.setState({ history: EMPTY_NAV })
    useThreads.setState({
      mode: 'threads',
      activeThreadId: 'a',
      threadsById: { a: row('a'), b: row('b'), c: row('c') },
      selectThread: async (id: string, options?: { readonly keepMode?: boolean }) => {
        useThreads.setState(options?.keepMode === true ? { activeThreadId: id } : { activeThreadId: id, mode: 'threads' })
      }
    })
    useStore.setState({ selectedUri: null, highlightQuery: null, viewerHistories: {}, selectByKeys: false, transient: null })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(createElement(Harness))
    })
    await flush()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('最初は両方無効。会話を替えると「戻る」が有効、押すと元の会話に戻り「進む」が有効', async () => {
    expect(backButton()?.disabled).toBe(true)
    expect(forwardButton()?.disabled).toBe(true)
    now += 5000
    await openThread('b')
    expect(backButton()?.disabled).toBe(false)
    await click(backButton())
    expect(useThreads.getState().activeThreadId).toBe('a')
    expect(backButton()?.disabled).toBe(true)
    expect(forwardButton()?.disabled).toBe(false)
    // A move opened by going back is not pushed (it stays a, b).
    expect(useNav.getState().history.entries.map((e) => e.threadId)).toEqual(['a', 'b'])
    await click(forwardButton())
    expect(useThreads.getState().activeThreadId).toBe('b')
  })

  it('会話 A → B で A の viewer のファイルが、戻ると復元される', async () => {
    await act(async () => useStore.getState().select('file:///w/a.ts'))
    await flush()
    now += 5000
    await openThread('b')
    await act(async () => useStore.getState().select('file:///w/b.ts'))
    await flush()
    expect(useNav.getState().history.entries.map((e) => e.viewerUri)).toEqual(['file:///w/a.ts', 'file:///w/b.ts'])
    await click(backButton())
    expect(useThreads.getState().activeThreadId).toBe('a')
    expect(selected()).toBe('file:///w/a.ts')
    await click(forwardButton())
    expect(useThreads.getState().activeThreadId).toBe('b')
    expect(selected()).toBe('file:///w/b.ts')
  })

  it('同じ会話の中の viewer のファイル切り替えは歩にならない', async () => {
    await act(async () => useStore.getState().select('file:///w/a.ts'))
    await act(async () => useStore.getState().select('file:///w/b.ts'))
    await flush()
    expect(useNav.getState().history.entries).toHaveLength(1)
    expect(backButton()?.disabled).toBe(true)
  })

  it('TODO 1257: モード (ActivityBar) の切り替えと Files / Search での選択は歩にならない', async () => {
    now += 5000
    await act(async () => useThreads.setState({ mode: 'files' }))
    now += 5000
    await act(async () => useStore.getState().select('file:///w/x.ts'))
    now += 5000
    await act(async () => useThreads.setState({ mode: 'search' }))
    await act(async () => useStore.getState().select('file:///w/y.ts'))
    await flush()
    expect(useNav.getState().history.entries.map((e) => `${e.threadId ?? '-'}:${e.viewerUri ?? '-'}`)).toEqual([
      'a:file:///w/y.ts'
    ])
    expect(backButton()?.disabled).toBe(true)
  })

  it('TODO 1257: 戻っても今のモードのまま (モードは歩に覚えない)', async () => {
    now += 5000
    await openThread('b')
    await act(async () => useThreads.setState({ mode: 'files' }))
    await flush()
    await click(backButton())
    expect(useThreads.getState().activeThreadId).toBe('a')
    expect(useThreads.getState().mode).toBe('files')
    await click(forwardButton())
    expect(useThreads.getState().activeThreadId).toBe('b')
    expect(useThreads.getState().mode).toBe('files')
  })

  it('消えた会話の歩は黙って飛ばす', async () => {
    now += 5000
    await openThread('b')
    now += 5000
    await openThread('c')
    useThreads.setState({ threadsById: { a: row('a'), c: row('c') } })
    await flush()
    await click(backButton())
    expect(useThreads.getState().activeThreadId).toBe('a')
  })

  it('消えた会話だけが残ったらボタンは無効 (TODO 803)', async () => {
    now += 5000
    await openThread('b')
    await act(async () => useThreads.setState({ threadsById: { b: row('b'), c: row('c') } }))
    await flush()
    expect(backButton()?.disabled).toBe(true)
  })

  it('戻った先の会話の viewer のファイルが無くなっていれば、viewer を閉じて会話だけ戻す', async () => {
    await act(async () => useStore.getState().select('file:///w/gone.ts'))
    await flush()
    now += 5000
    await openThread('b')
    await act(async () => useStore.getState().select('file:///w/ok.ts'))
    await flush()
    missing.add('file:///w/gone.ts')
    await click(backButton())
    expect(useThreads.getState().activeThreadId).toBe('a')
    expect(selected()).toBeNull()
  })

  it('キー (⌘[ / ⌘]) でも動く', async () => {
    now += 5000
    await openThread('b')
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '[', metaKey: true, bubbles: true, cancelable: true }))
    })
    await flush()
    expect(useThreads.getState().activeThreadId).toBe('a')
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ']', metaKey: true, bubbles: true, cancelable: true }))
    })
    await flush()
    expect(useThreads.getState().activeThreadId).toBe('b')
  })

  it('入力欄にフォーカスがあるときはキーを奪わない', async () => {
    now += 5000
    await openThread('b')
    const input = document.createElement('textarea')
    document.body.appendChild(input)
    input.focus()
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: '[', metaKey: true, bubbles: true, cancelable: true }))
    })
    await flush()
    expect(useThreads.getState().activeThreadId).toBe('b')
    input.remove()
  })

  it('ボタンの名前は辞書から (EN / JA)。viewer 用と別の文言', async () => {
    expect(backButton()?.getAttribute('aria-label')).toBe(en['nav.back'])
    expect(forwardButton()?.getAttribute('aria-label')).toBe(en['nav.forward'])
    expect(en['nav.back']).not.toBe(en['viewer.back'])
    await act(async () => useLocale.setState({ resolved: 'ja' }))
    await flush()
    expect(backButton()?.getAttribute('aria-label')).toBe(ja['nav.back'])
    expect(ja['nav.back']).not.toBe(ja['viewer.back'])
  })
})
