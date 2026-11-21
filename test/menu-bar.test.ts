/**
 * TODO 1269 (wave 94 bundle B): the macOS menu bar icon.
 *
 * - `trayMenuModel`: four things in a fixed order (show, new thread, pending approvals, quit); with no approvals the row is greyed and has no action;
 *   with some, the count is in the label and pressing it shows the window; EN / JA labels.
 * - `MenuBarPreference`: default off, remembers the value and calls `onChange`; where there is no menu bar (not macOS) `set` does nothing and `get` is false.
 * - The key is `display` for the AI's settings tool (a visual preference) and its default is off.
 *
 * Neither electron nor the OS is touched (electron is mocked; the tray itself, `os/tray.ts`, is not exercised).
 */
import { describe, expect, it, vi } from 'vitest'
import { APP_MENU_BAR, agentSettingAccess, type SettingKey } from '../src/common/settings-keys.js'
import { settingDefaults } from '../src/main/settings-snapshot.js'
import { trayMenuModel, trayMenuSignature } from '../src/main/os/tray-model.js'

vi.mock('electron', () => ({ app: {}, powerMonitor: {}, powerSaveBlocker: {} }))

const { MenuBarPreference } = await import('../src/main/os-settings.js')

class MemorySettings {
  readonly values = new Map<string, string>()
  readTyped<T>(def: SettingKey<T>): T {
    return def.parse(this.values.get(def.key) ?? null)
  }
  writeTyped<T>(def: SettingKey<T>, value: T): void {
    this.values.set(def.key, def.serialize(value))
  }
}

describe('trayMenuModel (TODO 1269)', () => {
  it('待ちの承認が 0 件なら灰色の「待ちの承認なし」で、押しても何も起きない', () => {
    const items = trayMenuModel('ja', 0)
    expect(items.map((entry) => (entry.kind === 'separator' ? '---' : entry.id))).toEqual(['show', 'newThread', '---', 'pending', '---', 'quit'])
    const pending = items.find((entry) => entry.kind === 'item' && entry.id === 'pending')
    expect(pending).toMatchObject({ label: '待ちの承認なし', enabled: false, action: null })
  })

  it('待ちの承認があれば件数が出て、押すと窓を出す', () => {
    const pending = trayMenuModel('ja', 3).find((entry) => entry.kind === 'item' && entry.id === 'pending')
    expect(pending).toMatchObject({ label: '待ちの承認: 3 件', enabled: true, action: 'show' })
    const english = trayMenuModel('en', 1).find((entry) => entry.kind === 'item' && entry.id === 'pending')
    expect(english).toMatchObject({ label: 'Pending approvals: 1', enabled: true, action: 'show' })
  })

  it('窓を出す・新しい会話・終了の操作と、EN / JA の文言', () => {
    const byId = (locale: 'en' | 'ja') =>
      Object.fromEntries(trayMenuModel(locale, 0).flatMap((entry) => (entry.kind === 'item' ? [[entry.id, entry]] : [])))
    expect(byId('en')['show']).toMatchObject({ action: 'show', enabled: true })
    expect(byId('en')['newThread']).toMatchObject({ action: 'newThread', enabled: true, label: 'New Thread' })
    expect(byId('en')['quit']).toMatchObject({ action: 'quit', enabled: true })
    expect(byId('ja')['newThread']).toMatchObject({ label: '新しい会話' })
    expect(byId('ja')['show']?.label).not.toContain('{app}')
  })

  it('不正な件数 (負・小数・NaN) は 0 件として扱う', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(trayMenuModel('en', bad)).toEqual(trayMenuModel('en', 0))
    }
  })

  it('署名は言語と件数が変わったときだけ変わる (作り直しの判定)', () => {
    expect(trayMenuSignature('en', 2)).toBe(trayMenuSignature('en', 2))
    expect(trayMenuSignature('en', 2)).not.toBe(trayMenuSignature('en', 3))
    expect(trayMenuSignature('en', 2)).not.toBe(trayMenuSignature('ja', 2))
    expect(trayMenuSignature('en', 0)).toBe(trayMenuSignature('en', -5))
  })
})

describe('MenuBarPreference (TODO 1269)', () => {
  it('既定は OFF で AI の口は display', () => {
    expect(APP_MENU_BAR.parse(null)).toBe(false)
    expect(settingDefaults().menuBar).toBe(false)
    expect(agentSettingAccess(APP_MENU_BAR)).toBe('display')
  })

  it('入れる・外すと覚え、そのたびに onChange を呼ぶ', () => {
    const settings = new MemorySettings()
    const changed = vi.fn()
    const preference = new MenuBarPreference(settings, changed, true)
    expect(preference.state()).toEqual({ enabled: false, supported: true })
    expect(preference.set(true)).toBe(true)
    expect(settings.values.get('app.menuBar')).toBe('true')
    expect(preference.get()).toBe(true)
    preference.set(false)
    expect(preference.get()).toBe(false)
    expect(changed).toHaveBeenCalledTimes(2)
    // A new instance reads what was remembered.
    settings.writeTyped(APP_MENU_BAR, true)
    expect(new MenuBarPreference(settings, changed, true).get()).toBe(true)
  })

  it('メニューバーの無い OS では set は何もせず、覚えた値があっても false', () => {
    const settings = new MemorySettings()
    settings.writeTyped(APP_MENU_BAR, true)
    const changed = vi.fn()
    const preference = new MenuBarPreference(settings, changed, false)
    expect(preference.get()).toBe(false)
    expect(preference.set(true)).toBe(false)
    expect(changed).not.toHaveBeenCalled()
    expect(preference.state()).toEqual({ enabled: false, supported: false })
  })
})
