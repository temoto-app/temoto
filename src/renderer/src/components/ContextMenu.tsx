/**
 * A small floating right-click menu (TODO 299). Shared by search result rows, file tree rows and viewer headings
 * (the items are built by `path-context-menu.ts`).
 *
 * - The native `Menu.popup` is not used (it cannot be verified in jsdom). It is portaled to `document.body` and
 *   placed with `position: fixed` (same practice as `Tooltip.tsx`).
 * - Closes on Esc or an outside click. The arrow keys move the selection and Enter chooses. Mouse hover also moves the selection.
 * - Focus is set after the position is fixed and the menu is visible, and on close it returns to where it was before opening (365-1).
 * - At the screen edge, `placeContextMenu` flips it so the top-left fits (a pure function, exported for tests).
 * - Colors are only CSS variables (`.context-menu`, 7.4.1).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ContextMenuItem } from '../path-context-menu.js'

export type { ContextMenuItem } from '../path-context-menu.js'

export interface ContextMenuPoint {
  readonly x: number
  readonly y: number
}

const MARGIN = 4

/** Where to place the menu. If it does not fit at the right / bottom edge, it flips inward (a pure function). */
export function placeContextMenu(
  point: ContextMenuPoint,
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number }
): { readonly top: number; readonly left: number } {
  const maxLeft = Math.max(MARGIN, viewport.width - size.width - MARGIN)
  const maxTop = Math.max(MARGIN, viewport.height - size.height - MARGIN)
  return {
    left: Math.min(Math.max(point.x, MARGIN), maxLeft),
    top: Math.min(Math.max(point.y, MARGIN), maxTop)
  }
}

/** Passed to the right-click target's `onContextMenu`. Holds the open / close state in a single hook (one per list is enough). */
export function useContextMenuState(): {
  readonly point: ContextMenuPoint | null
  readonly items: readonly ContextMenuItem[]
  readonly openMenu: (event: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number }, items: readonly ContextMenuItem[]) => void
  readonly closeMenu: () => void
} {
  const [state, setState] = useState<{
    readonly point: ContextMenuPoint | null
    readonly items: readonly ContextMenuItem[]
  }>({ point: null, items: [] })

  const openMenu = (
    event: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number },
    items: readonly ContextMenuItem[]
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    setState({ point: { x: event.clientX, y: event.clientY }, items })
  }
  const closeMenu = (): void => setState({ point: null, items: [] })
  return { point: state.point, items: state.items, openMenu, closeMenu }
}

export function ContextMenu({
  point,
  items,
  onClose
}: {
  readonly point: ContextMenuPoint | null
  readonly items: readonly ContextMenuItem[]
  readonly onClose: () => void
}): React.JSX.Element | null {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const [active, setActive] = useState(0)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Measuring the position and setting it (or clearing it) is consolidated into one layout effect.
  // A passive effect (useEffect) runs after a layout effect, so if `setPosition(null)` here were put in
  // a separate useEffect, it would erase the position we just measured after drawing (333-1).
  useLayoutEffect(() => {
    setActive(0)
    if (point === null || menuRef.current === null) {
      setPosition(null)
      return
    }
    const rect = menuRef.current.getBoundingClientRect()
    setPosition(
      placeContextMenu(
        point,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight }
      )
    )
  }, [point, items])

  // 365-1 (wave 20 bundle C): **focus after the position is fixed.** The first draw is
  // `visibility: hidden` to measure the position, and an invisible element does not take focus (Chromium). Previously the `[point]` effect
  // called `focus()` during that time, so focus did not enter the menu and the arrow keys / Enter reached the tree behind it.
  useEffect(() => {
    if (point === null || position === null) return
    menuRef.current?.focus()
  }, [point, position])

  // On close, return to where focus was before opening (the tree's container etc.), as in VS Code's menus.
  // Restore only when focus has lost its place (body / a detached element); if an item's action or an outside click
  // moved focus elsewhere, that takes priority. Since the restore happens in the passive cleanup, the focus (passive mount) of an
  // input opened in the same render (TODO 370's "New file...") wins later.
  useEffect(() => {
    if (point === null) return
    const previous = document.activeElement
    const back = previous instanceof HTMLElement && previous !== document.body ? previous : null
    const menu = menuRef.current
    return () => {
      if (back === null || !back.isConnected) return
      const active = document.activeElement
      const lost =
        active === null ||
        active === document.body ||
        !active.isConnected ||
        (menu !== null && menu.contains(active))
      if (lost) back.focus()
    }
  }, [point])

  // Close on Esc / an outside click. Take it first with capture so as not to disturb other Esc handling such as the approval frame.
  useEffect(() => {
    if (point === null) return
    const onPointerDown = (event: PointerEvent): void => {
      if (menuRef.current !== null && menuRef.current.contains(event.target as Node)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [point, onClose])

  if (point === null) return null

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      className="context-menu"
      style={
        position === null
          ? { top: point.y, left: point.x, visibility: 'hidden' }
          : { top: position.top, left: position.left }
      }
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActive((at) => Math.min(at + 1, items.length - 1))
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActive((at) => Math.max(at - 1, 0))
        } else if (event.key === 'Enter') {
          event.preventDefault()
          const item = items[active]
          if (item !== undefined && item.disabled !== true) {
            item.onSelect()
            onClose()
          }
        }
      }}
    >
      {items.map((item, index) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          className={`context-menu-item${index === active ? ' active' : ''}`}
          disabled={item.disabled === true}
          aria-disabled={item.disabled === true ? true : undefined}
          onMouseEnter={() => setActive(index)}
          onClick={() => {
            item.onSelect()
            onClose()
          }}
        >
          {item.checked === true ? <span className="context-menu-check">✓</span> : null}
          {item.label}
          {item.shortcut === undefined ? null : <span className="context-menu-shortcut">{item.shortcut}</span>}
          {item.hint === undefined ? null : <span className="context-menu-shortcut context-menu-hint">{item.hint}</span>}
        </button>
      ))}
    </div>,
    document.body
  )
}
