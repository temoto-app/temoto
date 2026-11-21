/**
 * TODO 1061 (1): capture the rendering of a file viewer (a plugin's sandbox iframe) and of a temporary view (diff) (the gateway's
 * `getViewerScreenshot`, ARCHITECTURE 7.6.2). **The host (main) captures it** — cut the ViewerPane's rectangle with the window renderer's `webContents.capturePage(rect)`.
 * No new capability is added to plugins (constraint 8). The rectangle is taken from the renderer's DOM with the app's fixed JS
 * (`VIEWER_RECT_SCRIPT`), and the returned value is re-validated by `viewerCaptureRect`.
 *
 * The Web view (`WebContentsView`) is a separate view layered over the window's renderer, so it does not appear here (the Web view is captured by
 * `WebViewHandle.captureTab`). The image is only returned; it is neither saved nor logged.
 */
import { BrowserWindow } from 'electron'
import {
  encodeScreenshot,
  VIEWER_RECT_SCRIPT,
  VIEWER_RECT_WORLD_ID,
  viewerCaptureRect,
  type NativeImageLike,
  type ScreenshotOutcome
} from './session/viewer-screenshot.js'

/** The renderer's `webContents.id` -> window. */
export function windowOfView(viewId: number): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.webContents.id === viewId) ?? null
}

/** Capture the viewer currently visible in the ViewerPane of window `viewId`. */
export async function captureViewerPane(viewId: number): Promise<ScreenshotOutcome> {
  const window = windowOfView(viewId)
  if (window === null) return { ok: false, reason: 'closed' }
  if (window.isMinimized() || !window.isVisible()) return { ok: false, reason: 'hidden' }
  const contents = window.webContents
  try {
    const raw: unknown = await contents.executeJavaScriptInIsolatedWorld(VIEWER_RECT_WORLD_ID, [{ code: VIEWER_RECT_SCRIPT }])
    if (window.isDestroyed()) return { ok: false, reason: 'closed' }
    const [width, height] = window.getContentSize()
    const rect = viewerCaptureRect(raw, contents.getZoomFactor(), { width: width ?? 0, height: height ?? 0 })
    if (rect === null) return { ok: false, reason: 'hidden' }
    const image = (await contents.capturePage(rect)) as unknown as NativeImageLike
    const encoded = encodeScreenshot(image)
    return encoded === null ? { ok: false, reason: 'empty' } : { ok: true, ...encoded }
  } catch {
    return window.isDestroyed() ? { ok: false, reason: 'closed' } : { ok: false, reason: 'failed' }
  }
}
