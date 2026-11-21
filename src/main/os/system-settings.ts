/**
 * TODO 967: main's entry point for opening a specific pane of the OS system settings.
 *
 * `open-external.ts` (http / https / mailto only) is not widened. The renderer passes only `kind`, not a URL, and
 * main looks up a fixed URL from the table here. An unknown `kind` opens nothing and returns `false`.
 * One of the OS layer (`src/main/os/`, TODO 986): the URLs of the OS settings screens (`x-apple.…`) are placed only here.
 * `electron` is not imported (runs in Vitest). The function that opens (`shell.openExternal`) is passed in by the caller.
 */
import { log, errorFields } from '../../common/logger.js'
import { hostPlatform, isMac } from '../../common/os/platform.js'
import type { SystemSettingsKind as Kind } from '@shared/ipc.js'

/** For now only screen recording (owner decision of TODO 967). Microphone etc. get one line in the table when added. */
const SETTINGS_URLS = {
  'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
} as const satisfies Record<Kind, string>

export type SystemSettingsKind = Kind

export function isSystemSettingsKind(value: unknown): value is Kind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SETTINGS_URLS, value)
}

/** `true` only when it opened. `false` for an unknown kind, non-macOS, or when it could not open (the reason goes to the structured log). */
export async function openSystemSettings(
  kind: unknown,
  open: (url: string) => Promise<void>,
  platform: NodeJS.Platform = hostPlatform()
): Promise<boolean> {
  if (!isSystemSettingsKind(kind)) {
    log.warn('system-settings.rejected', { kindType: typeof kind })
    return false
  }
  if (!isMac(platform)) return false
  try {
    await open(SETTINGS_URLS[kind])
    return true
  } catch (err) {
    log.warn('system-settings.open-failed', { kind, ...errorFields(err) })
    return false
  }
}
