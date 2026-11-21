/**
 * The band for a link that could not be opened (TODO 808 / 816, ARCHITECTURE.md 5.1).
 *
 * When main's `fs.resolveLink` attaches the material for a next step to the reason (`choices` / `tried` / `searchName` /
 * `handoffUri` of `LinkFailure`), it is placed here instead of the band at the top of the window (`app-error`), and
 * `LinkNotice` draws it. A failure without such material goes to `app-error` as before (`notify` in `markdown-link.ts`).
 * **It stays until dismissed** (so it does not vanish before the button is pressed): it goes away on ✕ / Esc / the next
 * link / when a candidate is chosen or the link is handed off.
 */
import { create } from 'zustand'
import type { LinkFailure } from '@shared/link.js'

interface LinkNoticeState {
  readonly notice: LinkFailure | null
  show(notice: LinkFailure): void
  clear(): void
}

export const useLinkNotice = create<LinkNoticeState>((set) => ({
  notice: null,
  show(notice): void {
    set({ notice })
  },
  clear(): void {
    set({ notice: null })
  }
}))

/** Whether there is material to show in the band (if not, the usual one line in `app-error`). */
export function hasLinkNextSteps(failure: LinkFailure): boolean {
  return (
    (failure.choices?.length ?? 0) > 0 ||
    (failure.tried?.length ?? 0) > 0 ||
    failure.searchName !== undefined ||
    failure.handoffUri !== undefined ||
    failure.restoreThread !== undefined
  )
}

/**
 * TODO 995: a small bubble ("not found") shown next to the link that was pressed. The band (`LinkNotice`) is at the top edge of
 * the window, far from where the user pressed, and gets overlooked; so the band stays and this is added for a few seconds when
 * the link could not be resolved. No stat is done at render time.
 */
export const LINK_POPOVER_MS = 2500

export interface LinkPopoverState {
  /** Position on screen (viewport): the bottom left of the pressed link. */
  readonly x: number
  readonly y: number
  readonly kind: 'notFound' | 'denied'
  /** A serial number to avoid forgetting to clear, or clearing the wrong one. */
  readonly seq: number
}

interface LinkPopoverStore {
  readonly popover: LinkPopoverState | null
  show(anchor: { x: number; y: number }, kind: LinkPopoverState['kind']): void
  clear(): void
}

let popoverSeq = 0
let popoverTimer: ReturnType<typeof setTimeout> | null = null

export const useLinkPopover = create<LinkPopoverStore>((set, get) => ({
  popover: null,
  show(anchor, kind): void {
    if (popoverTimer !== null) clearTimeout(popoverTimer)
    const seq = ++popoverSeq
    set({ popover: { x: anchor.x, y: anchor.y, kind, seq } })
    popoverTimer = setTimeout(() => {
      popoverTimer = null
      if (get().popover?.seq === seq) set({ popover: null })
    }, LINK_POPOVER_MS)
  },
  clear(): void {
    if (popoverTimer !== null) clearTimeout(popoverTimer)
    popoverTimer = null
    set({ popover: null })
  }
}))

/** The reasons to show a bubble (not found / refused for an excluded location). Other cases (several candidates, etc.) get only the band. */
export function popoverKindFor(reason: string): LinkPopoverState['kind'] | null {
  if (reason === 'link-not-found') return 'notFound'
  if (reason === 'link-excluded') return 'denied'
  return null
}
