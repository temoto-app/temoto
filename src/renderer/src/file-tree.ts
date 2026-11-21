/**
 * Pure functions around the rows of the file tree (the sidebar's "Files") (items 263 / 264, wave 15 bundle C).
 * They depend on neither React nor the store (`test/file-tree.test.ts`).
 *
 * - **The row's "new chat here"** (263): for a folder, that folder is the cwd; for a file, its parent folder.
 * - **auto reveal** (264, VS Code's `explorer.autoReveal`): open the ancestors of the file opened in the viewer,
 *   and scroll if the row is not visible.
 */
import { isReadOnlyShortcut, isUnindexedShortcut, type FileEntry, type FolderShortcut } from '@shared/types.js'
import { isAppBundle } from '@shared/app-bundle.js'
import type { MessageKey } from './i18n/index.js'
import { uriBasename, uriDirname } from '@shared/uri.js'
import { checkNewEntryName, checkRenameName, type NewEntryKind } from '@shared/new-entry.js'
import type { ReasonCode, ReasonParams } from '@shared/reason.js'

/** The file system root itself is not made a cwd (too broad as a working folder). */
const FILESYSTEM_ROOT = 'file:///'

/**
 * The URI that a row's "new chat" uses as cwd. Null for a row that cannot make one (parent unknown, or the root).
 *
 * Locations that hit an exclusion (under the backend's credentials location, etc.) are **not checked here**: excluded places do not enter the index and
 * appear neither in the tree nor in search results, so a visible row is outside the exclusions. main's `createThread`
 * checks again, so the renderer does not need to know (12.7, constraint 2).
 */
export function newChatTarget(
  entry: Pick<FileEntry, 'uri' | 'parentUri' | 'isDirectory'>
): string | null {
  const target = entry.isDirectory ? entry.uri : entry.parentUri
  if (target === null || target === FILESYSTEM_ROOT) return null
  return target
}

/**
 * The version of `newChatTarget` for callers that do not have `parentUri` (search result rows, the viewer's heading,
 * TODO 299). For a file the parent is found with `uriDirname` (tree rows use the indexed `parentUri`
 * as it is, so this version is not used for them; so that the two paths do not drift in how they find the parent, both
 * share only the same "null if root" rule).
 */
export function newChatTargetForUri(uri: string, isDirectory: boolean): string | null {
  const target = isDirectory ? uri : uriDirname(uri)
  if (target === null || target === FILESYSTEM_ROOT) return null
  return target
}

/** The folder name put in the title of a row's "new chat" (the last element of the cwd). */
export function newChatFolderName(target: string): string {
  return uriBasename(target)
}

/**
 * Whether to sync the tree to the selected file (auto reveal). While the list of file-name search results is showing, it does not
 * sync (the tree is not visible; `FileMode` syncs again when leaving the search).
 */
export function shouldAutoReveal(uri: string | null, searching: boolean): uri is string {
  return uri !== null && !searching
}

/**
 * Whether row `index` is **entirely** visible within scroll position `scrollTop` and visible height `viewport`.
 * If visible, auto reveal does not scroll (so it does not jump when a row is pressed to open it).
 */
export function rowInView(
  index: number,
  rowHeight: number,
  scrollTop: number,
  viewport: number
): boolean {
  if (viewport <= 0) return false
  const top = index * rowHeight
  return top >= scrollTop && top + rowHeight <= scrollTop + viewport
}

// ---- Truncating folders over 10 entries (TODO 904, wave 47 bundle C) ----

/** Number shown first in one folder (owner decision 2026-10-20: fixed at 10). Beyond that, "… N more". */
export const TREE_CHILD_LIMIT = 10

/** Of the children in sort order, the part shown now. All of them for `all`, or if not over the limit. */
export function limitChildren<T>(children: readonly T[], all: boolean): readonly T[] {
  return all || children.length <= TREE_CHILD_LIMIT ? children : children.slice(0, TREE_CHILD_LIMIT)
}

/** A `FileEntry` that is only for appearance for the "… N more" row (matches no URI; marks the parent's URI). */
export function moreRowEntry(parentUri: string): FileEntry {
  return {
    uri: `${parentUri}#aios-more`,
    parentUri,
    name: '',
    isDirectory: false,
    size: 0,
    mtimeMs: 0,
    ext: ''
  }
}

/** The `TreeRow.key` of the "… N more" row (does not collide with the `treeRowKey` shape; URIs start with `file://`). */
export function moreRowKey(rootIndex: number, parentUri: string): string {
  return `${rootIndex}|more|${parentUri}`
}

/**
 * Of `chain` (the list of URIs from the root to the target row), the parents where the next element is listed beyond the first 10.
 * Unless these truncations are expanded, the target row does not appear in the tree (reveal cannot find the row).
 */
export function limitedAncestors(
  chain: readonly string[],
  children: Readonly<Record<string, readonly { readonly uri: string }[]>>
): string[] {
  const result: string[] = []
  for (let i = 0; i + 1 < chain.length; i += 1) {
    const parent = chain[i]
    const child = chain[i + 1]
    if (parent === undefined || child === undefined) continue
    const list = children[parent]
    if (list === undefined) continue
    if (list.findIndex((entry) => entry.uri === child) >= TREE_CHILD_LIMIT) result.push(parent)
  }
  return result
}

/**
 * The scroll target when syncing a folder (working folder) row (TODO 887). If the file open in the viewer is inside that folder
 * and the whole fits on the same screen even with the folder row at the very top, the folder row goes first (`start`). If it does not fit,
 * the file's row is centered (as before). If the file is not found (not shown in the tree, or before the folder) or the height is unknown,
 * the folder row is centered as before. The index is an index into `rows`.
 */
export function planFolderReveal(
  folderIndex: number,
  fileIndex: number,
  rowHeight: number,
  viewport: number
): { readonly index: number; readonly align: 'start' | 'center' } {
  const visibleRows = Math.floor(viewport / rowHeight)
  if (visibleRows <= 0 || fileIndex <= folderIndex) return { index: folderIndex, align: 'center' }
  return fileIndex - folderIndex < visibleRows
    ? { index: folderIndex, align: 'start' }
    : { index: fileIndex, align: 'center' }
}

/** The list of URIs that `reveal` expands. When syncing a file (auto), the last one, itself, is not included. */
export function expandChain(chain: readonly string[], auto: boolean): readonly string[] {
  return auto ? chain.slice(0, -1) : chain
}

/** The shape of a row that `treeKeyAction` reads (part of `TreeRow`). */
export interface TreeKeyRow {
  readonly depth: number
  readonly expanded: boolean
  /** `name` is used only to recognize an `.app` (TODO 562). If absent, it is treated as an ordinary folder. */
  readonly entry: { readonly isDirectory: boolean; readonly name?: string }
}

/**
 * The result of a tree key (TODO 356). `move` moves to a row (and for a file opens it in the viewer too: owner decision),
 * `expand` / `collapse` open / close that row's folder, and `activate` is the same as pressing the row
 * (open a file, toggle a folder).
 */
export type TreeKeyAction =
  | { readonly kind: 'move'; readonly index: number }
  | { readonly kind: 'expand'; readonly index: number }
  | { readonly kind: 'collapse'; readonly index: number }
  | { readonly kind: 'activate'; readonly index: number }

/**
 * The tree's left / right / Enter (the same as VS Code's explorer). Up / down / Home / End are handled by `listKeyStep`
 * (stopping at the ends), so they are not handled here (null).
 *
 * - Right: open a closed folder. For an open folder, go to the first child (do nothing if there are no children yet). Do nothing for files and `.app`.
 * - Left: close an open folder. Otherwise go to the parent row (do nothing at the top level).
 * - Enter: the same as pressing the row.
 */
export function treeKeyAction(
  key: string,
  rows: readonly TreeKeyRow[],
  index: number
): TreeKeyAction | null {
  const row = rows[index]
  if (row === undefined) return null
  switch (key) {
    case 'ArrowRight': {
      if (!row.entry.isDirectory) return null
      // An `.app` (TODO 562) is not opened (a row that shows no disclosure triangle).
      if (isAppBundle({ name: row.entry.name ?? '', isDirectory: true })) return null
      if (!row.expanded) return { kind: 'expand', index }
      const child = rows[index + 1]
      return child !== undefined && child.depth > row.depth ? { kind: 'move', index: index + 1 } : null
    }
    case 'ArrowLeft': {
      if (row.entry.isDirectory && row.expanded) return { kind: 'collapse', index }
      for (let i = index - 1; i >= 0; i -= 1) {
        const candidate = rows[i]
        if (candidate !== undefined && candidate.depth < row.depth) return { kind: 'move', index: i }
      }
      return null
    }
    case 'Enter':
      return { kind: 'activate', index }
    default:
      return null
  }
}

// ---- New file / folder (TODO 370, wave 20 bundle C) ----

/**
 * Which folder to create the "new file / folder" in (the same as VS Code): for a folder row, that folder;
 * for a file row, its parent. Null for a row whose parent is unknown.
 */
export function newEntryParent(
  entry: Pick<FileEntry, 'uri' | 'parentUri' | 'isDirectory'>
): string | null {
  return entry.isDirectory ? entry.uri : entry.parentUri
}

/** Name folding (APFS is case-insensitive by default; the same as main's `foldPath`). */
function foldName(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

/**
 * Per-keystroke check of the input box (a renderer-side preview). The name rules are the same `checkNewEntryName` as main, and in addition
 * it is matched against **the currently visible parent listing** (`siblings`) to report "already exists" and "a path component is a file" early.
 * main is authoritative (hidden files and anything outside the listing are main's to check). Null if there is no problem.
 */
export function newEntryProblem(
  raw: string,
  kind: NewEntryKind,
  siblings: readonly Pick<FileEntry, 'name' | 'isDirectory'>[]
): { readonly code: ReasonCode; readonly params?: ReasonParams } | null {
  const checked = checkNewEntryName(raw, kind)
  if (!checked.ok) return checked.params === undefined ? { code: checked.code } : { code: checked.code, params: checked.params }
  const first = checked.segments[0] as string
  const hit = siblings.find((sibling) => foldName(sibling.name) === foldName(first))
  if (hit === undefined) return null
  if (checked.segments.length === 1) return { code: 'create-exists', params: { name: hit.name } }
  return hit.isDirectory ? null : { code: 'create-not-directory', params: { name: hit.name } }
}

/**
 * Per-keystroke check of the rename input box (TODO 1145) (a renderer-side preview). The rules are the same `checkRenameName` as main,
 * and in addition it is matched against sibling names (other than itself) with case and normalization folded. main is authoritative. Null if there is no problem.
 */
export function renameProblem(
  raw: string,
  entry: Pick<FileEntry, 'uri'>,
  siblings: readonly Pick<FileEntry, 'uri' | 'name'>[]
): { readonly code: ReasonCode; readonly params?: ReasonParams } | null {
  const checked = checkRenameName(raw)
  if (!checked.ok) return checked.params === undefined ? { code: checked.code } : { code: checked.code, params: checked.params }
  const hit = siblings.find((s) => s.uri !== entry.uri && foldName(s.name) === foldName(checked.name))
  return hit === undefined ? null : { code: 'create-exists', params: { name: hit.name } }
}

export { replaceUriPrefix } from '@shared/uri.js'

/**
 * The list of folders to relist after creating: each folder from the parent up to one above what was created (`uri`)
 * (for `a/b/c.txt`: parent / parent/a / parent/a/b). Relisting only those with a cache (`children`) makes intermediate folders appear too.
 */
export function createdChain(parentUri: string, uri: string): readonly string[] {
  const base = parentUri.endsWith('/') ? parentUri.slice(0, -1) : parentUri
  if (!uri.startsWith(`${base}/`)) return [parentUri]
  const rest = uri.slice(base.length + 1).split('/')
  const out = [parentUri]
  let current = base
  for (const segment of rest.slice(0, -1)) {
    current = `${current}/${segment}`
    out.push(current)
  }
  return out
}

/**
 * Rows of the virtual list (after the input box is inserted) <-> rows of the tree. The input box takes one row at the `inputAt` position
 * (nothing is inserted if `inputAt` is null). `fromView` is null at the input box's position.
 */
export function toViewIndex(rowIndex: number, inputAt: number | null): number {
  return inputAt !== null && rowIndex >= inputAt ? rowIndex + 1 : rowIndex
}

export function fromViewIndex(viewIndex: number, inputAt: number | null): number | null {
  if (inputAt === null) return viewIndex
  if (viewIndex === inputAt) return null
  return viewIndex > inputAt ? viewIndex - 1 : viewIndex
}

// ---- TODO 520: shortcuts at the top of the Files tree ----

/** Shortcut kind -> display-name key (the same names as Finder). */
const SHORTCUT_LABEL_KEYS: Readonly<Record<FolderShortcut, MessageKey>> = {
  downloads: 'files.shortcut.downloads',
  desktop: 'files.shortcut.desktop',
  applications: 'files.shortcut.applications',
  movies: 'files.shortcut.movies',
  documents: 'files.shortcut.documents',
  trash: 'files.shortcut.trash',
  tmp: 'files.shortcut.tmp'
}

/** The name key shown in a row. For a shortcut root it is the display-name key; otherwise null (show the file name as it is). */
export function shortcutLabelKey(entry: Pick<FileEntry, 'shortcut'>): MessageKey | null {
  return entry.shortcut === undefined ? null : SHORTCUT_LABEL_KEYS[entry.shortcut]
}

/** The URI of the root of a shortcut that is not in the index (Trash / `/tmp`, TODO 561). Rows inside do not show "Search in this folder". */
export function unindexedRootUris(roots: readonly Pick<FileEntry, 'uri' | 'shortcut'>[]): readonly string[] {
  return roots.filter((root) => isUnindexedShortcut(root.shortcut)).map((root) => root.uri)
}

/** The URI of the root of a view-only shortcut (Trash). */
export function readOnlyRootUris(roots: readonly Pick<FileEntry, 'uri' | 'shortcut'>[]): readonly string[] {
  return roots.filter((root) => isReadOnlyShortcut(root.shortcut)).map((root) => root.uri)
}

/**
 * Whether `uri` is inside a view-only root (including itself). Such rows do not show create, search in this folder, new chat, or
 * drag to attach (main also refuses at the `'write'` choke point, but operations that would be refused are not offered).
 */
export function insideReadOnlyRoot(uri: string, readOnlyRoots: readonly string[]): boolean {
  return readOnlyRoots.some((root) => uri === root || uri.startsWith(root.endsWith('/') ? root : `${root}/`))
}

/** Whether this is a value in the `treeRowKey` shape (`<root index>|<URI>`) or the URI itself; returns the anchor's URI. */
export function anchorUri(anchor: string): string {
  if (anchor.startsWith('file:')) return anchor
  const bar = anchor.indexOf('|')
  return bar < 0 ? anchor : anchor.slice(bar + 1)
}

/**
 * Anchor at the tree's key position (`TreeRow.key` or a URI) -> row index. A shortcut appears twice with the same URI as inside `~/`,
 * so an anchor held as a row key maps to that row, and a URI anchor maps to the first row where it appears. -1 if none.
 */
export function findTreeIndex(
  rows: readonly { readonly key: string; readonly entry: { readonly uri: string } }[],
  anchor: string
): number {
  if (!anchor.startsWith('file:')) {
    const byKey = rows.findIndex((row) => row.key === anchor)
    if (byKey >= 0) return byKey
  }
  const uri = anchorUri(anchor)
  return rows.findIndex((row) => row.entry.uri === uri)
}
