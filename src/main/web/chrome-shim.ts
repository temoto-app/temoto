/**
 * Give pages in the Web view a "plain Chrome `window.chrome`" (continuation of 721 / 857, 2026-10-18).
 *
 * Electron's `window.chrome` is empty (Chrome has `loadTimes` / `csi` / `app`). Google's sign-in looked at this
 * and refused with "this browser or app may not be secure" (`/v3/signin/rejected`).
 * Measured with a throwaway Electron: adding only the Client Hints brands was rejected, and adding just the 3 members of `window.chrome`
 * was accepted (in a session that refuses permission requests).
 *
 * A preload is not used (the Web view has no preload and `contextIsolation: true`, 7.8). It is injected into the main world before the page's scripts with CDP's
 * `Page.addScriptToEvaluateOnNewDocument`.
 * It neither reads nor rewrites the page's contents.
 */
import { log, errorFields } from '../../common/logger.js'

/** A small function that runs first in the main world. It does not overwrite what already exists. */
export const CHROME_SHIM_SOURCE = `(() => {
  const c = window.chrome || (window.chrome = {})
  const t = () => performance.timing
  if (!c.loadTimes) c.loadTimes = function () {
    const p = t()
    return { requestTime: p.navigationStart / 1000, startLoadTime: p.navigationStart / 1000,
      commitLoadTime: p.responseStart / 1000, finishDocumentLoadTime: p.domContentLoadedEventEnd / 1000,
      finishLoadTime: p.loadEventEnd / 1000, firstPaintTime: p.domContentLoadedEventEnd / 1000,
      firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: true, wasNpnNegotiated: true,
      npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2' }
  }
  if (!c.csi) c.csi = function () {
    const p = t()
    return { onloadT: p.domContentLoadedEventEnd, startE: p.navigationStart, pageT: Date.now() - p.navigationStart, tran: 15 }
  }
  if (!c.app) c.app = { isInstalled: false,
    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } }
})()`

/** Only the part of `webContents` that is used (tests can build it from a plain object). */
export interface ShimTarget {
  loadURL(url: string): Promise<void>
  readonly debugger: {
    attach(version: string): void
    sendCommand(method: string, params?: object): Promise<unknown>
  }
}

/**
 * Call once, right after the view is created. Make the first navigation only after the returned Promise resolves (`WebViewLike.ready`).
 * If the debugger is attached to a webContents before its first navigation, it is detached by the first navigation and the script disappears (measured:
 * `target closed`), so `about:blank` is loaded first and then it attaches. The view is usable even if this fails (only a log is left;
 * it always resolves).
 */
export async function installChromeShim(contents: ShimTarget): Promise<void> {
  try {
    await contents.loadURL('about:blank')
    contents.debugger.attach('1.3')
    await contents.debugger.sendCommand('Page.enable')
    await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: CHROME_SHIM_SOURCE })
  } catch (err) {
    log.warn('web.chrome-shim.failed', errorFields(err))
  }
}
