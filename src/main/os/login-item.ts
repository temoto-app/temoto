/**
 * Of the OS layer (TODO 986), the login item: start the app when the user logs in (TODO 1266, wave 93 bundle C).
 *
 * `app.setLoginItemSettings` / `app.getLoginItemSettings` are the only calls. On macOS 13 and later Electron registers the running app bundle with
 * SMAppService, so the entry shows under System Settings > General > Login Items. `openAtLogin` read back from the OS is the truth (the user can remove
 * the item there); the stored setting only remembers what was asked for. **The window is shown as usual** (no `openAsHidden`): hiding it waits for the menu bar (1269).
 *
 * Only a distributed build (an installed, packaged app with its own user data directory) may register itself: a development copy, a development
 * shell (`Resources/app` is a symlink to the repo) and a `--user-data-dir` copy would register a path that is not the user's installed app.
 * `loginItemUnavailable` is a pure function of those facts and does not import electron (tests call it directly).
 */
import { lstatSync } from 'node:fs'
import { app } from 'electron'
import { hostPlatform } from '../../common/os/platform.js'
import type { OsSettingUnavailableReason } from '@shared/os-settings.js'

export interface LoginItemEnvironment {
  readonly platform: NodeJS.Platform
  readonly isPackaged: boolean
  /** The renderer dev server is running (`npm run dev`). */
  readonly devServer: boolean
  /** The userData is the default one (not `--user-data-dir`, not `dev:instance`). */
  readonly defaultUserData: boolean
  /** `Resources/app` is a symlink: the development shell made by `npm run app`. */
  readonly appIsSymlink: boolean
}

/** Null if this process may register the login item, else the reason (the same order as the auto-update's detection). */
export function loginItemUnavailable(env: LoginItemEnvironment): OsSettingUnavailableReason | null {
  if (env.platform !== 'darwin' && env.platform !== 'win32') return 'platform'
  if (env.devServer) return 'dev'
  if (!env.isPackaged) return 'not-installed'
  if (env.appIsSymlink) return 'dev-shell'
  if (!env.defaultUserData) return 'instance'
  return null
}

/** The facts of the running process (`defaultUserData` is decided by the caller from the `--user-data-dir` handling). */
export function currentLoginItemEnvironment(defaultUserData: boolean): LoginItemEnvironment {
  let appIsSymlink = false
  try {
    appIsSymlink = lstatSync(app.getAppPath()).isSymbolicLink()
  } catch {
    // Unreadable: treat as not a shell (the other checks still apply).
  }
  return {
    platform: hostPlatform(),
    isPackaged: app.isPackaged,
    devServer: process.env['ELECTRON_RENDERER_URL'] !== undefined,
    defaultUserData,
    appIsSymlink
  }
}

/** The OS side. Tests pass a fake. */
export interface LoginItemBackend {
  isOpenAtLogin(): boolean
  setOpenAtLogin(enabled: boolean): void
  /**
   * Drop the registration and add it again, so that the OS records the bundle this process runs from now (TODO 1277). Only called while the item is ON.
   * On macOS 13 and later `app.setLoginItemSettings` takes no path: it registers the main app bundle (SMAppService `mainAppService`). Unregister + register
   * is the only way to make the OS look at the bundle again.
   */
  reregister(): void
}

export function electronLoginItemBackend(): LoginItemBackend {
  return {
    isOpenAtLogin: () => app.getLoginItemSettings().openAtLogin,
    setOpenAtLogin: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled }),
    reregister: () => {
      app.setLoginItemSettings({ openAtLogin: false })
      app.setLoginItemSettings({ openAtLogin: true })
    }
  }
}
