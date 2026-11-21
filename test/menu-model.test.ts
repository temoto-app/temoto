/**
 * The table of menu items and accelerators (item 195, wave 14 bundle D). `menu.ts` touches electron, so it is not tested;
 * instead the electron-free `menu-model.ts` is checked.
 *
 * What it checks:
 *  - the mode keys (⌃⌘I / ⌘⇧E / ⌘,) and ⌘B are registered as accelerators
 *  - the search keys the renderer's keydown picks up (⌘F / ⌘⇧F / ⌘P / ⌘K) are **not** registered
 *    (if electron takes them first, they never reach the renderer, and ⌘F also breaks search inside the viewer's editor)
 *  - accelerators do not overlap, and do not collide with keys that come from roles
 *  - the labels are in the native UI table
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  HELP_ITEM,
  HIDDEN_FILES_ITEM,
  NEW_THREAD_ITEM,
  RELOAD_ITEM,
  FORCE_RELOAD_ITEM,
  RENDERER_KEYDOWN_ACCELERATORS,
  SAVE_ITEM,
  SETTINGS_ITEM,
  dispatchMenuCommand,
  registeredAccelerators,
  viewMenuEntries,
  type CommandMenuItem,
  type MenuCommandTarget
} from '../src/main/menu-model.js'
import { NATIVE_DICTIONARIES } from '../src/main/i18n-native.js'

/** Keys held by electron roles (the part of the roles that menu.ts keeps). Notation is aligned before comparing. */
const ROLE_ACCELERATORS = [
  // reload (⌘R) left its role in TODO 468 and became an item with no accelerator (see the Reload section below).
  // forceReload (⌘⇧R) left its role in TODO 636, but its key is the same as the role's (FORCE_RELOAD_ITEM, outside the user's assignments).
  'Shift+CmdOrCtrl+R',
  'CmdOrCtrl+0',
  'CmdOrCtrl+Plus',
  'CmdOrCtrl+-',
  'CmdOrCtrl+Z',
  'Shift+CmdOrCtrl+Z',
  'CmdOrCtrl+X',
  'CmdOrCtrl+C',
  'CmdOrCtrl+V',
  'CmdOrCtrl+A',
  // close (⌘W) left its role in TODO 531 and became its own item (CLOSE_ITEM), which closes a Web tab if there is one, otherwise the window.
  'CmdOrCtrl+M',
  'CmdOrCtrl+Q',
  'CmdOrCtrl+H',
  'Alt+CmdOrCtrl+H',
  'CmdOrCtrl+N'
]

/** Role keys that differ by platform. */
const ROLE_ACCELERATORS_BY_PLATFORM = {
  darwin: ['Alt+Cmd+I' /* toggleDevTools */, 'Ctrl+Cmd+F' /* togglefullscreen */],
  other: ['Ctrl+Shift+I' /* toggleDevTools */, 'F11' /* togglefullscreen */]
} as const

/** Aligns the order of modifiers (makes `Shift+CmdOrCtrl+R` and `CmdOrCtrl+Shift+R` the same). */
function norm(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => part.toLowerCase())
    .sort()
    .join('+')
}

/** Expands to the actual keys on mac (`CmdOrCtrl` = Cmd). */
function onMac(accelerator: string): string {
  return norm(accelerator.replace('CmdOrCtrl', 'Cmd'))
}

/** Expands to the actual keys on other platforms (`CmdOrCtrl` = Ctrl). */
function onOther(accelerator: string): string {
  return norm(accelerator.replace('CmdOrCtrl', 'Ctrl'))
}

function items(platform: 'darwin' | 'other'): CommandMenuItem[] {
  return [...viewMenuEntries(platform), SETTINGS_ITEM, SAVE_ITEM, NEW_THREAD_ITEM].filter(
    (entry): entry is CommandMenuItem => entry !== 'separator'
  )
}

describe('menu table (item 195)', () => {
  it('mac: registers ⌃⌘I / ⇧⌘E / ⌘, / ⌘B and the search item has no key', () => {
    expect(registeredAccelerators('darwin').map(onMac).sort()).toEqual(
      [
        'Ctrl+Cmd+I',
        'CmdOrCtrl+Shift+E',
        'CmdOrCtrl+Shift+X',
        'CmdOrCtrl+,',
        'CmdOrCtrl+B',
        'CmdOrCtrl+Shift+.',
        'CmdOrCtrl+S',
        'CmdOrCtrl+Shift+O',
        'CmdOrCtrl+W'
      ]
        .map(onMac)
        .sort()
    )
    const search = items('darwin').find((item) => item.command === 'showSearch')
    expect(search?.accelerator).toBeUndefined()
  })

  it('other: Ctrl+Alt+I / Ctrl+Shift+E / Ctrl+, / Ctrl+B; Ctrl+Shift+F for search is display only', () => {
    expect(registeredAccelerators('other').map(onOther).sort()).toEqual(
      [
        'Ctrl+Alt+I',
        'Ctrl+Shift+E',
        'Ctrl+Shift+X',
        'Ctrl+,',
        'Ctrl+B',
        'Ctrl+Shift+.',
        'Ctrl+S',
        'Ctrl+Shift+O',
        'Ctrl+W'
      ].map(onOther).sort()
    )
    const search = items('other').find((item) => item.command === 'showSearch')
    expect(search?.accelerator).toBe('Ctrl+Shift+F')
    expect(search?.registerAccelerator).toBe(false)
  })

  it("does not register the renderer's keydown keys (electron would take them first)", () => {
    for (const platform of ['darwin', 'other'] as const) {
      const expand = platform === 'darwin' ? onMac : onOther
      const registered = new Set(registeredAccelerators(platform).map(expand))
      for (const key of RENDERER_KEYDOWN_ACCELERATORS) {
        expect(registered.has(expand(key))).toBe(false)
        // On mac, the renderer also picks up the Ctrl side (metaKey || ctrlKey)
        if (platform === 'darwin') expect(registered.has(onOther(key))).toBe(false)
      }
    }
  })

  it('registered keys overlap neither each other nor the role keys', () => {
    for (const platform of ['darwin', 'other'] as const) {
      const expand = platform === 'darwin' ? onMac : onOther
      const mine = registeredAccelerators(platform).map(expand)
      expect(new Set(mine).size).toBe(mine.length)
      const roles = new Set(
        [...ROLE_ACCELERATORS, ...ROLE_ACCELERATORS_BY_PLATFORM[platform]].map(expand)
      )
      for (const key of mine) expect(roles.has(key)).toBe(false)
    }
  })

  it('has item labels in the native UI table and non-empty in both EN / JA', () => {
    for (const platform of ['darwin', 'other'] as const) {
      for (const item of items(platform)) {
        expect(NATIVE_DICTIONARIES.ja[item.label]).toBeTruthy()
        expect(NATIVE_DICTIONARIES.en[item.label]).toBeTruthy()
      }
    }
  })

  it('puts the sidebar after the 「表示」 order, which is the same top-down order as the icon bar (threads / files / search / extensions)', () => {
    const commands = viewMenuEntries('darwin').map((entry) =>
      entry === 'separator' ? 'separator' : entry.command
    )
    expect(commands).toEqual(['showThreads', 'showFiles', 'showSearch', 'showExtensions', 'separator', 'toggleSidebar'])
  })
})

describe('extensions (TODO 367)', () => {
  it('is registered with the ⌘⇧X / Ctrl+Shift+X accelerator and does not collide with the renderer keydown', () => {
    for (const platform of ['darwin', 'other'] as const) {
      const item = viewMenuEntries(platform).find(
        (entry) => entry !== 'separator' && entry.command === 'showExtensions'
      )
      expect(item).toMatchObject({ label: 'menu.extensions', accelerator: 'CmdOrCtrl+Shift+X' })
      expect(registeredAccelerators(platform)).toContain('CmdOrCtrl+Shift+X')
      expect(RENDERER_KEYDOWN_ACCELERATORS).not.toContain('CmdOrCtrl+Shift+X')
    }
  })
})

describe('「保存」 (item 313)', () => {
  it('is registered with the ⌘S / Ctrl+S accelerator and the label is in the table for both EN / JA', () => {
    expect(SAVE_ITEM.command).toBe('save')
    expect(SAVE_ITEM.accelerator).toBe('CmdOrCtrl+S')
    expect(SAVE_ITEM.registerAccelerator).toBeUndefined()
    expect(registeredAccelerators('darwin').map(onMac)).toContain(onMac('CmdOrCtrl+S'))
    expect(registeredAccelerators('other').map(onOther)).toContain(onOther('CmdOrCtrl+S'))
    expect(NATIVE_DICTIONARIES.ja[SAVE_ITEM.label]).toBe('保存')
    expect(NATIVE_DICTIONARIES.en[SAVE_ITEM.label]).toBe('Save')
  })
})

describe('「新しいスレッド」 (TODO 408)', () => {
  it('is registered with the ⌘⇧O / Ctrl+Shift+O accelerator and overlaps neither the renderer keydown nor roles', () => {
    expect(NEW_THREAD_ITEM.command).toBe('newThread')
    expect(NEW_THREAD_ITEM.accelerator).toBe('CmdOrCtrl+Shift+O')
    expect(NEW_THREAD_ITEM.registerAccelerator).toBeUndefined()
    expect(registeredAccelerators('darwin').map(onMac)).toContain(onMac('CmdOrCtrl+Shift+O'))
    expect(registeredAccelerators('other').map(onOther)).toContain(onOther('CmdOrCtrl+Shift+O'))
    expect(RENDERER_KEYDOWN_ACCELERATORS).not.toContain('CmdOrCtrl+Shift+O')
    expect(NATIVE_DICTIONARIES.ja[NEW_THREAD_ITEM.label]).toBeTruthy()
    expect(NATIVE_DICTIONARIES.en[NEW_THREAD_ITEM.label]).toBeTruthy()
  })
})

describe('「隠しファイルを表示」 (TODO 261)', () => {
  it('uses ⌘⇧. (Ctrl+Shift+.) like Finder, and the label is in the native UI table for both EN / JA', () => {
    expect(HIDDEN_FILES_ITEM.accelerator).toBe('CmdOrCtrl+Shift+.')
    expect(NATIVE_DICTIONARIES.ja[HIDDEN_FILES_ITEM.label]).toBe('隠しファイルを表示')
    expect(NATIVE_DICTIONARIES.en[HIDDEN_FILES_ITEM.label]).toBe('Show Hidden Files')
  })

  it('overlaps neither the renderer keydown keys (⌘F / ⌘⇧F / ⌘P / ⌘K) nor other items', () => {
    for (const platform of ['darwin', 'other'] as const) {
      const expand = platform === 'darwin' ? onMac : onOther
      const key = expand(HIDDEN_FILES_ITEM.accelerator)
      expect(RENDERER_KEYDOWN_ACCELERATORS.map(expand)).not.toContain(key)
      expect(registeredAccelerators(platform).map(expand).filter((k) => k === key)).toHaveLength(1)
    }
  })
})

describe('「ヘルプ > Temoto ヘルプ」 (TODO 1174)', () => {
  it('has no key and sends openHelp, with the label in the table for both EN / JA; menu.ts puts it in the role help menu', () => {
    expect(HELP_ITEM).toEqual({ command: 'openHelp', label: 'menu.helpItem' })
    // TODO 1254: the product name is written as `{app}` and filled in by nativeText
    expect(NATIVE_DICTIONARIES.ja['menu.helpItem']).toBe('{app} ヘルプ')
    expect(NATIVE_DICTIONARIES.en['menu.helpItem']).toBe('{app} Help')
    expect(NATIVE_DICTIONARIES.ja['menu.help']).toBe('ヘルプ')
    expect(NATIVE_DICTIONARIES.en['menu.help']).toBe('Help')
    const source = readFileSync(new URL('../src/main/menu.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/role: 'help'[\s\S]*HELP_ITEM/)
  })
})

describe('「再読み込み」 (TODO 468)', () => {
  it("has no accelerator (⌘R / Ctrl+R go to the viewer's go-to-symbol) and the label is in the table for both EN / JA", () => {
    expect(Object.keys(RELOAD_ITEM)).toEqual(['label'])
    expect(NATIVE_DICTIONARIES.ja[RELOAD_ITEM.label]).toBe('再読み込み')
    expect(NATIVE_DICTIONARIES.en[RELOAD_ITEM.label]).toBe('Reload')
    expect(registeredAccelerators('darwin').map(onMac)).not.toContain(onMac('CmdOrCtrl+R'))
    expect(registeredAccelerators('other').map(onOther)).not.toContain(onOther('CmdOrCtrl+R'))
  })

  it('menu.ts does not use the role reload (default ⌘R)', () => {
    const source = readFileSync(new URL('../src/main/menu.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/role: 'reload'/)
    expect(source).toMatch(/RELOAD_ITEM\.label/)
  })

  it('TODO 636: force reload also drops the role (clears drafts before reloading) and the key is ⌘⇧R, same as the role', () => {
    const source = readFileSync(new URL('../src/main/menu.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/role: 'forceReload'/)
    expect(source).toMatch(/FORCE_RELOAD_ITEM\.label/)
    expect(source).toMatch(/reloadWindow/)
    expect(FORCE_RELOAD_ITEM.accelerator).toBe('Shift+CmdOrCtrl+R')
    expect(NATIVE_DICTIONARIES.ja[FORCE_RELOAD_ITEM.label]).toBe('強制再読み込み')
    expect(NATIVE_DICTIONARIES.en[FORCE_RELOAD_ITEM.label]).toBe('Force Reload')
    // It stays a reserved key (the user cannot assign it).
    expect(registeredAccelerators('darwin').map(onMac)).not.toContain(onMac(FORCE_RELOAD_ITEM.accelerator))
  })
})

describe('dispatchMenuCommand (TODO 588, code-review fix)', () => {
  function fakeTarget(destroyed = false): MenuCommandTarget & {
    readonly sent: readonly [string, unknown][]
    readonly focused: () => boolean
  } {
    const sent: [string, unknown][] = []
    let focused = false
    return {
      isDestroyed: () => destroyed,
      sent,
      focused: () => focused,
      webContents: {
        send: (channel: string, command: unknown) => {
          sent.push([channel, command])
        },
        focus: () => {
          focused = true
        }
      }
    }
  }

  it("returns the window's native focus to the renderer right after sending the command", () => {
    const target = fakeTarget()
    dispatchMenuCommand(target, 'newThread')
    expect(target.sent).toHaveLength(1)
    expect(target.sent[0]?.[1]).toBe('newThread')
    expect(target.focused()).toBe(true)
  })

  it('does not send to a destroyed window (and does not call focus)', () => {
    const target = fakeTarget(true)
    dispatchMenuCommand(target, 'newThread')
    expect(target.sent).toHaveLength(0)
    expect(target.focused()).toBe(false)
  })
})
