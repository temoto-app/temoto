/**
 * Open a dropped file in the viewer (TODO 563, wave 27 bundle D).
 *
 * - The overlay of the conversation pane (`pane-drop.ts`) went back to attaching over the whole area in TODO 913 (wave 48) (563's left/right split was abolished).
 * - ViewerPane (`viewer-drop.ts`) opens it if the viewer does not accept edits; while editing it inserts as before (opens if ⌥ is held).
 * - **The choke point is main's `drop.checkLinks`** (`FsAccess.assertAllowed(…, 'read')` + existence, the same entry point as 366). The first file
 *   that passes (folders skipped) is shown in ViewerPane with `select`. Loading for display passes through the choke point again in ViewerBroker.
 * - If refused, the reason goes to the band above the window (`app-error`, the same `notify` as links in the body).
 */
import { MAX_DROP_LINKS, type DropLinkCheck } from '@shared/drop-link.js'
import { notify } from './markdown-link.js'
import { useStore } from './store.js'

/** The result of opening (for tests and logs). */
export type DropOpenOutcome = 'opened' | 'denied' | 'none'

/**
 * Pass a list of URIs through the choke point and open the first file that passes in ViewerPane. Even when several are dropped, only one is opened
 * (there is one ViewerPane; the rest are not opened). Do nothing if there are only folders.
 */
export async function openDroppedUris(
  uris: readonly string[],
  check: (uris: readonly string[]) => Promise<DropLinkCheck>,
  deps: { readonly open?: (uri: string) => void; readonly notice?: (reason: string) => void } = {}
): Promise<DropOpenOutcome> {
  if (uris.length === 0) return 'none'
  const result = await check(uris.slice(0, MAX_DROP_LINKS))
  const file = result.allowed.find((target) => !target.isDirectory)
  if (file !== undefined) {
    ;(deps.open ?? ((uri: string) => useStore.getState().select(uri)))(file.uri)
    return 'opened'
  }
  const denied = result.denied[0]
  if (denied !== undefined) {
    ;(deps.notice ?? notify)(denied.reason)
    return 'denied'
  }
  return 'none'
}
