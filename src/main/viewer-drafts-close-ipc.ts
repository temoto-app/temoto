/**
 * Connect the viewer's unsaved drafts (TODO 606) at quit, window close, and window reload (TODO 636) to electron. The decisions and round trips are in `viewer-drafts-close.ts`
 * (independent of electron). This file holds only the receiver of the IPC replies and the native dialog (`dialog.showMessageBox`, wording in
 * `i18n-native.ts`).
 */
import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { IpcChannel, IpcEvent } from '@shared/ipc.js'
import type { AutoSaveMode } from '@shared/auto-save.js'
import type { Locale } from '@shared/locale.js'
import { uriBasename } from '@shared/uri.js'
import type { ViewerDraftEntry } from '@shared/viewer-drafts-close.js'
import { nativeFormat, nativeText } from './i18n-native.js'
import {
  listedNames,
  settleAllViewerDrafts,
  settleViewerDrafts,
  unsavedDialogKeys,
  ViewerDraftsRequests,
  type CloseVerdict,
  type SaveChoice,
  type SettlePurpose,
  type UnsavedChoice,
  type ViewerDraftsCloseDeps
} from './viewer-drafts-close.js'

export interface ViewerDraftsCloseWiring {
  readonly mode: () => AutoSaveMode
  readonly hasDrafts: (viewId: number) => boolean
  readonly locale: () => Locale
  /** `webContents.id` -> window (null if closed). */
  readonly windowOf: (viewId: number) => BrowserWindow | null
}

export interface ViewerDraftsCloser {
  /** Whether this window may be closed (finish writing or ask if needed). */
  settleWindow(window: BrowserWindow): Promise<CloseVerdict>
  /** Whether this window may be reloaded (TODO 636. The decision is the same as for closing; only the "could not save" wording differs). */
  settleReload(window: BrowserWindow): Promise<CloseVerdict>
  /** Before quit, all windows in turn. */
  settleAll(windows: readonly BrowserWindow[]): Promise<CloseVerdict>
  /** Whether any window has unsaved drafts (if none, quit and close are not held up, as before). */
  needsSettle(windows: readonly BrowserWindow[]): boolean
  /** The window closed or reloaded: finish the requests to that window. */
  forget(viewId: number): void
}

/** The dialog body: list the file names, then the explanation at the end. */
function detailOf(locale: Locale, entries: readonly ViewerDraftEntry[], tail: string): string {
  if (entries.length <= 1) return tail
  const { names, more } = listedNames(entries, uriBasename)
  const lines = [...names]
  if (more > 0) lines.push(nativeFormat(locale, 'dialog.more', { count: more }))
  return `${lines.join('\n')}\n\n${tail}`
}

/** Bring the window to the front before showing the dialog (so that, when several windows are open at quit, it is clear which window it is about). */
function bringToFront(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

export function registerViewerDraftsClose(wiring: ViewerDraftsCloseWiring): ViewerDraftsCloser {
  const requests = new ViewerDraftsRequests(IpcEvent.viewerDraftsRequest)
  ipcMain.handle(IpcChannel.viewerDraftsReply, (event, id: unknown, reply: unknown) => {
    requests.reply(event.sender.id, id, reply)
  })
  // TODO 606 (code-review): `save` was received (a signal to wait longer for the write to finish).
  ipcMain.handle(IpcChannel.viewerDraftsAck, (event, id: unknown, pending: unknown) => {
    requests.ack(event.sender.id, id, pending)
  })

  const depsFor = (purpose: SettlePurpose): ViewerDraftsCloseDeps => ({
    mode: wiring.mode,
    hasDrafts: wiring.hasDrafts,
    ask: (viewId, action) => {
      const window = wiring.windowOf(viewId)
      return requests.request(window === null || window.isDestroyed() ? null : window.webContents, action)
    },
    confirmSave: async (viewId, entries): Promise<SaveChoice> => {
      const window = wiring.windowOf(viewId)
      if (window === null || window.isDestroyed()) return 'discard'
      const locale = wiring.locale()
      bringToFront(window)
      const message =
        entries.length === 1
          ? nativeFormat(locale, 'dialog.saveDrafts.one', { name: uriBasename(entries[0]!.uri) })
          : nativeFormat(locale, 'dialog.saveDrafts.many', { count: entries.length })
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        message,
        detail: detailOf(locale, entries, nativeText(locale, 'dialog.saveDrafts.detail')),
        buttons: [
          nativeText(locale, 'dialog.saveDrafts.save'),
          nativeText(locale, 'dialog.saveDrafts.discard'),
          nativeText(locale, 'dialog.cancel')
        ],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      })
      return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel'
    },
    confirmUnsaved: async (viewId, entries): Promise<UnsavedChoice> => {
      const window = wiring.windowOf(viewId)
      if (window === null || window.isDestroyed()) return 'discard'
      const locale = wiring.locale()
      bringToFront(window)
      const message =
        entries.length === 1
          ? nativeFormat(locale, 'dialog.unsavedDrafts.one', { name: uriBasename(entries[0]!.uri) })
          : nativeFormat(locale, 'dialog.unsavedDrafts.many', { count: entries.length })
      // TODO 636: for a reload, "reload without saving".
      const keys = unsavedDialogKeys(purpose)
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        message,
        detail: detailOf(locale, entries, nativeText(locale, keys.detail)),
        // The default (Enter) is cancel — do not fall toward silently discarding.
        buttons: [nativeText(locale, 'dialog.cancel'), nativeText(locale, keys.discard)],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      return response === 1 ? 'discard' : 'cancel'
    }
  })
  const deps = depsFor('close')
  const reloadDeps = depsFor('reload')

  return {
    settleWindow: (window) =>
      window.isDestroyed() ? Promise.resolve('proceed') : settleViewerDrafts(window.webContents.id, deps),
    settleReload: (window) =>
      window.isDestroyed() ? Promise.resolve('proceed') : settleViewerDrafts(window.webContents.id, reloadDeps),
    settleAll: (windows) =>
      settleAllViewerDrafts(
        windows.filter((window) => !window.isDestroyed()).map((window) => window.webContents.id),
        deps
      ),
    needsSettle: (windows) =>
      windows.some((window) => !window.isDestroyed() && wiring.hasDrafts(window.webContents.id)),
    forget: (viewId) => requests.forget(viewId)
  }
}
