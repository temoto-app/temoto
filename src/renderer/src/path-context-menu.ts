/**
 * Items of the right-click menu (TODO 299). Shared in 3 places: a search result row (an fs hit), a file tree row, and
 * the viewer heading. Following the VS Code standard, the 4 items are "Open in editor / Copy path /
 * Reveal in Finder / New chat here" (not shown on file links in the timeline body
 * - owner decision, 299).
 *
 * - "Open in editor", "Copy path" and "Reveal in Finder" just call the same functions as `PathActions` / `OpenInEditorButton` of 289
 *   (no new entry point in main is added).
 * - For "New chat here", the cwd is the folder itself, or the parent folder for a file (the same creation route as 263,
 *   `newChatTargetForUri`). For a row where it cannot be created (the file system root), the item is not shown at all.
 * - This function is not pure (each item's `onSelect` calls the passed functions), but it depends on neither React nor the DOM,
 *   so tests can fake `deps`.
 * - TODO 1214 (owner decision 2026-11-12): only for files whose extension is in the table (`HOST_OPEN_DEFAULT_EXTENSIONS`: documents, images, videos, etc.),
 *   "Open in default app" is added at the top, so it sits as 2 rows with "Open in editor" (the single-button variant dispatches instead).
 */
import { fullPath } from '@shared/uri.js'
import { openRouteOf, opensInDefaultApp } from '@shared/open-default.js'
import type { EditorOpenOptions } from '@shared/editor.js'
import type { Platform } from '@shared/types.js'
import { newChatTargetForUri } from './file-tree.js'
import { revealLabelKey, writeClipboard } from './components/PathActions.js'
import type { Translate } from './i18n/index.js'
import type { SearchTarget } from './shortcuts.js'
import type { CodeNavAction } from '@shared/plugin.js'
import { gitRepositoryUri } from '@shared/plugin-git.js'

export interface ContextMenuItem {
  readonly key: string
  readonly label: string
  readonly onSelect: () => void
  /** The key notation shown faintly on the right (TODO 692, `F12`). Omitted = none. */
  readonly shortcut?: string
  /** A description shown faintly on the right (TODO 1018: "continue in a new thread" in the Model menu). Omitted = none. */
  readonly hint?: string
  /** A gray row that cannot be chosen (TODO 769: a model not usable in the current version). Click and Enter do nothing. */
  readonly disabled?: boolean
  /** The row currently selected (TODO 769: "Other" in Model). A ✓ is put at the front. */
  readonly checked?: boolean
}

export interface PathContextMenuDeps {
  readonly openInEditor: (uri: string) => Promise<boolean>
  /** Open in the OS default app (TODO 1214). Shown only on rows of files whose extension is in the table. */
  readonly openInDefaultApp: (uri: string) => Promise<boolean>
  readonly reveal: (uri: string, asDirectory: boolean) => Promise<boolean>
  readonly createThreadInFolder: (uri: string | null) => Promise<boolean>
  /** The default is `navigator.clipboard.writeText` (`writeClipboard`). Only tests replace it. */
  readonly copy?: (text: string) => Promise<boolean>
}

export function pathContextMenuItems(
  uri: string,
  asDirectory: boolean,
  t: Translate,
  platform: Platform | undefined,
  deps: PathContextMenuDeps
): readonly ContextMenuItem[] {
  const copy = deps.copy ?? writeClipboard
  const items: ContextMenuItem[] = [
    ...(!asDirectory && opensInDefaultApp(uri)
      ? [
          {
            key: 'open-default-app',
            label: t('path.openInDefaultApp'),
            onSelect: () => {
              void deps.openInDefaultApp(uri)
            }
          }
        ]
      : []),
    {
      key: 'open-editor',
      label: t('search.openInEditor'),
      onSelect: () => {
        void deps.openInEditor(uri)
      }
    },
    {
      key: 'copy-path',
      label: t('path.copy'),
      onSelect: () => {
        void copy(fullPath(uri))
      }
    },
    {
      key: 'reveal',
      label: t(revealLabelKey(platform)),
      onSelect: () => {
        void deps.reveal(uri, asDirectory)
      }
    }
  ]
  const chatTarget = newChatTargetForUri(uri, asDirectory)
  if (chatTarget !== null) {
    items.push({
      key: 'new-chat',
      label: t('contextMenu.newChatHere'),
      onSelect: () => {
        void deps.createThreadInFolder(chatTarget)
      }
    })
  }
  return items
}

/**
 * The key of the label for the single "Open" button (TODO 1214). If the dispatch target (`openRouteOf`) is the default app, "Open in default app";
 * if it is the editor, the caller's "Open in editor" key (the viewer heading / a search hit).
 */
export function openButtonLabelKey(
  uri: string,
  options: EditorOpenOptions,
  editorKey: 'viewer.openInEditor' | 'search.openInEditor'
): 'path.openInDefaultApp' | 'viewer.openInEditor' | 'search.openInEditor' {
  return openRouteOf(uri, options) === 'default-app' ? 'path.openInDefaultApp' : editorKey
}

/**
 * "Search in this folder…" added to the right-click on a folder row of the file tree (TODO 437, the same place as VS Code's
 * Explorer "Find in Folder…"). `run` is passed the same `openSearchInFolder` as the 🔎 shown on row hover (two entrances, one route).
 */
export function searchInFolderMenuItem(
  uri: string,
  t: Translate,
  run: (uri: string) => void
): ContextMenuItem {
  return { key: 'search-in-folder', label: t('files.searchInFolder'), onSelect: () => run(uri) }
}

/**
 * "Open in Source Control" on a folder row of the file tree (TODO 834 stage 1). Opens the folder as an `aios-git:` URI, which main resolves to the
 * git extension's viewer and grants that folder to it (`ViewerBroker.open`). Shown only while an enabled extension declares the read-only git capability.
 * null if the URI is not a `file:` URI.
 */
export function sourceControlMenuItem(
  uri: string,
  t: Translate,
  open: (uri: string) => void
): ContextMenuItem | null {
  const target = gitRepositoryUri(uri)
  if (target === null) return null
  return { key: 'open-source-control', label: t('files.openSourceControl'), onSelect: () => open(target) }
}

/** Whether some enabled extension can show the Source Control view (it declares the read-only git capability, TODO 834). */
export function hasSourceControlExtension(list: readonly { readonly enabled: boolean; readonly capabilities: readonly string[] }[] | null): boolean {
  return (list ?? []).some((plugin) => plugin.enabled && plugin.capabilities.includes('git'))
}

/** Upper bound on the length `selectionSearchQueryOf` shortens to (in characters, a surrogate pair counts as 1, TODO 630). */
export const SELECTION_SEARCH_MAX = 60

/**
 * Build a search term from the selected text (TODO 630). For several lines, the first non-empty line; a long line is cut at the limit
 * (`truncated` if cut). A whitespace-only selection gives null. Built the same way as `provisionalTitle` (composer-drafts.ts).
 */
export function selectionSearchQueryOf(
  text: string,
  max = SELECTION_SEARCH_MAX
): { readonly query: string; readonly truncated: boolean } | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (line === '') continue
    const chars = Array.from(line)
    return chars.length > max
      ? { query: chars.slice(0, max).join(''), truncated: true }
      : { query: line, truncated: false }
  }
  return null
}

const SELECTION_SEARCH_LABELS = {
  files: 'viewer.contextMenu.searchFiles',
  names: 'viewer.contextMenu.searchNames',
  conversation: 'viewer.contextMenu.searchConversations'
} as const

/**
 * The 3 search items added to the right-click on selected text (TODO 1030, widening TODO 630's single item. Listed directly, not as a submenu):
 * body search / file-name search / conversation search. What is passed to `run` is the field kind and the shortened term itself (no display ellipsis is added).
 * `keyLabel` is the key notation of each field (null = none shown). If the selection is whitespace only, an empty array (no items shown).
 */
export function selectionSearchMenuItems(
  text: string,
  t: Translate,
  run: (target: SearchTarget, query: string) => void,
  keyLabel: (target: SearchTarget) => string | null = () => null
): readonly ContextMenuItem[] {
  const found = selectionSearchQueryOf(text)
  if (found === null) return []
  const shown = found.truncated ? `${found.query}…` : found.query
  return (['files', 'names', 'conversation'] as const).map((target) => {
    const shortcut = keyLabel(target)
    return {
      key: `search-selection-${target}`,
      label: t(SELECTION_SEARCH_LABELS[target], { query: shown }),
      onSelect: () => run(target, found.query),
      ...(shortcut === null ? {} : { shortcut })
    }
  })
}

/**
 * Right-click on a selection in the ThreadPane (the conversation body) (TODO 1030). The custom menu hides the default "Copy",
 * so "Copy" is put first (the same order as VS Code's editor menu). If the selection is empty (even whitespace only), an empty array =
 * the caller shows no menu and leaves it to the default behavior. What `copy` writes is the selection itself (not shortened).
 */
export function threadSelectionMenuItems(
  text: string,
  t: Translate,
  copy: (text: string) => void,
  run: (target: SearchTarget, query: string) => void,
  keyLabel?: (target: SearchTarget) => string | null
): readonly ContextMenuItem[] {
  const searches = selectionSearchMenuItems(text, t, run, keyLabel)
  if (searches.length === 0) return []
  return [{ key: 'copy-selection', label: t('contextMenu.copy'), onSelect: () => copy(text) }, ...searches]
}

/**
 * "Rename…" added only to the right-click on a file tree row (TODO 1145, the same as VS Code's Explorer).
 * Type the name in the in-row input field, Enter confirms and Esc cancels. The key is F2 (when the tree has focus).
 */
export function renameMenuItem(t: Translate, start: () => void): ContextMenuItem {
  return { key: 'rename', label: t('files.rename'), onSelect: start, shortcut: 'F2' }
}

/**
 * "Go to declaration" and "List assignments and uses" added to the right-click on a name in the code viewer (TODO 692, within the file only).
 * `keyLabel` is the notation of the active key (null if it is unbound, and then no notation is added). When chosen, ask the viewer via `run`
 * (the analysis is inside the viewer, `plugins/_shared/code-nav.ts`). As in VS Code's editor menu, placed before the search items.
 */
export function codeNavMenuItems(
  t: Translate,
  keyLabel: (action: CodeNavAction) => string | null,
  run: (action: CodeNavAction) => void
): readonly ContextMenuItem[] {
  const item = (action: CodeNavAction, key: string, label: string): ContextMenuItem => {
    const shortcut = keyLabel(action)
    return { key, label, onSelect: () => run(action), ...(shortcut === null ? {} : { shortcut }) }
  }
  return [
    item('declaration', 'go-to-declaration', t('viewer.contextMenu.goToDeclaration')),
    item('references', 'list-references', t('viewer.contextMenu.listReferences'))
  ]
}

/**
 * "New file… / New folder…" added only to the right-click on a file tree row (TODO 370, the same as the top of VS Code's
 * Explorer menu). Where to create (inside it for a folder row, the parent for a file row) is decided by the caller.
 * Not shown for search results or the viewer heading (VS Code also has it only in the Explorer).
 */
export function newEntryMenuItems(
  t: Translate,
  start: (kind: 'file' | 'folder') => void
): readonly ContextMenuItem[] {
  return [
    { key: 'new-file', label: t('files.newFile'), onSelect: () => start('file') },
    { key: 'new-folder', label: t('files.newFolder'), onSelect: () => start('folder') }
  ]
}
