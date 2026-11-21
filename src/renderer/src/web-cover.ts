/**
 * The stacking order of the web view (TODO 400) - the "hide" decision (the default of TODO 411).
 *
 * The page is main's `WebContentsView`, drawn **always above** the renderer's DOM. While the renderer shows cover UI
 * (right-click menus, dialogs, balloons, `/` `@` candidates, the conversation pane's drop overlay, divider drags),
 * if that rectangle overlaps the page's rectangle, the page is hidden (main returns a copy from before hiding and puts it in its place).
 *
 * **Components are not made to register their covers one by one.** The showing side (Tooltip / ContextMenu / dialogs ...) is also touched by other bundles, so
 * this side watches document changes (`MutationObserver`) and collects the rectangles of elements matching the selector below.
 * The decision (`shouldHideWebView`) is a pure function, tested by `test/web-cover.test.ts`.
 */

export interface CoverRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/**
 * The selector for cover UI. What can be picked up by role (`role`) uses the role, and what cannot uses a class. When adding,
 * also fix the table in ARCHITECTURE 5.2.1.
 */
export const COVER_SELECTOR = [
  '[role="menu"]',
  '[role="dialog"]',
  '[role="tooltip"]',
  '.settings-backdrop',
  '.usage-popover',
  '.composer-slash-menu',
  '.pane-drop-overlay',
  '.workspace.dragging'
].join(', ')

/** Whether two rectangles overlap (merely touching edges does not overlap). */
export function rectsOverlap(a: CoverRect, b: CoverRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/** A rectangle with no size (an element with `display: none`, etc.). */
export function isEmptyRect(rect: CoverRect): boolean {
  return rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0
}

/**
 * Whether to hide the page. Hide it if any cover overlaps the page's rectangle. If the page's rectangle is empty (the pane is hidden),
 * hide it regardless of covers.
 */
export function shouldHideWebView(view: CoverRect, covers: readonly CoverRect[]): boolean {
  if (isEmptyRect(view)) return true
  return covers.some((cover) => !isEmptyRect(cover) && rectsOverlap(view, cover))
}

/**
 * TODO 1221: the page rectangle used for the cover decision. While Web content is full screen the view covers the whole window, so it is judged by
 * the whole window (`viewport`), not the pane's rectangle - wherever a cover appears (the Cmd+, settings, the new-thread dialog ...) it is hidden (= main leaves full screen).
 */
export function coverTarget(pane: CoverRect, viewport: CoverRect, fullscreen: boolean): CoverRect {
  return fullscreen ? viewport : pane
}

/** Collects the rectangles of covers in the document (the only place that touches the DOM). */
export function collectCovers(root: ParentNode): CoverRect[] {
  const out: CoverRect[] = []
  for (const element of Array.from(root.querySelectorAll(COVER_SELECTOR))) {
    const rect = element.getBoundingClientRect()
    out.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
  }
  return out
}

/**
 * Watches document changes and calls `onChange` when the covers change (only once before the next paint). Returns the cleanup function.
 * A balloon gets its position from `style` / `class` after it appears, so attribute changes are watched too.
 */
export function watchCovers(onChange: () => void): () => void {
  let frame: number | null = null
  const schedule = (): void => {
    if (frame !== null) return
    frame = requestAnimationFrame(() => {
      frame = null
      onChange()
    })
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style']
  })
  window.addEventListener('resize', schedule)
  return () => {
    observer.disconnect()
    window.removeEventListener('resize', schedule)
    if (frame !== null) cancelAnimationFrame(frame)
  }
}
