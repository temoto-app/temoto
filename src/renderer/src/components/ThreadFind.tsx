/**
 * Floating in-thread search box (TODO 496, ARCHITECTURE 5.1.7). Shows "field + n / N + up/down + close" at the top right
 * of ThreadPane (same shape as the VS Code find widget / Chrome's find in page). It opens with Cmd+F / Ctrl+F inside
 * ThreadPane and with the magnifier in the heading.
 *
 * - **What is on screen** (the DOM already loaded and drawn) is highlighted immediately on every keystroke
 *   (`thread/find-dom.ts`, `CSS.highlights`).
 * - **The whole thread** is looked up in the conversation search (Cmd+K) index, narrowed to this thread
 *   (`window.aios.search.thread`, after a 150 ms wait). Of the matching messages, only those **not loaded yet
 *   (earlier pages)** are added to the count one by one at the old end. Loaded messages are counted by their DOM
 *   matches, so the same message is never counted twice. Stepping to one loads the earlier pages
 *   (`loadOlder` until it arrives, `thread/load-until.ts`, same as when jumping from Cmd+K) and moves to that
 *   message's match.
 * - **Collapsed content** (tool arguments, plans, hidden sub-agent rows, thinking) is counted by the marker the
 *   component sets (`data-find-pending`) as "one place where opening it reveals a match". Stepping to it opens it
 *   and moves to the match inside.
 * - The hit is placed at the vertical center of the timeline (same as 431 / 446). Enter / Shift+Enter go to the
 *   next / previous (wrapping at the ends, like VS Code); Esc closes and returns focus to where it was before opening.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AiosEvent } from '@shared/agent.js'
import { ASCII_INPUT } from '@shared/ascii-input.js'
import { useThreads } from '../threadStore.js'
import { closeThreadFind, useThreadFind } from '../threadFindStore.js'
import { termsCaseSensitive } from '../thread/find-text.js'
import { loadedEventIds, loadUntil } from '../thread/load-until.js'
import {
  centerInBox,
  clearFindHighlights,
  compareSpots,
  FIND_PENDING_ATTR,
  FIND_ROOT_ATTR,
  firstSpotFromTop,
  indexOfSpotKey,
  paintFindHighlights,
  rangeVisible,
  rekeyFinishedStream,
  scanFindSpots,
  spotKeyAt,
  type FindSpot,
  type SpotKey
} from '../thread/find-dom.js'
import { useT } from '../i18n/index.js'
import { JumpNextIcon } from '../icons/JumpNextIcon.js'
import { JumpPrevIcon } from '../icons/JumpPrevIcon.js'
import { CloseIcon } from '../icons/CloseIcon.js'
import { SearchCaseBadge } from './SearchCaseBadge.js'
import { Tooltip } from './Tooltip.js'
import { keyPlatformOf } from '../composer-keys.js'
import { threadFindKeyLabel } from '../shortcuts.js'

/** How long to wait before querying the index (same as the 150 ms of the search box). */
const INDEX_DEBOUNCE_MS = 150
/** Interval for rescanning while the body is growing (while receiving). */
const RESCAN_THROTTLE_MS = 120

const PLATFORM = keyPlatformOf(typeof navigator === 'undefined' ? '' : navigator.platform)

/**
 * Query sequence number (P6). The index process remembers, **per window**, the latest in-thread search number and
 * discards older numbers without running them (TODO 497: main attaches the webContents id and clears the ledger when
 * the window closes or reloads). The number only has to increase monotonically within this window (this renderer),
 * so it counts from 1. It is a module variable, so reopening the component does not rewind it.
 * (In 496 the ledger was shared by all windows, so it started from the clock time; but setting the clock back, or
 * one huge number arriving once, made everything stale.)
 */
let lastSeq = 0
function nextSeq(): number {
  lastSeq += 1
  return lastSeq
}

const NO_EVENTS: readonly AiosEvent[] = []
const NO_IDS: readonly string[] = []

interface IndexAnswer {
  readonly threadId: string
  readonly query: string
  readonly eventIds: readonly string[]
  readonly caseSensitive: boolean
}

/** The place waiting for the destination to be drawn. */
type Want =
  | {
      readonly kind: 'pending'
      /** The marked element (the marker disappears, or the element itself disappears, once opened). */
      readonly element: HTMLElement
      /** Range to search for matches after opening (the marked element, or the `data-find-root` ancestor; for a "+N" group of children, the group's root). */
      readonly scope: HTMLElement
      readonly forward: boolean
      /** The match we were on before stepping. If it is inside the range, pick from the one after / before it (so a heading match is not hit twice). */
      readonly after: Range | null
    }
  | {
      readonly kind: 'event'
      readonly eventId: string
      readonly forward: boolean
      /** `loadUntil` has finished (arrived / did not arrive). Until then it is not consumed unless that message has been drawn. */
      readonly settled: boolean
    }

/** The current position: a message on an earlier page, or a drawn match / group. */
type Cursor = { readonly kind: 'older'; readonly eventId: string } | { readonly kind: 'spot'; readonly key: SpotKey }

/** The Range of the current match (null for a group or an earlier page). */
function currentRange(list: readonly FindSpot[], c: Cursor | null): Range | null {
  if (c === null || c.kind !== 'spot') return null
  const at = indexOfSpotKey(list, c.key)
  const spot = at < 0 ? undefined : list[at]
  return spot?.kind === 'hit' ? spot.range : null
}

/** From the matches after the redraw, pick the place we were waiting for (the opened group / the loaded message). */
function resolveWant(list: readonly FindSpot[], pending: Want): number {
  if (pending.kind === 'event') {
    const inside = list.map((spot, i) => (spot.itemId === pending.eventId ? i : -1)).filter((i) => i >= 0)
    if (inside.length > 0) return pending.forward ? inside[0]! : inside[inside.length - 1]!
    return list.length === 0 ? -1 : 0
  }
  const element = pending.scope
  const inside = list
    .map((spot, i) => (spot.kind === 'hit' && element.contains(spot.range.startContainer) ? i : -1))
    .filter((i) => i >= 0)
  if (inside.length > 0) {
    const after = pending.after
    if (after !== null && element.contains(after.startContainer)) {
      const order = (i: number): number => {
        const spot = list[i]!
        return spot.kind === 'hit' ? spot.range.compareBoundaryPoints(Range.START_TO_START, after) : 0
      }
      const found = pending.forward ? inside.find((i) => order(i) > 0) : [...inside].reverse().find((i) => order(i) < 0)
      if (found !== undefined) return found
    }
    return pending.forward ? inside[0]! : inside[inside.length - 1]!
  }
  // Opening revealed no match (hidden text differs from drawn text). Go to the next / previous place after that group.
  const probe: FindSpot = { kind: 'pending', element, key: '', itemId: null }
  if (pending.forward) {
    const next = list.findIndex((spot) => compareSpots(probe, spot) < 0)
    return next < 0 ? (list.length === 0 ? -1 : 0) : next
  }
  for (let i = list.length - 1; i >= 0; i -= 1) if (compareSpots(list[i]!, probe) < 0) return i
  return list.length - 1
}

export function ThreadFind({
  threadId,
  bodyRef
}: {
  threadId: string
  bodyRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element | null {
  const t = useT()
  const open = useThreadFind((state) => state.open)
  const query = useThreadFind((state) => state.query)
  const terms = useThreadFind((state) => state.terms)
  const focusSeq = useThreadFind((state) => state.focusSeq)
  const setQuery = useThreadFind((state) => state.setQuery)
  const requestReveal = useThreadFind((state) => state.requestReveal)
  const input = useRef<HTMLInputElement | null>(null)

  const events = useThreads((state) => state.events[threadId] ?? NO_EVENTS)
  const buckets = useThreads((state) => state.childEvents[threadId])

  // ---- Index (whole thread) ----
  const [answer, setAnswer] = useState<IndexAnswer | null>(null)
  const seq = useRef(0)
  useEffect(() => {
    if (!open || terms.length === 0) return
    const asked = query
    const timer = window.setTimeout(() => {
      const mine = nextSeq()
      seq.current = mine
      void window.aios.search
        .thread(asked, threadId, mine)
        .then((response) => {
          if (response.stale === true || mine !== seq.current) return
          setAnswer({
            threadId,
            query: asked,
            // Terms that are too short (P8) are not looked up in the index. Only the on-screen highlighting continues.
            eventIds: response.tooShort === true ? NO_IDS : response.eventIds,
            caseSensitive: response.caseSensitive === true
          })
        })
        .catch(() => {
          // Even if the index cannot be queried, the on-screen part is still highlighted. Silently fall back to on-screen only.
        })
    }, INDEX_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [open, query, terms, threadId])

  /** Matches on earlier pages (oldest first). Loaded messages are counted by the DOM, so they are excluded. */
  const olderIds = useMemo(() => {
    if (answer === null || answer.threadId !== threadId || answer.query !== query) return NO_IDS
    const loaded = loadedEventIds(events, buckets)
    const out = answer.eventIds.filter((id) => !loaded.has(id))
    return out.length === 0 ? NO_IDS : out
  }, [answer, threadId, query, events, buckets])

  // ---- On screen (DOM) ----
  const spots = useRef<readonly FindSpot[]>([])
  const cursor = useRef<Cursor | null>(null)
  const want = useRef<Want | null>(null)
  /** Only once at the start of typing (right after the term changes): pick the first match among the visible ones and move to it. */
  const fresh = useRef(true)
  const [view, setView] = useState<{ readonly index: number; readonly count: number }>({ index: 0, count: 0 })
  const olderRef = useRef(olderIds)
  olderRef.current = olderIds

  /** Bring the display (n / N and the highlight) in line with the current cursor. */
  const publish = useCallback(() => {
    const older = olderRef.current
    const list = spots.current
    const c = cursor.current
    let index = 0
    if (c !== null) {
      if (c.kind === 'older') {
        const at = older.indexOf(c.eventId)
        index = at < 0 ? 0 : at + 1
      } else {
        const at = indexOfSpotKey(list, c.key)
        index = at < 0 ? 0 : older.length + at + 1
      }
    }
    paintFindHighlights(list, currentRange(list, c))
    setView((prev) => (prev.index === index && prev.count === older.length + list.length ? prev : { index, count: older.length + list.length }))
  }, [])

  /** Make `spots[at]` the current place and, if not visible, center it (always, if `always`). */
  const land = useCallback(
    (at: number, always: boolean) => {
      const spot = spots.current[at]
      const key = spotKeyAt(spots.current, at)
      if (spot === undefined || key === null) return
      cursor.current = { kind: 'spot', key }
      const container = bodyRef.current
      const target = spot.kind === 'hit' ? spot.range : spot.element
      if (container !== null && (always || !rangeVisible(target, container))) centerInBox(target, container)
      publish()
    },
    [publish, bodyRef]
  )

  /** Rescan. The current place is carried over by its key. */
  const rescan = useCallback(() => {
    const body = bodyRef.current
    const active = useThreadFind.getState()
    if (body === null || !active.open || active.terms.length === 0) {
      spots.current = []
      cursor.current = null
      publish()
      return
    }
    spots.current = scanFindSpots(body, active.terms)
    const was = cursor.current
    if (was !== null && was.kind === 'spot') cursor.current = { kind: 'spot', key: rekeyFinishedStream(spots.current, was.key) }
    const pending = want.current
    if (pending !== null) {
      // Waiting for a group to open / a page to load. Pick it once opened (the marker is gone). A message on an earlier page
      // waits until that message is drawn or `loadUntil` finishes (it is not consumed by a redraw of a loading button
      // or by body text while receiving; review 2026-10-06).
      const stillClosed =
        pending.kind === 'pending'
          ? pending.element.isConnected && pending.element.hasAttribute(FIND_PENDING_ATTR)
          : !pending.settled && !spots.current.some((spot) => spot.itemId === pending.eventId)
      if (!stillClosed) {
        want.current = null
        const at = resolveWant(spots.current, pending)
        if (at >= 0) {
          land(at, true)
          return
        }
      }
    }
    // The re-pick at the start of typing waits until a match has been drawn (right after opening a thread there is no timeline yet).
    if (fresh.current && spots.current.length > 0) {
      fresh.current = false
      const at = firstSpotFromTop(spots.current, body)
      if (at >= 0) {
        land(at, false)
        return
      }
      cursor.current = null
    }
    publish()
  }, [publish, land, bodyRef])

  // When the term / thread changes, re-pick as a fresh start (scan after drawing).
  useLayoutEffect(() => {
    fresh.current = true
    want.current = null
    cursor.current = null
    rescan()
  }, [terms, threadId, open, rescan])

  // When the matches on earlier pages change, recount (the highlight does not change).
  useEffect(() => {
    publish()
  }, [olderIds, publish])

  // Rescan along with redraws (body text while receiving, opened groups, loaded pages).
  useEffect(() => {
    const body = bodyRef.current
    if (!open || body === null || terms.length === 0 || typeof MutationObserver === 'undefined') return
    let timer: number | null = null
    const observer = new MutationObserver(() => {
      if (timer !== null) return
      timer = window.setTimeout(
        () => {
          timer = null
          rescan()
        },
        want.current === null ? RESCAN_THROTTLE_MS : 0
      )
    })
    observer.observe(body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-find-pending'] })
    return () => {
      observer.disconnect()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [open, terms, bodyRef, rescan])

  // Clear the highlight when closed.
  useEffect(() => {
    if (open) return
    clearFindHighlights()
  }, [open])
  useEffect(() => () => clearFindHighlights(), [])

  // Every Cmd+F / magnifier press focuses the field and selects all.
  useEffect(() => {
    if (!open) return
    const el = input.current
    if (el === null) return
    el.focus()
    el.select()
  }, [open, focusSeq])

  /** Next / previous. At an end it wraps to the opposite end. */
  const step = (forward: boolean): void => {
    const older = olderRef.current
    const list = spots.current
    const total = older.length + list.length
    if (total === 0) return
    // Once the user steps by hand, the fresh-start re-pick is no longer needed. If we stepped to an earlier page with no
    // match on screen, `fresh` stayed set and the scan after arrival re-picked a match at the top of the screen
    // (the 29th proxy verification, TODO 501-1).
    fresh.current = false
    const current = view.index - 1
    const next =
      current < 0 ? (forward ? Math.min(older.length, total - 1) : total - 1) : (current + (forward ? 1 : -1) + total) % total
    if (next < older.length) {
      const eventId = older[next]!
      cursor.current = { kind: 'older', eventId }
      publish()
      const mine: Want = { kind: 'event', eventId, forward, settled: false }
      want.current = mine
      void loadUntil(useThreads, threadId, eventId).then(() => {
        // A loaded page is picked up by the MutationObserver. In case it never arrives, mark it finished and scan once.
        if (want.current === mine) want.current = { ...mine, settled: true }
        window.requestAnimationFrame(() => rescan())
      })
      return
    }
    const at = next - older.length
    const spot = list[at]!
    if (spot.kind === 'hit') {
      want.current = null
      land(at, true)
      return
    }
    // Collapsed group: have it opened, then go to the match inside after the redraw.
    want.current = {
      kind: 'pending',
      element: spot.element,
      scope: spot.element.closest<HTMLElement>(`[${FIND_ROOT_ATTR}]`) ?? spot.element,
      forward,
      after: currentRange(list, cursor.current)
    }
    cursor.current = { kind: 'spot', key: spotKeyAt(list, at)! }
    publish()
    requestReveal(spot.key)
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => rescan()))
  }

  if (!open) return null
  const label = `${t('threadFind.placeholder')} (${threadFindKeyLabel(PLATFORM)})`
  const caseSensitive = termsCaseSensitive(terms)
  const status =
    terms.length === 0
      ? ''
      : view.count === 0
        ? t('threadFind.none')
        : t('threadFind.count', { index: view.index === 0 ? '?' : String(view.index), count: String(view.count) })
  return (
    <div className="thread-find-host">
      <div className="thread-find" role="search">
        <span className="thread-find-field">
          <input
            ref={input}
            type="text"
            {...ASCII_INPUT}
            className="thread-find-input"
            value={query}
            placeholder={label}
            aria-label={label}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter') {
                event.preventDefault()
                step(!event.shiftKey)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                closeThreadFind(true)
              }
            }}
          />
          <SearchCaseBadge shown={caseSensitive} />
        </span>
        <span className="thread-find-count" aria-live="polite">
          {status}
        </span>
        <Tooltip content={`${t('threadFind.prev')} (${PLATFORM === 'mac' ? '⇧Enter' : 'Shift+Enter'})`}>
          <button
            type="button"
            className="icon-button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => step(false)}
            disabled={view.count === 0}
            aria-label={t('threadFind.prev')}
          >
            <JumpPrevIcon />
          </button>
        </Tooltip>
        <Tooltip content={`${t('threadFind.next')} (Enter)`}>
          <button
            type="button"
            className="icon-button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => step(true)}
            disabled={view.count === 0}
            aria-label={t('threadFind.next')}
          >
            <JumpNextIcon />
          </button>
        </Tooltip>
        <Tooltip content={`${t('threadFind.close')} (Esc)`}>
          <button
            type="button"
            className="icon-button"
            onClick={() => closeThreadFind(true)}
            aria-label={t('threadFind.close')}
          >
            <CloseIcon />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
