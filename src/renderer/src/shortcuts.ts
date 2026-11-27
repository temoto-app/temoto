/**
 * App-wide keyboard shortcuts (ARCHITECTURE.md 5.5.2, TODO 46 / 48 / 189 / 195).
 *
 * What lives here is **only the key -> target table and the decision of how to open the sidebar**;
 * it knows neither the DOM nor React (the same convention as `composer-keys.ts` / `sidebarCollapse.ts`).
 * `App.tsx` attaches exactly one `keydown` to `window`, and when `searchShortcut` returns a
 * target, it does "switch to search mode + focus the matching field"
 * (`shortcut-actions.ts` drives that).
 *
 * **Assignments aligned with VS Code** (items 189 / 195, owner decision 2026-09-28):
 *
 * | Key (mac / other) | Action | Where it is picked up |
 * |---|---|---|
 * | ⌘P / Ctrl+P | file-name search | the renderer's keydown |
 * | ⌘⇧F / Ctrl+Shift+F | body search over all files | the renderer's keydown |
 * | ⌘F / Ctrl+F (inside the ThreadPane, including the Composer. TODO 496) | search within that thread (the floating search window) | the renderer's keydown (`appShortcut`) |
 * | ⌘F / Ctrl+F (outside the viewer and the ThreadPane) | body search (same as ⌘⇧F, item 189) | the renderer's keydown |
 * | ⌘F (inside the viewer) | search within that file (the editor) | the viewer itself |
 * | ⌘F / ⌘R (inside a web page, TODO 400) | in-page search / reload | main's `before-input-event` (`webViewShortcuts`) |
 * | ⌘K / Ctrl+K | conversation search | the renderer's keydown |
 * | ⌃⌘I / Ctrl+Alt+I | Threads | the menu accelerator |
 * | ⌘⇧E / Ctrl+Shift+E | Files | the menu accelerator |
 * | ⌘⇧X / Ctrl+Shift+X | Extensions (TODO 367) | the menu accelerator |
 * | ⌘, / Ctrl+, | Settings | the menu accelerator |
 * | ⌘B | collapse / open the sidebar | the menu accelerator |
 * | ⌘⇧O / Ctrl+Shift+O | new thread (TODO 408, the same key as ChatGPT) | the menu accelerator |
 * | ⌃- / Alt+← | viewer back (TODO 369) | the renderer's keydown + forwarding from the viewer |
 * | ⌃⇧- / Alt+→ | viewer forward (TODO 369) | the renderer's keydown + forwarding from the viewer |
 * | ⌘D / Ctrl+D (inside the viewer) | also select the next occurrence of the same word (multiple cursors, TODO 467) | the viewer itself (CodeMirror's `searchKeymap`) |
 * | ⌥-click / ⌥ + drag (inside the viewer) | add a cursor / rectangular selection (TODO 467) | the viewer itself (`editor-extras.ts`) |
 * | ⌘⌥[ / ⌘⌥] (Ctrl+Shift+[ / ]) (inside the viewer) | fold / unfold. Ctrl+Alt+[ / ] for all (TODO 467) | the viewer itself (`foldKeymap`) |
 * | ⌘R / Ctrl+R (inside the viewer) | symbol list within the file (TODO 468). The accelerator of the menu's "Reload" was removed | the viewer itself (`symbol-picker.ts`) |
 * | F12 / ⇧F12 (inside the code viewer) | go to declaration / list assignments and uses (TODO 692, within the file only). **Can be changed in the table** | the viewer itself (`code-nav.ts`). The host passes the keys as `editorKeys` (`viewerEditorKeys`) |
 * | ⌘T / ⌘L / ⌃Tab / ⌃⇧Tab (when the Web pane is in front) | new tab / go to the URL field / next and previous tab (TODO 531) | the renderer's keydown (`webTabShortcut`) + forwarding from the web page |
 * | ⌘W / Ctrl+W | close in the order Web tab -> viewer (closes the same way as ✕) -> the window if neither exists (TODO 531 / 843. Replaces role `close`) | the menu accelerator (`CLOSE_ITEM`) |
 *
 * **The modifier is `metaKey || ctrlKey`** (the same convention as ⌘S / Ctrl+S in `ViewerPane.tsx`).
 * It is not split by platform: Ctrl+F also works on mac (the owner uses Ctrl).
 * **If `Alt` is held, it is not picked up** (⌥ is a modifier that produces other characters, and nothing is assigned to it here).
 *
 * **Do not make the 3 searches (⌘P / ⌘⇧F / ⌘K) and ⌘F menu accelerators.**
 * An accelerator has electron take the key first, so putting ⌘F there would kill the search inside the viewer's editor.
 * ⌘⇧F / ⌘K / ⌘P do not collide with the viewer, but they are placed in the same keydown table as ⌘F, and from inside the viewer
 * the bridge forwards them using the same table (`viewerForwardedShortcuts`, item 189). The 3 modes
 * (⌘⇧E / ⌃⌘I / ⌘,) do not collide with CodeMirror's default keys, so they became accelerators:
 * that way they work even when the viewer (OOPIF) has focus (the table is `src/main/menu-model.ts`).
 *
 * **TODO 549 (wave 27 bundle E): which key it is comes from a single table in `src/shared/keybindings.ts` (command ID -> default key).**
 * Assignments the user changed in the settings screen enter here through `setKeybindings`, and the decisions (`searchShortcut` /
 * `appShortcut` / `isSaveShortcut` / `viewerNavShortcut`), the forwarding tables (`viewerForwardedShortcuts` /
 * `webViewShortcuts`) and the tooltip notation (`*KeyLabel`) all follow it. The table above is the **default** assignment.
 * Keys inside the viewer (CodeMirror) are out of scope (owner decision 2026-10-09). The exception is TODO 692's F12 / ⇧F12 (scope `viewer`,
 * passed to the viewer via `viewerEditorKeys`. Owner decision 2026-10-11).
 */

import type { WebViewShortcut } from '@shared/web-view.js'
import {
  VIEWER_KEYBINDING_COMMAND_IDS,
  displayKeybinding,
  effectiveKeybinding,
  isKeybindingModified,
  isPrimaryRow,
  keyRowsOf,
  matchesKeybinding,
  resolveKeybinding,
  type KeyRow,
  type KeybindingCommandId,
  type KeybindingOverrides,
  type ViewerKeybindingCommandId
} from '@shared/keybindings.js'
import { keyPlatformOf } from './composer-keys.js'

// ---------------------------------------------------------------------------
// User assignments (TODO 549)
// ---------------------------------------------------------------------------

let keybindingPlatform: ShortcutPlatform = keyPlatformOf(
  typeof navigator === 'undefined' ? '' : navigator.platform
)
let keybindingOverrides: KeybindingOverrides = {}
const keybindingListeners = new Set<() => void>()

/**
 * Replace the user's assignments (`keybindingStore.ts` in the renderer receives them from main and calls this. Tests call it too).
 * The forwarding tables (`viewerForwardedShortcuts` / `webViewShortcuts`) are built from the current assignments on every call, so the
 * parts that send a table call it at send time (TODO 589: before, this rewrote the array it had returned). `WebViewerPane`, which resends
 * the web page's table to main, learns of it via `onKeybindingsChanged`.
 */
export function setKeybindings(overrides: KeybindingOverrides, platform: ShortcutPlatform = keybindingPlatform): void {
  keybindingOverrides = overrides
  keybindingPlatform = platform
  for (const listener of keybindingListeners) listener()
}

/** The current assignments (settings screen, tests). */
export function currentKeybindings(): { readonly platform: ShortcutPlatform; readonly overrides: KeybindingOverrides } {
  return { platform: keybindingPlatform, overrides: keybindingOverrides }
}

/** Call when the assignments change. The return value removes the listener. */
export function onKeybindingsChanged(listener: () => void): () => void {
  keybindingListeners.add(listener)
  return () => {
    keybindingListeners.delete(listener)
  }
}

function bindingOf(id: KeybindingCommandId, platform: ShortcutPlatform): string | null {
  return effectiveKeybinding(id, platform, keybindingOverrides)
}

/**
 * A safety net so the renderer also picks up a menu accelerator command (e.g. `isToggleHiddenKey` for "Show hidden files").
 * If the user has not changed it, use the `legacy` check; if changed, match against the table's key (TODO 549).
 */
export function matchesCommandKey(
  id: KeybindingCommandId,
  event: ShortcutKey & { readonly code?: string },
  legacy: () => boolean
): boolean {
  if (event.isComposing) return false
  if (!isKeybindingModified(id, keybindingOverrides)) return legacy()
  const key = bindingOf(id, keybindingPlatform)
  return key !== null && matchesKeybinding(key, event, keybindingPlatform)
}

/** The tooltip notation of a command whose assignment was removed. */
const UNBOUND_LABEL = '—'

/** If the user changed it, that notation. If not, `legacy` (show the long-standing notation as is). */
function labelOf(id: KeybindingCommandId, platform: ShortcutPlatform, legacy: () => string): string {
  if (!isKeybindingModified(id, keybindingOverrides)) return legacy()
  const key = bindingOf(id, platform)
  return key === null ? UNBOUND_LABEL : displayKeybinding(key, platform)
}

/** The 3 search windows. One-to-one with the input fields of `SearchMode.tsx`. */
export type SearchTarget = 'files' | 'names' | 'conversation'

/** Only the parts of `KeyboardEvent` used for the decision. Tests can build it as a plain object. */
export interface ShortcutKey {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  /** Whether it fired during composition (IME). Keys during conversion are not picked up. */
  readonly isComposing: boolean
}

/**
 * Which search window this key points at. null if none.
 *
 * `key` arrives as `'F'` (uppercase) when Shift is held, so it is folded to lowercase before comparing.
 * ⌘F and ⌘⇧F both mean body search (item 189: ⌘F outside the viewer does the same as ⌘⇧F).
 * ⌘⇧P / ⌘⇧K have no assignment, so null (there is no feature corresponding to VS Code's command palette).
 */
export function searchShortcut(event: ShortcutKey): SearchTarget | null {
  const id = searchCommandOf(event)
  return id === null ? null : SEARCH_TARGET_OF[id]
}

/** The search commands the renderer's keydown picks up (the ids of the TODO 549 table). */
const SEARCH_COMMANDS = ['search.files', 'search.names', 'search.conversation', 'find'] as const
type SearchCommandId = (typeof SEARCH_COMMANDS)[number]

const SEARCH_TARGET_OF: Readonly<Record<SearchCommandId, SearchTarget>> = {
  'search.files': 'files',
  'search.names': 'names',
  'search.conversation': 'conversation',
  // ⌘F outside the ThreadPane is body search (item 189). Inside it, `appShortcut` makes it in-thread search.
  find: 'files'
}

function searchCommandOf(event: ShortcutKey): SearchCommandId | null {
  if (event.isComposing) return null
  return resolveKeybinding(event, SEARCH_COMMANDS, keybindingPlatform, keybindingOverrides)
}

/** Targets the renderer's keydown drives (TODO 496): the 3 search windows + in-thread search. */
export type AppShortcutTarget = SearchTarget | 'threadFind'

/**
 * The decision of the renderer's top-level keydown (TODO 496, owner decision 2026-10-06). Adds to `searchShortcut` "whether the ThreadPane
 * (including the Composer) currently has focus": ⌘F / Ctrl+F there (without Shift) is search within the thread.
 * As in VS Code, "⌘F inside the place, ⌘⇧F for everything"; ⌘⇧F stays body search from anywhere.
 *
 * The viewer's forwarding (`viewerForwardedShortcuts`) and the web view's table (`webViewShortcuts`) are built from `searchShortcut`,
 * so they do not change (the viewer / web page is outside the ThreadPane; ⌘F there is search inside the editor / page).
 */
export function appShortcut(event: ShortcutKey, context: { readonly inThreadPane: boolean }): AppShortcutTarget | null {
  const id = searchCommandOf(event)
  if (id === null) return null
  if (id === 'find' && context.inThreadPane) return 'threadFind'
  return SEARCH_TARGET_OF[id]
}

/** The key notation for in-thread search (attached to the 🔍 tooltip, TODO 496). */
export function threadFindKeyLabel(platform: ShortcutPlatform): string {
  return labelOf('find', platform, () => (platform === 'mac' ? '⌘F' : 'Ctrl+F'))
}

/** The shortcut id to have the viewer forward. `SearchTarget` is used as is. */
export function isSearchTarget(value: unknown): value is SearchTarget {
  return value === 'files' || value === 'names' || value === 'conversation'
}

/** The modifier convention (the same values as `KeyPlatform` in `composer-keys.ts`). */
export type ShortcutPlatform = 'mac' | 'other'

/**
 * The save key (⌘S / Ctrl+S, item 313). Saves the viewer's draft. As in VS Code, with Shift / Alt added it is
 * a different key (⌘⇧S has no assignment).
 */
export const SAVE_SHORTCUT_ID = 'save'

export function isSaveShortcut(event: ShortcutKey): boolean {
  if (event.isComposing) return false
  if (isKeybindingModified('file.save', keybindingOverrides)) {
    const key = bindingOf('file.save', keybindingPlatform)
    return key !== null && matchesKeybinding(key, event, keybindingPlatform, true)
  }
  if (!(event.metaKey || event.ctrlKey)) return false
  if (event.altKey || event.shiftKey) return false
  return event.key === 's' || event.key === 'S'
}

/**
 * The ids for the viewer's back / forward (TODO 369, wave 20 bundle D). The keys, the mouse back / forward buttons, forwarding from the viewer, and
 * main's gesture (`MenuCommand`) all use the same names.
 */
export type ViewerNavId = 'viewerBack' | 'viewerForward'

export function isViewerNavId(value: unknown): value is ViewerNavId {
  return value === 'viewerBack' || value === 'viewerForward'
}

/**
 * The back / forward keys (TODO 369). Aligned with VS Code's Go Back / Go Forward:
 *
 * - **mac: ⌃- / ⌃⇧-**. ⌘- is "View" zoom out (role `zoomOut`, `CmdOrCtrl+-`), so only Ctrl.
 *   On a US layout ⌃⇧- arrives with `key` as `_`, and on a JIS layout as `=`, so both are picked up (if `code` is present, check it as `Minus`).
 * - **Other: Alt+← / Alt+→** (VS Code's Windows / Linux). Ctrl+- is eaten by the zoom-out accelerator.
 *
 * Not picked up during IME composition.
 */
export function viewerNavShortcut(
  event: ShortcutKey & { readonly code?: string },
  platform: ShortcutPlatform
): ViewerNavId | null {
  if (event.isComposing) return null
  // What the user changed is matched against the table (TODO 549). The unchanged side uses the long-standing check below (the JIS ⌃⇧-, etc.).
  for (const [id, command] of VIEWER_NAV_COMMANDS) {
    if (!isKeybindingModified(command, keybindingOverrides)) continue
    const key = bindingOf(command, platform)
    if (key !== null && matchesKeybinding(key, event, platform, true)) return id
  }
  const legacy = legacyViewerNav(event, platform)
  if (legacy === null) return null
  return isKeybindingModified(VIEWER_NAV_COMMAND_OF[legacy], keybindingOverrides) ? null : legacy
}

const VIEWER_NAV_COMMAND_OF: Readonly<Record<ViewerNavId, KeybindingCommandId>> = {
  viewerBack: 'viewer.back',
  viewerForward: 'viewer.forward'
}
const VIEWER_NAV_COMMANDS = Object.entries(VIEWER_NAV_COMMAND_OF) as readonly (readonly [ViewerNavId, KeybindingCommandId])[]

function legacyViewerNav(event: ShortcutKey & { readonly code?: string }, platform: ShortcutPlatform): ViewerNavId | null {
  if (platform === 'mac') {
    if (!event.ctrlKey || event.metaKey || event.altKey) return null
    const minus = event.code === 'Minus' || event.key === '-' || event.key === '_' || event.key === '='
    if (!minus) return null
    if (!event.shiftKey) return event.key === '-' || event.code === 'Minus' ? 'viewerBack' : null
    return 'viewerForward'
  }
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null
  if (event.key === 'ArrowLeft') return 'viewerBack'
  if (event.key === 'ArrowRight') return 'viewerForward'
  return null
}

/** The key notation attached to the heading button's tooltip (TODO 369). */
export function viewerNavKeyLabel(id: ViewerNavId, platform: ShortcutPlatform): string {
  return labelOf(VIEWER_NAV_COMMAND_OF[id], platform, () => {
    if (platform === 'mac') return id === 'viewerBack' ? '⌃-' : '⌃⇧-'
    return id === 'viewerBack' ? 'Alt+←' : 'Alt+→'
  })
}

/**
 * The mouse back / forward buttons (3 / 4 of `MouseEvent.button`, TODO 369). Picked up **on mac only**: on Windows / Linux
 * main's `app-command` (`browser-backward` / `browser-forward`) delivers the same buttons, so picking up both would move 2 steps.
 */
export function viewerNavMouseButton(button: number, platform: ShortcutPlatform): ViewerNavId | null {
  if (platform !== 'mac') return null
  if (button === 3) return 'viewerBack'
  if (button === 4) return 'viewerForward'
  return null
}

/**
 * The keys for aios-wide back / forward (TODO 801). A different id and assignment from the viewer's back / forward (`ViewerNavId`)
 * (⌘[ / ⌘] on mac, Alt+Shift+← / → elsewhere). Matches the table key using only the modifiers exactly as pressed.
 * Not forwarded from the viewer (OOPIF): CodeMirror's `Mod-[` / `Mod-]` indent and outdent, so they cannot be taken.
 */
export type GlobalNavId = 'navBack' | 'navForward'

const GLOBAL_NAV_COMMAND_OF: Readonly<Record<GlobalNavId, KeybindingCommandId>> = {
  navBack: 'nav.back',
  navForward: 'nav.forward'
}

export function globalNavShortcut(event: ShortcutKey & { readonly code?: string }): GlobalNavId | null {
  if (event.isComposing) return null
  for (const [id, command] of Object.entries(GLOBAL_NAV_COMMAND_OF) as readonly (readonly [GlobalNavId, KeybindingCommandId])[]) {
    const key = bindingOf(command, keybindingPlatform)
    if (key !== null && matchesKeybinding(key, event, keybindingPlatform)) return id
  }
  return null
}

/** TODO 1327: the title bar's layout toggles (VS Code's Toggle Primary / Secondary Side Bar). */
export type LayoutToggleId = 'sidebar' | 'viewer'

const LAYOUT_TOGGLE_COMMAND_OF: Readonly<Record<LayoutToggleId, KeybindingCommandId>> = {
  sidebar: 'view.toggleSidebar',
  viewer: 'view.toggleViewer'
}

/** The key notation in the layout toggle's tooltip (the menu accelerator, after the user's assignment). */
export function layoutToggleKeyLabel(id: LayoutToggleId, platform: ShortcutPlatform): string {
  const key = bindingOf(LAYOUT_TOGGLE_COMMAND_OF[id], platform)
  return key === null ? UNBOUND_LABEL : displayKeybinding(key, platform)
}

/** The key notation attached to the titlebar button's tooltip (TODO 801). */
export function globalNavKeyLabel(id: GlobalNavId, platform: ShortcutPlatform): string {
  return labelOf(GLOBAL_NAV_COMMAND_OF[id], platform, () => {
    if (platform === 'mac') return id === 'navBack' ? '⌘[' : '⌘]'
    return id === 'navBack' ? 'Alt+Shift+←' : 'Alt+Shift+→'
  })
}

/**
 * Start / stop dictation (TODO 1268). Called from the Composer input field's keydown, so it only works while that field has focus.
 * Matches the modifiers exactly as pressed (mac's Ctrl+D stays emacs-style delete forward). false if the assignment was removed.
 */
export function isDictateShortcut(event: ShortcutKey): boolean {
  if (event.isComposing) return false
  const key = bindingOf('composer.dictate', keybindingPlatform)
  return key !== null && matchesKeybinding(key, event, keybindingPlatform)
}

/** The key notation of the dictation shortcut (attached to the microphone's tooltip). null if removed. */
export function dictateKeyLabel(platform: ShortcutPlatform): string | null {
  const key = bindingOf('composer.dictate', platform)
  return key === null ? null : displayKeybinding(key, platform)
}

/** The ids of keys the viewer has forwarded (the 3 searches + save + back / forward). */
export type ForwardedShortcutId = SearchTarget | typeof SAVE_SHORTCUT_ID | ViewerNavId | 'webNewTab'

/** One row of the forwarding table. The same shape as `ViewerShortcut` in `src/shared/plugin.ts` (matching structurally). */
export interface ForwardedShortcut {
  readonly id: ForwardedShortcutId
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  /** The physical key of a row with ⌥ (TODO 589, `KeyRow.code`). */
  readonly code?: string
  /**
   * The mouse button (TODO 369). A row where it is set matches not a key but the mouse button released inside the viewer
   * (`button` of `mouseup`) (`key` is empty).
   */
  readonly button?: number
}

/** Build the rows of the forwarding table. */
function rowsFor(id: ForwardedShortcutId, rows: readonly KeyRow[]): ForwardedShortcut[] {
  return rows.map((row) => ({ id, ...row }))
}

/** Whether it is the search `Mod-f` of the viewer's editor (CodeMirror). ⌘F inside the viewer stays search within the file (out of scope). */
function isEditorFind(row: KeyRow, platform: ShortcutPlatform): boolean {
  if (row.key !== 'f' || row.shiftKey || row.altKey) return false
  return platform === 'mac' ? row.metaKey && !row.ctrlKey : row.ctrlKey && !row.metaKey
}

/** The rows of the 3 searches and the ⌘F row (the base for both the viewer and web). */
function searchRows(platform: ShortcutPlatform): {
  readonly search: readonly ForwardedShortcut[]
  readonly find: readonly KeyRow[]
} {
  const search: ForwardedShortcut[] = []
  for (const [command, target] of [
    ['search.files', 'files'],
    ['search.names', 'names'],
    ['search.conversation', 'conversation']
  ] as const) {
    const key = bindingOf(command, platform)
    if (key !== null) search.push(...rowsFor(target, keyRowsOf(key, platform)))
  }
  const findKey = bindingOf('find', platform)
  return { search, find: findKey === null ? [] : keyRowsOf(findKey, platform) }
}

/** The back / forward rows (TODO 369). ⌃⇧- arrives as `_` on US and `=` on JIS, so both (`keyRowsOf`). */
function navRows(platform: ShortcutPlatform): ForwardedShortcut[] {
  const out: ForwardedShortcut[] = []
  for (const [id, command] of VIEWER_NAV_COMMANDS) {
    const key = bindingOf(command, platform)
    if (key !== null) out.push(...rowsFor(id, keyRowsOf(key, platform)))
  }
  return out
}

/**
 * The table of keys that should be forwarded to the host when pressed inside the viewer (item 189).
 *
 * **Built mechanically from the shortcut table (TODO 549, `src/shared/keybindings.ts`)** (not holding two tables).
 * It expands the keys of the 3 searches, ⌘F, save and back / forward into rows (`keyRowsOf`: `CmdOrCtrl` becomes rows for both ⌘ and Ctrl),
 * and removes only the keys the viewer itself uses:
 *
 * - **The editor's ⌘F (`Mod-f`, the search panel)**. CodeMirror's `Mod` is ⌘ on mac and Ctrl elsewhere.
 *   As in VS Code, ⌘F inside the viewer stays search within the file.
 *
 * On mac, Ctrl+P / Ctrl+F / Ctrl+K (emacs-style cursor movement, delete to end of line) are **on the sending side**
 * (the owner uses Ctrl. Inside the viewer those 3 cursor movements become unusable).
 *
 * Built from the current assignments on every call (TODO 589). The parts that send to the viewer call it at send time (`viewerShortcuts` in `shortcut-actions.ts`).
 * Rows with ⌥ carry the physical key (`code`) (`keyRowsOf`).
 */
export function viewerForwardedShortcuts(platform: ShortcutPlatform): readonly ForwardedShortcut[] {
  const { search, find } = searchRows(platform)
  const out: ForwardedShortcut[] = [
    ...search,
    ...rowsFor(
      'files',
      find.filter((row) => !isEditorFind(row, platform))
    )
  ]
  // Save (item 313). The editor's (CodeMirror) defaults have no ⌘S, so it used to pass straight through from the viewer,
  // but when the viewer (OOPIF) has focus it does not reach the parent's keydown. Provide both this and the menu accelerator.
  // Both ⌘ and Ctrl (Ctrl+S saves on mac too, the same as the 3 searches).
  const save = bindingOf('file.save', platform)
  if (save !== null) out.push(...rowsFor(SAVE_SHORTCUT_ID, keyRowsOf(save, platform)))
  // Back / forward (TODO 369). When the viewer (OOPIF) has focus it does not reach the parent's keydown, so have it forwarded.
  // The editor's (CodeMirror) default mac keymap has no ⌃- / ⌃⇧-. Alt+← / Alt+→ elsewhere would
  // take CodeMirror's "move by syntax unit" (in VS Code too, Alt+← is back).
  out.push(...navRows(platform))
  // New Web tab ⌘T (TODO 777). 771 made it "work anywhere", but when the viewer (OOPIF) has focus it does not
  // reach the parent's keydown. The other Web tab keys (⌘L / ⌃Tab) work only when the Web pane is in front, so they are out of scope.
  // CodeMirror's default keymap has no ⌘T. Rebinding follows, because `bindingOf` returns the current assignment.
  const newTab = bindingOf('web.newTab', platform)
  // On mac, ⌃T is emacs-style character transposition (only the modifiers exactly as pressed, same as `webTabShortcut`), so only the ⌘ row.
  if (newTab !== null) {
    out.push(
      ...rowsFor(
        'webNewTab',
        keyRowsOf(newTab, platform).filter((row) => isPrimaryRow(row, newTab, platform))
      )
    )
  }
  if (platform === 'mac') {
    // The mouse back / forward buttons (mac only: `viewerNavMouseButton`).
    for (const [id, button] of [
      ['viewerBack', 3],
      ['viewerForward', 4]
    ] as const) {
      out.push({ id, key: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button })
    }
  }
  return out
}

/**
 * The transition for making a shortcut leave the sidebar "open in that mode" (items 48 / 195).
 *
 * `threadStore.setMode` **toggles to collapse when the icon of the same mode is pressed**
 * (`pressMode` in `sidebarCollapse.ts`), so pressing ⌘⇧F while in search mode makes
 * the sidebar disappear. This returns only 3 cases: "if already open in that mode, do nothing /
 * if collapsed, open / if in another mode, open in that mode".
 * **A key does not collapse** (collapsing is ⌘B). A click on the icon toggles as before.
 *
 * The return value is the one operation the caller performs on threadStore:
 * - `'none'`   ... already open in that mode
 * - `'expand'` ... that mode but collapsed -> `toggleSidebar()`
 * - `'switch'` ... another mode -> `setMode(mode)` (opens even if collapsed)
 */
export type SidebarStep = 'none' | 'expand' | 'switch'

export function openModeStep<M>(view: { readonly mode: M; readonly collapsed: boolean }, mode: M): SidebarStep {
  if (view.mode !== mode) return 'switch'
  return view.collapsed ? 'expand' : 'none'
}

/** The search-mode form (a name from item 48). The same as `openModeStep`. */
export function openSearchStep<M>(view: { readonly mode: M; readonly collapsed: boolean }, search: M): SidebarStep {
  return openModeStep(view, search)
}

/**
 * What happens when a mode key (⌃⌘I / ⌘⇧E, menu accelerator) is pressed (item 195).
 *
 * Aligned with the real VS Code 1.139 (the `run` of `registerOpenViewContainerAction`):
 * **only when that view is visible and the sidebar has focus** does it return focus to the editor;
 * otherwise it opens the view and moves focus. **It does not collapse in either case.** aios's "editor" is
 * the conversation's input field (`main`).
 */
export interface ModeKeyAction {
  readonly sidebar: SidebarStep
  readonly focus: 'panel' | 'main'
}

export function modeKeyAction<M>(
  view: { readonly mode: M; readonly collapsed: boolean },
  mode: M,
  panelFocused: boolean
): ModeKeyAction {
  const sidebar = openModeStep(view, mode)
  return { sidebar, focus: sidebar === 'none' && panelFocused ? 'main' : 'panel' }
}

/** The key notation attached to the icon's title (item 195). The same order as VS Code's tooltips. */
export type ModeKeyName = 'threads' | 'files' | 'search' | 'extensions' | 'settings'

const MODE_KEY_LABELS: Readonly<Record<ShortcutPlatform, Readonly<Record<ModeKeyName, string>>>> = {
  mac: {
    threads: '⌃⌘I',
    files: '⇧⌘E',
    search: '⇧⌘F',
    // Extensions (TODO 367): ⌘⇧X, the same as VS Code's Extensions.
    extensions: '⇧⌘X',
    settings: '⌘,'
  },
  other: {
    threads: 'Ctrl+Alt+I',
    files: 'Ctrl+Shift+E',
    search: 'Ctrl+Shift+F',
    extensions: 'Ctrl+Shift+X',
    settings: 'Ctrl+,'
  }
}

const MODE_KEY_COMMANDS: Readonly<Record<ModeKeyName, KeybindingCommandId>> = {
  threads: 'view.threads',
  files: 'view.files',
  search: 'search.files',
  extensions: 'view.extensions',
  settings: 'app.settings'
}

export function modeKeyLabel(mode: ModeKeyName, platform: ShortcutPlatform): string {
  return labelOf(MODE_KEY_COMMANDS[mode], platform, () => MODE_KEY_LABELS[platform][mode])
}

/**
 * The "new thread" key (TODO 408, ⌘⇧O / Ctrl+Shift+O). Aligned with the same key as ChatGPT's New chat
 * (the icon was also aligned to compose). Being a menu accelerator, it does not collide with ⌘N (new window) or
 * the mode keys (⌃⌘I / ⌘⇧E / ⌘⇧X). Attached to the bubble at the top of the Activity Bar.
 */
export function newThreadKeyLabel(platform: ShortcutPlatform): string {
  return labelOf('thread.new', platform, () => (platform === 'mac' ? '⇧⌘O' : 'Ctrl+Shift+O'))
}

/**
 * The keys attached to the placeholders of the 3 search input fields (item 287). The table of representative keys that `searchShortcut` has
 * **point at that field**, and the notation is built from it (not hard-coded in the wording. `test/shortcuts.test.ts` confirms with
 * `searchShortcut` and `viewerForwardedShortcuts` that they "actually arrive").
 * Document search uses Shift (⌘⇧F): ⌘F inside the viewer is the editor's search, and only ⌘⇧F arrives from anywhere.
 */
export const SEARCH_KEY_SPEC: Readonly<Record<SearchTarget, { readonly key: string; readonly shift: boolean }>> = {
  files: { key: 'f', shift: true },
  names: { key: 'p', shift: false },
  conversation: { key: 'k', shift: false }
}

/** On mac `⌘⇧F` / `⌘P` / `⌘K`, otherwise `Ctrl+Shift+F` / `Ctrl+P` / `Ctrl+K`. */
const SEARCH_COMMAND_OF: Readonly<Record<SearchTarget, KeybindingCommandId>> = {
  files: 'search.files',
  names: 'search.names',
  conversation: 'search.conversation'
}

export function searchKeyLabel(target: SearchTarget, platform: ShortcutPlatform): string {
  return labelOf(SEARCH_COMMAND_OF[target], platform, () => {
    const { key, shift } = SEARCH_KEY_SPEC[target]
    const letter = key.toUpperCase()
    return platform === 'mac' ? `⌘${shift ? '⇧' : ''}${letter}` : `Ctrl+${shift ? 'Shift+' : ''}${letter}`
  })
}

/**
 * The ids used only inside the web view (TODO 400). In-page search (⌘F / Ctrl+F -> `findInPage`) and reload (⌘R / Ctrl+R).
 * Both are the same keys as a browser. ⌘R is the same key as the accelerator of View's `reload` (re-reading the app's renderer),
 * but when the page has focus main's `before-input-event` takes it first, so it becomes a reload of the page.
 */
export type WebViewShortcutId = 'webFind' | 'webReload'

export function isWebViewShortcutId(value: unknown): value is WebViewShortcutId {
  return value === 'webFind' || value === 'webReload'
}

/**
 * The table of keys that main should pick up and forward when the web view (main's `WebContentsView`) has focus (TODO 400).
 *
 * The page is a separate webContents, so nothing arrives at the renderer's keydown (the same situation as the viewer's iframe, item 189).
 * The table has the same base as the viewer's forwarding table (the 3 searches and back / forward), plus in-page search (the row of ⌘F with the modifiers
 * exactly as pressed. The same treatment as ⌘F in the viewer being the editor's search. Ctrl+F on mac stays body search) and reload.
 * The save (⌘S) and mouse button rows are removed (a page does not save; `before-input-event` sees only keys).
 *
 * Built from the current assignments on every call (TODO 589). `WebViewerPane` calls it when the pane is shown and when the assignments change
 * (`onKeybindingsChanged`), and sends it to main. Rows with ⌥ carry the physical key (`code`).
 */
export function webViewShortcuts(platform: ShortcutPlatform): readonly WebViewShortcut[] {
  const { search, find } = searchRows(platform)
  const findKey = bindingOf('find', platform)
  const out: WebViewShortcut[] = search.map(webRow)
  for (const row of find) {
    const primary = findKey !== null && isPrimaryRow(row, findKey, platform)
    out.push(webRow({ id: primary ? 'webFind' : 'files', ...row }))
  }
  out.push(...navRows(platform).map(webRow))
  // Reload and the Web tab keys (TODO 531) are only rows with the modifiers exactly as pressed (mac's ⌃R / ⌃T / ⌃L are passed to the page, as in Chrome).
  for (const [id, command] of [['webReload', 'web.reload'], ...WEB_TAB_COMMANDS] as const) {
    const key = bindingOf(command, platform)
    if (key === null) continue
    for (const row of keyRowsOf(key, platform)) {
      if (isPrimaryRow(row, key, platform)) out.push(webRow({ id, ...row }))
    }
  }
  return out
}

function webRow(row: ForwardedShortcut | (KeyRow & { readonly id: string })): WebViewShortcut {
  const { id, key, metaKey, ctrlKey, shiftKey, altKey, code } = row
  return { id, key, metaKey, ctrlKey, shiftKey, altKey, ...(code === undefined ? {} : { code }) }
}

/**
 * The ids of the Web tab keys (TODO 531, the same ⌘T / ⌘L / ⌃Tab / ⌃⇧Tab as Chrome). They work **only when the Web pane is in front**:
 * if the renderer has focus, App's keydown picks them up with `webTabShortcut`; if the page has focus, main forwards them using the web view's table
 * (`webViewShortcuts`). ⌘W (closes in the order tab -> viewer -> window) is a menu accelerator (`closeTabOrWindow`).
 */
export type WebTabShortcutId = 'webNewTab' | 'webFocusAddress' | 'webNextTab' | 'webPrevTab'

const WEB_TAB_COMMANDS: readonly (readonly [WebTabShortcutId, KeybindingCommandId])[] = [
  ['webNewTab', 'web.newTab'],
  ['webFocusAddress', 'web.focusAddress'],
  ['webNextTab', 'web.nextTab'],
  ['webPrevTab', 'web.prevTab']
]

export function isWebTabShortcutId(value: unknown): value is WebTabShortcutId {
  return WEB_TAB_COMMANDS.some(([id]) => id === value)
}

/**
 * The renderer's keydown: whether it is a Web tab key (whether it is in front is checked by the caller). Unlike the search keys, **only the modifiers exactly as pressed**
 * (mac's ⌃T / ⌃L stay emacs-style operations of input fields. The same matching as the in-page table `webViewShortcuts`).
 */
export function webTabShortcut(event: ShortcutKey): WebTabShortcutId | null {
  if (event.isComposing) return null
  for (const [id, command] of WEB_TAB_COMMANDS) {
    const key = bindingOf(command, keybindingPlatform)
    if (key !== null && matchesKeybinding(key, event, keybindingPlatform)) return id
  }
  return null
}

/** The key notation attached to the bubble of the in-page search field and so on (TODO 400). */
export function webViewKeyLabel(id: WebViewShortcutId, platform: ShortcutPlatform): string {
  return labelOf(id === 'webFind' ? 'find' : 'web.reload', platform, () => {
    const letter = id === 'webFind' ? 'F' : 'R'
    return platform === 'mac' ? `⌘${letter}` : `Ctrl+${letter}`
  })
}

/**
 * The key notation for "Go to symbol" (TODO 468). Attached to the bubble of the viewer's heading button. The key is taken directly by the viewer's (CodeMirror)
 * keymap (`plugins/_shared/symbol-picker.ts`). The accelerator (⌘R) of the menu "View > Reload" was
 * removed (owner decision 2026-10-04): if it were not removed, electron would eat it first and it would not reach the viewer.
 */
export function symbolsKeyLabel(platform: ShortcutPlatform): string {
  return platform === 'mac' ? '⌘R' : 'Ctrl+R'
}

/**
 * The currently effective keys of commands inside the viewer's editor (TODO 692, go to declaration / list assignments and uses). The host
 * carries them in `ViewerHostMessage.editorKeys` and the viewer builds them into CodeMirror's keymap. A command whose assignment was removed is not
 * carried (the viewer holds no key). Not carried in the forwarding table (`viewerForwardedShortcuts`): if it were, the bridge would take it
 * in the capture phase.
 */
export function viewerEditorKeys(platform: ShortcutPlatform): Readonly<Partial<Record<ViewerKeybindingCommandId, string>>> {
  const out: Partial<Record<ViewerKeybindingCommandId, string>> = {}
  for (const id of VIEWER_KEYBINDING_COMMAND_IDS) {
    const key = bindingOf(id, platform)
    if (key !== null) out[id] = key
  }
  return out
}

/** The key notation of commands inside the viewer's editor (attached to the right-click menu, TODO 692). null if removed. */
export function viewerEditorKeyLabel(id: ViewerKeybindingCommandId, platform: ShortcutPlatform): string | null {
  const key = bindingOf(id, platform)
  return key === null ? null : displayKeybinding(key, platform)
}
