/**
 * The look of the first window, readable before the DB is open (TODO 807, ARCHITECTURE 3.1 "launch order").
 *
 * The first window now opens before the DB key, so the window record (`window.bounds` in `app_settings`, item 36) and the theme /
 * language settings (7.4.1 / 7.4.4) cannot be read yet. Without a hint the window would appear centred in the system colours and
 * jump to its remembered place a moment later on every launch. So the quit that writes the record (`persistSession`) also writes
 * this small file next to the DB: where the first window goes, whether it was maximized, and the two preferences.
 *
 * - **It is only a hint.** Nothing reads it after the DB is open; the record in the DB stays the source. A missing, broken or stale
 *   file only costs that jump once.
 * - **No content**: four numbers, one flag and two preference names. No thread id, no path, no title (constraints 9 / 10 / 11 are
 *   about content; window geometry is UI state).
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isStoredWindowBounds, type StoredWindowBounds, type StoredWindowState } from '../common/settings-keys.js'
import { isLocalePreference, type LocalePreference } from '@shared/locale.js'
import { isThemePreference, type ThemePreference } from '@shared/theme.js'

/** The file inside userData. */
export const BOOT_HINT_FILE = 'window-boot.json'

const HINT_VERSION = 1

export interface BootHint {
  /** Where the first window goes (the first restored window, else the last closed one). Null = let the OS centre it. */
  readonly bounds: StoredWindowBounds | null
  readonly maximized: boolean
  readonly theme: ThemePreference
  readonly locale: LocalePreference
}

/** No file, or an unreadable one: the system look, centred. */
export const DEFAULT_BOOT_HINT: BootHint = { bounds: null, maximized: false, theme: 'system', locale: 'system' }

function roundBounds(bounds: StoredWindowBounds): StoredWindowBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  }
}

/**
 * The hint for the record just written at quit (`snapshotSession`'s value). The window the next launch adopts first is the first
 * `restore: true` element (`planRestore` keeps that order); with none, the next launch opens one window where `chooseBounds` puts it,
 * which is the first closed position that is still on screen, so the first closed element.
 */
export function bootHintFromRecord(
  record: readonly StoredWindowState[],
  theme: ThemePreference,
  locale: LocalePreference
): BootHint {
  const restored = record.find((state) => state.restore === true)
  if (restored !== undefined) return { bounds: roundBounds(restored), maximized: restored.maximized === true, theme, locale }
  const closed = record.find((state) => state.restore !== true)
  return { bounds: closed === undefined ? null : roundBounds(closed), maximized: false, theme, locale }
}

/** Reads the file's text. Anything that does not fit falls back to the default value by field (never throws). */
export function parseBootHint(text: string | null): BootHint {
  if (text === null) return DEFAULT_BOOT_HINT
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return DEFAULT_BOOT_HINT
  }
  if (typeof value !== 'object' || value === null) return DEFAULT_BOOT_HINT
  const record = value as Record<string, unknown>
  if (record['v'] !== HINT_VERSION) return DEFAULT_BOOT_HINT
  const bounds = record['bounds']
  return {
    bounds: isStoredWindowBounds(bounds) ? roundBounds(bounds) : null,
    maximized: record['maximized'] === true,
    theme: isThemePreference(record['theme']) ? record['theme'] : DEFAULT_BOOT_HINT.theme,
    locale: isLocalePreference(record['locale']) ? record['locale'] : DEFAULT_BOOT_HINT.locale
  }
}

export function serializeBootHint(hint: BootHint): string {
  return `${JSON.stringify({ v: HINT_VERSION, ...hint })}\n`
}

/** Reads `<userData>/window-boot.json`. Missing or unreadable = the default. */
export function readBootHint(userDataDir: string, read: (path: string) => string = (path) => readFileSync(path, 'utf8')): BootHint {
  try {
    return parseBootHint(read(join(userDataDir, BOOT_HINT_FILE)))
  } catch {
    return DEFAULT_BOOT_HINT
  }
}

/** Writes it whole (a temporary file and a rename, so a crash midway leaves the old one). Throws on failure; the caller logs. */
export function writeBootHint(userDataDir: string, hint: BootHint): void {
  const path = join(userDataDir, BOOT_HINT_FILE)
  const temporary = `${path}.tmp`
  writeFileSync(temporary, serializeBootHint(hint), { mode: 0o600 })
  renameSync(temporary, path)
}
