/**
 * The renderer side of carrying unsaved drafts over an idle restart for an update (TODO 1333, ARCHITECTURE 8.5).
 *
 * - **Collect**: right before an idle restart main asks every window (`update.onCollectDrafts`). The answer is the Composer text per thread (**only that**: the viewer's
 *   unsaved drafts are not carried and hold the restart in main). **Attachments cannot be carried**, so a window holding any answers
 *   `carriable: false` and the restart waits (losing text is worse than waiting). Over the size limits is the same.
 * - **Restore**: at launch the window asks once (`update.takeCarriedDrafts`) and puts the text back into the Composer's `drafts`
 *   **without overwriting anything the window already holds**.
 *
 * Independent of React and electron (the API and the stores are passed in), so `test/carried-drafts.test.ts` tests it directly.
 */
import type { Attachment } from '@shared/thread.js'
import { parseCarriedDrafts, type CarriedDrafts, type CarriedDraftsReply, type CarriedDraftsRequest } from '@shared/update.js'

export interface CarriedDraftsSources {
  readonly drafts: Readonly<Record<string, string>>
  readonly attachments: Readonly<Record<string, readonly Attachment[]>>
}

/** What this window answers to a collect request. */
export function collectCarriedDrafts(sources: CarriedDraftsSources): CarriedDraftsReply {
  for (const list of Object.values(sources.attachments)) if (list.length > 0) return { carriable: false }
  const composer: Record<string, string> = {}
  for (const [threadId, text] of Object.entries(sources.drafts)) if (text.trim() !== '') composer[threadId] = text
  const drafts = parseCarriedDrafts({ composer })
  return drafts === null ? { carriable: false } : { carriable: true, drafts }
}

/** Put carried drafts back without overwriting anything this window holds (a blank Composer text counts as nothing). */
export function mergeRestoredDrafts(current: { readonly drafts: Readonly<Record<string, string>> }, carried: CarriedDrafts): { readonly drafts: Record<string, string> } {
  const drafts: Record<string, string> = { ...current.drafts }
  for (const [threadId, text] of Object.entries(carried.composer)) {
    if ((drafts[threadId] ?? '').trim() === '') drafts[threadId] = text
  }
  return { drafts }
}

export interface CarriedDraftsApi {
  onCollectDrafts(listener: (request: CarriedDraftsRequest) => void): unknown
  submitDrafts(requestId: string, reply: CarriedDraftsReply): Promise<void>
  takeCarriedDrafts(): Promise<CarriedDrafts | null>
}

export interface CarriedDraftsDeps {
  readonly sources: () => CarriedDraftsSources
  /** Write the merged result back into the stores. */
  readonly apply: (merged: { readonly drafts: Record<string, string> }) => void
}

/** Wire both directions. A missing entry point (an old preload / a test fake) does nothing. */
export function installCarriedDrafts(api: Partial<CarriedDraftsApi> | undefined, deps: CarriedDraftsDeps): void {
  if (api === undefined) return
  const { onCollectDrafts, submitDrafts, takeCarriedDrafts } = api
  if (typeof onCollectDrafts === 'function' && typeof submitDrafts === 'function') {
    onCollectDrafts.call(api, (request) => {
      let reply: CarriedDraftsReply
      try {
        reply = collectCarriedDrafts(deps.sources())
      } catch {
        reply = { carriable: false }
      }
      void submitDrafts.call(api, request.id, reply).catch(() => undefined)
    })
  }
  if (typeof takeCarriedDrafts === 'function') {
    void takeCarriedDrafts
      .call(api)
      .then((carried) => {
        if (carried === null) return
        deps.apply(mergeRestoredDrafts(deps.sources(), carried))
      })
      .catch(() => undefined)
  }
}
