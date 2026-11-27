/**
 * Previous / next change navigation shared by the diff views and the patch view (TODO 1339 / 1341).
 *
 * No CodeMirror in here: the callers say where each target is (`locate`) and how to center it (`scroll`).
 *
 * **Which target "next" / "previous" starts from (TODO 1341 item 1, the same as VS Code).** Right after a jump the base is the
 * change that was jumped to. Once the person scrolls by themselves, the base is the middle of what is visible, so "next" is
 * the first change below it and "previous" the last one above it. A scroll counts as the person's only when an input
 * (wheel / pointer / key / touch) came after the last jump and then a scroll event followed; the scroll a jump causes
 * itself arrives with no such input in between, so it is told apart by state and not by a timer.
 */
import { vt } from '../../_shared/i18n.js'
import { watchRecenter } from '../../_shared/hit-nav.js'

/** Pixels of slack when comparing a change's top with the middle of the view (a centered change must not count as "below"). */
export const NAV_EPSILON = 1

/**
 * The change to go to from the middle of the view. `top(i)` is the vertical position of change `i` (ascending, ties allowed) and `ref`
 * the middle of the visible range, both in the same coordinates. Next is the first change below `ref`, previous the last one above it;
 * with none in that direction it wraps to the other end. Returns -1 for no changes.
 */
export function pickChunk(count: number, top: (index: number) => number, ref: number, direction: 1 | -1): number {
  if (count <= 0) return -1
  if (direction === 1) {
    // First index whose top is below the middle.
    let lo = 0
    let hi = count
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (top(mid) > ref + NAV_EPSILON) hi = mid
      else lo = mid + 1
    }
    return lo < count ? lo : 0
  }
  // Last index whose top is above the middle.
  let lo = 0
  let hi = count
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (top(mid) < ref - NAV_EPSILON) lo = mid + 1
    else hi = mid
  }
  return lo > 0 ? lo - 1 : count - 1
}

/** What `pickNav` needs to know about the view, all in the same coordinates. */
export interface NavView {
  /** The middle of the visible range. */
  readonly ref: number
  /** The visible range (top / bottom edge). Defaults to the middle alone when absent. */
  readonly viewTop?: number
  readonly viewBottom?: number
  /** The scroller is at its top / bottom end, so a change near that end cannot be brought to the middle. */
  readonly atStart?: boolean
  readonly atEnd?: boolean
  /** The top of change `i`. */
  readonly top: (index: number) => number
}

/**
 * The change to go to after the person scrolled (TODO 1341, review X2 / X3). One rule:
 * - The base is the middle of the view, except that "next" at the very top of the scroller uses the top edge and "previous" at the very
 *   bottom uses the bottom edge (changes near an end can never reach the middle, and would be skipped).
 * - If that picks the change the last jump went to (`current`) while it is still on screen, nothing would seem to happen (a jump centers
 *   a row by its middle, so its top sits half a row off the base), so go one step further in that direction.
 */
export function pickNav(count: number, view: NavView, direction: 1 | -1, current: number): number {
  if (count <= 0) return -1
  const viewTop = view.viewTop ?? view.ref
  const viewBottom = view.viewBottom ?? view.ref
  let ref = view.ref
  if (direction === 1 && view.atStart === true) ref = viewTop
  else if (direction === -1 && view.atEnd === true) ref = viewBottom
  const picked = pickChunk(count, view.top, ref, direction)
  if (picked === current && current >= 0) {
    const top = view.top(current)
    if (top >= viewTop - NAV_EPSILON && top <= viewBottom + NAV_EPSILON) return (picked + direction + count) % count
  }
  return picked
}

/** The `NavView` fields that come from a scroller element (client coordinates). */
export function scrollerView(scroller: HTMLElement): Omit<NavView, 'top'> {
  const rect = scroller.getBoundingClientRect()
  return {
    ref: rect.top + scroller.clientHeight / 2,
    viewTop: rect.top,
    viewBottom: rect.top + scroller.clientHeight,
    atStart: scroller.scrollTop <= 0,
    atEnd: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
  }
}

export interface NavParts {
  readonly group: HTMLSpanElement
  readonly prev: HTMLButtonElement
  readonly next: HTMLButtonElement
  readonly pos: HTMLSpanElement
}

function navButton(kind: 'prev' | 'next'): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.nav = kind
  button.textContent = kind === 'prev' ? '↑' : '↓'
  const key = kind === 'prev' ? 'Shift+F7' : 'F7'
  const label = vt(kind === 'prev' ? 'diffPrevChange' : 'diffNextChange')
  button.title = `${label} (${key})`
  button.setAttribute('aria-label', label)
  button.disabled = true
  return button
}

/** The `↑ N / M ↓` group for a toolbar. */
export function createNavGroup(): NavParts {
  const group = document.createElement('span')
  group.className = 'diff-nav'
  const prev = navButton('prev')
  const next = navButton('next')
  const pos = document.createElement('span')
  pos.className = 'diff-nav-pos'
  group.append(prev, pos, next)
  return { group, prev, next, pos }
}

export interface NavController {
  readonly count: number
  readonly current: () => number
  next(): void
  prev(): void
  destroy(): void
}

/** Where the changes are right now, in client coordinates (read at the time of a press, never cached). */
export type NavLocation = NavView

/** VS Code's diff editor keys: F7 / Shift+F7, and Alt+F5 / Shift+Alt+F5. The host's shortcut table has none of these. */
function navKey(event: KeyboardEvent): 'next' | 'prev' | null {
  if (event.ctrlKey || event.metaKey) return null
  const f7 = event.key === 'F7' && !event.altKey
  const altF5 = event.key === 'F5' && event.altKey
  if (!f7 && !altF5) return null
  return event.shiftKey ? 'prev' : 'next'
}

/**
 * Wires the previous / next buttons, the keys and the first-change jump to a list of `count` changes. `scroll(i)` centers change `i`.
 *
 * The automatic jump re-centers while the size settles (`watchRecenter`, the same wait as the search-hit jump): measuring the center
 * at the first frame drifts once the pane is laid out. It stops at the first wheel / pointer / key / touch, so a late
 * re-center never takes the position from a person who already scrolled. The target is the *current* change, so a jump the
 * person made with the buttons is what gets re-centered, not the first change.
 */
export function attachNav(args: {
  readonly parts: NavParts
  readonly body: HTMLElement
  readonly count: number
  readonly start: number
  /** Do not jump on open: nothing is current until the first press (the patch view opens at the top, with its file heading). */
  readonly idle?: boolean
  readonly scroll: (index: number) => void
  /** Where the changes are now, for the base after the person scrolled. Without it the base is always the last change jumped to. */
  readonly locate?: () => NavLocation | null
}): NavController {
  const { parts, body, count, scroll } = args
  let current = args.idle === true ? -1 : count > 0 ? Math.min(Math.max(Math.trunc(args.start) || 0, 0), count - 1) : -1
  // An input came after the last jump / a scroll followed that input: the person has moved the view since the last jump.
  let inputSinceJump = false
  let userMoved = false
  const show = (): void => {
    parts.prev.disabled = count === 0
    parts.next.disabled = count === 0
    parts.pos.textContent = count === 0 ? '' : `${current >= 0 ? current + 1 : '–'} / ${count}`
  }
  const go = (index: number): void => {
    current = index
    inputSinceJump = false
    userMoved = false
    scroll(index)
    show()
  }
  const step = (direction: 1 | -1): void => {
    if (count === 0) return
    const location = userMoved ? (args.locate?.() ?? null) : null
    if (location !== null) {
      go(pickNav(count, location, direction, current))
      return
    }
    if (current < 0) go(direction === 1 ? 0 : count - 1)
    else go((current + direction + count) % count)
  }
  const next = (): void => step(1)
  const prev = (): void => step(-1)
  parts.next.addEventListener('click', next)
  parts.prev.addEventListener('click', prev)
  const onKey = (event: KeyboardEvent): void => {
    const which = navKey(event)
    if (which === null) return
    event.preventDefault()
    if (which === 'prev') prev()
    else next()
  }
  const doc = body.ownerDocument
  doc.addEventListener('keydown', onKey)
  // Inputs and scrolls of the person. `scroll` does not bubble but does pass the capture phase, so one listener sees every scroller inside `body`.
  const onInput = (event: Event): void => {
    if (event.type === 'keydown' && navKey(event as KeyboardEvent) !== null) return
    inputSinceJump = true
  }
  const onScroll = (): void => {
    if (inputSinceJump) userMoved = true
  }
  // Keys go to the document: the editors are read-only and the patch view takes no focus, so a key's target is the iframe body and never passes `body`.
  const inputs = ['wheel', 'pointerdown', 'touchstart'] as const
  for (const type of inputs) body.addEventListener(type, onInput, { capture: true, passive: true })
  doc.addEventListener('keydown', onInput, { capture: true, passive: true })
  body.addEventListener('scroll', onScroll, { capture: true, passive: true })
  const watch = watchRecenter(body, () => {
    if (current >= 0) scroll(current)
  })
  show()
  if (count > 0 && current >= 0) {
    scroll(current)
    watch.arm()
  }
  return {
    count,
    current: () => current,
    next,
    prev,
    destroy() {
      watch.destroy()
      doc.removeEventListener('keydown', onKey)
      doc.removeEventListener('keydown', onInput, { capture: true })
      for (const type of inputs) body.removeEventListener(type, onInput, { capture: true })
      body.removeEventListener('scroll', onScroll, { capture: true })
    }
  }
}
