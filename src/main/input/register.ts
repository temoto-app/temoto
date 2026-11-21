/**
 * Connects ASCII input in the search field (TODO 463, ARCHITECTURE 4.5.11) to electron. Kept separate from
 * `handlers.ts` (like voice input's `voice/register.ts`, so as not to touch the same place as parallel bundles).
 *
 * - The renderer's report (`input.asciiForSearch(focused)`) goes to the controller per window (webContents
 *   id). A window that disappears is treated as having lost focus (switch back after the grace period).
 * - When the app goes to the background (`did-resign-active`, macOS), switch back without waiting for the grace period.
 * - On quit (`will-quit`, TODO 932), switch back at once and close the helper's stdin (the helper also
 *   restores on EOF before exiting).
 *
 * **TODO 675 (investigating why 463 does not work on the real machine)**: log at info the setting value at
 * launch, the resolved path of the helper and whether it exists, and the focus reports that arrived from the
 * renderer (no fix; logs only, to track down the cause).
 */
import { app, ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc.js'
import { log } from '../../common/logger.js'
import type { AppSettingsStore } from '../../common/settings.js'
import { AsciiInputController } from './controller.js'
import { InputSourceHelper } from './helper.js'
import { AsciiInputPreference } from './preference.js'

export function registerAsciiInput(
  settings: AppSettingsStore,
  helperPath: string,
  /** Called after the setting changes (TODO 1060 stage 3: keeps an open settings screen in sync). */
  onSettingChanged: () => void = () => undefined
): AsciiInputPreference {
  const helper = new InputSourceHelper({ helperPath })
  // TODO 675 (investigating why 463 does not work on the real machine): even when the setting is OFF, make the path resolution itself visible.
  helper.logResolvedPath()
  // `enabled` is read at call time (the preference is created right after).
  const active = new AsciiInputController({ helper, enabled: () => preference.get() })
  const preference = new AsciiInputPreference(settings, (enabled) => {
    log.info('input.helper.settingChanged', { enabled })
    if (enabled) helper.warm()
    active.settingChanged(enabled)
    onSettingChanged()
  })
  // TODO 675: one line with the setting value at launch.
  log.info('input.helper.setting', { enabled: preference.get() })
  if (preference.get()) helper.warm()

  const watched = new Set<number>()
  ipcMain.on(IpcChannel.inputAsciiForSearch, (event, focused: unknown) => {
    const sender = event.sender
    const id = sender.id
    if (!watched.has(id)) {
      watched.add(id)
      sender.once('destroyed', () => {
        watched.delete(id)
        active.dropSource(id)
      })
      // TODO 932: on a reload (main-frame navigation) the renderer sends nothing, so the focus record stays and
      // `restore` is never sent. Treat a navigation as focus having been lost (if the field is still focused, the
      // renderer reports again after loading).
      sender.on('did-navigate', () => active.dropSource(id))
    }
    // TODO 675: whether the renderer's focus reports reach main (about one line per focus in/out).
    log.info('input.helper.focusReport', { windowId: id, focused: focused === true })
    active.report(id, focused === true)
  })
  ipcMain.handle(IpcChannel.inputAsciiGet, () => preference.get())
  ipcMain.handle(IpcChannel.inputAsciiSet, (_event, enabled: unknown) =>
    typeof enabled === 'boolean' ? preference.set(enabled) : preference.get()
  )

  app.on('did-resign-active', () => active.deactivate())
  // TODO 932: `will-quit`, not `before-quit`. `before-quit` also fires when the quit is cancelled by
  // `preventDefault()` (a "save?" cancel, or during a reload), after which ASCII switching would never happen
  // again. `will-quit` fires only after the quit is decided and all windows are closed. It does not fire on
  // `app.exit()`, but the helper also restores when its parent dies (EOF on stdin).
  app.on('will-quit', () => {
    active.dispose()
    helper.dispose()
  })
  return preference
}
