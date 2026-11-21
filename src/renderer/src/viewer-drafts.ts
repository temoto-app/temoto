/**
 * Remembers the viewer's unsaved drafts per file (small observation in TODO 312, wave 18 bundle B).
 *
 * Previously ViewerPane called `setDraft(null)` every time the URI changed, so a draft was silently lost when moving to another file
 * through a link with a line number, the tree, search, or a thread switch while holding a draft.
 * **Owner decision (2026-10-03): like a dirty tab in VS Code, remember the draft per file and restore it
 * when the user comes back. Do not add a confirmation dialog.**
 *
 *   - The table key is **the URI only** (the thread is not part of the key). There is one file on disk, so opening the same file in
 *     another thread shows the same draft (like two VS Code editor groups sharing the same dirty
 *     buffer). The table is per window (per renderer) and is not shared across windows.
 *   - **Renderer memory only.** It is passed neither to the DB nor to main (main gets only the count, to stop the auto-update idle
 *     restart, code review of TODO 103). It is gone after an app restart.
 *   - Entries disappear when: saved / "reload from disk" / closed with the close button (including "close without saving" in the unsaved
 *     confirmation) / the edit was undone back to the original body. The viewer closing on a thread switch
 *     (the destination thread has no memory) is not "closing", so the draft stays.
 *   - `baseMtimeMs` is the mtime of the contents the draft was based on. If it differs from the mtime of the contents re-read on return,
 *     the disk changed while the user was away (a model Edit / another process), and it goes onto the existing draft conflict band
 *     (item 97 second half, the shape of bundle J in TODO 313).
 *
 * Pure functions independent of electron and React, so `test/viewer-drafts.test.ts` tests them directly.
 */
import type { ViewerResource } from '@shared/types.js'

interface DraftTableSource {
  readonly viewerDrafts: DraftTable
}

interface Subscribable<S> {
  getState(): S
  subscribe(listener: (state: S, previous: S) => void): () => void
}

/**
 * Tells main the number of entries in the drafts table (code review of TODO 103). Calls `report` only when the count changes. Neither bodies nor URIs
 * are sent. The first call is sent unless it is 0 (a reloaded window has been forgotten on the main side - `closeView`). The return value unsubscribes.
 */
export function installViewerDraftCountReport<S extends DraftTableSource>(
  store: Subscribable<S>,
  report: (count: number) => Promise<void> | void
): () => void {
  let last = 0
  const send = (state: S): void => {
    const count = Object.keys(state.viewerDrafts).length
    if (count === last) return
    last = count
    void Promise.resolve(report(count)).catch(() => undefined)
  }
  send(store.getState())
  return store.subscribe((state, previous) => {
    if (state.viewerDrafts !== previous.viewerDrafts) send(state)
  })
}

/** One remembered draft. */
export interface StoredDraft {
  /** The draft body. */
  readonly text: string
  /** The mtime of the contents (as read from disk) the draft is based on. Used for the save conflict check. */
  readonly baseMtimeMs: number
}

/** URI -> draft. */
export type DraftTable = Readonly<Record<string, StoredDraft>>

/** The result of deciding what to restore on return. */
export interface DraftRestore {
  /** The contents ViewerPane holds. On a conflict the mtime is reset to the base value (a normal save is refused by main with `conflict`). */
  readonly resource: ViewerResource
  /** The draft to restore. null if none. */
  readonly draft: string | null
  /** The disk contents changed while the user was away (shows the draft conflict band). */
  readonly conflict: boolean
  /** This URI may be removed from the table (the draft became identical to the original body). */
  readonly forget: boolean
}

/**
 * The base of a draft (= if the draft equals this, it is not unsaved). For text it is the body; for an `.xlsx` that accepts cell-value drafts
 * (TODO 1212 stage 1, `resource.cellEdits`) it is the empty string (the edit list is empty). null for contents that cannot hold a draft (error, truncated,
 * read-only, plain binary).
 */
export function draftBaseOf(resource: ViewerResource | null): string | null {
  if (resource === null) return null
  if (resource.kind === 'text') return resource.truncated || resource.readOnly === true ? null : resource.text
  if (resource.kind === 'binary') return resource.cellEdits === true ? '' : null
  return null
}

/**
 * Overlays the remembered draft `stored` on the re-read contents `resource`.
 *
 * - Nothing remembered -> as is.
 * - Not body text (error, plain binary), truncated, or read-only -> do not restore (cannot be edited). **Keep** it in the table
 *   (an `.xlsx` that accepts cell-value drafts has the empty string as its base and is treated like text - TODO 1212 stage 1).
 *   (A file that is only temporarily unreadable must not lose the draft. It goes away when closed.)
 * - The draft equals the disk contents -> do not restore (it is not unsaved). Remove it from the table.
 * - mtime equals the base -> restore the draft.
 * - mtime differs -> restore the draft and report a conflict. The contents' mtime is reset to the base - after the band is closed a
 *   normal save hits main's mtime check (`ViewerBroker.write`) and gets `conflict`, so it never overwrites silently
 *   (same behavior as closing the band and saving after the model wrote). Overwriting is done from "Overwrite and save" on the band.
 */
export function restoreDraft(stored: StoredDraft | undefined, resource: ViewerResource): DraftRestore {
  const none = { resource, draft: null, conflict: false }
  if (stored === undefined) return { ...none, forget: false }
  const base = draftBaseOf(resource)
  if (base === null || resource.kind === 'error') return { ...none, forget: false }
  if (stored.text === base) return { ...none, forget: true }
  if (stored.baseMtimeMs === resource.mtimeMs) {
    return { resource, draft: stored.text, conflict: false, forget: false }
  }
  return {
    resource: { ...resource, mtimeMs: stored.baseMtimeMs },
    draft: stored.text,
    conflict: true,
    forget: false
  }
}

/**
 * The operation when mirroring the current draft into the table. `resource` is the contents of the URI being shown (`currentResource`);
 * in the middle of a switch (null) nothing is done, so the previous file's draft is not written under the new URI.
 */
export type DraftSync =
  | { readonly kind: 'none' }
  | { readonly kind: 'remember'; readonly draft: StoredDraft }
  | { readonly kind: 'forget' }

export function syncDraft(draft: string | null, resource: ViewerResource | null): DraftSync {
  const base = draftBaseOf(resource)
  if (draft === null || resource === null || resource.kind === 'error' || base === null) return { kind: 'none' }
  if (draft === base) return { kind: 'forget' }
  return { kind: 'remember', draft: { text: draft, baseMtimeMs: resource.mtimeMs } }
}

/** Writes one entry to the table (returns the same table for the same value, so store subscriptions are not woken needlessly). */
export function withDraft(table: DraftTable, uri: string, draft: StoredDraft): DraftTable {
  const known = table[uri]
  if (known !== undefined && known.text === draft.text && known.baseMtimeMs === draft.baseMtimeMs) {
    return table
  }
  return { ...table, [uri]: draft }
}

/** Removes one entry from the table (returns the same table if absent). */
export function withoutDraft(table: DraftTable, uri: string): DraftTable {
  if (!(uri in table)) return table
  const next: Record<string, StoredDraft> = { ...table }
  delete next[uri]
  return next
}
