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

describe('table (default keys)', () => {
  it('ids are unique and every default key is readable', () => {
    expect(new Set(KEYBINDING_COMMAND_IDS).size).toBe(KEYBINDING_COMMAND_IDS.length)
    expect(KEYBINDING_COMMANDS.map((c) => c.id)).toEqual([...KEYBINDING_COMMAND_IDS])
    for (const command of KEYBINDING_COMMANDS) {
      for (const platform of ['mac', 'other'] as const) {
        const key = command.defaults[platform]
        if (key !== null) expect(parseKeybinding(key), `${command.id} ${platform}`).not.toBeNull()
      }
    }
  })

  it('the menu accelerator defaults are the same as the table (derived from one table)', () => {
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

  it("with defaults only, the send-back table has the same rows as before (mac's Ctrl+Shift+- gives _ and =)", () => {
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

describe('key strings', () => {
  it('read and write: aligns modifier aliases and order; only F keys have no modifier', () => {
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

  it('notation: mac uses the order of Ctrl Option Shift Cmd symbols, others Ctrl+Alt+Shift', () => {
    expect(displayKeybinding('CmdOrCtrl+Shift+F', 'mac')).toBe('⇧⌘F')
    expect(displayKeybinding('Ctrl+Cmd+I', 'mac')).toBe('⌃⌘I')
    expect(displayKeybinding('Ctrl+Shift+-', 'mac')).toBe('⌃⇧-')
    expect(displayKeybinding('CmdOrCtrl+Shift+F', 'other')).toBe('Ctrl+Shift+F')
    expect(displayKeybinding('Alt+Left', 'other')).toBe('Alt+←')
  })

  it('name of the pressed key: symbols and letters with Shift / Option are physical keys (the same name for US / JIS)', () => {
    expect(keyNameOf({ key: '_', code: 'Minus', shiftKey: true, altKey: false })).toBe('-')
    expect(keyNameOf({ key: '=', code: 'Minus', shiftKey: true, altKey: false })).toBe('-') // JIS
    expect(keyNameOf({ key: '=', shiftKey: true, altKey: false })).toBe('-') // JIS ⇧- without a code
    expect(keyNameOf({ key: 'ƒ', code: 'KeyF', shiftKey: false, altKey: true })).toBe('F') // mac ⌥F
    expect(keyNameOf({ key: '@', code: 'BracketLeft', shiftKey: false, altKey: false })).toBe('@') // JIS @ stays as is
    expect(keyNameOf({ key: '!', code: 'Digit1', shiftKey: true, altKey: false })).toBe('1')
    expect(keyNameOf({ key: 'ArrowLeft', shiftKey: false, altKey: true })).toBe('Left')
    expect(keyNameOf({ key: 'Meta', shiftKey: false, altKey: false })).toBeNull()
  })

  it("recording: modifiers as pressed (mac's Cmd is Cmd, the Win key is not used elsewhere)", () => {
    expect(keybindingFromInput(press({ key: 't', metaKey: true }), 'mac')).toBe('Cmd+T')
    expect(keybindingFromInput(press({ key: 'T', ctrlKey: true, shiftKey: true }), 'other')).toBe('Ctrl+Shift+T')
    expect(keybindingFromInput(press({ key: 't', metaKey: true }), 'other')).toBeNull()
    expect(keybindingFromInput(press({ key: 't' }), 'mac')).toBeNull()
    expect(keybindingFromInput(press({ key: 'Shift', shiftKey: true }), 'mac')).toBeNull()
  })

  it('matching: CmdOrCtrl matches either Cmd or Ctrl when lenient; the exact press wins first', () => {
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

  it('TODO 589: rows for letters, digits and symbols with Option have a physical key (code); named keys and rows without Option do not', () => {
    expect(keyRowsOf('Alt+Cmd+F', 'mac')).toEqual([
      { key: 'f', metaKey: true, ctrlKey: false, shiftKey: false, altKey: true, code: 'KeyF' }
    ])
    expect(keyRowsOf('Alt+Shift+Cmd+-', 'mac').map((r) => [r.key, r.code])).toEqual([['-', 'Minus']])
    expect(keyRowsOf('CmdOrCtrl+Alt+1', 'mac').map((r) => r.code)).toEqual(['Digit1', 'Digit1'])
    expect(keyRowsOf('Alt+Left', 'other').map((r) => [r.key, r.code])).toEqual([['ArrowLeft', undefined]])
    expect(keyRowsOf('Cmd+F', 'mac')[0]?.code).toBeUndefined()
  })

  it('TODO 589: assignments with Option on mac also arrive from inside a viewer / web page (matched by code even if Option changes key to another character)', () => {
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

  it('send-back rows: CmdOrCtrl gives 2 rows, and symbols with Shift use the US and JIS characters', () => {
    expect(keyRowsOf('CmdOrCtrl+K', 'mac').map((r) => [r.key, r.metaKey, r.ctrlKey])).toEqual([
      ['k', true, false],
      ['k', false, true]
    ])
    expect(keyRowsOf('Ctrl+Shift+-', 'mac').map((r) => r.key)).toEqual(['_', '='])
    expect(keyRowsOf('Ctrl+Tab', 'mac').map((r) => r.key)).toEqual(['Tab'])
  })
})

describe('validation and conflicts', () => {
  it('drops unknown ids and unreadable keys, and drops the real key that equals the default; null (removed) is kept', () => {
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

  it('conflicts: with other commands, and with OS / edit menu keys', () => {
    expect(conflictsOf('Cmd+P', 'search.conversation', 'mac', {})).toEqual({ commands: ['search.names'], reserved: [] })
    expect(conflictsOf('Cmd+C', 'search.names', 'mac', {})).toEqual({ commands: [], reserved: ['edit'] })
    expect(conflictsOf('Cmd+P', 'search.names', 'mac', {})).toEqual({ commands: [], reserved: [] })
    // Does not conflict with a command that was unbound
    expect(conflictsOf('Cmd+P', 'search.conversation', 'mac', { 'search.names': null }).commands).toEqual([])
  })
})

describe("the renderer's decisions and tables follow the assignments", () => {
  it('search: changing the assignment matches the new key and no longer the old one', () => {
    setKeybindings({ 'search.names': 'Cmd+T' }, 'mac')
    expect(searchShortcut(press({ key: 't', metaKey: true }))).toBe('names')
    expect(searchShortcut(press({ key: 'p', metaKey: true }))).toBeNull()
    expect(searchKeyLabel('names', 'mac')).toBe('⌘T')
  })

  it('changing Cmd+F makes the in-thread search inside ThreadPane use that key too; removing it does nothing', () => {
    setKeybindings({ find: 'Cmd+G' }, 'mac')
    expect(appShortcut(press({ key: 'g', metaKey: true }), { inThreadPane: true })).toBe('threadFind')
    expect(appShortcut(press({ key: 'f', metaKey: true }), { inThreadPane: true })).toBeNull()
    expect(threadFindKeyLabel('mac')).toBe('⌘G')
    setKeybindings({ find: null }, 'mac')
    expect(appShortcut(press({ key: 'f', metaKey: true }), { inThreadPane: true })).toBeNull()
    expect(threadFindKeyLabel('mac')).toBe('—')
  })

  it('the send-back table is built from the current assignments on every call (TODO 589: an array taken earlier is not rewritten)', () => {
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

  it('save, back / forward and the hidden files fallback also follow the assignments', () => {
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

  it('the tooltip notation (mode, new thread) also follows the assignments', () => {
    setKeybindings({ 'view.threads': 'Cmd+1', 'thread.new': 'Cmd+Shift+N' }, 'mac')
    expect(modeKeyLabel('threads', 'mac')).toBe('⌘1')
    expect(modeKeyLabel('files', 'mac')).toBe('⇧⌘E')
    expect(newThreadKeyLabel('mac')).toBe('⇧⌘N')
  })
})

describe('menu (rebuilt by main)', () => {
  it('accelerators whose assignment changed and accelerators that were removed', () => {
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

describe('saving (KeybindingsPreference, main)', () => {
  it('validates and saves, and notifies only when it changes; remembered even after recreation', () => {
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

  it('the ui.keybindings key: a broken value becomes empty, and only strings and null remain', () => {
    expect(UI_KEYBINDINGS.owner).toBe('main')
    expect(UI_KEYBINDINGS.parse(null)).toEqual({})
    expect(UI_KEYBINDINGS.parse('{oops')).toEqual({})
    expect(UI_KEYBINDINGS.parse('[1]')).toEqual({})
    expect(UI_KEYBINDINGS.parse('{"a":"Cmd+T","b":null,"c":3}')).toEqual({ a: 'Cmd+T', b: null })
    expect(UI_KEYBINDINGS.parse(UI_KEYBINDINGS.serialize({ find: null }))).toEqual({ find: null })
  })
})
