/**
 * Zoom for the image / video viewers (TODO 1188, wave 79 bundle A).
 *
 * The scale `scale` is 1 when "1 image px is 1 physical px". The CSS size is `px * scale / devicePixelRatio`,
 * so even on Retina, 1x means 1 image px = 1 physical px (Dot by Dot).
 * The upper half (pure computation) is tested by `test/viewer-zoom.test.ts`. The lower half is DOM.
 * Neither the scale nor the filter is remembered (owner decision 2026-11-08): each open starts at the initial scale and Nearest.
 *
 * Switching the filter (interpolation) is drawn by the host's heading (TODO 1200, wave 81 bundle C, ARCHITECTURE 7.4.12): the viewer puts the selectable interpolations and
 * the current one into the bridge's `view-modes` via `reportFilterModes`, and passes the host's `set-view-mode` to
 * `ZoomController.setFilter`. What is drawn here is only the +/- buttons and the scale display.
 */
import type { ViewerFilterMode } from '@shared/viewer-view-mode.js'
import { VIEWER_FILTER_MODES, isViewerFilterMode } from '@shared/viewer-view-mode.js'
import type { ViewerBridge } from './bridge.js'
import { vt } from './i18n.js'

export const MIN_SCALE = 0.05
export const MAX_SCALE = 64
/** If the long side is this or less, it is treated as a "small picture" and initially shown at the largest integer multiple that fits the frame. */
export const SMALL_LONG_SIDE = 128
export const SMALL_MAX_FACTOR = 16
/** The steps of the +/- buttons. */
export const SCALE_STEPS: readonly number[] = [
  0.05, 0.1, 0.125, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64
]

export type ZoomFilter = ViewerFilterMode

/** The interpolation on each open (owner decision 2026-11-08: Nearest, not remembered). */
export const DEFAULT_FILTER: ZoomFilter = 'nearest'

/** The CSS for the interpolation (`image-rendering`). */
export function filterRendering(filter: ZoomFilter): 'pixelated' | 'auto' {
  return filter === 'nearest' ? 'pixelated' : 'auto'
}

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/**
 * The scale right after opening. If the long side is 128px or less, the largest integer multiple (1 to 16) that fits the frame (CSS px); otherwise 1x (1).
 * Also 1x when the frame size is unknown (0 or less).
 */
export function initialScale(input: {
  readonly width: number
  readonly height: number
  readonly stageWidth: number
  readonly stageHeight: number
  readonly dpr: number
  /** Shrinks a large picture until it fits the frame (shrink only; for video, TODO 1188 review Y-3). The default is 1x with scrolling. */
  readonly shrinkToFit?: boolean
}): number {
  const { width, height, stageWidth, stageHeight, dpr } = input
  if (!(width > 0) || !(height > 0)) return 1
  if (!(stageWidth > 0) || !(stageHeight > 0) || !(dpr > 0)) return 1
  if (Math.max(width, height) > SMALL_LONG_SIDE) {
    if (input.shrinkToFit !== true) return 1
    const ratio = Math.min((stageWidth * dpr) / width, (stageHeight * dpr) / height)
    return ratio >= 1 ? 1 : clampScale(ratio)
  }
  const fit = Math.floor(Math.min((stageWidth * dpr) / width, (stageHeight * dpr) / height))
  return Math.min(SMALL_MAX_FACTOR, Math.max(1, fit))
}

/** The next step (direction 1 = zoom in, -1 = zoom out). Between steps, goes to the adjacent step. Never leaves the range. */
export function stepScale(scale: number, direction: 1 | -1): number {
  const eps = 1e-6
  if (direction === 1) {
    for (const s of SCALE_STEPS) if (s > scale + eps) return s
    return MAX_SCALE
  }
  for (let i = SCALE_STEPS.length - 1; i >= 0; i--) {
    const s = SCALE_STEPS[i]!
    if (s < scale - eps) return s
  }
  return MIN_SCALE
}

/** New scale from the deltaY of a pinch (wheel + ctrlKey). Opening upward (deltaY < 0) zooms in. */
export function pinchScale(scale: number, deltaY: number): number {
  return clampScale(scale * Math.exp(-deltaY * 0.01))
}

/** Display of the scale ("100%", "1600%", "12.5%"). */
export function formatScale(scale: number): string {
  const pct = scale * 100
  return `${Number.isInteger(pct) || pct >= 100 ? Math.round(pct) : Number(pct.toFixed(1))}%`
}

/** The CSS size (px). */
export function cssSize(natural: number, scale: number, dpr: number): number {
  return (natural * scale) / (dpr > 0 ? dpr : 1)
}

export interface ZoomController {
  /** Call it when the element's natural size is known (an image's load, a video's loadedmetadata). Returns to the initial scale (the interpolation is unchanged). */
  setNatural(width: number, height: number): void
  /** The interpolation chosen in the host's heading (TODO 1200). */
  setFilter(filter: ZoomFilter): void
  readonly filter: ZoomFilter
}

/**
 * Tells the host the selectable interpolations and the current one (TODO 1200). The host shows a switch in the heading using the same component as the Composer's Model picker.
 * If `controller` is null (cannot be opened / cannot be played), an empty list = no switch is shown.
 */
export function reportFilterModes(
  bridge: Pick<ViewerBridge, 'reportViewModes'>,
  uri: string,
  controller: ZoomController | null
): void {
  if (controller === null) bridge.reportViewModes(uri, [], DEFAULT_FILTER)
  else bridge.reportViewModes(uri, VIEWER_FILTER_MODES, controller.filter)
}

/**
 * Connects the host heading's interpolation switch (TODO 1200) to the viewer. What was identical in `aios.image` / `aios.video` - "the zoom being displayed and the record of the
 * destination" and the `onSetViewMode` handler - is gathered here (wave 81 review Y). A plugin calls this only once and calls the returned function
 * each time it opened (with zoom) / failed to open (null) - it records and reports.
 *
 * `set-view-mode` is applied to the recorded zoom, and **after applying it always reports the current value again** (the host's heading does not move optimistically,
 * it moves only on the viewer's report. Even when the value is not an interpolation or there is no zoom, the current value is reported again).
 */
export function connectFilterModes(
  bridge: Pick<ViewerBridge, 'reportViewModes' | 'onSetViewMode'>
): (uri: string, controller: ZoomController | null) => void {
  let shown: { readonly uri: string; readonly zoom: ZoomController | null } | null = null
  bridge.onSetViewMode((next) => {
    if (shown === null) return
    if (shown.zoom !== null && isViewerFilterMode(next)) shown.zoom.setFilter(next)
    reportFilterModes(bridge, shown.uri, shown.zoom)
  })
  return (uri, controller) => {
    shown = { uri, zoom: controller }
    reportFilterModes(bridge, uri, controller)
  }
}

/**
 * Zooms `target` (img / video) inside `stage` (the scrolling frame). Adds +/- and the scale to `bar` (the interpolation switch is the host's).
 * Pinch does not become the browser's default page zoom (preventDefault with passive: false).
 */
/** A flag for removing the previous mount's resize listener (so reopening does not keep adding to window and leak - review Y-1). */
let previousMount: AbortController | null = null

export function mountZoom(
  bar: HTMLElement,
  stage: HTMLElement,
  target: HTMLElement,
  options: { readonly shrinkToFit?: boolean } = {}
): ZoomController {
  previousMount?.abort()
  const mount = new AbortController()
  previousMount = mount
  let natural: { w: number; h: number } | null = null
  let scale = 1
  let filter: ZoomFilter = DEFAULT_FILTER

  const minus = button('−', vt('zoomOut'))
  const plus = button('+', vt('zoomIn'))
  const label = button('100%', vt('zoomReset'))
  label.classList.add('zoom-label')
  bar.classList.add('toolbar', 'zoom-bar')
  bar.append(minus, label, plus)

  const padding = (side: 'Left' | 'Right' | 'Top' | 'Bottom'): number =>
    parseFloat(getComputedStyle(stage)[`padding${side}`]) || 0
  const dpr = (): number => (window.devicePixelRatio > 0 ? window.devicePixelRatio : 1)

  function apply(): void {
    if (natural === null) return
    target.style.width = `${cssSize(natural.w, scale, dpr())}px`
    target.style.height = `${cssSize(natural.h, scale, dpr())}px`
    target.style.imageRendering = filterRendering(filter)
    label.textContent = formatScale(scale)
    minus.disabled = scale <= MIN_SCALE
    plus.disabled = scale >= MAX_SCALE
  }

  /** Changes the scale without moving the point under (clientX, clientY). */
  function setScale(next: number, clientX?: number, clientY?: number): void {
    const to = clampScale(next)
    if (to === scale || natural === null) return
    const before = target.getBoundingClientRect()
    const stageRect = stage.getBoundingClientRect()
    const px = clientX ?? stageRect.left + stageRect.width / 2
    const py = clientY ?? stageRect.top + stageRect.height / 2
    const fx = before.width > 0 ? (px - before.left) / before.width : 0.5
    const fy = before.height > 0 ? (py - before.top) / before.height : 0.5
    scale = to
    apply()
    const after = target.getBoundingClientRect()
    stage.scrollLeft += after.left + fx * after.width - px
    stage.scrollTop += after.top + fy * after.height - py
  }

  minus.addEventListener('click', () => setScale(stepScale(scale, -1)))
  plus.addEventListener('click', () => setScale(stepScale(scale, 1)))
  label.addEventListener('click', () => setScale(1))
  stage.addEventListener(
    'wheel',
    (event) => {
      // A macOS trackpad pinch arrives as wheel + ctrlKey. Do not turn it into a whole-page zoom.
      if (!event.ctrlKey) return
      event.preventDefault()
      setScale(pinchScale(scale, event.deltaY), event.clientX, event.clientY)
    },
    { passive: false }
  )
  // When the window size or dpr changes, recompute the CSS size (keeps 1 image px = 1 physical px).
  window.addEventListener('resize', apply, { signal: mount.signal })

  return {
    setNatural(width, height) {
      if (!(width > 0) || !(height > 0)) return
      natural = { w: width, h: height }
      scale = initialScale({
        width,
        height,
        stageWidth: stage.clientWidth - padding('Left') - padding('Right'),
        stageHeight: stage.clientHeight - padding('Top') - padding('Bottom'),
        dpr: dpr(),
        shrinkToFit: options.shrinkToFit === true
      })
      apply()
      stage.scrollLeft = 0
      stage.scrollTop = 0
    },
    setFilter(next) {
      filter = next
      apply()
    },
    get filter() {
      return filter
    }
  }
}

function button(text: string, title: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = text
  b.title = title
  return b
}
