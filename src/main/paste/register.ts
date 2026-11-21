/**
 * IPC for the clipboard image (item 319). Kept separate from `handlers.ts` (so as not to touch the same place as parallel bundles -
 * the same practice as voice input's `voice/register.ts`). No value is received from the renderer.
 */
import { BrowserWindow, clipboard, ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc.js'
import type { AttachmentResolution } from '@shared/thread.js'
import { MAX_ATTACHMENT_BYTES } from '../session/manager.js'
import { readClipboardImage } from './clipboard-image.js'
import type { AppSettingsStore } from '../../common/settings.js'
import { CAPTURE_HEADSUP_SHOWN } from '../../common/settings-keys.js'
import { captureScreenRegion, createCaptureHeadsUp, execScreencapture } from './screen-capture.js'
import { hostPlatform } from '../../common/os/platform.js'
import { screenAccessStatus } from '../os/electron.js'

export function registerPasteImageHandler(settings: AppSettingsStore | null = null): void {
  ipcMain.handle(
    IpcChannel.pasteImage,
    (): Promise<AttachmentResolution> => readClipboardImage(clipboard, MAX_ATTACHMENT_BYTES)
  )

  // TODO 1064: the notice before the first capture. The "shown" marker is written here (if there is no setting, it is not shown every time = false).
  // It is not written on a query. It is written only when the confirm arrives, after the renderer has shown the band and given time to read.
  const headsUp = createCaptureHeadsUp(
    settings === null
      ? null
      : {
          shown: () => settings.readTyped(CAPTURE_HEADSUP_SHOWN),
          markShown: () => settings.writeTyped(CAPTURE_HEADSUP_SHOWN, true)
        },
    hostPlatform(),
    screenAccessStatus
  )
  ipcMain.handle(IpcChannel.pasteCaptureHeadsUp, (): boolean => headsUp.query())
  ipcMain.handle(IpcChannel.pasteCaptureHeadsUpShown, (): void => headsUp.confirm())

  // TODO 957: capture part of the screen and attach it. From the renderer only the boolean for Opt is accepted (arguments and environment are fixed in screen-capture.ts).
  ipcMain.handle(
    IpcChannel.pasteCapture,
    (event, keepWindows: unknown): Promise<AttachmentResolution> =>
      captureScreenRegion(
        {
          platform: hostPlatform(),
          screenAccess: screenAccessStatus,
          hideWindows: () => {
            const origin = BrowserWindow.fromWebContents(event.sender)
            const hidden = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible())
            for (const w of hidden) w.hide()
            return () => {
              for (const w of hidden) if (!w.isDestroyed()) w.show()
              if (origin !== null && !origin.isDestroyed()) origin.focus()
            }
          },
          run: execScreencapture,
          wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        },
        { keepWindows: keepWindows === true },
        MAX_ATTACHMENT_BYTES
      )
  )
}
