// @vitest-environment jsdom
/**
 * TODO 531 (wave 27 bundle E): Web tab keys (⌘T / ⌘W / ⌘L / ⌃Tab / ⌃⇧Tab). The form adds five keys to the table of TODO 549.
 * In jsdom, `window.aios.web` is a fake. Neither the model nor electron is used.
 *
 * - table: the default keys, the reverse-send table when the page has focus (only the modifier rows as pressed), and the renderer's judgment
 * - movement: ⌘T = a new blank tab, ⌘L = the focus signal to the URL field, ⌃Tab / ⌃⇧Tab = the neighboring tab (wraps at the ends)
 * - ⌘W (the menu's 'Close'): a tab if the Web pane is in front, otherwise the window. The role `close` is no longer used
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WEB_SECTIONS, WEB_BLANK_URL, type WebTabsState } from '../src/shared/web-tabs.js'
import { effectiveKeybinding } from '../src/shared/keybindings.js'
import { matchWebShortcut } from '../src/shared/web-view.js'
import { CLOSE_ITEM, registeredAccelerators } from '../src/main/menu-model.js'
import { NATIVE_DICTIONARIES } from '../src/main/i18n-native.js'

const TABS: WebTabsState = {
  tabs: [
    { id: 't1', url: 'https://a.example/', title: 'A', favicon: null },
    { id: 't2', url: 'https://b.example/', title: 'B', favicon: null },
    { id: 't3', url: 'https://c.example/', title: 'C', favicon: null }
  ],
  activeId: 't1'
}

const calls: string[] = []

function stubApi(): void {
  ;(window as unknown as { aios: unknown }).aios = {
    web: {
      activateTab: vi.fn(async (id: string) => {
        calls.push(`activate:${id}`)
        return TABS
      }),
      newTab: vi.fn(async (url: string | null) => {
        calls.push(`newTab:${url ?? 'blank'}`)
        return TABS
      }),
      closeTab: vi.fn(async (id: string) => {
        calls.push(`close:${id}`)
        return { tabs: TABS.tabs.filter((tab) => tab.id !== id), activeId: 't2' }
      }),
      load: vi.fn(async () => true)
    },
    app: { onMenuCommand: () => () => {} }
  }
}

describe('keys for Web tabs (TODO 531)', () => {
  let shortcuts: typeof import('../src/renderer/src/shortcuts.js')
  let actions: typeof import('../src/renderer/src/shortcut-actions.js')
  let store: typeof import('../src/renderer/src/store.js')
  let web: typeof import('../src/renderer/src/webStore.js')

  beforeAll(async () => {
    stubApi()
    shortcuts = await import('../src/renderer/src/shortcuts.js')
    actions = await import('../src/renderer/src/shortcut-actions.js')
    store = await import('../src/renderer/src/store.js')
    web = await import('../src/renderer/src/webStore.js')
  })

  beforeEach(() => {
    stubApi()
    calls.length = 0
    store.useStore.setState({ selectedUri: 'https://a.example/', transient: null, viewerDeferred: false, viewerFolded: false })
    web.useWeb.setState({ tabs: TABS, history: [], favorites: [], sections: DEFAULT_WEB_SECTIONS, focusAddress: 0 })
  })

  afterEach(() => shortcuts.setKeybindings({}, 'mac'))

  const press = (over: Partial<KeyboardEventInit & { key: string }>) => ({
    key: 't',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    ...over
  })

  it('the default keys are the same as Chrome', () => {
    expect(effectiveKeybinding('web.newTab', 'mac', {})).toBe('CmdOrCtrl+T')
    expect(effectiveKeybinding('web.closeTab', 'mac', {})).toBe('CmdOrCtrl+W')
    expect(effectiveKeybinding('web.focusAddress', 'mac', {})).toBe('CmdOrCtrl+L')
    expect(effectiveKeybinding('web.nextTab', 'mac', {})).toBe('Ctrl+Tab')
    expect(effectiveKeybinding('web.prevTab', 'other', {})).toBe('Ctrl+Shift+Tab')
  })

  it('table when the page has focus: only rows with the modifiers exactly as pressed (mac ⌃T / ⌃L go to the page)', () => {
    const table = shortcuts.webViewShortcuts('mac')
    const input = (key: string, mods: { meta?: boolean; control?: boolean; shift?: boolean }) => ({
      type: 'keyDown',
      key,
      meta: mods.meta ?? false,
      control: mods.control ?? false,
      shift: mods.shift ?? false,
      alt: false
    })
    expect(matchWebShortcut(input('t', { meta: true }), table)).toBe('webNewTab')
    expect(matchWebShortcut(input('t', { control: true }), table)).toBeNull()
    expect(matchWebShortcut(input('l', { meta: true }), table)).toBe('webFocusAddress')
    expect(matchWebShortcut(input('Tab', { control: true }), table)).toBe('webNextTab')
    expect(matchWebShortcut(input('Tab', { control: true, shift: true }), table)).toBe('webPrevTab')
    // ⌘W is a menu accelerator, so it is not in the table (the menu catches it even when the page has focus)
    expect(matchWebShortcut(input('w', { meta: true }), table)).toBeNull()
    const other = shortcuts.webViewShortcuts('other')
    expect(matchWebShortcut(input('t', { control: true }), other)).toBe('webNewTab')
  })

  it("the renderer's decision (whether it is in front is up to the caller) and assignment changes", () => {
    expect(shortcuts.webTabShortcut(press({ key: 't', metaKey: true }))).toBe('webNewTab')
    expect(shortcuts.webTabShortcut(press({ key: 'L', metaKey: true }))).toBe('webFocusAddress')
    expect(shortcuts.webTabShortcut(press({ key: 'Tab', ctrlKey: true }))).toBe('webNextTab')
    expect(shortcuts.webTabShortcut(press({ key: 'Tab', ctrlKey: true, shiftKey: true }))).toBe('webPrevTab')
    expect(shortcuts.webTabShortcut(press({ key: 'Tab' }))).toBeNull()
    // On mac, ⌃T / ⌃L stay the emacs-style operations of the input field (unlike the search keys, they are not matched loosely)
    expect(shortcuts.webTabShortcut(press({ key: 't', ctrlKey: true }))).toBeNull()
    expect(shortcuts.webTabShortcut(press({ key: 't', metaKey: true, isComposing: true }))).toBeNull()
    shortcuts.setKeybindings({ 'web.newTab': 'Cmd+Shift+T' }, 'mac')
    expect(shortcuts.webTabShortcut(press({ key: 't', metaKey: true }))).toBeNull()
    expect(shortcuts.webTabShortcut(press({ key: 'T', metaKey: true, shiftKey: true }))).toBe('webNewTab')
  })

  it('front: a web page or a blank tab; not in front while a file or temporary display is shown', () => {
    expect(actions.webPaneFront()).toBe(true)
    store.useStore.setState({ selectedUri: WEB_BLANK_URL })
    expect(actions.webPaneFront()).toBe(true)
    store.useStore.setState({ selectedUri: 'file:///tmp/a.txt' })
    expect(actions.webPaneFront()).toBe(false)
    store.useStore.setState({ selectedUri: 'https://a.example/', transient: { kind: 'diff' } as never })
    expect(actions.webPaneFront()).toBe(false)
  })

  it('⌃Tab / ⌃⇧Tab go to the neighbor tab (wrapping at the ends); sending back from the page takes the same path', () => {
    expect(actions.neighborWebTab(TABS.tabs, 't3', 1)?.id).toBe('t1')
    expect(actions.neighborWebTab(TABS.tabs, 't1', -1)?.id).toBe('t3')
    expect(actions.neighborWebTab(TABS.tabs.slice(0, 1), 't1', 1)).toBeNull()
    actions.runWebTabShortcut('webNextTab')
    expect(calls).toEqual(['activate:t2'])
    expect(store.useStore.getState().selectedUri).toBe('https://b.example/')
    actions.runViewerShortcut('webPrevTab')
    expect(calls.at(-1)).toBe('activate:t1')
  })

  it('⌘T is a blank new tab (with the signal to focus the URL field), and ⌘L is only the signal', () => {
    actions.runViewerShortcut('webNewTab')
    expect(calls).toEqual(['newTab:blank'])
    expect(store.useStore.getState().selectedUri).toBe(WEB_BLANK_URL)
    expect(web.useWeb.getState().focusAddress).toBe(1)
    actions.runWebTabShortcut('webFocusAddress')
    expect(web.useWeb.getState().focusAddress).toBe(2)
    expect(calls).toEqual(['newTab:blank'])
  })

  it('⌘W: closes the tab if the Web pane is in front, otherwise closes the window', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined)
    actions.closeTabOrWindow()
    await Promise.resolve()
    expect(calls).toEqual(['close:t1'])
    expect(close).not.toHaveBeenCalled()
    // TODO 843: if a file viewer is in front, it closes the viewer (not the window) by the same route as ✕
    store.useStore.setState({ selectedUri: 'file:///tmp/a.txt' })
    const closer = vi.fn()
    const unregister = actions.registerViewerCloser(closer)
    actions.closeTabOrWindow()
    expect(closer).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    unregister()
    // Even without a registration (e.g. an empty state), the selection is cleared. The window is not closed
    actions.closeTabOrWindow()
    expect(store.useStore.getState().selectedUri).toBeNull()
    expect(close).not.toHaveBeenCalled()
    // With neither a viewer nor Web, the window closes (same as VS Code)
    actions.closeTabOrWindow()
    expect(close).toHaveBeenCalledTimes(1)
    // TODO 1326 review Y2: a Web view in front with no current tab (here not a single tab) closes the view first, then the window
    store.useStore.setState({ selectedUri: WEB_BLANK_URL })
    web.useWeb.setState({ tabs: { tabs: [], activeId: null } })
    actions.closeTabOrWindow()
    expect(store.useStore.getState().selectedUri).toBeNull()
    expect(close).toHaveBeenCalledTimes(1)
    actions.closeTabOrWindow()
    expect(close).toHaveBeenCalledTimes(2)
    close.mockRestore()
  })

  it('TODO 1327: with the viewer hidden (or folded), ⌘W closes the window and leaves what the viewer holds alone', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined)
    const closer = vi.fn()
    const unregister = actions.registerViewerCloser(closer)
    try {
      store.useStore.setState({ viewerFolded: true })
      actions.closeTabOrWindow()
      await Promise.resolve()
      expect(calls).toEqual([])
      expect(store.useStore.getState().selectedUri).toBe('https://a.example/')
      store.useStore.setState({ selectedUri: 'file:///tmp/a.txt' })
      actions.closeTabOrWindow()
      expect(closer).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledTimes(2)
      // Shown again: ⌘W closes the file in front as before.
      store.useStore.setState({ viewerFolded: false })
      actions.closeTabOrWindow()
      expect(closer).toHaveBeenCalledTimes(1)
      expect(close).toHaveBeenCalledTimes(2)
    } finally {
      unregister()
      close.mockRestore()
    }
  })

  it('TODO 1326 review Y2: ⌘W after a typed-into blank tab was closed never closes the window, and the blank step is gone', async () => {
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const { canStep } = await import('../src/renderer/src/viewer-history.js')
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined)
    const F = 'file:///tmp/f.md'
    const U = 'https://u.example/'
    const step = (uri: string) => ({ uri, highlight: null, at: 0, byKeys: false })
    // + gave a blank tab, a URL was typed into it: the history is [F, blank, U] and the tab (tU) shows U.
    useThreads.setState({ activeThreadId: 'k1' })
    store.useStore.setState({
      selectedUri: U,
      viewerHistories: { k1: { entries: [step(F), step(WEB_BLANK_URL), step(U)], index: 2 } }
    })
    web.useWeb.setState({ tabs: { tabs: [{ id: 'tU', url: U, title: '', favicon: null }], activeId: 'tU' } })
    const api = (window as unknown as { aios: { web: { closeTab: ReturnType<typeof vi.fn> } } }).aios.web
    api.closeTab = vi.fn(async () => ({ tabs: [], activeId: null }))
    try {
      // ⌘W closes the tab: back to F, and the blank step of the closed tab leaves the history (no tab is blank any more).
      actions.closeTabOrWindow()
      await vi.waitFor(() => expect(store.useStore.getState().selectedUri).toBe(F))
      const history = store.useStore.getState().viewerHistories.k1
      expect(history?.entries.map((e) => e.uri)).toEqual([F])
      expect(canStep(history!, F, 'forward')).toBe(false)
      // Even if a Web step with no current tab is in front (an old history), ⌘W closes that view, not the window.
      store.useStore.setState({
        selectedUri: WEB_BLANK_URL,
        viewerHistories: { k1: { entries: [step(F), step(WEB_BLANK_URL)], index: 1 } }
      })
      web.useWeb.setState({ tabs: { tabs: [], activeId: null } })
      actions.closeTabOrWindow()
      expect(store.useStore.getState().selectedUri).toBe(F)
      expect(store.useStore.getState().viewerHistories.k1?.entries.map((e) => e.uri)).toEqual([F])
      expect(close).not.toHaveBeenCalled()
    } finally {
      useThreads.setState({ activeThreadId: null })
      store.useStore.setState({ viewerHistories: {} })
      close.mockRestore()
    }
  })

  it('menu: 「閉じる」 is its own item (does not use role close), and ⌘W is registered and follows the assignment', () => {
    const menu = readFileSync(join(process.cwd(), 'src/main/menu.ts'), 'utf8')
    expect(menu).not.toMatch(/role: 'close'/)
    expect(CLOSE_ITEM.command).toBe('closeTabOrWindow')
    expect(NATIVE_DICTIONARIES.ja[CLOSE_ITEM.label]).toBeTruthy()
    expect(NATIVE_DICTIONARIES.en[CLOSE_ITEM.label]).toBeTruthy()
    expect(registeredAccelerators('darwin')).toContain('CmdOrCtrl+W')
    expect(registeredAccelerators('darwin', { 'web.closeTab': 'Cmd+Shift+W' })).toContain('Cmd+Shift+W')
    expect(registeredAccelerators('darwin', { 'web.closeTab': null })).not.toContain('CmdOrCtrl+W')
  })
})
