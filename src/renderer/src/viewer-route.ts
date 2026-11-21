/**
 * The decision of what ViewerPane may send to and receive from the iframe's port (item 149).
 *
 * **Switch mismatch.** When the URI changes, ViewerPane rebuilds `push` within the same render, but
 * resolving the new URI's viewer (`viewer.open`) and reading the contents (`viewer.read`) come back later
 * through IPC round trips. In the meantime `viewer` and `resource` are **still the previous file's**, and the port belongs
 * to the previous iframe. Previously, in this gap, "the new URI + the previous file's contents" was sent to the previous iframe.
 * For Markdown -> PNG, `aios.markdown` would request the heading list (the plugin-host's `outline`) with the PNG's URI, and the Broker refused
 * it with `no-grant` because it has no grant for that URI.
 *
 * So the contents carry "which URI they were read for, and for which plugin", and are sent only when these three agree:
 * (1) the URI that should be shown now, (2) the current viewer, and (3) the `src` of the iframe the port was handed to.
 * Files of the same plugin (md -> md) do not rebuild the iframe (the Phase 4 rule), so once the new file's contents are read
 * they go to the same port.
 *
 * Pure functions independent of electron and React, so `test/viewer-route.test.ts` tests them directly.
 */
import type { ViewerResource } from '@shared/types.js'

/** The contents read and their origin (the URI and the viewer's plugin at the time of reading). */
export interface LoadedResource {
  readonly uri: string
  readonly pluginId: string
  readonly resource: ViewerResource
  /**
   * The draft restored from the table when reading (TODO 312, wave 18 bundle B). Sent to the viewer together with `resource`, and
   * the viewer shows it instead of the body. It is not attached to contents rebuilt by a save or a re-read.
   */
  readonly draft?: string
}

/** Only the part of the viewer's resolution result that the decision needs (a subset of `ResolvedViewer`). */
export interface RouteViewer {
  readonly pluginId: string
  readonly url: string
}

/**
 * The contents belonging to the URI being shown and the current viewer. null if they do not belong (still reading the new file).
 * Whether it can be edited, whether it is unsaved, and the save base also do not use the previous file's values while this is null.
 */
export function currentResource(
  uri: string | null,
  viewer: RouteViewer | null,
  loaded: LoadedResource | null
): ViewerResource | null {
  if (uri === null || viewer === null || loaded === null) return null
  if (loaded.uri !== uri || loaded.pluginId !== viewer.pluginId) return null
  return loaded.resource
}

/**
 * The contents that may be sent to the port. `portUrl` is the `src` of the iframe the port was handed to (null if none).
 * Even if the contents are ready, they are not sent if the port belongs to another viewer's iframe.
 */
export function routableResource(
  uri: string | null,
  viewer: RouteViewer | null,
  loaded: LoadedResource | null,
  portUrl: string | null
): ViewerResource | null {
  if (viewer === null || portUrl !== viewer.url) return null
  return currentResource(uri, viewer, loaded)
}

/**
 * Whether to accept a draft that arrived from the viewer. Only when what the viewer is drawing is the URI being shown
 * (the URI last sent to that port). Even if the previous file's draft arrives in the middle of a switch,
 * it is not held as the new file's draft.
 */
export function acceptsDraft(pushedUri: string | null, uri: string | null, draftUri?: unknown): boolean {
  // TODO 938: the file the draft was drawn for (the `draft.uri` the viewer declares) is treated the same as the `resource` sent now.
  // A draft the viewer sent about the previous file before it received the new `resource` arrives when `pushedUri` already points to
  // the next file, so without the URI it would be accepted as the next file's draft.
  if (draftUri !== undefined && draftUri !== pushedUri) return false
  return uri !== null && pushedUri === uri
}

/**
 * A revision per read contents (items 309-2 / 303, wave 16 bundle I). The contents object is rebuilt on every `setLoaded`
 * (new file, save, re-read), so a number is assigned per object. Resending `resource` on a change of theme / language / search term or on `ready`
 * is the same object, hence the same number - the viewer sees that and does not replace the body
 * (`plugins/_shared/resource-update.ts`).
 */
export class ResourceRevisions {
  private readonly ids = new WeakMap<LoadedResource, number>()
  private last = 0

  of(loaded: LoadedResource): number {
    const known = this.ids.get(loaded)
    if (known !== undefined) return known
    this.last += 1
    this.ids.set(loaded, this.last)
    return this.last
  }

  /**
   * Gives `next` the same revision as `prev` (TODO 555). When characters were typed during the save round trip - sending a new revision makes the viewer
   * replace the body with the saved one because "the body differs from the current editor", losing the typed characters and the cursor (hit often with auto-save).
   * With the same revision, `samePush` does not resend, and the viewer keeps the editor as is.
   */
  carry(prev: LoadedResource, next: LoadedResource): void {
    this.ids.set(next, this.of(prev))
  }
}

/** The contents of the `resource` last sent to the port (to throttle host-side resends). */
export interface PushedResource {
  readonly port: unknown
  readonly uri: string
  readonly revision: number
  readonly editable: boolean
  readonly theme: string
  readonly locale: string
  readonly highlightQuery: string | null
  /**
   * The identity of the record of key assignments (`ui.keybindings` of TODO 549). When it changes, resend even with the same revision and replace the open viewer's
   * send-back table (`shortcuts`) (proxy verification 620-1, run 33. Before, the stale table stayed until the next `resource`).
   */
  readonly keybindings?: unknown
}

/**
 * Do not send the same `resource` to the same port twice (item 309-2). A new iframe ran `push` twice, right after load and on the bridge's
 * `ready`, and the same contents arrived twice. Port messages queue until the other side
 * receives the port, so what was sent right after load is not lost - the second is not needed.
 * If even one thing differs it is sent (theme / language changes etc. still arrive as before).
 */
export function samePush(prev: PushedResource | null, next: PushedResource): boolean {
  return (
    prev !== null &&
    prev.port === next.port &&
    prev.uri === next.uri &&
    prev.revision === next.revision &&
    prev.editable === next.editable &&
    prev.theme === next.theme &&
    prev.locale === next.locale &&
    prev.highlightQuery === next.highlightQuery &&
    prev.keybindings === next.keybindings
  )
}
