/**
 * The user's assignments of keyboard shortcuts (TODO 549, ARCHITECTURE 5.5.2).
 *
 * Stored as one key in `app_settings` (`UI_KEYBINDINGS`, owned by main - TODO 85). It is one for the whole app, so when it changes,
 * **all windows** are notified and the menu accelerators are rebuilt (`onChanged`). Same light shape as `HiddenFilesPreference`,
 * independent of electron (`keybindings-ipc.ts` connects it to ipcMain). Value validation is here, which knows the platform
 * (`sanitizeKeybindingOverrides`: drops unknown commands and unreadable keys, and drops those equal to the default).
 */
import type { AppSettingsStore } from '../common/settings.js'
import { UI_KEYBINDINGS } from '../common/settings-keys.js'
import { isMac } from '../common/os/platform.js'
import {
  sanitizeKeybindingOverrides,
  type KeyPlatform,
  type KeybindingOverrides
} from '@shared/keybindings.js'

/** OS name (`hostPlatform()`) -> platform of the table. */
export function keyPlatformOfProcess(platform: string): KeyPlatform {
  return isMac(platform) ? 'mac' : 'other'
}

function sameOverrides(a: KeybindingOverrides, b: KeybindingOverrides): boolean {
  const left = Object.entries(a)
  const right = Object.entries(b)
  if (left.length !== right.length) return false
  const table = new Map(right)
  return left.every(([id, value]) => table.has(id) && table.get(id) === value)
}

export class KeybindingsPreference {
  private current: KeybindingOverrides

  constructor(
    private readonly settings: AppSettingsStore,
    private readonly platform: KeyPlatform,
    private readonly onChanged: (overrides: KeybindingOverrides) => void = () => undefined
  ) {
    this.current = sanitizeKeybindingOverrides(settings.readTyped(UI_KEYBINDINGS), platform)
  }

  get(): KeybindingOverrides {
    return this.current
  }

  /** Validates, saves, and notifies all windows. Does nothing if the same. Returns the value after saving. */
  set(raw: unknown): KeybindingOverrides {
    const next = sanitizeKeybindingOverrides(raw, this.platform)
    if (sameOverrides(next, this.current)) return this.current
    this.current = next
    this.settings.writeTyped(UI_KEYBINDINGS, next as Readonly<Record<string, string | null>>)
    this.onChanged(next)
    return this.current
  }
}
