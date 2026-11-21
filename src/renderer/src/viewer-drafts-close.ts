/**
 * The renderer side of the viewer's unsaved drafts before closing a window / quitting the app (TODO 606, wave 29 bundle B, ARCHITECTURE 5.2.2).
 *
 * Drafts live in two places: the draft of the file currently shown (ViewerPane's state), and the per-file table (`viewerDrafts`,
 * TODO 312 - the shown file's draft is also mirrored there by an effect). Before the window's `close` / `before-quit`, main asks only the
 * renderer of the window being closed (`viewer.onDraftsRequest`):
 *
 *   - `list` - returns the URIs of unsaved drafts (bodies are not sent). The material for the "Save?" prompt when auto-save is OFF.
 *   - `save` - writes everything and returns whatever could not be written. **The shown file is saved by ViewerPane itself**
 *     (`registerPaneSaver`) - writing from outside leaves ViewerPane's base mtime stale, so after a "Cancel" that did not close the window,
 *     the next save would wrongly become a conflict. Files that were left are written from the table with `viewer.open` -> `viewer.write` (passing the base mtime - if the disk side
 *     changed, main refuses with `conflict`) -> `viewer.close`. Files showing a conflict band are not written.
 *   - If a write is in flight (auto-save, background save), wait for it to finish first (`trackSave`). Without waiting, the same draft would be
 *     written twice with a stale mtime, and whichever arrives first advances the mtime so the second wrongly becomes a conflict.
 *
 * Independent of electron and React (entry points are passed as arguments), so `test/viewer-drafts-close-renderer.test.ts` tests it directly.
 */
import type { ResolvedViewer } from '@shared/plugin.js'
import type { TextWriteResult } from '@shared/types.js'
import type { ViewerDraftEntry, ViewerDraftsReply, ViewerDraftsRequest } from '@shared/viewer-drafts-close.js'
import type { DraftTable } from './viewer-drafts.js'

const inFlight = new Set<Promise<unknown>>()

/** Counts a viewer write (`viewer.write`) as "in flight". Returns the same Promise as is. */
export function trackSave<T>(promise: Promise<T>): Promise<T> {
  inFlight.add(promise)
  const done = (): void => {
    inFlight.delete(promise)
  }
  promise.then(done, done)
  return promise
}

/** Waits until all writes currently in flight have finished (including ones that start while waiting). */
export async function settleInFlightSaves(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight])
}

/** The result of ViewerPane saving by itself. `skip` means "nothing is shown / not ready - write from the table". */
export type PaneSaveResult = 'saved' | 'conflict' | 'failed' | 'skip'

export interface PaneSaver {
  /** The file currently shown. null if none. */
  uri(): string | null
  /** Whether there are unsaved edits. */
  dirty(): boolean
  save(): Promise<PaneSaveResult>
}

let paneSaver: PaneSaver | null = null

/** ViewerPane registers it (one viewer per window). The return value unregisters. */
export function registerPaneSaver(saver: PaneSaver): () => void {
  paneSaver = saver
  return () => {
    if (paneSaver === saver) paneSaver = null
  }
}

export function currentPaneSaver(): PaneSaver | null {
  return paneSaver
}

export interface DraftsCloseDeps {
  readonly table: () => DraftTable
  /** The file showing a conflict band (null if none). */
  readonly conflictUri: () => string | null
  /** Written, so remove it from the table (provided the table's draft is still the text that was written). */
  readonly forget: (uri: string, text: string) => void
  readonly pane: () => PaneSaver | null
  readonly open: (uri: string) => Promise<ResolvedViewer | null>
  readonly write: (pluginId: string, uri: string, text: string, baseMtimeMs: number) => Promise<TextWriteResult>
  readonly close: (pluginId: string, uri: string) => Promise<void> | void
}

/** Unsaved drafts (those in the table, plus the shown file's if it is not yet mirrored in the table). */
export function listDrafts(deps: DraftsCloseDeps): ViewerDraftsReply {
  const conflictUri = deps.conflictUri()
  const uris = Object.keys(deps.table())
  const pane = deps.pane()
  const paneUri = pane?.uri() ?? null
  if (pane !== null && paneUri !== null && pane.dirty() && !uris.includes(paneUri)) uris.push(paneUri)
  return { unsaved: uris.map((uri) => ({ uri, conflict: uri === conflictUri })) }
}

/** Writes one draft of a file that was left. */
async function writeStored(
  deps: DraftsCloseDeps,
  uri: string,
  text: string,
  baseMtimeMs: number
): Promise<ViewerDraftEntry | null> {
  let resolved: ResolvedViewer | null = null
  try {
    resolved = await deps.open(uri)
  } catch {
    resolved = null
  }
  if (resolved === null) return { uri, conflict: false }
  try {
    const result = await trackSave(deps.write(resolved.pluginId, uri, text, baseMtimeMs))
    if (result.ok) {
      deps.forget(uri, text)
      return null
    }
    return { uri, conflict: result.reason === 'conflict' }
  } catch {
    return { uri, conflict: false }
  } finally {
    try {
      await deps.close(resolved.pluginId, uri)
    } catch {
      // A permission left unreturned goes away when the window closes.
    }
  }
}

/** Writes everything and returns whatever could not be written. */
export async function flushDrafts(deps: DraftsCloseDeps): Promise<ViewerDraftsReply> {
  await settleInFlightSaves()
  const unsaved: ViewerDraftEntry[] = []
  const handled = new Set<string>()
  const pane = deps.pane()
  const paneUri = pane?.uri() ?? null
  if (pane !== null && paneUri !== null && pane.dirty()) {
    let result: PaneSaveResult
    try {
      result = await pane.save()
    } catch {
      result = 'failed'
    }
    if (result !== 'skip') {
      handled.add(paneUri)
      if (result !== 'saved') unsaved.push({ uri: paneUri, conflict: result === 'conflict' })
    }
  }
  const conflictUri = deps.conflictUri()
  for (const [uri, stored] of Object.entries(deps.table())) {
    if (handled.has(uri)) continue
    if (uri === conflictUri) {
      unsaved.push({ uri, conflict: true })
      continue
    }
    const left = await writeStored(deps, uri, stored.text, stored.baseMtimeMs)
    if (left !== null) unsaved.push(left)
  }
  return { unsaved }
}

/** The entry point that answers the request (part of the preload's `viewer`). */
export interface DraftsCloseApi {
  onDraftsRequest?: (listener: (request: ViewerDraftsRequest) => void) => unknown
  replyDrafts?: (id: number, reply: ViewerDraftsReply) => Promise<void>
  /** Received `save` (code review of TODO 606). If absent, nothing is sent (main waits for a short limit as before). */
  ackDrafts?: (id: number, pending: ViewerDraftsReply) => Promise<void>
}

/** Receives main's request and answers it. Does nothing if the entry point is missing (an old preload or a test fake). */
export function installViewerDraftsClose(api: DraftsCloseApi | undefined, deps: DraftsCloseDeps): void {
  if (api === undefined || typeof api.onDraftsRequest !== 'function' || typeof api.replyDrafts !== 'function') return
  const reply = api.replyDrafts.bind(api)
  const ack = typeof api.ackDrafts === 'function' ? api.ackDrafts.bind(api) : null
  api.onDraftsRequest((request) => {
    // `save` returns "received" before it starts writing (code review of TODO 606). Main waits long for the receiving window to finish writing,
    // and if it never finishes, the drafts listed here are turned into "could not be saved".
    if (request.action === 'save' && ack !== null) {
      let pending: ViewerDraftsReply
      try {
        pending = listDrafts(deps)
      } catch {
        pending = { unsaved: [] }
      }
      void ack(request.id, pending).catch(() => undefined)
    }
    const run = async (): Promise<ViewerDraftsReply> =>
      request.action === 'save' ? flushDrafts(deps) : listDrafts(deps)
    void run()
      .catch((): ViewerDraftsReply => listDrafts(deps))
      .then((result) => reply(request.id, result))
      .catch(() => undefined)
  })
}
