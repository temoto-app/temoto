/**
 * Of the OS layer (TODO 986), electron's **macOS-only APIs**. The Dock, the screen recording permission (TCC), and the thermal state.
 *
 * This is the only place that touches `app.dock` / `systemPreferences` / `powerMonitor.getCurrentThermalState`
 * (enforced by `npm run lint:os`). On other OSes it does nothing or returns `null` - the same behavior as the scattered places before they were gathered.
 */
import { isMac } from '../../common/os/platform.js'
import { app, powerMonitor, systemPreferences, type Menu } from 'electron'

/**
 * The macOS-only part of the window's look (`hiddenInset`, which puts the traffic-light buttons inside; expanded into `BrowserWindow` options).
 * Other OSes add nothing (the default title bar). TODO 986 stage 2.
 */
export function windowChromeOptions(): { titleBarStyle?: 'hiddenInset' } {
  return isMac() ? { titleBarStyle: 'hiddenInset' } : {}
}

/** The Dock badge. An empty string clears it. Does nothing on non-macOS (no `app.dock`). */
export function setDockBadge(text: string): void {
  app.dock?.setBadge(text)
}

/** The menu shown when the Dock icon is right-clicked. Does nothing on non-macOS. */
export function setDockMenu(menu: Menu): void {
  app.dock?.setMenu(menu)
}

/**
 * The state of the screen recording permission (`systemPreferences.getMediaAccessStatus('screen')`).
 * Returns `'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'` as a string as is.
 */
export function screenAccessStatus(): string {
  return systemPreferences.getMediaAccessStatus('screen')
}

/** The thermal state (`powerMonitor.getCurrentThermalState()`). null on versions without it and on other OSes. */
export function currentThermalState(): unknown {
  return typeof powerMonitor.getCurrentThermalState === 'function' ? powerMonitor.getCurrentThermalState() : null
}
