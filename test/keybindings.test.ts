/**
 * TODO 549 (wave 27 bundle E): the keyboard shortcut table (`src/shared/keybindings.ts`) and the judgments, forwarding table,
 * menu accelerators and saving (`KeybindingsPreference`) that follow it. Uses neither the model nor Electron.
 *
 * - The default keys match the four old places they were written (renderer keydown / menu / viewer forwarding / web page)
 * - Reading and writing key strings, naming the pressed key (US / JIS ⌃⇧-, the ⌥ character on mac), lenient ⌘ / Ctrl
 * - When the user's assignments are applied, the judgments, the tables (rebuilt on the spot), the tooltip notation and the menus all follow
 * - Conflict detection (other commands, and OS / Edit menu keys) and validation (unknown id, same as default, no modifier)
 */
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { UI_KEYBINDINGS } from '../src/common/settings-keys.js'
import { KeybindingsPreference, keyPlatformOfProcess } from '../src/main/keybindings.js'
import {
  HIDDEN_FILES_ITEM,
  NEW_THREAD_ITEM,
  SAVE_ITEM,
  SETTINGS_ITEM,
  boundMenuItem,
  registeredAccelerators,
  viewMenuEntries,
  type CommandMenuItem
} from '../src/main/menu-model.js'
import {
  KEYBINDING_COMMANDS,
  KEYBINDING_COMMAND_IDS,
  conflictsOf,
  displayKeybinding,
  effectiveKeybinding,
  keyNameOf,
  keyRowsOf,
  keybindingIdentity,
  keybindingFromInput,
  matchesKeybinding,
  normalizeKeybinding,
  parseKeybinding,
  resolveKeybinding,
  sanitizeKeybindingOverrides,
  withKeybinding
} from '../src/shared/keybindings.js'
import {
  appShortcut,
  isSaveShortcut,
  matchesCommandKey,
  modeKeyLabel,
  newThreadKeyLabel,
  searchKeyLabel,
  searchShortcut,
  setKeybindings,
  threadFindKeyLabel,
  viewerForwardedShortcuts,
  viewerNavKeyLabel,
  viewerNavShortcut,
  webViewKeyLabel,
  webViewShortcuts
} from '../src/renderer/src/shortcuts.js'
import { matchWebShortcut, sanitizeWebShortcuts } from '../src/shared/web-view.js'
import { matchViewerShortcut } from '../plugins/_shared/shortcuts.js'

function press(over: Partial<{ key: string; code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>) {
  return { key: 'f', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, ...over }
}

afterEach(() => setKeybindings({}, 'mac'))

describe('表 (既定のキー)', () => {
  it('id は一意で、既定のキーはどれも読める', () => {
    expect(new Set(KEYBINDING_COMMAND_IDS).size).toBe(KEYBINDING_COMMAND_IDS.length)
    expect(KEYBINDING_COMMANDS.map((c) => c.id)).toEqual([...KEYBINDING_COMMAND_IDS])
    for (const command of KEYBINDING_COMMANDS) {
      for (const platform of ['mac', 'other'] as const) {
        const key = command.defaults[platform]
        if (key !== null) expect(parseKeybinding(key), `${command.id} ${platform}`).not.toBeNull()
      }
    }
  })

  it('メニューの accelerator の既定は表と同じ (表 1 つから引く)', () => {
    for (const [menuPlatform, platform] of [
      ['darwin', 'mac'],
      ['other', 'other']
    ] as const) {
      const items = [...viewMenuEntries(menuPlatform), SETTINGS_ITEM, SAVE_ITEM, NEW_THREAD_ITEM].filter(
        (entry): entry is CommandMenuItem => entry !== 'separator'
      )
      for (const item of items) {
        if (item.binding === undefined) continue
        const key = effectiveKeybinding(item.binding, platform, {}) as string
        expect(keybindingIdentity(item.accelerator as string, platform)).toBe(keybindingIdentity(key, platform))
      }
      expect(effectiveKeybinding(HIDDEN_FILES_ITEM.binding, platform, {})).toBe(HIDDEN_FILES_ITEM.accelerator)
    }
  })

  it('既定のままなら、送り返しの表は昔と同じ行 (mac の ⌃⇧- は _ と =)', () => {
    const mac = viewerForwardedShortcuts('mac')
    expect(mac.filter((row) => row.id === 'viewerForward' && row.button === undefined).map((row) => row.key)).toEqual(['_', '='])
    expect(mac.filter((row) => row.id === 'viewerBack' && row.button === undefined).map((row) => row.key)).toEqual(['-'])
    const web = webViewShortcuts('mac')
    expect(web.filter((row) => row.id === 'webReload')).toEqual([
      { id: 'webReload', key: 'r', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }
    ])
    expect(web.find((row) => row.key === 'f' && row.ctrlKey && !row.shiftKey)?.id).toBe('files')
  })
})

describe('キーの文字列', () => {
  it('読み書き: 修飾の別名・順番を揃える。修飾が無いのは F キーだけ', () => {
    expect(normalizeKeybinding('Shift+CommandOrControl+f')).toBe('CmdOrCtrl+Shift+F')
    expect(normalizeKeybinding('Cmd+Ctrl+I')).toBe('Ctrl+Cmd+I')
    expect(normalizeKeybinding('Option+Left')).toBe('Alt+Left')
    expect(normalizeKeybinding('F5')).toBe('F5')
    expect(normalizeKeybinding('Shift+F')).toBeNull()
    expect(normalizeKeybinding('F')).toBeNull()
    expect(normalizeKeybinding('Cmd+Cmd+F')).toBeNull()
    expect(normalizeKeybinding('CmdOrCtrl+Cmd+F')).toBeNull()
    expect(normalizeKeybinding('Hyper+F')).toBeNull()
    expect(normalizeKeybinding('Cmd+ArrowLeft')).toBeNull()
    expect(normalizeKeybinding(42)).toBeNull()
  })

  it('表記: mac は ⌃⌥⇧⌘ の並び、その他は Ctrl+Alt+Shift', () => {
    expect(displayKeybinding('CmdOrCtrl+Shift+F', 'mac')).toBe('⇧⌘F')
    expect(displayKeybinding('Ctrl+Cmd+I', 'mac')).toBe('⌃⌘I')
    expect(displayKeybinding('Ctrl+Shift+-', 'mac')).toBe('⌃⇧-')
    expect(displayKeybinding('CmdOrCtrl+Shift+F', 'other')).toBe('Ctrl+Shift+F')
    expect(displayKeybinding('Alt+Left', 'other')).toBe('Alt+←')
  })

  it('押されたキーの名前: Shift / ⌥ 付きの記号と字は物理キー (US / JIS で同じ名前)', () => {
    expect(keyNameOf({ key: '_', code: 'Minus', shiftKey: true, altKey: false })).toBe('-')
    expect(keyNameOf({ key: '=', code: 'Minus', shiftKey: true, altKey: false })).toBe('-') // JIS
    expect(keyNameOf({ key: '=', shiftKey: true, altKey: false })).toBe('-') // JIS ⇧- without a code
    expect(keyNameOf({ key: 'ƒ', code: 'KeyF', shiftKey: false, altKey: true })).toBe('F') // mac ⌥F
    expect(keyNameOf({ key: '@', code: 'BracketLeft', shiftKey: false, altKey: false })).toBe('@') // JIS @ stays as is
    expect(keyNameOf({ key: '!', code: 'Digit1', shiftKey: true, altKey: false })).toBe('1')
    expect(keyNameOf({ key: 'ArrowLeft', shiftKey: false, altKey: true })).toBe('Left')
    expect(keyNameOf({ key: 'Meta', shiftKey: false, altKey: false })).toBeNull()
  })

  it('記録: 押したとおりの修飾 (mac の ⌘ は Cmd、その他の Win キーは使わない)', () => {
    expect(keybindingFromInput(press({ key: 't', metaKey: true }), 'mac')).toBe('Cmd+T')
    expect(keybindingFromInput(press({ key: 'T', ctrlKey: true, shiftKey: true }), 'other')).toBe('Ctrl+Shift+T')
    expect(keybindingFromInput(press({ key: 't', metaKey: true }), 'other')).toBeNull()
    expect(keybindingFromInput(press({ key: 't' }), 'mac')).toBeNull()
    expect(keybindingFromInput(press({ key: 'Shift', shiftKey: true }), 'mac')).toBeNull()
  })

  it('当て方: CmdOrCtrl は寛容なら ⌘ でも Ctrl でも。押したとおりの方が先に勝つ', () => {
    expect(matchesKeybinding('CmdOrCtrl+P', press({ key: 'p', ctrlKey: true }), 'mac')).toBe(false)
    expect(matchesKeybinding('CmdOrCtrl+P', press({ key: 'p', ctrlKey: true }), 'mac', true)).toBe(true)
    expect(matchesKeybinding('Cmd+P', press({ key: 'p', ctrlKey: true }), 'mac', true)).toBe(false)
    const overrides = { 'search.conversation': 'Ctrl+P' } as const
    expect(
      resolveKeybinding(press({ key: 'p', ctrlKey: true }), ['search.names', 'search.conversation'], 'mac', overrides)
    ).toBe('search.conversation')
    expect(
      resolveKeybinding(press({ key: 'p', metaKey: true }), ['search.names', 'search.conversation'], 'mac', overrides)
    ).toBe('search.names')
  })

  it('TODO 589: ⌥ 付きの英字・数字・記号の行は物理キー (code) を持つ。名前付きのキー・⌥ の無い行は持たない', () => {
    expect(keyRowsOf('Alt+Cmd+F', 'mac')).toEqual([
      { key: 'f', metaKey: true, ctrlKey: false, shiftKey: false, altKey: true, code: 'KeyF' }
    ])
    expect(keyRowsOf('Alt+Shift+Cmd+-', 'mac').map((r) => [r.key, r.code])).toEqual([['-', 'Minus']])
    expect(keyRowsOf('CmdOrCtrl+Alt+1', 'mac').map((r) => r.code)).toEqual(['Digit1', 'Digit1'])
    expect(keyRowsOf('Alt+Left', 'other').map((r) => [r.key, r.code])).toEqual([['ArrowLeft', undefined]])
    expect(keyRowsOf('Cmd+F', 'mac')[0]?.code).toBeUndefined()
  })

  it('TODO 589: mac の ⌥ 付きの割り当ては viewer / web ページの中からも届く (⌥ で key が別の字になっても code で当てる)', () => {
    setKeybindings({ 'search.names': 'Alt+Cmd+F', 'web.reload': 'Alt+Cmd+R', 'viewer.back': 'Alt+Cmd+[' }, 'mac')
    const viewer = viewerForwardedShortcuts('mac')
    const web = webViewShortcuts('mac')
    // On mac, ⌥⌘F has key = 'ƒ' and code = 'KeyF'.
    expect(matchViewerShortcut(press({ key: 'ƒ', code: 'KeyF', metaKey: true, altKey: true }), viewer)).toBe('names')
    expect(matchViewerShortcut(press({ key: '“', code: 'BracketLeft', metaKey: true, altKey: true }), viewer)).toBe(
      'viewerBack'
    )
    const input = (key: string, code: string) => ({ type: 'keyDown', key, code, meta: true, control: false, shift: false, alt: true })
    expect(matchWebShortcut(input('ƒ', 'KeyF'), web)).toBe('names')
    expect(matchWebShortcut(input('®', 'KeyR'), web)).toBe('webReload')
    // Does not match ⌘F / ⌘R without ⌥ (modifiers must match exactly). Does not match another physical key either.
    expect(matchWebShortcut({ ...input('f', 'KeyF'), alt: false }, web)).not.toBe('names')
    expect(matchWebShortcut(input('∂', 'KeyD'), web)).toBeNull()
    // A layout that produces letters (other Alt+F) matches by key (same as the renderer's keyNameOf).
    expect(matchViewerShortcut(press({ key: 'f', code: 'KeyF', metaKey: true, altKey: true }), viewer)).toBe('names')
    // Even when main validates again, code remains (rows with a malformed code are dropped).
    const sanitized = sanitizeWebShortcuts(web)
    expect(sanitized.find((row) => row.id === 'webReload')).toMatchObject({ code: 'KeyR', altKey: true })
    expect(sanitizeWebShortcuts([{ id: 'x', key: 'f', metaKey: true, ctrlKey: false, shiftKey: false, altKey: true, code: 'Key F!' }])).toEqual([])
  })

  it('送り返しの行: CmdOrCtrl は 2 行、Shift 付きの記号は US と JIS の字', () => {
    expect(keyRowsOf('CmdOrCtrl+K', 'mac').map((r) => [r.key, r.metaKey, r.ctrlKey])).toEqual([
      ['k', true, false],
      ['k', false, true]
    ])
    expect(keyRowsOf('Ctrl+Shift+-', 'mac').map((r) => r.key)).toEqual(['_', '='])
    expect(keyRowsOf('Ctrl+Tab', 'mac').map((r) => r.key)).toEqual(['Tab'])
  })
})

describe('検め・衝突', () => {
  it('知らない id・読めないキーは捨て、既定と同じ実キーは落とす。null (外した) は残す', () => {
    expect(
      sanitizeKeybindingOverrides(
        {
          'search.names': 'cmd+t',
          'search.files': 'Cmd+Shift+F', // On mac, the same real key as the default (CmdOrCtrl+Shift+F)
          find: null,
          bogus: 'Cmd+J',
          'view.files': 'J',
          'thread.new': 3
        },
        'mac'
      )
    ).toEqual({ 'search.names': 'Cmd+T', find: null })
    expect(sanitizeKeybindingOverrides(['Cmd+T'], 'mac')).toEqual({})
    expect(withKeybinding({ find: null }, 'find', undefined, 'mac')).toEqual({})
  })

  it('衝突: 他のコマンドと、OS / 編集メニューのキー', () => {
    expect(conflictsOf('Cmd+P', 'search.conversation', 'mac', {})).toEqual({ commands: ['search.names'], reserved: [] })
    expect(conflictsOf('Cmd+C', 'search.names', 'mac', {})).toEqual({ commands: [], reserved: ['edit'] })
    expect(conflictsOf('Cmd+P', 'search.names', 'mac', {})).toEqual({ commands: [], reserved: [] })
    // Does not conflict with a command that was unbound
    expect(conflictsOf('Cmd+P', 'search.conversation', 'mac', { 'search.names': null }).commands).toEqual([])
  })
})

describe('renderer の判定と表が割り当てに従う', () => {
  it('検索: 割り当てを替えると新しいキーで当たり、古いキーは外れる', () => {
    setKeybindings({ 'search.names': 'Cmd+T' }, 'mac')
    expect(searchShortcut(press({ key: 't', metaKey: true }))).toBe('names')
    expect(searchShortcut(press({ key: 'p', metaKey: true }))).toBeNull()
    expect(searchKeyLabel('names', 'mac')).toBe('⌘T')
  })

  it('⌘F を替えたら ThreadPane の中のスレッド内検索もそのキー。外したら何もしない', () => {
    setKeybindings({ find: 'Cmd+G' }, 'mac')
    expect(appShortcut(press({ key: 'g', metaKey: true }), { inThreadPane: true })).toBe('threadFind')
    expect(appShortcut(press({ key: 'f', metaKey: true }), { inThreadPane: true })).toBeNull()
    expect(threadFindKeyLabel('mac')).toBe('⌘G')
    setKeybindings({ find: null }, 'mac')
    expect(appShortcut(press({ key: 'f', metaKey: true }), { inThreadPane: true })).toBeNull()
    expect(threadFindKeyLabel('mac')).toBe('—')
  })

  it('送り返しの表は呼ぶたびに今の割り当てで作る (TODO 589: 前に取った配列は書き換えない)', () => {
    const before = webViewShortcuts('mac')
    const snapshot = JSON.stringify(before)
    setKeybindings({ 'search.names': 'Cmd+T', find: 'Cmd+G', 'web.reload': 'Cmd+Shift+L' }, 'mac')
    expect(JSON.stringify(before)).toBe(snapshot)
    const viewer = viewerForwardedShortcuts('mac')
    const web = webViewShortcuts('mac')
    expect(matchViewerShortcut(press({ key: 't', metaKey: true }), viewer)).toBe('names')
    expect(matchViewerShortcut(press({ key: 'p', metaKey: true }), viewer)).toBeNull()
    // Inside the viewer, ⌘G goes to the body search (the editor's ⌘F stays with CodeMirror)
    expect(matchViewerShortcut(press({ key: 'g', metaKey: true }), viewer)).toBe('files')
    const input = (key: string, shift = false) => ({ type: 'keyDown', key, meta: true, control: false, shift, alt: false })
    expect(matchWebShortcut(input('g'), web)).toBe('webFind')
    expect(matchWebShortcut(input('f'), web)).toBeNull()
    expect(matchWebShortcut(input('L', true), web)).toBe('webReload')
    expect(webViewKeyLabel('webReload', 'mac')).toBe('⇧⌘L')
  })

  it('保存・戻る / 進む・隠しファイルの保険も割り当てに従う', () => {
    setKeybindings({ 'file.save': 'Cmd+Shift+S', 'viewer.back': 'Cmd+[', 'view.hiddenFiles': 'Cmd+J' }, 'mac')
    expect(isSaveShortcut(press({ key: 's', metaKey: true }))).toBe(false)
    expect(isSaveShortcut(press({ key: 'S', metaKey: true, shiftKey: true }))).toBe(true)
    expect(viewerNavShortcut(press({ key: '[', code: 'BracketLeft', metaKey: true }), 'mac')).toBe('viewerBack')
    expect(viewerNavShortcut(press({ key: '-', ctrlKey: true }), 'mac')).toBeNull()
    // The unchanged "forward" keeps its old judgment (including JIS ⌃⇧-)
    expect(viewerNavShortcut(press({ key: '=', ctrlKey: true, shiftKey: true }), 'mac')).toBe('viewerForward')
    expect(viewerNavKeyLabel('viewerBack', 'mac')).toBe('⌘[')
    expect(viewerNavKeyLabel('viewerForward', 'mac')).toBe('⌃⇧-')
    expect(matchesCommandKey('view.hiddenFiles', press({ key: 'j', metaKey: true }), () => false)).toBe(true)
    expect(matchesCommandKey('view.hiddenFiles', press({ key: '.', metaKey: true, shiftKey: true }), () => true)).toBe(false)
    const saves = viewerForwardedShortcuts('mac').filter((row) => row.id === 'save')
    expect(saves.map((row) => [row.key, row.metaKey, row.shiftKey])).toEqual([['s', true, true]])
  })

  it('吹き出しの表記 (モード・新しいスレッド) も割り当てに従う', () => {
    setKeybindings({ 'view.threads': 'Cmd+1', 'thread.new': 'Cmd+Shift+N' }, 'mac')
    expect(modeKeyLabel('threads', 'mac')).toBe('⌘1')
    expect(modeKeyLabel('files', 'mac')).toBe('⇧⌘E')
    expect(newThreadKeyLabel('mac')).toBe('⇧⌘N')
  })
})

describe('メニュー (main が作り直す)', () => {
  it('割り当てを替えた accelerator・外した accelerator', () => {
    const overrides = { 'view.toggleSidebar': 'Cmd+Shift+B', 'view.files': null, 'view.hiddenFiles': 'Cmd+J' } as const
    const registered = registeredAccelerators('darwin', overrides)
    expect(registered).toContain('Cmd+Shift+B')
    expect(registered).not.toContain('CmdOrCtrl+B')
    expect(registered).not.toContain('CmdOrCtrl+Shift+E')
    expect(registered).toContain('Cmd+J')
    const files = viewMenuEntries('darwin').find((e): e is CommandMenuItem => e !== 'separator' && e.command === 'showFiles')
    expect(boundMenuItem(files as CommandMenuItem, 'darwin', overrides).accelerator).toBeUndefined()
    // With no assignment the item stays as is (including the display-only Ctrl+Shift+F)
    const search = viewMenuEntries('other').find((e): e is CommandMenuItem => e !== 'separator' && e.command === 'showSearch')
    expect(boundMenuItem(search as CommandMenuItem, 'other', {})).toBe(search)
  })
})

describe('保存 (KeybindingsPreference、main)', () => {
  it('検めて保存し、変わったときだけ知らせる。作り直しても覚えている', () => {
    expect(keyPlatformOfProcess('darwin')).toBe('mac')
    expect(keyPlatformOfProcess('linux')).toBe('other')
    const memory = new Database(':memory:')
    runMigrations(memory)
    const settings = new AppSettingsStore(memory)
    const changes: unknown[] = []
    const preference = new KeybindingsPreference(settings, 'mac', (overrides) => changes.push(overrides))
    expect(preference.get()).toEqual({})
    expect(preference.set({ 'search.names': 'cmd+t', bogus: 'Cmd+J' })).toEqual({ 'search.names': 'Cmd+T' })
    expect(preference.set({ 'search.names': 'Cmd+T' })).toEqual({ 'search.names': 'Cmd+T' })
    expect(changes).toEqual([{ 'search.names': 'Cmd+T' }])
    expect(settings.readTyped(UI_KEYBINDINGS)).toEqual({ 'search.names': 'Cmd+T' })
    expect(new KeybindingsPreference(settings, 'mac').get()).toEqual({ 'search.names': 'Cmd+T' })
    memory.close()
  })

  it('ui.keybindings の鍵: 壊れた値は空、文字列と null だけ残す', () => {
    expect(UI_KEYBINDINGS.owner).toBe('main')
    expect(UI_KEYBINDINGS.parse(null)).toEqual({})
    expect(UI_KEYBINDINGS.parse('{oops')).toEqual({})
    expect(UI_KEYBINDINGS.parse('[1]')).toEqual({})
    expect(UI_KEYBINDINGS.parse('{"a":"Cmd+T","b":null,"c":3}')).toEqual({ a: 'Cmd+T', b: null })
    expect(UI_KEYBINDINGS.parse(UI_KEYBINDINGS.serialize({ find: null }))).toEqual({ find: null })
  })
})
