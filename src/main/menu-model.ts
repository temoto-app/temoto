/**
 * The table of menu items that tell the renderer about an operation (item 195, wave 14 bundle D).
 *
 * `menu.ts` touches electron directly, so it is not tested. Only the item-to-accelerator mapping is split out here,
 * and since it **does not import electron**, `test/menu-model.test.ts` can check it
 * (accelerators do not duplicate, do not collide with the renderer's keydown, and labels are in the table).
 *
 * Accelerator strings use electron's format (`CmdOrCtrl+Shift+E` etc.). **electron consumes the key first**,
 * so a key placed here never reaches the renderer's `keydown` (Cmd+B was the first example).
 */
import { IpcEvent, type MenuCommand } from '@shared/ipc.js'
import {
  effectiveKeybinding,
  isKeybindingModified,
  type KeybindingCommandId,
  type KeybindingOverrides
} from '@shared/keybindings.js'
import type { NativeKey } from './i18n-native.js'

export type MenuPlatform = 'darwin' | 'other'

/** The minimal shape `sendCommand` needs from its destination (TODO 588, a code-review fix: so it can be tested without touching electron). */
export interface MenuCommandTarget {
  isDestroyed(): boolean
  readonly webContents: {
    send(channel: string, command: MenuCommand): void
    focus(): void
  }
}

/**
 * Sends a menu command (everything that goes through `sendCommand`: Cmd+N new thread, search, Cmd+, settings, ...) to the window's renderer
 * (TODO 588, a code-review fix).
 *
 * **Call the window's `webContents.focus()` right after sending.** When a Web page (`WebContentsView`) has native focus,
 * even if the renderer receives this command and moves DOM focus to an input field, native focus stays on the page
 * (confirmed in the proxy verification of 588) - characters typed on the physical keys go to the page. Since `sendCommand` is used only for commands on this path,
 * the renderer is always the receiver, so no per-command allow list is made and focus is returned uniformly (to avoid omissions).
 * Operations on the Web tab itself (Cmd+R reload, Ctrl+Tab, back / forward, Cmd+W) do not go through `sendCommand`; `menu.ts` / `reloadWindow` /
 * `sendNav` send them directly, so they need not be excluded here.
 */
export function dispatchMenuCommand(target: MenuCommandTarget, command: MenuCommand): void {
  if (target.isDestroyed()) return
  target.webContents.send(IpcEvent.menuCommand, command)
  target.webContents.focus()
}

export interface CommandMenuItem {
  readonly command: MenuCommand
  readonly label: NativeKey
  /** If absent, no key is attached. */
  readonly accelerator?: string
  /**
   * If false, the key is only displayed and not registered (electron's `registerAccelerator`, which works **only on Windows / Linux**).
   * Used to show the menu a key that the renderer's keydown picks up.
   */
  readonly registerAccelerator?: boolean
  /**
   * A command of the shortcut table (TODO 549, `src/shared/keybindings.ts`). If present, `accelerator` is the table's default,
   * and if the user has an assignment, `boundMenuItem` replaces it (if the assignment is removed, no accelerator).
   */
  readonly binding?: KeybindingCommandId
}

export type ViewMenuEntry = CommandMenuItem | 'separator'

/**
 * Keys picked up by the renderer's `keydown` (`searchShortcut` in `src/renderer/src/shortcuts.ts`).
 * **They must not be included in the registered accelerators** - if electron consumes them first they do not reach the renderer,
 * and Cmd+F would even die for the search inside the viewer's editor (items 46 / 48 / 189).
 */
export const RENDERER_KEYDOWN_ACCELERATORS: readonly string[] = [
  'CmdOrCtrl+F',
  'CmdOrCtrl+Shift+F',
  'CmdOrCtrl+P',
  'CmdOrCtrl+K'
]

/**
 * The upper half of the "View" menu (before the role items). The same order as VS Code's View menu
 * (not Chat / Explorer / Search, but the order from the top of aios's icon bar).
 *
 * - Threads: Ctrl+Cmd+I / Ctrl+Alt+I (the same key as VS Code's `workbench.action.chat.open`).
 *   The role's "Developer Tools" is Opt+Cmd+I / Ctrl+Shift+I, so there is no collision.
 * - Files: Cmd+Shift+E / Ctrl+Shift+E (Explorer).
 * - Extensions: Cmd+Shift+X / Ctrl+Shift+X (Extensions, TODO 367).
 * - Search: Cmd+Shift+F is **not** made a menu accelerator (it stays the renderer's keydown, item 189).
 *   macOS cannot do "display only" (`registerAccelerator` has no effect), so no key is shown there,
 *   while Windows / Linux show it for display only.
 */
export function viewMenuEntries(platform: MenuPlatform): readonly ViewMenuEntry[] {
  return [
    {
      command: 'showThreads',
      label: 'menu.threads',
      accelerator: platform === 'darwin' ? 'Ctrl+Cmd+I' : 'Ctrl+Alt+I',
      binding: 'view.threads'
    },
    { command: 'showFiles', label: 'menu.files', accelerator: 'CmdOrCtrl+Shift+E', binding: 'view.files' },
    platform === 'darwin'
      ? { command: 'showSearch', label: 'menu.search' }
      : {
          command: 'showSearch',
          label: 'menu.search',
          accelerator: 'Ctrl+Shift+F',
          registerAccelerator: false,
          binding: 'search.files'
        },
    // Extensions (TODO 367): the same Cmd+Shift+X as VS Code's Extensions. It does not collide with CodeMirror's defaults, so it is an accelerator.
    {
      command: 'showExtensions',
      label: 'menu.extensions',
      accelerator: 'CmdOrCtrl+Shift+X',
      binding: 'view.extensions'
    },
    'separator',
    { command: 'toggleSidebar', label: 'menu.sidebar', accelerator: 'CmdOrCtrl+B', binding: 'view.toggleSidebar' }
  ]
}

/**
 * Settings (Cmd+, / Ctrl+,). On macOS it is "Settings..." in the app-name menu (the standard position); elsewhere
 * it goes in the "File" menu (`menu.ts`).
 */
export const SETTINGS_ITEM: CommandMenuItem = {
  command: 'openSettings',
  label: 'menu.settings',
  accelerator: 'CmdOrCtrl+,',
  binding: 'app.settings'
}

/**
 * "Save" in "File" (Cmd+S / Ctrl+S, item 313). The same key as VS Code's File > Save. If the viewer has a draft,
 * it is saved (if not, the renderer does nothing). Being an accelerator, it works even when a viewer (OOPIF) or
 * the editor has focus.
 */
export const SAVE_ITEM: CommandMenuItem = {
  command: 'save',
  label: 'menu.save',
  accelerator: 'CmdOrCtrl+S',
  binding: 'file.save'
}

/**
 * "New thread" (Cmd+Shift+O / Ctrl+Shift+O, TODO 408). The same key as ChatGPT's New chat. Opens the create
 * dialog (the same behavior as the button at the top of the Activity Bar). CodeMirror's default keymap has no Cmd+Shift+O,
 * and it does not collide with `RENDERER_KEYDOWN_ACCELERATORS` (the three search keys), so it can be an accelerator -
 * it works even when a viewer (OOPIF) has focus.
 */
export const NEW_THREAD_ITEM: CommandMenuItem = {
  command: 'newThread',
  label: 'menu.newThread',
  accelerator: 'CmdOrCtrl+Shift+O',
  binding: 'thread.new'
}

/**
 * "Close" (Cmd+W / Ctrl+W, TODO 531). Replaces electron's role `close` (close the window): it closes in the order temporary view -> Web tab -> file
 * viewer (closed the same way as the X), and closes the window only when none of these exist (the same order as VS Code, TODO 843). The renderer decides (`closeTabOrWindow`) - only
 * the renderer knows what is in front. On macOS it replaces the contents of the "File" role; elsewhere, those of the "Window" role (`menu.ts`).
 */
export const CLOSE_ITEM: CommandMenuItem = {
  command: 'closeTabOrWindow',
  label: 'menu.close',
  accelerator: 'CmdOrCtrl+W',
  binding: 'web.closeTab'
}

/**
 * "aios Help" in "Help" (TODO 1174, one of the entry points of owner decision 2026-11-07). Shows Help as a temporary view in the ViewerPane.
 * **No key is attached** - VS Code's Help menu items have no default key either (Cmd+? is used by macOS for the menu search).
 * On macOS it is the role `help` menu (the OS adds the search field); elsewhere "Help" is placed in the same position (`menu.ts`).
 */
export const HELP_ITEM: CommandMenuItem = {
  command: 'openHelp',
  label: 'menu.helpItem'
}

/**
 * "Release Notes" in "Help" (TODO 1186, the counterpart of VS Code's Help > Release Notes). Shows the bundled changelog in the ViewerPane
 * as a temporary view. No key is attached.
 */
export const RELEASE_NOTES_ITEM: CommandMenuItem = {
  command: 'openReleaseNotes',
  label: 'menu.releaseNotes'
}

/**
 * "Show hidden files" in "View" (TODO 261, wave 15 bundle D). Cmd+Shift+. (Ctrl+Shift+.), the same as Finder.
 * A checkbox item that **main toggles directly** (`HiddenFilesPreference`, one for the whole app) -
 * it does not go through the renderer, so it has no `MenuCommand`. When it changes, all windows' renderers are notified
 * and the menu check is rebuilt.
 */
export const HIDDEN_FILES_ITEM: {
  readonly label: NativeKey
  readonly accelerator: string
  readonly binding: KeybindingCommandId
} = {
  label: 'menu.hiddenFiles',
  accelerator: 'CmdOrCtrl+Shift+.',
  binding: 'view.hiddenFiles'
}

/**
 * "Reload" in "View" (TODO 468, owner decision 2026-10-04). **No accelerator is attached** - Cmd+R / Ctrl+R is passed to the viewer's
 * "Go to symbol" (CodeMirror's keymap). Since electron consumes accelerator keys first, keeping the role `reload`'s
 * default Cmd+R would not reach the viewer, and the app's renderer would be reloaded. The item stays (for development), so instead of the role,
 * `menu.ts` calls `webContents.reload()` itself. Force reload (Cmd+Shift+R) also dropped the role in TODO 636 (`FORCE_RELOAD_ITEM`).
 * Both settle the viewer's unsaved drafts before reloading (TODO 636, `MenuActions.reloadWindow`).
 * The idea of running it from main's `before-input-event` only when the viewer has focus was not adopted (owner decision).
 */
export const RELOAD_ITEM: { readonly label: NativeKey } = {
  label: 'menu.reload'
}

/**
 * "Force reload" in "View" (TODO 636). The role `forceReload` makes electron call `reloadIgnoringCache()` directly and cannot fit in the step
 * that settles the viewer's unsaved drafts (606 / 5.2.3), so it became an item of our own. The key is the same as the role's, Cmd+Shift+R / Ctrl+Shift+R
 * (not put in the user's assignment table - it stays a reserved key, `reservedKeybindings`).
 */
export const FORCE_RELOAD_ITEM: { readonly label: NativeKey; readonly accelerator: string } = {
  label: 'menu.forceReload',
  accelerator: 'Shift+CmdOrCtrl+R'
}

/**
 * "Full screen" in "View" (TODO 1221). An item of our own in place of the role `togglefullscreen`, with the same key as the role
 * (Ctrl+Cmd+F on macOS, F11 elsewhere - both stay reserved keys, `reservedKeybindings`, not put in the user's assignment table).
 * When pressed, `MenuActions.toggleFullScreen`: if a Web page is in front, only the Web contents go full screen; otherwise the window does.
 */
export const FULLSCREEN_ITEM: { readonly label: NativeKey } = {
  label: 'menu.fullScreen'
}

/** The key for "Full screen" (the same as the role `togglefullscreen`). */
export function fullScreenAccelerator(platform: MenuPlatform): string {
  return platform === 'darwin' ? 'Ctrl+Cmd+F' : 'F11'
}

/** `MenuPlatform` -> platform of the shortcut table. */
function keyPlatformOf(platform: MenuPlatform): 'mac' | 'other' {
  return platform === 'darwin' ? 'mac' : 'other'
}

/**
 * Applies the user's assignments (TODO 549) to menu items. Items without a table command are left as is. A command whose assignment
 * was removed loses its accelerator (the item stays).
 */
export function boundMenuItem(
  item: CommandMenuItem,
  platform: MenuPlatform,
  overrides: KeybindingOverrides = {}
): CommandMenuItem {
  if (item.binding === undefined || item.accelerator === undefined) return item
  if (!isKeybindingModified(item.binding, overrides)) return item
  const key = effectiveKeybinding(item.binding, keyPlatformOf(platform), overrides)
  if (key === null) {
    const { accelerator: _accelerator, registerAccelerator: _register, ...rest } = item
    return rest
  }
  return { ...item, accelerator: key }
}

/** The accelerator for "Show hidden files" (undefined if the assignment was removed). */
export function hiddenFilesAccelerator(platform: MenuPlatform, overrides: KeybindingOverrides = {}): string | undefined {
  return effectiveKeybinding(HIDDEN_FILES_ITEM.binding, keyPlatformOf(platform), overrides) ?? undefined
}

/** List of registered accelerators (excluding display-only ones). For tests and the duplicate check. */
export function registeredAccelerators(
  platform: MenuPlatform,
  overrides: KeybindingOverrides = {}
): readonly string[] {
  const items = [
    ...viewMenuEntries(platform),
    SETTINGS_ITEM,
    SAVE_ITEM,
    NEW_THREAD_ITEM,
    CLOSE_ITEM
  ]
    .filter((entry): entry is CommandMenuItem => entry !== 'separator')
    .map((item) => boundMenuItem(item, platform, overrides))
  const hidden = hiddenFilesAccelerator(platform, overrides)
  return [
    ...items
      .filter((item) => item.accelerator !== undefined && item.registerAccelerator !== false)
      .map((item) => item.accelerator as string),
    ...(hidden === undefined ? [] : [hidden])
  ]
}
