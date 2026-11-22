/**
 * Of the OS layer (TODO 986), the menu bar icon (TODO 1269). The only place that creates an electron `Tray` (enforced by `npm run lint:os`).
 *
 * `MenuBarTray.sync` is idempotent: call it whenever the setting, the display language or what the menu shows changes. It creates the icon when
 * enabled, rebuilds the menu only when its contents would differ (`trayMenuSignature`), swaps the image and the number next to the icon only when those
 * change (TODO 1302: a dot while a conversation runs; no timers, no animation), and destroys the icon when disabled. `dispose()` (before-quit)
 * destroys it for good; a later `sync` does nothing. The images are template images (the file names end in `Template`), so macOS tints them for light / dark.
 * They are read from `<appPath>/resources/tray/`, the same way in dev, in the shell and in a distributed build (`release-config.mjs` ships them).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import { PRODUCT_NAME } from '@shared/product.js'
import { log } from '../../common/logger.js'
import { isMac } from '../../common/os/platform.js'
import { trayIconState, trayMenuModel, trayMenuSignature, type TrayAction, type TrayIconState, type TrayMenuEntry, type TrayMenuInput } from './tray-model.js'

export interface MenuBarTrayState {
  readonly enabled: boolean
  readonly menu: TrayMenuInput
}

export class MenuBarTray {
  private tray: Tray | null = null
  private signature = ''
  /** The look currently set on the icon (so the image and the title are touched only when they change). */
  private iconRunning = false
  private iconTitle = ''
  private disposed = false

  /**
   * `appPath` is `app.getAppPath()`. `onAction` runs the chosen item in main (show the window / a new conversation / quit).
   */
  constructor(
    private readonly appPath: string,
    private readonly onAction: (action: TrayAction) => void,
    /** false for a non-default userData (dev, verification builds, copies): the icon is never created there. */
    readonly allowed = true
  ) {}

  sync(state: MenuBarTrayState): void {
    if (this.disposed) return
    if (!this.allowed || !state.enabled || !isMac()) {
      this.destroy()
      return
    }
    if (this.tray === null) {
      const created = this.create()
      if (created === null) return
      this.tray = created
      this.signature = ''
      this.iconRunning = false
      this.iconTitle = ''
    }
    this.syncIcon(this.tray, trayIconState(state.menu))
    const signature = trayMenuSignature(state.menu)
    if (signature === this.signature) return
    this.signature = signature
    this.tray.setContextMenu(this.buildMenu(state.menu))
  }

  /** On shutdown. The icon goes away and a later `sync` does nothing. */
  dispose(): void {
    this.disposed = true
    this.destroy()
  }

  /** Whether an icon is currently shown (for tests of the wiring and for logs). */
  get active(): boolean {
    return this.tray !== null
  }

  /** The dot while something runs, and the badge number next to the icon. Touched only on a change. */
  private syncIcon(tray: Tray, icon: TrayIconState): void {
    if (icon.running !== this.iconRunning) {
      const image = this.loadImage(icon.running ? 'trayRunningTemplate.png' : 'trayTemplate.png')
      if (image !== null) {
        tray.setImage(image)
        this.iconRunning = icon.running
      }
    }
    const title = icon.badge > 0 ? String(icon.badge) : ''
    if (title !== this.iconTitle) {
      tray.setTitle(title)
      this.iconTitle = title
    }
  }

  private loadImage(name: string): NativeImage | null {
    const path = join(this.appPath, 'resources', 'tray', name)
    if (!existsSync(path)) {
      log.warn('tray.image.missing', { path })
      return null
    }
    const image = nativeImage.createFromPath(path)
    if (image.isEmpty()) {
      log.warn('tray.image.empty', { path })
      return null
    }
    image.setTemplateImage(true)
    return image
  }

  private create(): Tray | null {
    const image = this.loadImage('trayTemplate.png')
    if (image === null) return null
    const tray = new Tray(image)
    tray.setToolTip(PRODUCT_NAME)
    log.info('tray.created')
    return tray
  }

  private destroy(): void {
    if (this.tray === null) return
    try {
      this.tray.destroy()
    } catch {
      // Already gone (for example during shutdown): nothing to restore.
    }
    this.tray = null
    this.signature = ''
    this.iconRunning = false
    this.iconTitle = ''
    log.info('tray.destroyed')
  }

  private buildMenu(input: TrayMenuInput): Menu {
    return Menu.buildFromTemplate(this.template(trayMenuModel(input)))
  }

  private template(entries: readonly TrayMenuEntry[]): MenuItemConstructorOptions[] {
    return entries.map((entry): MenuItemConstructorOptions => {
      if (entry.kind === 'separator') return { type: 'separator' }
      if (entry.kind === 'submenu') return { label: entry.label, submenu: this.template(entry.items) }
      const { action } = entry
      return {
        label: entry.label,
        enabled: entry.enabled,
        ...(action === null ? {} : { click: () => this.onAction(action) })
      }
    })
  }
}
