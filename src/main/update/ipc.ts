/**
 * Wire auto-update (TODO 103 stage 1, ARCHITECTURE.md 8.5) to electron. The core is `service.ts` (independent of electron).
 *
 * - The inputs for deciding the install location (`detectInstall`) are taken from `app`. In forms where updating cannot run (a development shell, `npm run dev`, a duplicate)
 *   the IPC is still registered and returns `supported: false` with a reason (the settings screen shows it).
 * - New versions are fetched from the public Release over unauthenticated HTTPS first, then with the user's `gh` (`public-release-source.ts`, `release-source.ts`; TODO 1275). This is the only place in main that reaches the network (plugins do not go through it).
 * - Restart is `app.relaunch({ execPath: <executable of ~/Applications/Temoto.app> })` + `app.quit()`. The swap (rename,
 *   TODO 1050) happens inside the shutdown (`applyAtQuit` on `before-quit`) — the .app is never moved while running. Shutdown runs as usual,
 *   and the windows and threads come back through the next launch's restore (item 36).
 */
import { app, ipcMain, type WebContents } from 'electron'
import { IpcChannel, IpcEvent } from '@shared/ipc.js'
import type { AppSettingsStore } from '../../common/settings.js'
import { guarded } from '../ipc/handlers.js'
import {
  bundlePathOf,
  executableOf,
  heldVersion,
  linkIsBundle,
  linkedVersion,
  type InstallDetection
} from './layout.js'
import { detectInstallWithRegistration } from './register.js'
import { ghReleaseSource, runCommand } from './release-source.js'
import { fallbackReleaseSource, publicReleaseSource } from './public-release-source.js'
import { KEEP_VERSIONS, pruneVersions, stageRelease, swapApp } from './stage.js'
import { detectKeychainPrompt } from './signer-change.js'
import { fetchPluginVersionTable, type PluginReleaseCatalog } from './plugin-versions.js'
import { installPluginRelease, type PluginReloader } from './plugin-install.js'
import type { UpdatedPluginStore } from '../plugin/updated-store.js'
import type { PluginSummary } from '@shared/plugin.js'
import { reasonError } from '@shared/reason.js'
import { UpdateService } from './service.js'
import { hostPlatform } from '../../common/os/platform.js'

/**
 * A marker added to the next launch started by an idle restart. If there were 0 windows at the previous exit (the app was left in the Dock),
 * the next launch does not open a window either (no windows appear on their own).
 */
export const UPDATE_RELAUNCH_ARG = '--aios-update-relaunch'

export interface UpdateWiring {
  readonly settings: AppSettingsStore
  readonly defaultUserData: boolean
  readonly getTargets: () => readonly WebContents[]
  readonly restartBlocker: () => string | null
  readonly systemIdleSeconds: () => number
  readonly closing: () => boolean
  /** Confirmation before "restart and update" (TODO 606). */
  readonly confirmRestart?: () => Promise<boolean>
  readonly restartAborted?: () => void
  /** TODO 1144 stage 1: the extension version table. Rides on the main app's check and fetches `plugins.json` of the latest Release (8.5.1). */
  readonly pluginRelease?: PluginReleaseCatalog
  /**
   * TODO 1144 stage 2: per-extension "update" (8.5.1). The install location (`UpdatedPluginStore`), the list (the renderer's id is re-validated against it), and
   * the reload entry point (`PluginHost`).
   */
  readonly pluginInstall?: {
    readonly store: UpdatedPluginStore
    readonly host: PluginReloader & { summaries(): readonly PluginSummary[] }
  }
}

export function detectCurrentInstall(defaultUserData: boolean): InstallDetection {
  return detectInstallWithRegistration({
    platform: hostPlatform(),
    arch: process.arch,
    isPackaged: app.isPackaged,
    devServer: process.env['ELECTRON_RENDERER_URL'] !== undefined,
    defaultUserData,
    execPath: process.execPath,
    appPath: app.getAppPath()
  })
}

export function registerUpdateHandlers(wiring: UpdateWiring): UpdateService {
  const detection = detectCurrentInstall(wiring.defaultUserData)
  const layout = detection.kind === 'versioned' ? detection.layout : null
  const source = layout === null ? null : fallbackReleaseSource(publicReleaseSource(layout.repo), ghReleaseSource(layout.repo))
  const notSupported = (): never => {
    throw new Error('update unsupported')
  }
  const pluginRelease = wiring.pluginRelease
  if (pluginRelease !== undefined && detection.kind === 'unsupported') pluginRelease.setUnsupported(detection.reason)
  const service = new UpdateService({
    settings: wiring.settings,
    currentVersion: app.getVersion(),
    detection,
    latestTag: () => (source === null ? notSupported() : source.latestTag()),
    stage: (tag, version) =>
      layout === null || source === null ? notSupported() : stageRelease(layout, tag, version, source, runCommand),
    linkedVersion: () => (layout === null ? null : linkedVersion(layout)),
    heldVersion: () => (layout === null ? null : heldVersion(layout)),
    swapLink: (version) => (layout === null ? notSupported() : swapApp(layout, version)),
    // The installed version's real copy lives outside versions, so leave one fewer in versions (same total as install-aios.sh).
    prune: (keep) =>
      layout === null ? [] : pruneVersions(layout.versionsDir, keep, linkIsBundle(layout) ? KEEP_VERSIONS - 1 : KEEP_VERSIONS),
    keychainPromptExpected: (version) =>
      layout === null ? Promise.resolve(false) : detectKeychainPrompt(layout.link, bundlePathOf(layout, version), runCommand),
    deferSwap: () => layout !== null && linkIsBundle(layout),
    restartBlocker: wiring.restartBlocker,
    systemIdleSeconds: wiring.systemIdleSeconds,
    closing: wiring.closing,
    ...(wiring.confirmRestart === undefined ? {} : { confirmRestart: wiring.confirmRestart }),
    ...(wiring.restartAborted === undefined ? {} : { restartAborted: wiring.restartAborted }),
    ...(pluginRelease === undefined || source === null
      ? {}
      : {
          onReleaseChecked: (result: Parameters<PluginReleaseCatalog['releaseChecked']>[0]) => {
            void pluginRelease.releaseChecked(result, (tag) => fetchPluginVersionTable(source, tag))
          }
        }),
    relaunch: () => {
      if (layout === null) return
      app.relaunch({ execPath: executableOf(layout), args: [UPDATE_RELAUNCH_ARG] })
      app.quit()
    },
    onChanged: (status) => {
      for (const contents of wiring.getTargets()) {
        if (!contents.isDestroyed()) contents.send(IpcEvent.updateChanged, status)
      }
    }
  })

  ipcMain.handle(IpcChannel.updateStatus, guarded(IpcChannel.updateStatus, () => service.status()))
  ipcMain.handle(
    IpcChannel.updateCheck,
    guarded(IpcChannel.updateCheck, async () => {
      // A failure is carried in the state (`failure`), so it is not thrown. Only `update-unsupported` (a form that cannot run) is thrown.
      await service.check()
      return service.status()
    })
  )
  ipcMain.handle(
    IpcChannel.updateInstall,
    guarded(IpcChannel.updateInstall, async () => {
      await service.install()
      return service.status()
    })
  )
  ipcMain.handle(IpcChannel.updateRestart, guarded(IpcChannel.updateRestart, () => service.restartNow()))
  ipcMain.handle(
    IpcChannel.updateSetAuto,
    guarded(IpcChannel.updateSetAuto, (_event: unknown, on: unknown) => service.setAuto(on === true))
  )
  ipcMain.handle(IpcChannel.updateDismissNotice, guarded(IpcChannel.updateDismissNotice, () => service.dismissNotice()))
  // TODO 1144 stage 2: update one extension. The renderer's id is accepted only if it is a bundled one in main's list (the loaded manifests).
  const pluginInstall = wiring.pluginInstall
  ipcMain.handle(
    IpcChannel.pluginUpdate,
    guarded(IpcChannel.pluginUpdate, async (_event: unknown, pluginId: unknown) => {
      if (typeof pluginId !== 'string' || pluginId.length > 128) throw new Error('invalid pluginId')
      if (pluginRelease === undefined || pluginInstall === undefined || source === null) throw reasonError('update-unsupported')
      if (wiring.closing()) throw new Error('closing')
      const plugin = pluginInstall.host.summaries().find((entry) => entry.id === pluginId)
      if (plugin === undefined) throw new Error('unknown plugin')
      if (!plugin.bundled) throw reasonError('plugin-update-unavailable')
      await pluginRelease.update({ id: plugin.id, version: plugin.version, bundled: plugin.bundled }, (tag, id, entry) =>
        installPluginRelease({ source, store: pluginInstall.store, host: pluginInstall.host, closing: wiring.closing }, tag, id, entry)
      )
    })
  )
  // TODO 1144 stage 3: bulk "update all". The targets are chosen from main's list (nothing is accepted from the renderer). One at a time, through the same path as above.
  ipcMain.handle(
    IpcChannel.pluginUpdateAll,
    guarded(IpcChannel.pluginUpdateAll, async () => {
      if (pluginRelease === undefined || pluginInstall === undefined || source === null) throw reasonError('update-unsupported')
      if (wiring.closing()) throw new Error('closing')
      return pluginRelease.updateAll(
        () => pluginInstall.host.summaries().map((entry) => ({ id: entry.id, version: entry.version, bundled: entry.bundled })),
        (tag, id, entry) =>
          installPluginRelease({ source, store: pluginInstall.store, host: pluginInstall.host, closing: wiring.closing }, tag, id, entry),
        wiring.closing
      )
    })
  )
  return service
}
