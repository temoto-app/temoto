/**
 * Open in an external editor (item 115, difference #10 from VS Code).
 *
 * aios does not aim to be an IDE (owner decision 2026-09-26): it only puts "open in editor" on the viewer, search hits and
 * a thread's cwd; the default is VS Code, and settings can switch it to
 * Cursor / Zed.
 *
 * **How to launch (binary names, building arguments with a line number) is not placed here.**
 * It is an implementation detail only main needs to know, and it is in
 * `src/main/editor/launcher.ts` (not `compat/`: it is aios's own setting, unrelated to the CLI). What is placed here is
 * only the renderer's choices (id and display name) and the types and validation used by both main and the renderer.
 */

export type EditorId = 'vscode' | 'cursor' | 'zed'

export const EDITOR_IDS: readonly EditorId[] = ['vscode', 'cursor', 'zed']

/** Display names shown in the settings screen's `<select>`. Proper nouns, so they are not put in the dictionary (same treatment as the version names of T91/92). */
export const EDITOR_LABELS: Readonly<Record<EditorId, string>> = {
  vscode: 'VS Code',
  cursor: 'Cursor',
  zed: 'Zed'
}

export const DEFAULT_EDITOR_ID: EditorId = 'vscode'

export function isEditorId(value: unknown): value is EditorId {
  return typeof value === 'string' && (EDITOR_IDS as readonly string[]).includes(value)
}

/**
 * Options passed to `editor.open`. `line` is a 1-based line number (null if none), and
 * `asDirectory` is true when the target is a directory, as when opening a thread's cwd
 * (the line number is ignored).
 */
export interface EditorOpenOptions {
  readonly line?: number | null
  readonly asDirectory?: boolean
}
