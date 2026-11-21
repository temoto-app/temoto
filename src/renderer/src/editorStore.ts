/**
 * Open in an external editor (ARCHITECTURE.md 5 "Open in external editor", item 115).
 *
 * **The source is in one place, main** (same shape as theme / language). Both the saved value and the default (VS Code) are held by main.
 * This file only chooses and passes. For `open`, main revalidates the URI (`FsAccess.assertAllowed`)
 * before launching, so no validation is needed on the renderer side.
 *
 * TODO 1214: the single "Open" button is `openFile`, which routes by extension (`openRouteOf`: extensions in the table go to the OS default app,
 * text types, folders, and anything with a line number go to the chosen editor). The right-click menu calls `open` (editor) and `openDefault` (default app)
 * as separate rows. main does not trust the routing and rechecks with the same table.
 */
import { create } from 'zustand'
import { DEFAULT_EDITOR_ID, type EditorId, type EditorOpenOptions } from '@shared/editor.js'
import { openRouteOf } from '@shared/open-default.js'

interface EditorStore {
  readonly id: EditorId
  init(): Promise<void>
  setId(id: EditorId): Promise<void>
  /** Open with the editor chosen in settings (right-click "Open in editor", working folder, with a line number). */
  open(uri: string, options?: EditorOpenOptions): Promise<boolean>
  /** Open with the OS default app (right-click "Open with default app", TODO 1214). If it cannot open, main falls back to the editor. */
  openDefault(uri: string): Promise<boolean>
  /** The single "Open" button (TODO 1214): routes to the default app / editor by extension. */
  openFile(uri: string, options?: EditorOpenOptions): Promise<boolean>
}

export const useEditor = create<EditorStore>((set) => ({
  id: DEFAULT_EDITOR_ID,

  async init(): Promise<void> {
    const id = await window.aios.editor.get()
    set({ id })
  },

  async setId(id: EditorId): Promise<void> {
    const saved = await window.aios.editor.set(id)
    set({ id: saved })
  },

  open(uri, options): Promise<boolean> {
    return window.aios.editor.open(uri, options)
  },

  openDefault(uri): Promise<boolean> {
    return window.aios.editor.openInDefaultApp(uri)
  },

  openFile(uri, options): Promise<boolean> {
    return openRouteOf(uri, options) === 'default-app'
      ? window.aios.editor.openInDefaultApp(uri)
      : window.aios.editor.open(uri, options)
  }
}))
