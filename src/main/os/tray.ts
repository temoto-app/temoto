/**
 * Of the OS layer (TODO 986), the menu bar icon (TODO 1269). The only place that creates an electron `Tray` (enforced by `npm run lint:os`).
 *
 * `MenuBarTray.sync` is idempotent: call it whenever the setting, the display language or the pending approval count changes. It creates the icon when
 * enabled, rebuilds the menu only when its contents would differ (`trayMenuSignature`), and destroys the icon when disabled. `dispose()` (before-quit)
 * destroys it for good; a later `sync` does nothing. The icon is a template image (the file name ends in `Template`), so macOS tints it for light / dark.
 * The image is read from `<appPath>/resources/tray/`, the same way in dev, in the shell and in a distributed build (`release-config.mjs` ships it).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import type { Locale } from '@shared/locale.js'
import { PRODUCT_NAME } from '@shared/product.js'
import { log } from '../../common/logger.js'
import { isMac } from '../../common/os/platform.js'
import { trayMenuModel, trayMenuSignature, type TrayAction } from './tray-model.js'

export interface MenuBarTrayState {
  readonly enabled: boolean
  readonly locale: Locale
  readonly pending: number
}

export class MenuBarTray {
  private tray: Tray | null = null
  private signature = ''
  private disposed = false

  /**
   * `appPath` is `app.getAppPath()`. `onAction` runs the chosen item in main (show the window / a new conversation / quit).
   */
  constructor(
    private readonly appPath: string,
    private readonly onAction: (action: TrayAction) => void
  ) {}

  sync(state: MenuBarTrayState): void {
    if (this.disposed) return
    if (!state.enabled || !isMac()) {
      this.destroy()
      return
    }
    if (this.tray === null) {
      const created = this.create()
      if (created === null) return
      this.tray = created
      this.signature = ''
    }
    const signature = trayMenuSignature(state.locale, state.pending)
    if (signature === this.signature) return
    this.signature = signature
    this.tray.setContextMenu(this.buildMenu(state))
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

  private create(): Tray | null {
    const path = join(this.appPath, 'resources', 'tray', 'trayTemplate.png')
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
    log.info('tray.destroyed')
  }

  private buildMenu(state: MenuBarTrayState): Menu {
    const template: MenuItemConstructorOptions[] = trayMenuModel(state.locale, state.pending).map((entry) => {
      if (entry.kind === 'separator') return { type: 'separator' }
      const { action } = entry
      return {
        label: entry.label,
        enabled: entry.enabled,
        ...(action === null ? {} : { click: () => this.onAction(action) })
      }
    })
    return Menu.buildFromTemplate(template)
  }
}
