/**
 * Cleanup of attachments piled up by Drop (items 253 / 258).
 *
 * The attachment receiver was raised to the whole conversation pane (`ThreadPane`), but the band "this file is outside the reference range; make it
 * readable?" appears above the Composer. This small store (kept per thread) connects the two.
 * The attachments themselves are piled in `useThreads.attachments[threadId]`: even if dropped while the Composer is hidden
 * (awaiting approval, items 166 / 182), they are visible when it returns after approval.
 */
import { create } from 'zustand'
import { useThreads } from './threadStore.js'

/** One that could not become an attachment (TODO 489). `reason` is a reason code (7.4.4) or the raw sentence from the choke point. */
export interface AttachFailure {
  readonly uri: string
  readonly reason: string
}

interface DropState {
  /** An attachment (URI) that was outside the reference range. Kept to ask the user for permission. */
  outside: Readonly<Record<string, readonly string[]>>
  addOutside(threadId: string, uri: string): void
  clearOutside(threadId: string): void
  /**
   * Things that could not become attachments (TODO 489). **Do not stay silent when something fails**: reasons such as excluded, not an image, too large, or vanished
   * are shown above the Composer, in the same place as the permission band. The same URI is collapsed to one entry with the last reason.
   */
  failed: Readonly<Record<string, readonly AttachFailure[]>>
  addFailed(threadId: string, failure: AttachFailure): void
  /** Clear the failure of a URI that could be attached later (when it passes after being dropped again). */
  forgetFailed(threadId: string, uri: string): void
  clearFailed(threadId: string): void
  /**
   * Folders for which "add to reference range" was refused (TODO 600). `uri` is the folder's URI, `reason` is a reason code or the choke point's sentence.
   * Formerly main only wrote a log and returned silently, so the band just vanished.
   */
  allowFailed: Readonly<Record<string, readonly AttachFailure[]>>
  setAllowFailed(threadId: string, failures: readonly AttachFailure[]): void
  clearAllowFailed(threadId: string): void
}

/** An empty array so that the selector does not return a new array every time (the React #185 pitfall). */
export const NO_OUTSIDE: readonly string[] = []
export const NO_FAILED: readonly AttachFailure[] = []

export const useDropNotices = create<DropState>((set) => ({
  allowFailed: {},
  setAllowFailed(threadId, failures) {
    set((state) => {
      if (failures.length > 0) return { allowFailed: { ...state.allowFailed, [threadId]: [...failures] } }
      if (state.allowFailed[threadId] === undefined) return state
      const rest = { ...state.allowFailed }
      delete rest[threadId]
      return { allowFailed: rest }
    })
  },
  clearAllowFailed(threadId) {
    set((state) => {
      if (state.allowFailed[threadId] === undefined) return state
      const rest = { ...state.allowFailed }
      delete rest[threadId]
      return { allowFailed: rest }
    })
  },
  failed: {},
  addFailed(threadId, failure) {
    set((state) => {
      const current = (state.failed[threadId] ?? NO_FAILED).filter((f) => f.uri !== failure.uri)
      return { failed: { ...state.failed, [threadId]: [...current, failure] } }
    })
  },
  forgetFailed(threadId, uri) {
    set((state) => {
      const current = state.failed[threadId]
      if (current === undefined || !current.some((f) => f.uri === uri)) return state
      const next = current.filter((f) => f.uri !== uri)
      if (next.length > 0) return { failed: { ...state.failed, [threadId]: next } }
      const rest = { ...state.failed }
      delete rest[threadId]
      return { failed: rest }
    })
  },
  clearFailed(threadId) {
    set((state) => {
      if (state.failed[threadId] === undefined) return state
      const rest = { ...state.failed }
      delete rest[threadId]
      return { failed: rest }
    })
  },
  outside: {},
  addOutside(threadId, uri) {
    set((state) => {
      const current = state.outside[threadId] ?? NO_OUTSIDE
      if (current.includes(uri)) return state
      return { outside: { ...state.outside, [threadId]: [...current, uri] } }
    })
  },
  clearOutside(threadId) {
    set((state) => {
      if (state.outside[threadId] === undefined) return state
      const rest = { ...state.outside }
      delete rest[threadId]
      return { outside: rest }
    })
  }
}))

/**
 * Make selected / dropped / pasted files attachments of the thread (a single path, item 161).
 *
 * The first `resolveAttachment` goes out to main inside the caller's drop event (before the first await):
 * the temporary file of a ⌘⇧4 thumbnail may be deleted right after the drop, so the earlier main reads it the better (TODO 489).
 */
export async function attachUris(threadId: string, uris: readonly string[]): Promise<void> {
  for (const uri of uris) {
    const outcome = await useThreads.getState().addAttachment(threadId, uri)
    const notices = useDropNotices.getState()
    if (!outcome.ok) {
      notices.addFailed(threadId, { uri, reason: outcome.reason })
      continue
    }
    notices.forgetFailed(threadId, uri)
    if (outcome.outside !== null) notices.addOutside(threadId, outcome.outside)
  }
}

/** The URI of a file URI's parent folder (the unit added to the reference range, 4.5). */
export function dirnameOfUri(uri: string): string {
  return uri.slice(0, uri.lastIndexOf('/'))
}

/**
 * "Add to reference range" of the permission band (4.5). Add the parent folders of the outside attachments one by one (the same folder once),
 * and leave the refused ones in the band with their reasons (TODO 600: do not silently dismiss the band). The permission band closes immediately.
 */
export async function allowOutsideDirs(threadId: string, uris: readonly string[]): Promise<void> {
  const notices = useDropNotices.getState()
  notices.clearOutside(threadId)
  notices.clearAllowFailed(threadId)
  const failures: AttachFailure[] = []
  for (const dir of [...new Set(uris.map(dirnameOfUri))]) {
    const reason = await useThreads.getState().allowDir(threadId, dir)
    if (reason !== null) failures.push({ uri: dir, reason })
  }
  useDropNotices.getState().setAllowFailed(threadId, failures)
}
