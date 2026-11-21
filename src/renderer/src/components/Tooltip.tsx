/**
 * Common balloon (items 290 / 286, wave 16 bundle A). A self-made frame close to the VS Code hover, instead of the OS `title`.
 *
 * - Appears after `delay` (default 400 ms) of hovering. Also appears on keyboard focus (not when focus came from a click).
 * - Disappears on Esc, click, or leaving. It waits a little (120 ms) after leaving, so the mouse can be moved into the balloon to scroll long content.
 * - Portaled to `document.body` and placed with `position: fixed` (so it is not clipped by `overflow: hidden` of `.composer-frame` etc.).
 *   Default is below, above if it does not fit below. Left and right are pulled inside the window.
 * - Only while shown, adds `aria-describedby` (the balloon's id, `role="tooltip"`) to the child.
 * - Colors only through CSS variables (`.tooltip`, 7.4.1).
 *
 * The child is a single DOM element (a button, etc.). The child's existing events are called, and ours are added.
 */
import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type HTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

export const TOOLTIP_DELAY_MS = 400
const HIDE_GRACE_MS = 120
const GAP = 6
const MARGIN = 8

type AnchorProps = HTMLAttributes<HTMLElement>

export interface TooltipProps {
  /** Content. If a function, it is built only when shown (do not build a few KB of full text per row). */
  readonly content: ReactNode | (() => ReactNode)
  readonly children: ReactElement<AnchorProps>
  readonly delay?: number
  /**
   * The direction to try first. `top` / `bottom` use the opposite side if they do not fit. `right` is for the activity bar
   * at the left edge of the window (item 320): if it does not fit, it goes to the left. A heading at the top edge of the window keeps the default (`bottom`).
   */
  readonly placement?: 'top' | 'bottom' | 'right'
  /** A class added to the balloon's frame. */
  readonly className?: string
  /** Called just before showing. If false, it is not shown (e.g. when the summary fits in the field). */
  readonly when?: (anchor: HTMLElement) => boolean
}

interface Position {
  readonly top: number
  readonly left: number
  readonly side: 'top' | 'bottom' | 'right' | 'left'
}

/** Where to put the balloon (pure function, exported for tests). */
export function placeTooltip(
  anchor: { top: number; bottom: number; left: number; right?: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  prefer: 'top' | 'bottom' | 'right'
): Position {
  if (prefer === 'right') {
    const anchorRight = anchor.right ?? anchor.left
    const right = anchorRight + GAP
    const fitsRight = right + size.width <= viewport.width - MARGIN
    const left = fitsRight ? right : Math.max(MARGIN, anchor.left - GAP - size.width)
    const center = (anchor.top + anchor.bottom) / 2 - size.height / 2
    const maxTop = Math.max(MARGIN, viewport.height - size.height - MARGIN)
    const top = Math.min(Math.max(MARGIN, center), maxTop)
    return { top, left, side: fitsRight ? 'right' : 'left' }
  }
  const below = anchor.bottom + GAP
  const above = anchor.top - GAP - size.height
  const fitsBelow = below + size.height <= viewport.height - MARGIN
  const fitsAbove = above >= MARGIN
  const side: 'top' | 'bottom' =
    prefer === 'bottom' ? (fitsBelow || !fitsAbove ? 'bottom' : 'top') : fitsAbove || !fitsBelow ? 'top' : 'bottom'
  const top = side === 'bottom' ? below : above
  const maxLeft = Math.max(MARGIN, viewport.width - size.width - MARGIN)
  const left = Math.min(Math.max(anchor.left, MARGIN), maxLeft)
  return { top: Math.max(MARGIN, top), left, side }
}

export function Tooltip({
  content,
  children,
  delay = TOOLTIP_DELAY_MS,
  placement = 'bottom',
  className,
  when
}: TooltipProps): React.JSX.Element {
  const id = useId()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [position, setPosition] = useState<Position | null>(null)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerDown = useRef(false)
  const tip = useRef<HTMLDivElement | null>(null)

  const clearTimers = useCallback((): void => {
    if (showTimer.current !== null) clearTimeout(showTimer.current)
    if (hideTimer.current !== null) clearTimeout(hideTimer.current)
    showTimer.current = null
    hideTimer.current = null
  }, [])

  const hide = useCallback((): void => {
    clearTimers()
    setAnchor(null)
    setPosition(null)
  }, [clearTimers])

  const scheduleShow = useCallback(
    (target: HTMLElement, wait: number): void => {
      clearTimers()
      showTimer.current = setTimeout(() => {
        showTimer.current = null
        if (!target.isConnected) return
        if (when !== undefined && !when(target)) return
        setAnchor(target)
      }, wait)
    },
    [clearTimers, when]
  )

  const scheduleHide = useCallback((): void => {
    if (showTimer.current !== null) {
      clearTimeout(showTimer.current)
      showTimer.current = null
    }
    if (hideTimer.current !== null) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(hide, HIDE_GRACE_MS)
  }, [hide])

  useEffect(() => clearTimers, [clearTimers])

  // Dismiss with Esc. Listen only while shown. Other Esc jobs (rejecting an approval, etc.) are not stopped.
  useEffect(() => {
    if (anchor === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [anchor, hide])

  // The position is decided by the size after drawing (the first pass is drawn invisible).
  useLayoutEffect(() => {
    if (anchor === null || tip.current === null) return
    const rect = anchor.getBoundingClientRect()
    setPosition(
      placeTooltip(
        rect,
        { width: tip.current.offsetWidth, height: tip.current.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        placement
      )
    )
  }, [anchor, placement])

  const props = children.props
  const describedBy = [props['aria-describedby'], anchor === null ? undefined : id].filter(Boolean).join(' ')
  const anchorProps: AnchorProps = {
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      props.onMouseEnter?.(event)
      if (anchor !== null) {
        if (hideTimer.current !== null) clearTimeout(hideTimer.current)
        hideTimer.current = null
        return
      }
      scheduleShow(event.currentTarget, delay)
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      props.onMouseLeave?.(event)
      pointerDown.current = false
      scheduleHide()
    },
    onMouseDown: (event: MouseEvent<HTMLElement>) => {
      props.onMouseDown?.(event)
      pointerDown.current = true
      hide()
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      props.onFocus?.(event)
      // Do not show when focus arrived by a click (the balloon would cover the spot right after pressing).
      if (pointerDown.current) {
        pointerDown.current = false
        return
      }
      scheduleShow(event.currentTarget, delay)
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      props.onBlur?.(event)
      pointerDown.current = false
      hide()
    },
    ...(describedBy === '' ? {} : { 'aria-describedby': describedBy })
  }

  return (
    <>
      {cloneElement(children, anchorProps)}
      {anchor === null
        ? null
        : createPortal(
            <div
              ref={tip}
              id={id}
              role="tooltip"
              className={`tooltip${position === null ? '' : ` ${position.side}`}${className === undefined ? '' : ` ${className}`}`}
              style={
                position === null
                  ? { top: 0, left: 0, visibility: 'hidden' }
                  : { top: position.top, left: position.left }
              }
              onMouseEnter={() => {
                if (hideTimer.current !== null) clearTimeout(hideTimer.current)
                hideTimer.current = null
              }}
              onMouseLeave={scheduleHide}
            >
              {typeof content === 'function' ? (content as () => ReactNode)() : content}
            </div>,
            document.body
          )}
    </>
  )
}
