/**
 * The only entry point on main's side for opening a URL in an external browser (ARCHITECTURE.md 5.1 "External links").
 *
 * There are three paths, but the decision is gathered in this one place:
 *
 *   - the renderer's IPC (`aios:app/openExternal`) - links in the timeline
 *   - viewer plugin -> ViewerPane (host) -> the same IPC - links in the Markdown viewer
 *   - `setWindowOpenHandler` - new-window requests such as `target="_blank"`
 *
 * **Values from the renderer are not trusted.** The decision is a pure function in `@shared/open-external.js`;
 * everything other than `http:` / `https:` / `mailto:` is rejected and recorded in the structured log.
 * The log holds only the scheme and the length (and the host name when allowed), never the whole URL
 * (the convention "do not log argument values").
 *
 * `electron` is not imported so that this runs in Vitest (plain Node). The function that actually opens
 * (`shell.openExternal`) is passed in by the caller.
 */
import { externalUrlProtocol, isOpenableExternally } from '@shared/open-external.js'
import { log, errorFields } from '../common/logger.js'

export { isOpenableExternally, externalUrlProtocol } from '@shared/open-external.js'

/** Which path the request came from. For separating log entries. */
export type ExternalOpenOrigin = 'ipc' | 'window-open'

export type ExternalOpener = (url: string) => Promise<void>

function hostOf(url: string): string | null {
  try {
    const host = new URL(url).host
    return host === '' ? null : host
  } catch {
    return null
  }
}

/**
 * Checks, then passes to `open`. **Returns `true` only when it passed (allowed).**
 *
 * A failure of `open` (no handler on the OS side, etc.) is not thrown; it is logged and `false` is returned.
 * Throwing back to the renderer would carry no more information than "could not open".
 */
export async function openExternalChecked(
  url: unknown,
  open: ExternalOpener,
  origin: ExternalOpenOrigin
): Promise<boolean> {
  const protocol = externalUrlProtocol(url)
  if (!isOpenableExternally(url) || typeof url !== 'string') {
    log.warn('open-external.rejected', {
      origin,
      protocol,
      length: typeof url === 'string' ? url.length : null,
      type: typeof url
    })
    return false
  }
  try {
    await open(url)
    log.info('open-external.opened', { origin, protocol, host: hostOf(url) })
    return true
  } catch (err) {
    log.warn('open-external.failed', { origin, protocol, ...errorFields(err) })
    return false
  }
}
