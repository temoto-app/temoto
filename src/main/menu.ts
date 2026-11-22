/**
 * The application menu and the Dock menu (ARCHITECTURE.md chapter 3 / T21).
 *
 * There are two reasons to include it: **a way to "New Window Cmd+N"** (T21), and
 * **a way to "Collapse sidebar Cmd+B"** (T27, 5.5.1). "New thread Cmd+Shift+O" (TODO 408) also
 * rides on the accelerators here (the same entry as the button at the top of the Activity Bar).
 * `~/Applications/aios.app` is launched with `open`, so an existing instance just comes to the front
 * and no window is added (the shell of `~/Applications/aios.app`). The ways to add windows are placed in the menu and the Dock.
 *
 * The default menu is replaced, so **keep every standard role**. Dropping a role also removes
 * Cmd+C / Cmd+V / Cmd+W. Items without a label are shown by electron in the OS language.
 *
 * **`role: 'viewMenu'` can no longer be used**: to put Cmd+B in "View", the contents are
 * laid out by hand. Dropping a role removes Cmd+R / Cmd++ / Cmd+F and so on, so **all** the
 * roles that `viewMenu` has are written out **as they are**.
 *
 * **Cmd+F / Cmd+P / Cmd+Shift+F / Cmd+K are not placed here as accelerators** (items 46 / 48 / 189).
 * They are picked up by `keydown` in `src/renderer/src/shortcuts.ts` + `App.tsx`. If the same accelerator is
 * added here, electron consumes it first and it does not reach the renderer, and Cmd+F would even die for the search inside the viewer's editor.
 * **Ctrl+Cmd+I / Cmd+Shift+E for modes and Cmd+, for settings are accelerators** (item 195) - they do not collide with the editor and
 * work even when a viewer (OOPIF) has focus. The table of items and accelerators is in `menu-model.ts`
 * (independent of electron, tested). When pressed, the window is notified via `sendCommand`, the same as Cmd+B.
 *
 * **Wording follows the display language** (TODO 66, 7.4.4). Labels are looked up from the table in `i18n-native.ts`, and
 * when the language changes, `setLocale` **rebuilds the whole menu** (an electron menu
 * cannot have an item's label rewritten afterwards). Items that come from roles (Edit, Window, the contents of appMenu)
 * are not in the table and are decided by electron / the OS.
 *
 * It touches electron directly, so it is not tested (what is tested is the pure part of `windows.ts`, the renderer's
 * `sidebarCollapse.ts`, and the wording table `i18n-native.ts`).
 */
import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { PRODUCT_NAME } from '@shared/product.js'
import type { MenuCommand } from '@shared/ipc.js'
import type { Locale } from '@shared/locale.js'
import type { KeybindingOverrides } from '@shared/keybindings.js'
import { nativeText, type NativeKey } from './i18n-native.js'
import { IpcEvent } from '@shared/ipc.js'
import type { ReloadKind } from './viewer-drafts-close.js'
import { isMac } from '../common/os/platform.js'
import { setDockMenu } from './os/electron.js'
import {
  CLOSE_ITEM,
  FORCE_RELOAD_ITEM,
  FULLSCREEN_ITEM,
  HELP_ITEM,
  RELEASE_NOTES_ITEM,
  HIDDEN_FILES_ITEM,
  NEW_THREAD_ITEM,
  RELOAD_ITEM,
  SAVE_ITEM,
  SETTINGS_ITEM,
  boundMenuItem,
  fullScreenAccelerator,
  hiddenFilesAccelerator,
  viewMenuEntries,
  type CommandMenuItem
} from './menu-model.js'

const onMac = isMac()

/** The Cmd+N item. The app menu and the Dock menu use the same one. */
function newWindowItem(locale: Locale, openWindow: () => void): MenuItemConstructorOptions {
  return {
    label: nativeText(locale, 'menu.newWindow'),
    accelerator: 'CmdOrCtrl+N',
    click: () => openWindow()
  }
}

/** Operations called from the menu. Only `index.ts` knows `BrowserWindow`. */
export interface MenuActions {
  /** Open one window (Cmd+N). */
  openWindow(): void
  /**
   * Notifies the focused window of an operation (the Cmd+B sidebar, the mode switching and settings of item 195).
   * **For an accelerator, electron consumes the key first**, so the renderer's `keydown` cannot pick it up.
   * It is pushed from here.
   */
  sendCommand(command: MenuCommand): void
  /**
   * "Show hidden files" (Cmd+Shift+., TODO 261). The check state and the toggle. Touches main's
   * `HiddenFilesPreference` directly (one for the whole app, not through the renderer).
   */
  readonly hiddenFiles?: { shown(): boolean; toggle(): void }
  /**
   * The user's assignments of keyboard shortcuts (TODO 549). Fetched every time the menu is built, to replace accelerators.
   * When the assignments change, it is rebuilt with `refresh()`.
   */
  readonly keybindings?: () => KeybindingOverrides
  /**
   * "Reload" / "Force reload" (TODO 636). Settles the viewer's unsaved drafts before reloading (the same handling as 606).
   * If absent, it reloads directly as before.
   */
  readonly reloadWindow?: (window: BrowserWindow, kind: ReloadKind) => void
  /**
   * "Full screen" (Ctrl+Cmd+F, TODO 1221). If a Web page is in front, only the Web contents; otherwise the window goes full screen.
   * If absent, it stays the role `togglefullscreen`.
   */
  readonly toggleFullScreen?: (window: BrowserWindow) => void
  /** "Help > Report a Problem" (TODO 1308). Main builds the masked report file and shows it in Finder. */
  readonly reportProblem?: () => void
}

/** Operations on the built menu. `index.ts` calls them on a language change (the source of `locale.changed`). */
export interface InstalledMenus {
  /** Rebuild when the language changes. Does nothing for the same language. */
  setLocale(locale: Locale): void
  /** Rebuild with the same language (when the check state changed, TODO 261). */
  refresh(): void
}

export function installMenus(actions: MenuActions, locale: Locale): InstalledMenus {
  let current = locale
  build(actions, current)
  return {
    setLocale(next) {
      if (next === current) return
      current = next
      build(actions, current)
    },
    refresh() {
      build(actions, current)
    }
  }
}

const menuPlatform = onMac ? 'darwin' : 'other'

/** Turns one item of `menu-model.ts` into an electron item. The accelerator is applied after the user's assignment (TODO 549). */
function commandItem(
  locale: Locale,
  actions: MenuActions,
  raw: CommandMenuItem
): MenuItemConstructorOptions {
  const item = boundMenuItem(raw, menuPlatform, actions.keybindings?.() ?? {})
  return {
    label: nativeText(locale, item.label),
    ...(item.accelerator === undefined ? {} : { accelerator: item.accelerator }),
    ...(item.registerAccelerator === undefined
      ? {}
      : { registerAccelerator: item.registerAccelerator }),
    click: () => actions.sendCommand(item.command)
  }
}

function build(actions: MenuActions, locale: Locale): void {
  const openWindow = (): void => actions.openWindow()
  const settings = commandItem(locale, actions, SETTINGS_ITEM)
  const newThread = commandItem(locale, actions, NEW_THREAD_ITEM)
  const template: MenuItemConstructorOptions[] = [
    // `role: 'appMenu'` cannot have contents inserted, so it is laid out again to place Cmd+, "Settings..."
    // (the same order as electron's appMenu. Dropping the role removes Cmd+Q / Cmd+H).
    ...(onMac
      ? [
          {
            // TODO 1254: `app.name` is an internal name (aios), so the heading and the role wording are set to the public name.
            label: PRODUCT_NAME,
            submenu: [
              { role: 'about' as const, label: nativeText(locale, 'menu.about') },
              { type: 'separator' as const },
              settings,
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const, label: nativeText(locale, 'menu.hide') },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const, label: nativeText(locale, 'menu.quit') }
            ]
          }
        ]
      : []),
    {
      label: nativeText(locale, 'menu.file'),
      submenu: [
        newWindowItem(locale, openWindow),
        { type: 'separator' },
        // "New thread" (Cmd+Shift+O, TODO 408). The same behavior as the button at the top of the Activity Bar.
        newThread,
        { type: 'separator' },
        // "Save" (item 313, VS Code's File > Save). Saves the viewer's draft if there is one.
        commandItem(locale, actions, SAVE_ITEM),
        { type: 'separator' },
        // On non-macOS, Settings is placed in "File" (the same position as VS Code's File > Preferences).
        ...(onMac ? [] : [settings, { type: 'separator' as const }]),
        // Cmd+W (TODO 531): an item that closes "the Web tab, or the window if none" in place of the role `close`.
        onMac ? closeItem(locale, actions) : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: nativeText(locale, 'menu.view'),
      submenu: [
        ...viewMenuEntries(menuPlatform).map(
          (entry): MenuItemConstructorOptions =>
            entry === 'separator' ? { type: 'separator' } : commandItem(locale, actions, entry)
        ),
        ...hiddenFilesItems(locale, actions),
        { type: 'separator' },
        // From here down is the same order as `role: 'viewMenu'`. Dropping it removes Cmd++ and so on.
        // "Reload" does not use the role (TODO 468): the role's default Cmd+R is passed to the viewer's "Go to symbol",
        // so it is laid out by hand as an item without an accelerator. Cmd+Shift+R force reload also dropped the role in TODO 636 - the role
        // makes electron reload directly and cannot fit in the step that settles the viewer's unsaved drafts (606).
        reloadItem(locale, actions, RELOAD_ITEM.label, 'normal'),
        reloadItem(locale, actions, FORCE_RELOAD_ITEM.label, 'ignoreCache', FORCE_RELOAD_ITEM.accelerator),
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        // TODO 1221: in place of the role `togglefullscreen`. If a Web page is in front, only the Web contents go full screen (if the entry point is absent, the role).
        fullScreenItem(locale, actions)
      ]
    },
    // The role `windowMenu` on non-macOS has the role `close` (Ctrl+W) in its contents, so the contents are replaced and a close item is placed (TODO 531).
    onMac
      ? { role: 'windowMenu' }
      : { role: 'windowMenu', submenu: [{ role: 'minimize' }, { role: 'zoom' }, closeItem(locale, actions)] },
    // "Help > Temoto Help" (TODO 1174). On macOS the role `help` makes the OS add the menu's search field (the same position as VS Code's Help).
    {
      role: 'help',
      label: nativeText(locale, 'menu.help'),
      submenu: [
        commandItem(locale, actions, HELP_ITEM),
        commandItem(locale, actions, RELEASE_NOTES_ITEM),
        ...(actions.reportProblem === undefined
          ? []
          : [{ label: nativeText(locale, 'menu.reportProblem'), click: () => actions.reportProblem?.() }])
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  // Items shown on right-clicking the Dock icon. Even after all windows are closed, you can come back from here.
  if (onMac) {
    setDockMenu(Menu.buildFromTemplate([newWindowItem(locale, openWindow)]))
  }
}

/**
 * "Close" (Cmd+W, TODO 531). If the window that was pressed is an aios window and its renderer is alive, the renderer decides tab or window
 * (only the renderer knows what is in front). `sendCommand` (the last window if there is no focus) is not used - so that a background window is
 * not closed when there is no focus. For a window whose renderer is down, or a non-aios window, the window is closed, the same as the role `close`.
 */
function closeItem(locale: Locale, actions: MenuActions): MenuItemConstructorOptions {
  const item = boundMenuItem(CLOSE_ITEM, menuPlatform, actions.keybindings?.() ?? {})
  return {
    label: nativeText(locale, item.label),
    ...(item.accelerator === undefined ? {} : { accelerator: item.accelerator }),
    click: (_menuItem, window) => {
      if (window === undefined || window.isDestroyed()) return
      if (window instanceof BrowserWindow && !window.webContents.isCrashed()) {
        window.webContents.send(IpcEvent.menuCommand, item.command)
        return
      }
      window.close()
    }
  }
}

/**
 * "Reload" / "Force reload" (TODO 468 / 636). The window that was pressed is reloaded after settling the viewer's unsaved drafts
 * (`actions.reloadWindow`). If there is no entry point (a test fake, etc.), it reloads directly.
 */
function reloadItem(
  locale: Locale,
  actions: MenuActions,
  label: NativeKey,
  kind: ReloadKind,
  accelerator?: string
): MenuItemConstructorOptions {
  return {
    label: nativeText(locale, label),
    ...(accelerator === undefined ? {} : { accelerator }),
    click: (_item, window) => {
      if (!(window instanceof BrowserWindow) || window.isDestroyed()) return
      if (actions.reloadWindow !== undefined) actions.reloadWindow(window, kind)
      else if (kind === 'ignoreCache') window.webContents.reloadIgnoringCache()
      else window.webContents.reload()
    }
  }
}

/**
 * "Full screen" (Ctrl+Cmd+F / F11, TODO 1221). For the window that was pressed (the focused window), `actions.toggleFullScreen`
 * decides. When there is no window, it is a non-aios window, or there is no entry point, it toggles the window's full screen, the same as the role.
 */
function fullScreenItem(locale: Locale, actions: MenuActions): MenuItemConstructorOptions {
  const toggle = actions.toggleFullScreen
  if (toggle === undefined) return { role: 'togglefullscreen' }
  return {
    label: nativeText(locale, FULLSCREEN_ITEM.label),
    accelerator: fullScreenAccelerator(menuPlatform),
    click: (_item, window) => {
      if (!(window instanceof BrowserWindow) || window.isDestroyed()) return
      toggle(window)
    }
  }
}

/** The checkbox item of "Show hidden files" (TODO 261). Not shown if there is no entry point for toggling. */
function hiddenFilesItems(locale: Locale, actions: MenuActions): MenuItemConstructorOptions[] {
  const hidden = actions.hiddenFiles
  if (hidden === undefined) return []
  const accelerator = hiddenFilesAccelerator(menuPlatform, actions.keybindings?.() ?? {})
  return [
    { type: 'separator' },
    {
      label: nativeText(locale, HIDDEN_FILES_ITEM.label),
      type: 'checkbox',
      checked: hidden.shown(),
      ...(accelerator === undefined ? {} : { accelerator }),
      click: () => hidden.toggle()
    }
  ]
}
