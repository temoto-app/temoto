/**
 * IPC for the font of Gmail drafts (TODO 1229). Values coming from the renderer are checked with `isGmailDraftFont`; an unknown value is not saved and the current value is returned.
 * After a change, `onChanged` is called so that open settings screens (all windows) can re-read.
 */
import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc.js'
import { isGmailDraftFont } from '@shared/gmail-draft-font.js'
import type { GmailDraftFontPreference } from './gmail-draft-font.js'

export function registerGmailDraftFontHandlers(preference: GmailDraftFontPreference, onChanged: () => void): void {
  ipcMain.handle(IpcChannel.gmailDraftFontGet, () => preference.get())
  ipcMain.handle(IpcChannel.gmailDraftFontSet, (_event, font: unknown) => {
    if (!isGmailDraftFont(font)) return preference.get()
    const saved = preference.set(font)
    onChanged()
    return saved
  })
}
