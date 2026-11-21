/**
 * Resolving and saving the color theme (ARCHITECTURE.md 7.4.1, TODO 13 / T10).
 *
 * The first half is the pure function `resolveTheme` (the saved value + the OS dark flag -> the effective theme).
 * The second half drives `ThemeController` with the real encrypted DB and a fake `nativeTheme`, covering the round trip through `app_settings`, pushing an OS change, and handling broken values.
 * No model is called.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { SETTING_THEME, ThemeController, type NativeThemeLike } from '../src/main/theme.js'
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_BACKGROUND,
  THEME_PREFERENCES,
  isTheme,
  isThemePreference,
  resolveTheme,
  type ThemeState
} from '../src/shared/theme.js'
import { makeTestDir } from './helpers/tmp.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

describe('resolveTheme (純関数)', () => {
  it('明示された light / dark は OS より強い', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('dark', true)).toBe('dark')
  })

  it('system のときだけ OS の暗色フラグを見る', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('既定は system で、3 値はこれで全部', () => {
    expect(DEFAULT_THEME_PREFERENCE).toBe('system')
    expect([...THEME_PREFERENCES].sort()).toEqual(['dark', 'light', 'system'])
  })

  it('renderer から来た値を弾ける', () => {
    for (const value of THEME_PREFERENCES) expect(isThemePreference(value)).toBe(true)
    for (const bad of ['', 'Light', 'auto', null, undefined, 0, {}, ['dark']]) {
      expect(isThemePreference(bad)).toBe(false)
    }
    expect(isTheme('system')).toBe(false)
  })
})

describe('窓の backgroundColor (flash 対策)', () => {
  it('THEME_BACKGROUND は styles.css の --bg と一致する', () => {
    // CSS variables do not take effect in the window's first frame, so main needs the same colors too. Breakage looks like this: fixing only one side makes a different color flash briefly right after launch.
    const css = readFileSync(join(repoRoot, 'src/renderer/src/styles.css'), 'utf8')
    const blocks = [...css.matchAll(/:root(\[[^\]]*\])?\s*\{([^}]*)\}/g)]
    const bgOf = (selector: string | undefined): string | undefined => {
      const body = blocks.find((m) => m[1] === selector)?.[2] ?? ''
      return /--bg:\s*([^;]+);/.exec(body)?.[1]?.trim()
    }
    expect(bgOf(undefined)).toBe(THEME_BACKGROUND.light)
    expect(bgOf('[data-theme="dark"]')).toBe(THEME_BACKGROUND.dark)
  })
})

/** The test's nativeTheme. Writing `themeSource` fires `updated`, as the real one does. */
class FakeNativeTheme implements NativeThemeLike {
  private source: 'system' | 'light' | 'dark' = 'system'
  private listeners: (() => void)[] = []
  /** The OS setting. */
  osDark = false

  get shouldUseDarkColors(): boolean {
    if (this.source === 'light') return false
    if (this.source === 'dark') return true
    return this.osDark
  }

  get themeSource(): 'system' | 'light' | 'dark' {
    return this.source
  }

  set themeSource(value: 'system' | 'light' | 'dark') {
    this.source = value
    this.emit()
  }

  on(_event: 'updated', listener: () => void): this {
    this.listeners.push(listener)
    return this
  }

  /** The OS switched to dark mode. */
  setOsDark(dark: boolean): void {
    this.osDark = dark
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

describe('ThemeController (実物の暗号化 DB)', () => {
  const KEY = 'theme-test-key'
  let dbDir = ''
  let db: Db
  let settings: AppSettingsStore

  beforeAll(() => {
    // On macOS tmpdir() is under /var/folders, which hits the exclusion in 4.4.2, so create it under the home directory.
    dbDir = makeTestDir('theme-test')
    db = new Database(join(dbDir, 'aios.db'))
    db.pragma(`key='${KEY}'`)
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    settings = new AppSettingsStore(db)
  })

  afterAll(() => {
    if (db.open) db.close()
    rmSync(dbDir, { recursive: true, force: true })
  })

  function make(native: FakeNativeTheme): { theme: ThemeController; pushed: ThemeState[] } {
    const pushed: ThemeState[] = []
    const theme = new ThemeController({
      settings,
      native,
      onChanged: (state) => pushed.push(state)
    })
    return { theme, pushed }
  }

  it('保存が無ければ system で、OS の暗色フラグに従う', () => {
    settings.remove(SETTING_THEME)
    const native = new FakeNativeTheme()
    native.osDark = true
    const { theme } = make(native)
    expect(theme.state()).toEqual({ preference: 'system', resolved: 'dark' })
    expect(native.themeSource).toBe('system')
  })

  it('選んだ値は app_settings に残り、次の起動で読み直される', () => {
    settings.remove(SETTING_THEME)
    const native = new FakeNativeTheme()
    const { theme, pushed } = make(native)

    expect(theme.setPreference('dark')).toEqual({ preference: 'dark', resolved: 'dark' })
    expect(settings.read(SETTING_THEME)).toBe('dark')
    // A change is pushed only once (not doubled with the write to themeSource).
    expect(pushed).toEqual([{ preference: 'dark', resolved: 'dark' }])

    // Recreating it = the next launch.
    const { theme: reopened } = make(new FakeNativeTheme())
    expect(reopened.state()).toEqual({ preference: 'dark', resolved: 'dark' })
    expect(reopened.theme).toBe('dark')
  })

  it('明示した値は OS が変わっても動かない', () => {
    settings.remove(SETTING_THEME)
    const native = new FakeNativeTheme()
    const { theme, pushed } = make(native)
    theme.setPreference('light')
    pushed.length = 0

    native.setOsDark(true)
    expect(theme.state().resolved).toBe('light')
    expect(pushed).toEqual([])
  })

  it('system のときは OS の変更を renderer へ押す', () => {
    settings.remove(SETTING_THEME)
    const native = new FakeNativeTheme()
    const { theme, pushed } = make(native)
    expect(theme.state().resolved).toBe('light')

    native.setOsDark(true)
    expect(theme.state()).toEqual({ preference: 'system', resolved: 'dark' })
    expect(pushed).toEqual([{ preference: 'system', resolved: 'dark' }])

    // No push on a re-notification with the same value.
    pushed.length = 0
    native.setOsDark(true)
    expect(pushed).toEqual([])
  })

  it('壊れた保存値は既定 (system) に倒す', () => {
    settings.write(SETTING_THEME, 'chartreuse')
    const native = new FakeNativeTheme()
    native.osDark = true
    const { theme } = make(native)
    expect(theme.state()).toEqual({ preference: 'system', resolved: 'dark' })
  })
})
