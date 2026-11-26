/**
 * Launch order "window first, key later" (TODO 807, ARCHITECTURE 3.1 "launch order").
 *
 * The first window is opened before main asks the OS keychain for the DB key (which can block on a macOS dialog). Its renderer
 * starts with a small boot entry that draws nothing but a (delayed) "starting" notice, and loads the real app only after main says
 * every IPC handler is registered (`BootAnswer.ready`). Until then the renderer calls no IPC that needs the DB.
 */
import type { Locale } from './locale.js'
import type { Theme } from './theme.js'

/** The look main resolved from the DB once it is open. The boot entry writes it into the query before loading the app. */
export interface BootLook {
  readonly theme: Theme
  readonly locale: Locale
  /** `THREAD_COLLAPSE_QUERY_KEY` (TODO 659). */
  readonly threadCollapseDays: number
}

/**
 * The answer to `boot.wait`. `ready: false` = the launch was abandoned (quit while waiting, or it failed); the window is about to
 * close, so the boot entry keeps its notice and loads nothing.
 */
export type BootAnswer = { readonly ready: true; readonly look: BootLook } | { readonly ready: false }

/**
 * The query name carrying the per-machine data name (`aios` or `Temoto`, TODO 1263) to the boot notice: it names the keychain
 * item (`<name> Safe Storage`) the macOS dialog shows. `AppInfo` is not reachable yet at that point (its handler needs the DB).
 */
export const DATA_NAME_QUERY_KEY = 'aios-data'

/**
 * Wave 106 review Z5: the query name telling the boot notice which OS it runs on (`BootOs`), decided by main through the OS entry point
 * (`isMac()`, constraint 8.2). The keychain sentence is shown only on macOS; anywhere else (and when the key is missing) the notice
 * only says the app is starting.
 */
export const BOOT_OS_QUERY_KEY = 'aios-os'

/** The OS kinds the boot notice tells apart. */
export type BootOs = 'mac' | 'other'

/** How long the boot notice stays invisible (ms). A normal launch is ready well before this, so it never shows. */
export const BOOT_NOTICE_DELAY_MS = 1500
