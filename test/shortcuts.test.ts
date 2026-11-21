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

describe('searchShortcut (項目 48)', () => {
  it('Ctrl+F は File 内検索 (viewer の外の ⌘F は ⌘⇧F と同じ、項目 189)', () => {
    expect(searchShortcut(key({ ctrlKey: true }))).toBe('files')
  })

  it('⌘F (mac) も File 内検索', () => {
    expect(searchShortcut(key({ metaKey: true }))).toBe('files')
  })

  it('Ctrl+Shift+F / ⌘⇧F は全ファイルの本文検索 (項目 189、Shift で key が大文字になっても同じ)', () => {
    expect(searchShortcut(key({ ctrlKey: true, shiftKey: true, key: 'F' }))).toBe('files')
    expect(searchShortcut(key({ metaKey: true, shiftKey: true, key: 'f' }))).toBe('files')
  })

  it('⌘K / Ctrl+K は会話検索 (項目 189)', () => {
    expect(searchShortcut(key({ metaKey: true, key: 'k' }))).toBe('conversation')
    expect(searchShortcut(key({ ctrlKey: true, key: 'K' }))).toBe('conversation')
  })

  it('⌘⇧K は割り当て無し', () => {
    expect(searchShortcut(key({ metaKey: true, shiftKey: true, key: 'K' }))).toBeNull()
  })

  it('Ctrl+P / ⌘P は File 名検索 (項目 46)', () => {
    expect(searchShortcut(key({ ctrlKey: true, key: 'p' }))).toBe('names')
    expect(searchShortcut(key({ metaKey: true, key: 'P' }))).toBe('names')
  })

  it('Ctrl+Shift+P は割り当て無し', () => {
    expect(searchShortcut(key({ ctrlKey: true, shiftKey: true, key: 'P' }))).toBeNull()
  })

  it('修飾キーの無い f / p は拾わない (文字入力を邪魔しない)', () => {
    expect(searchShortcut(key())).toBeNull()
    expect(searchShortcut(key({ key: 'p' }))).toBeNull()
    expect(searchShortcut(key({ shiftKey: true, key: 'F' }))).toBeNull()
  })

  it('⌥ が立っていたら拾わない', () => {
    expect(searchShortcut(key({ metaKey: true, altKey: true }))).toBeNull()
    expect(searchShortcut(key({ ctrlKey: true, altKey: true, key: 'p' }))).toBeNull()
  })

  it('IME の合成中は拾わない', () => {
    expect(searchShortcut(key({ ctrlKey: true, isComposing: true }))).toBeNull()
  })

  it('他のキーは拾わない (⌘S / ⌘B / ⌘N など既存の割り当てと干渉しない)', () => {
    for (const k of ['s', 'b', 'n', 'e', 'i', ',', 'Enter', 'Escape', 'ArrowLeft']) {
      expect(searchShortcut(key({ metaKey: true, key: k }))).toBeNull()
      expect(searchShortcut(key({ ctrlKey: true, key: k }))).toBeNull()
    }
  })
})

describe('appShortcut (TODO 496: ThreadPane の中の ⌘F はスレッド内検索)', () => {
  const inThread = { inThreadPane: true }
  const outside = { inThreadPane: false }

  it('ThreadPane (Composer を含む) に focus があるときの ⌘F / Ctrl+F はスレッド内検索', () => {
    expect(appShortcut(key({ metaKey: true }), inThread)).toBe('threadFind')
    expect(appShortcut(key({ ctrlKey: true, key: 'F' }), inThread)).toBe('threadFind')
  })

  it('⌘⇧F はどこからでも本文検索のまま (全体の検索は ⌘⇧F に一本化)', () => {
    expect(appShortcut(key({ metaKey: true, shiftKey: true, key: 'F' }), inThread)).toBe('files')
    expect(appShortcut(key({ ctrlKey: true, shiftKey: true, key: 'F' }), outside)).toBe('files')
  })

  it('ThreadPane の外の ⌘F は今までどおり本文検索 (項目 189)', () => {
    expect(appShortcut(key({ metaKey: true }), outside)).toBe('files')
  })

  it('⌘P / ⌘K は ThreadPane の中でも検索窓のまま', () => {
    expect(appShortcut(key({ metaKey: true, key: 'p' }), inThread)).toBe('names')
    expect(appShortcut(key({ metaKey: true, key: 'k' }), inThread)).toBe('conversation')
  })

  it('IME の合成中・⌥ 付き・修飾なしは拾わない', () => {
    expect(appShortcut(key({ metaKey: true, isComposing: true }), inThread)).toBeNull()
    expect(appShortcut(key({ metaKey: true, altKey: true }), inThread)).toBeNull()
    expect(appShortcut(key(), inThread)).toBeNull()
  })

  it('viewer と web ビューの送り返しの表は変わらない (viewer の ⌘F はエディタ、ページの ⌘F はページ内検索)', () => {
    for (const platform of ['mac', 'other'] as const) {
      const rows = viewerForwardedShortcuts(platform)
      expect(rows.some((row) => row.key === 'f' && !row.shiftKey && (platform === 'mac' ? row.metaKey : row.ctrlKey))).toBe(false)
      expect(rows.every((row) => (row.id as string) !== 'threadFind')).toBe(true)
      const web = webViewShortcuts(platform)
      expect(web.filter((row) => row.id === 'webFind')).toHaveLength(1)
      expect(web.every((row) => (row.id as string) !== 'threadFind')).toBe(true)
    }
  })

  it('吹き出しのキーの表記', () => {
    expect(threadFindKeyLabel('mac')).toBe('⌘F')
    expect(threadFindKeyLabel('other')).toBe('Ctrl+F')
  })
})

describe('openSearchStep (検索モードで開いた状態にする)', () => {
  it('別のモードなら検索モードへ切り替える (畳んでいても)', () => {
    expect(openSearchStep({ mode: 'threads', collapsed: false }, 'search')).toBe('switch')
    expect(openSearchStep({ mode: 'files', collapsed: true }, 'search')).toBe('switch')
  })

  it('検索モードで畳んでいるなら開くだけ', () => {
    expect(openSearchStep({ mode: 'search', collapsed: true }, 'search')).toBe('expand')
  })

  it('検索モードで開いているなら何もしない (トグルで畳んではいけない)', () => {
    expect(openSearchStep({ mode: 'search', collapsed: false }, 'search')).toBe('none')
  })
})

describe('openModeStep / modeKeyAction (項目 195: キーでは畳まない)', () => {
  it('4 つのモードとも openSearchStep と同じ 3 通り', () => {
    for (const mode of ['threads', 'files', 'search'] as const) {
      expect(openModeStep({ mode: 'other', collapsed: false }, mode)).toBe('switch')
      expect(openModeStep({ mode, collapsed: true }, mode)).toBe('expand')
      expect(openModeStep({ mode, collapsed: false }, mode)).toBe('none')
    }
  })

  it('開いて中に focus。既に開いていて focus も中なら会話の入力欄へ戻す (VS Code の view container と同じ)', () => {
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

  it('別のモードで focus がパネルにあっても、切り替えて中へ (畳まない)', () => {
    expect(modeKeyAction({ mode: 'search', collapsed: false }, 'threads', true)).toEqual({
      sidebar: 'switch',
      focus: 'panel'
    })
  })
})

describe('viewerForwardedShortcuts (項目 189: viewer の中から送り返すキー)', () => {
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

  it('mac: ⌘F はエディタの検索なので送らない。⌘⇧F / ⌘P / ⌘K と Ctrl の側は送る', () => {
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

  it('TODO 777: ⌘T (新しい Web のタブ) を送る。mac の ⌃T は送らない (emacs 風の入れ替え)、他は Ctrl+T', () => {
    const mac = viewerForwardedShortcuts('mac')
    expect(has(mac, 't', { meta: true })).toBe('webNewTab')
    expect(has(mac, 't', { ctrl: true })).toBeUndefined()
    expect(has(viewerForwardedShortcuts('other'), 't', { ctrl: true })).toBe('webNewTab')
  })

  it('その他: Ctrl+F がエディタの検索 (Mod-f) なので送らない', () => {
    const table = viewerForwardedShortcuts('other')
    expect(has(table, 'f', { ctrl: true })).toBeUndefined()
    expect(has(table, 'f', { ctrl: true, shift: true })).toBe('files')
    expect(has(table, 'p', { ctrl: true })).toBe('names')
    expect(has(table, 'k', { ctrl: true })).toBe('conversation')
  })

  it('表の行はどれも searchShortcut が同じ id を返す (表を 2 つ持たない)', () => {
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

  it('isSearchTarget は表の id だけを通す', () => {
    expect(isSearchTarget('files')).toBe(true)
    expect(isSearchTarget('names')).toBe(true)
    expect(isSearchTarget('conversation')).toBe(true)
    expect(isSearchTarget('settings')).toBe(false)
    expect(isSearchTarget(1)).toBe(false)
  })
})

describe('キーの表記 (項目 195 / 189)', () => {
  it('アイコンの title に添えるキー', () => {
    expect(modeKeyLabel('threads', 'mac')).toBe('⌃⌘I')
    expect(modeKeyLabel('files', 'mac')).toBe('⇧⌘E')
    expect(modeKeyLabel('search', 'mac')).toBe('⇧⌘F')
    expect(modeKeyLabel('settings', 'mac')).toBe('⌘,')
    expect(modeKeyLabel('threads', 'other')).toBe('Ctrl+Alt+I')
    expect(modeKeyLabel('files', 'other')).toBe('Ctrl+Shift+E')
    expect(modeKeyLabel('settings', 'other')).toBe('Ctrl+,')
  })
})

describe('項目 287: 検索欄の placeholder のキー表記', () => {
  it('mac は ⌘⇧F / ⌘P / ⌘K、それ以外は Ctrl+Shift+F / Ctrl+P / Ctrl+K', async () => {
    const { searchKeyLabel } = await import('../src/renderer/src/shortcuts.js')
    expect(searchKeyLabel('files', 'mac')).toBe('⌘⇧F')
    expect(searchKeyLabel('names', 'mac')).toBe('⌘P')
    expect(searchKeyLabel('conversation', 'mac')).toBe('⌘K')
    expect(searchKeyLabel('files', 'other')).toBe('Ctrl+Shift+F')
    expect(searchKeyLabel('names', 'other')).toBe('Ctrl+P')
    expect(searchKeyLabel('conversation', 'other')).toBe('Ctrl+K')
  })

  it('出すキーは実際にその欄へ届き、viewer の中からも送り返される', async () => {
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

describe('保存のキー (項目 313)', () => {
  it('isSaveShortcut: ⌘S / Ctrl+S だけ。Shift / Alt / IME 合成中 / 修飾なしは拾わない', () => {
    expect(isSaveShortcut(key({ key: 's', metaKey: true }))).toBe(true)
    expect(isSaveShortcut(key({ key: 's', ctrlKey: true }))).toBe(true)
    expect(isSaveShortcut(key({ key: 'S', metaKey: true }))).toBe(true)
    expect(isSaveShortcut(key({ key: 's', metaKey: true, shiftKey: true }))).toBe(false)
    expect(isSaveShortcut(key({ key: 's', metaKey: true, altKey: true }))).toBe(false)
    expect(isSaveShortcut(key({ key: 's', metaKey: true, isComposing: true }))).toBe(false)
    expect(isSaveShortcut(key({ key: 's' }))).toBe(false)
    expect(isSaveShortcut(key({ key: 'a', metaKey: true }))).toBe(false)
  })

  it('送り返しの表には mac でも他でも ⌘S / Ctrl+S の 2 行が載り、検索の id と混ざらない', () => {
    for (const platform of ['mac', 'other'] as const) {
      const saves = viewerForwardedShortcuts(platform).filter((e) => e.id === 'save')
      expect(saves.map((e) => [e.key, e.metaKey, e.ctrlKey, e.shiftKey, e.altKey])).toEqual([
        ['s', true, false, false, false],
        ['s', false, true, false, false]
      ])
      for (const e of saves) expect(isSaveShortcut({ ...e, isComposing: false })).toBe(true)
    }
  })

  it('runViewerShortcut は save を検索として扱わない (isSearchTarget が通さない)', () => {
    expect(isSearchTarget('save')).toBe(false)
  })
})
