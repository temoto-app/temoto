/**
 * A button and a small popover that opens under it (item 187). Used by the gear menu of settings editor entries and
 * the menu in the thread heading (`ThreadSettingsMenu`).
 *
 * - Closes on a press outside or Esc. Esc returns focus to the button.
 * - The contents are drawn with `children(close)` (the contents decide that pressing an item closes it).
 * - `above` (TODO 1041): opens **above** the button. In places like the Composer's lower row where an ancestor has `overflow: hidden`
 *   (`.composer-frame`) or `container-type` (`.composer`, which becomes the reference for fixed), drawing inside the frame
 *   clips whatever overflows. As with the Model menu (`ContextMenu`) it is portaled to `document.body` and placed with `position: fixed`
 *   (decided by `popoverPlacement` from the button's rectangle).
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip } from './Tooltip.js'

const GAP = 4

/** The placement of the `above` popover (a pure function that fits it inside the window's right / left edge from the button's rectangle). */
export function popoverPlacement(
  rect: { readonly top: number; readonly left: number; readonly right: number },
  viewport: { readonly width: number; readonly height: number },
  align: 'left' | 'right'
): { readonly bottom: number; readonly left?: number; readonly right?: number } {
  const bottom = Math.max(GAP, viewport.height - rect.top + GAP)
  return align === 'right'
    ? { bottom, right: Math.max(GAP, viewport.width - rect.right) }
    : { bottom, left: Math.max(GAP, rect.left) }
}

export function MenuPopover({
  label,
  icon,
  className,
  buttonClassName,
  role = 'menu',
  align = 'left',
  busy = false,
  disabled = false,
  above = false,
  children
}: {
  label: string
  icon: React.ReactNode
  className?: string
  /** A class added to the button (TODO 866: a look per placement, such as a button shown on hover). */
  buttonClassName?: string
  /** `menu` if only items that close on press, `dialog` if checkboxes and the like are placed. */
  role?: 'menu' | 'dialog'
  /** Whether the popover aligns to the button's left edge or right edge. */
  align?: 'left' | 'right'
  /** In progress (`aria-busy`, the export in progress of TODO 866). Cannot be pressed. */
  busy?: boolean
  /** Cannot be pressed (another entry is in progress, etc.). If it is open, it closes. */
  disabled?: boolean
  /** Opens above the button, portaled outside the frame (TODO 1041). */
  above?: boolean
  children: (close: () => void) => React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [placed, setPlaced] = useState<ReturnType<typeof popoverPlacement> | null>(null)
  const popover = useRef<HTMLDivElement | null>(null)
  const anchor = useRef<HTMLSpanElement | null>(null)
  const button = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent): void => {
      const target = event.target as Node
      if (anchor.current !== null && !anchor.current.contains(target) && !(popover.current?.contains(target) ?? false)) {
        setOpen(false)
      }
    }
    // If the window size changes while open, or the composer scrolls, the fixed coordinates go off. Close.
    const onResize = (): void => setOpen(false)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      button.current?.focus()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey, true)
    if (above) {
      window.addEventListener('resize', onResize)
      window.addEventListener('scroll', onResize, true)
    }
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, above])

  // `above`: measure the button's position every time it opens (close if the window size changes).
  useEffect(() => {
    if (!open) {
      // Reset on close (so the next open does not draw with coordinates from one frame ago).
      setPlaced(null)
      return
    }
    if (!above || button.current === null) return
    setPlaced(
      popoverPlacement(button.current.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, align)
    )
  }, [above, open, align])

  const body = (
    <div
      ref={popover}
      className={`menu-popover ${align}${above ? ' above' : ''}`}
      role={role}
      aria-label={label}
      style={above ? { ...(placed ?? { visibility: 'hidden' as const }) } : undefined}
    >
      {children(() => setOpen(false))}
    </div>
  )

  return (
    <span ref={anchor} className={`menu-anchor${className === undefined ? '' : ` ${className}`}`}>
      <Tooltip content={label}>
        <button
          ref={button}
          type="button"
          className={`icon-button menu-button${buttonClassName === undefined ? '' : ` ${buttonClassName}`}`}
          aria-label={label}
          aria-haspopup={role}
          aria-expanded={open}
          aria-busy={busy || undefined}
          disabled={busy || disabled}
          onClick={() => setOpen((value) => !value)}
        >
          {icon}
        </button>
      </Tooltip>
      {open && !busy && !disabled ? (above ? createPortal(body, document.body) : body) : null}
    </span>
  )
}
