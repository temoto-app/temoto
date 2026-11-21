/**
 * App-wide shortcuts (ARCHITECTURE.md 5.5.2, TODO 46 / 48).
 *
 * Three things to look at:
 * 1. Key -> the search box table (Ctrl+F / Ctrl+Shift+F = body, Ctrl+P = name, Ctrl+K = conversation; aligned with VS Code in item 189. The ⌘ side on mac is the same).
 * 2. Things that must not be picked up (no modifier / ⌥ / during IME composition / keys with no assignment).
 * 3. Pressing ⌘F in search mode does **not** collapse the sidebar (pressing the same mode again in `setMode` is a toggle, so calling it raw would hide it).
 */
import { describe, expect, it } from 'vitest'
import {
  appShortcut,
  threadFindKeyLabel,
  webViewShortcuts,
  isSearchTarget,
  modeKeyAction,
  modeKeyLabel,
  openModeStep,
  openSearchStep,
  searchShortcut,
  viewerForwardedShortcuts,
  isSaveShortcut,
  type ShortcutKey
} from '@renderer/shortcuts.js'

function key(overrides: Partial<ShortcutKey> = {}): ShortcutKey {
  return {
    key: 'f',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    ...overrides
  }
}

describe('searchShortcut (item 48)', () => {
  it('Ctrl+F is in-file search (Cmd+F outside the viewer is the same as Cmd+Shift+F, item 189)', () => {
    expect(searchShortcut(key({ ctrlKey: true }))).toBe('files')
  })

  it('Cmd+F (mac) is also in-file search', () => {
    expect(searchShortcut(key({ metaKey: true }))).toBe('files')
  })

  it('Ctrl+Shift+F / Cmd+Shift+F is full-text search over all files (item 189, the same even when Shift makes the key uppercase)', () => {
    expect(searchShortcut(key({ ctrlKey: true, shiftKey: true, key: 'F' }))).toBe('files')
    expect(searchShortcut(key({ metaKey: true, shiftKey: true, key: 'f' }))).toBe('files')
  })

  it('Cmd+K / Ctrl+K is conversation search (item 189)', () => {
    expect(searchShortcut(key({ metaKey: true, key: 'k' }))).toBe('conversation')
    expect(searchShortcut(key({ ctrlKey: true, key: 'K' }))).toBe('conversation')
  })

  it('Cmd+Shift+K has no assignment', () => {
    expect(searchShortcut(key({ metaKey: true, shiftKey: true, key: 'K' }))).toBeNull()
  })

  it('Ctrl+P / Cmd+P is file name search (item 46)', () => {
    expect(searchShortcut(key({ ctrlKey: true, key: 'p' }))).toBe('names')
    expect(searchShortcut(key({ metaKey: true, key: 'P' }))).toBe('names')
  })

  it('Ctrl+Shift+P has no assignment', () => {
    expect(searchShortcut(key({ ctrlKey: true, shiftKey: true, key: 'P' }))).toBeNull()
  })

  it('f / p without a modifier key are not caught (does not interfere with text input)', () => {
    expect(searchShortcut(key())).toBeNull()
    expect(searchShortcut(key({ key: 'p' }))).toBeNull()
    expect(searchShortcut(key({ shiftKey: true, key: 'F' }))).toBeNull()
  })

  it('not caught when Option is held', () => {
    expect(searchShortcut(key({ metaKey: true, altKey: true }))).toBeNull()
    expect(searchShortcut(key({ ctrlKey: true, altKey: true, key: 'p' }))).toBeNull()
  })

  it('not caught during IME composition', () => {
    expect(searchShortcut(key({ ctrlKey: true, isComposing: true }))).toBeNull()
  })

  it('other keys are not caught (does not interfere with existing assignments such as Cmd+S / Cmd+B / Cmd+N)', () => {
    for (const k of ['s', 'b', 'n', 'e', 'i', ',', 'Enter', 'Escape', 'ArrowLeft']) {
      expect(searchShortcut(key({ metaKey: true, key: k }))).toBeNull()
      expect(searchShortcut(key({ ctrlKey: true, key: k }))).toBeNull()
    }
  })
})

describe('appShortcut (TODO 496: Cmd+F inside ThreadPane is in-thread search)', () => {
  const inThread = { inThreadPane: true }
  const outside = { inThreadPane: false }

  it('Cmd+F / Ctrl+F while focus is in ThreadPane (including the Composer) is in-thread search', () => {
    expect(appShortcut(key({ metaKey: true }), inThread)).toBe('threadFind')
    expect(appShortcut(key({ ctrlKey: true, key: 'F' }), inThread)).toBe('threadFind')
  })

  it('Cmd+Shift+F stays body search from anywhere (global search is unified on Cmd+Shift+F)', () => {
    expect(appShortcut(key({ metaKey: true, shiftKey: true, key: 'F' }), inThread)).toBe('files')
    expect(appShortcut(key({ ctrlKey: true, shiftKey: true, key: 'F' }), outside)).toBe('files')
  })

  it('Cmd+F outside ThreadPane is body search as before (item 189)', () => {
    expect(appShortcut(key({ metaKey: true }), outside)).toBe('files')
  })

  it('Cmd+P / Cmd+K stay the search window even inside ThreadPane', () => {
    expect(appShortcut(key({ metaKey: true, key: 'p' }), inThread)).toBe('names')
    expect(appShortcut(key({ metaKey: true, key: 'k' }), inThread)).toBe('conversation')
  })

  it('not caught during IME composition, with Option, or without a modifier', () => {
    expect(appShortcut(key({ metaKey: true, isComposing: true }), inThread)).toBeNull()
    expect(appShortcut(key({ metaKey: true, altKey: true }), inThread)).toBeNull()
    expect(appShortcut(key(), inThread)).toBeNull()
  })

  it("the table of keys forwarded back from the viewer and web view does not change (Cmd+F in the viewer is the editor's, Cmd+F in a page is in-page search)", () => {
    for (const platform of ['mac', 'other'] as const) {
      const rows = viewerForwardedShortcuts(platform)
      expect(rows.some((row) => row.key === 'f' && !row.shiftKey && (platform === 'mac' ? row.metaKey : row.ctrlKey))).toBe(false)
      expect(rows.every((row) => (row.id as string) !== 'threadFind')).toBe(true)
      const web = webViewShortcuts(platform)
      expect(web.filter((row) => row.id === 'webFind')).toHaveLength(1)
      expect(web.every((row) => (row.id as string) !== 'threadFind')).toBe(true)
    }
  })

  it('key notation in the tooltip', () => {
    expect(threadFindKeyLabel('mac')).toBe('⌘F')
    expect(threadFindKeyLabel('other')).toBe('Ctrl+F')
  })
})

describe('openSearchStep (put into the state opened in search mode)', () => {
  it('switches to search mode if in another mode (even if collapsed)', () => {
    expect(openSearchStep({ mode: 'threads', collapsed: false }, 'search')).toBe('switch')
    expect(openSearchStep({ mode: 'files', collapsed: true }, 'search')).toBe('switch')
  })

  it('if collapsed in search mode, only opens', () => {
    expect(openSearchStep({ mode: 'search', collapsed: true }, 'search')).toBe('expand')
  })

  it('if open in search mode, does nothing (must not collapse on toggle)', () => {
    expect(openSearchStep({ mode: 'search', collapsed: false }, 'search')).toBe('none')
  })
})

describe('openModeStep / modeKeyAction (item 195: keys do not collapse)', () => {
  it('all 4 modes take the same 3 cases as openSearchStep', () => {
    for (const mode of ['threads', 'files', 'search'] as const) {
      expect(openModeStep({ mode: 'other', collapsed: false }, mode)).toBe('switch')
      expect(openModeStep({ mode, collapsed: true }, mode)).toBe('expand')
      expect(openModeStep({ mode, collapsed: false }, mode)).toBe('none')
    }
  })

  it("opens and focuses inside. If already open and focus is already inside, returns to the conversation input (same as VS Code's view container)", () => {
    expect(modeKeyAction({ mode: 'threads', collapsed: false }, 'files', false)).toEqual({
      sidebar: 'switch',
      focus: 'panel'
    })
    expect(modeKeyAction({ mode: 'files', collapsed: true }, 'files', false)).toEqual({
      sidebar: 'expand',
      focus: 'panel'
    })
    expect(modeKeyAction({ mode: 'files', collapsed: false }, 'files', false)).toEqual({
      sidebar: 'none',
      focus: 'panel'
    })
    expect(modeKeyAction({ mode: 'files', collapsed: false }, 'files', true)).toEqual({
      sidebar: 'none',
      focus: 'main'
    })
  })

  it('even if focus is in the panel in another mode, switches and goes inside (does not collapse)', () => {
    expect(modeKeyAction({ mode: 'search', collapsed: false }, 'threads', true)).toEqual({
      sidebar: 'switch',
      focus: 'panel'
    })
  })
})

describe('viewerForwardedShortcuts (item 189: keys forwarded back from inside the viewer)', () => {
  const has = (
    table: ReturnType<typeof viewerForwardedShortcuts>,
    k: string,
    mods: { meta?: boolean; ctrl?: boolean; shift?: boolean }
  ): string | undefined =>
    table.find(
      (e) =>
        e.key === k &&
        e.metaKey === (mods.meta ?? false) &&
        e.ctrlKey === (mods.ctrl ?? false) &&
        e.shiftKey === (mods.shift ?? false)
    )?.id

  it("mac: Cmd+F is the editor's search so it is not forwarded. Cmd+Shift+F / Cmd+P / Cmd+K and the Ctrl side are forwarded", () => {
    const table = viewerForwardedShortcuts('mac')
    expect(has(table, 'f', { meta: true })).toBeUndefined()
    expect(has(table, 'f', { meta: true, shift: true })).toBe('files')
    expect(has(table, 'p', { meta: true })).toBe('names')
    expect(has(table, 'k', { meta: true })).toBe('conversation')
    // Ctrl+P / Ctrl+F / Ctrl+K on mac (emacs-style cursor movement) are passed on (the owner uses Ctrl).
    expect(has(table, 'p', { ctrl: true })).toBe('names')
    expect(has(table, 'f', { ctrl: true })).toBe('files')
    expect(has(table, 'k', { ctrl: true })).toBe('conversation')
  })

  it('TODO 777: forwards Cmd+T (new Web tab). Does not forward Ctrl+T on mac (an emacs-style swap), Ctrl+T elsewhere', () => {
    const mac = viewerForwardedShortcuts('mac')
    expect(has(mac, 't', { meta: true })).toBe('webNewTab')
    expect(has(mac, 't', { ctrl: true })).toBeUndefined()
    expect(has(viewerForwardedShortcuts('other'), 't', { ctrl: true })).toBe('webNewTab')
  })

  it("others: Ctrl+F is the editor's search (Mod-f) so it is not forwarded", () => {
    const table = viewerForwardedShortcuts('other')
    expect(has(table, 'f', { ctrl: true })).toBeUndefined()
    expect(has(table, 'f', { ctrl: true, shift: true })).toBe('files')
    expect(has(table, 'p', { ctrl: true })).toBe('names')
    expect(has(table, 'k', { ctrl: true })).toBe('conversation')
  })

  it('every row of the table returns the same id from searchShortcut (does not keep 2 tables)', () => {
    for (const platform of ['mac', 'other'] as const) {
      for (const entry of viewerForwardedShortcuts(platform)) {
        if (entry.id === 'save') continue // Save goes through isSaveShortcut (item 313).
        if (entry.id === 'viewerBack' || entry.id === 'viewerForward') continue // Back / forward (TODO 369, viewer-history.test.ts).
        if (entry.id === 'webNewTab') continue // New tab (TODO 777, webTabShortcut).
        expect(searchShortcut({ ...entry, isComposing: false })).toBe(entry.id)
        expect(entry.altKey).toBe(false)
      }
    }
  })

  it("isSearchTarget lets only the table's ids through", () => {
    expect(isSearchTarget('files')).toBe(true)
    expect(isSearchTarget('names')).toBe(true)
    expect(isSearchTarget('conversation')).toBe(true)
    expect(isSearchTarget('settings')).toBe(false)
    expect(isSearchTarget(1)).toBe(false)
  })
})

describe('key notation (items 195 / 189)', () => {
  it("the key attached to the icon's title", () => {
    expect(modeKeyLabel('threads', 'mac')).toBe('⌃⌘I')
    expect(modeKeyLabel('files', 'mac')).toBe('⇧⌘E')
    expect(modeKeyLabel('search', 'mac')).toBe('⇧⌘F')
    expect(modeKeyLabel('settings', 'mac')).toBe('⌘,')
    expect(modeKeyLabel('threads', 'other')).toBe('Ctrl+Alt+I')
    expect(modeKeyLabel('files', 'other')).toBe('Ctrl+Shift+E')
    expect(modeKeyLabel('settings', 'other')).toBe('Ctrl+,')
  })
})

describe("item 287: key notation in the search field's placeholder", () => {
  it('mac shows Cmd+Shift+F / Cmd+P / Cmd+K, others Ctrl+Shift+F / Ctrl+P / Ctrl+K', async () => {
    const { searchKeyLabel } = await import('../src/renderer/src/shortcuts.js')
    expect(searchKeyLabel('files', 'mac')).toBe('⌘⇧F')
    expect(searchKeyLabel('names', 'mac')).toBe('⌘P')
    expect(searchKeyLabel('conversation', 'mac')).toBe('⌘K')
    expect(searchKeyLabel('files', 'other')).toBe('Ctrl+Shift+F')
    expect(searchKeyLabel('names', 'other')).toBe('Ctrl+P')
    expect(searchKeyLabel('conversation', 'other')).toBe('Ctrl+K')
  })

  it('the keys shown actually reach that field and are also forwarded back from inside the viewer', async () => {
    const { SEARCH_KEY_SPEC } = await import('../src/renderer/src/shortcuts.js')
    for (const platform of ['mac', 'other'] as const) {
      const table = viewerForwardedShortcuts(platform)
      for (const target of ['files', 'names', 'conversation'] as const) {
        const { key, shift } = SEARCH_KEY_SPEC[target]
        const event = {
          key: shift ? key.toUpperCase() : key,
          metaKey: platform === 'mac',
          ctrlKey: platform !== 'mac',
          shiftKey: shift,
          altKey: false,
          isComposing: false
        }
        expect(searchShortcut(event)).toBe(target)
        expect(
          table.some((row) => row.id === target && row.shiftKey === shift && row.key === key)
        ).toBe(true)
      }
    }
  })
})

describe('save key (item 313)', () => {
  it('isSaveShortcut: only Cmd+S / Ctrl+S. Shift / Alt / during IME composition / without a modifier are not caught', () => {
    expect(isSaveShortcut(key({ key: 's', metaKey: true }))).toBe(true)
    expect(isSaveShortcut(key({ key: 's', ctrlKey: true }))).toBe(true)
    expect(isSaveShortcut(key({ key: 'S', metaKey: true }))).toBe(true)
    expect(isSaveShortcut(key({ key: 's', metaKey: true, shiftKey: true }))).toBe(false)
    expect(isSaveShortcut(key({ key: 's', metaKey: true, altKey: true }))).toBe(false)
    expect(isSaveShortcut(key({ key: 's', metaKey: true, isComposing: true }))).toBe(false)
    expect(isSaveShortcut(key({ key: 's' }))).toBe(false)
    expect(isSaveShortcut(key({ key: 'a', metaKey: true }))).toBe(false)
  })

  it('the forwarding table has 2 rows for Cmd+S / Ctrl+S on both mac and others, and they do not mix with search ids', () => {
    for (const platform of ['mac', 'other'] as const) {
      const saves = viewerForwardedShortcuts(platform).filter((e) => e.id === 'save')
      expect(saves.map((e) => [e.key, e.metaKey, e.ctrlKey, e.shiftKey, e.altKey])).toEqual([
        ['s', true, false, false, false],
        ['s', false, true, false, false]
      ])
      for (const e of saves) expect(isSaveShortcut({ ...e, isComposing: false })).toBe(true)
    }
  })

  it('runViewerShortcut does not treat save as search (isSearchTarget does not let it through)', () => {
    expect(isSearchTarget('save')).toBe(false)
  })
})
