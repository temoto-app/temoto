/**
 * The search-hit box (ARCHITECTURE.md 7.4.3, TODO 431).
 *
 * When opened from a hit of the body search (Ctrl+F / Cmd+Shift+F), a tall box showing "n / N" and first / previous / next / last buttons
 * is shown at the bottom right of the source view (the Source of `aios.text` and `aios.markdown`). Its look and layout match the conversation pane's
 * jump between questions (`JumpNav`, TODO 53 / 67). The pointer over the iframe does not reach the host (7.4.2), and only the viewer
 * knows where the matches are, so the box is **ordinary DOM inside the viewer**.
 *
 * - The plugin boundary (constraint 8, `lint:plugins`) forbids importing `src/renderer/`, so the icon shapes
 *   (`src/renderer/src/icons/Jump*Icon.tsx`) are copied here. Color is only `currentColor`, and the box's colors are viewer.css variables.
 * - It is shown when there are 2 or more matches (not for 0 / 1). No close control is provided (it goes away when the search term goes away).
 * - Keyboard does not duplicate CodeMirror's search panel (F3 / Cmd+G). The box is mouse only, plus Enter on a focused button.
 * - Enumerating matches, the current match and the instruction to center are owned by `editor.ts`. This file has only the state computation, the DOM and the
 *   watcher that "re-centers once the size is settled" (a form that can be tested in isolation with vitest's jsdom).
 */
import { vt } from './i18n.js'

export interface HitNavState {
  readonly visible: boolean
  /** The current match (1-based). 0 if there are no matches. */
  readonly index: number
  readonly count: number
  readonly canFirst: boolean
  readonly canPrev: boolean
  readonly canNext: boolean
  readonly canLast: boolean
}

export const HIDDEN_HIT_NAV: HitNavState = {
  visible: false,
  index: 0,
  count: 0,
  canFirst: false,
  canPrev: false,
  canNext: false,
  canLast: false
}

/** Derives the box state from the current match (1-based) and the count. At the ends, the direction that cannot be taken is disabled. */
export function hitNavState(index: number, count: number): HitNavState {
  if (count < 2 || index < 1 || index > count) return HIDDEN_HIT_NAV
  return {
    visible: true,
    index,
    count,
    canFirst: index > 1,
    canPrev: index > 1,
    canNext: index < count,
    canLast: index < count
  }
}

export type HitStep = 'first' | 'prev' | 'next' | 'last'

/** The destination (1-based) for the pressed direction. null if it cannot go. */
export function stepTarget(step: HitStep, index: number, count: number): number | null {
  const state = hitNavState(index, count)
  if (!state.visible) return null
  switch (step) {
    case 'first':
      return state.canFirst ? 1 : null
    case 'prev':
      return state.canPrev ? index - 1 : null
    case 'next':
      return state.canNext ? index + 1 : null
    case 'last':
      return state.canLast ? count : null
  }
}

/** Icon shapes (the same paths as `Jump*Icon.tsx`, derived from qlm's `#jump-*`). */
const ICON_PATHS: Readonly<Record<HitStep, readonly string[]>> = {
  first: ['M5 5h14', 'M12 20V9', 'm7 14 5-5 5 5'],
  prev: ['m6 15 6-6 6 6'],
  next: ['m6 9 6 6 6-6'],
  last: ['M12 4v11', 'm7 10 5 5 5-5', 'M5 19h14']
}

const LABEL_KEYS = {
  first: 'hitFirst',
  prev: 'hitPrev',
  next: 'hitNext',
  last: 'hitLast'
} as const satisfies Record<HitStep, string>

const STEPS: readonly HitStep[] = ['first', 'prev', 'next', 'last']

const SVG_NS = 'http://www.w3.org/2000/svg'

function icon(doc: Document, step: HitStep): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  for (const [name, value] of [
    ['width', '16'],
    ['height', '16'],
    ['viewBox', '0 0 24 24'],
    ['fill', 'none'],
    ['stroke', 'currentColor'],
    ['stroke-width', '2'],
    ['stroke-linecap', 'round'],
    ['stroke-linejoin', 'round'],
    ['aria-hidden', 'true'],
    ['focusable', 'false']
  ] as const) {
    svg.setAttribute(name, value)
  }
  for (const d of ICON_PATHS[step]) {
    const path = doc.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

export interface HitNav {
  readonly element: HTMLDivElement
  /** Redraws the state. The labels (display language) are also looked up again here. */
  update(state: HitNavState): void
}

/** Builds the box DOM. It only calls `onStep` when pressed; where to jump is decided by the caller. */
export function createHitNav(doc: Document, onStep: (step: HitStep) => void): HitNav {
  const element = doc.createElement('div')
  element.className = 'hit-nav'
  element.hidden = true
  const pos = doc.createElement('span')
  pos.className = 'hit-nav-pos'
  element.append(pos)
  const buttons = new Map<HitStep, HTMLButtonElement>()
  for (const step of STEPS) {
    const button = doc.createElement('button')
    button.type = 'button'
    button.className = 'hit-nav-btn'
    button.dataset.step = step
    button.append(icon(doc, step))
    // Pressing does not steal the editor's focus (caret, the search panel's Cmd+G). Focus then Enter works through the button's default.
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () => onStep(step))
    buttons.set(step, button)
    element.append(button)
  }
  return {
    element,
    update(state) {
      element.hidden = !state.visible
      if (!state.visible) return
      pos.textContent = `${state.index} / ${state.count}`
      const enabled: Record<HitStep, boolean> = {
        first: state.canFirst,
        prev: state.canPrev,
        next: state.canNext,
        last: state.canLast
      }
      for (const step of STEPS) {
        const button = buttons.get(step)!
        const label = vt(LABEL_KEYS[step])
        button.setAttribute('aria-label', label)
        button.title = label
        button.disabled = !enabled[step]
      }
    }
  }
}

export interface RecenterWatch {
  /** Call right after opening (right after applying the search terms). From then on it re-centers whenever the size changes. */
  arm(): void
  disarm(): void
  destroy(): void
}

/** How long (ms) to keep re-centering. Allows for the wait on the heading list (a plugin-host command) response. */
export const RECENTER_WINDOW_MS = 5000

/**
 * A watcher that "re-centers once the iframe / editor size is settled" (TODO 431 (b)).
 *
 * `EditorView.scrollIntoView(pos, { y: 'center' })` measures the center with **the size at that moment**. Right after opening,
 * the ViewerPane's width and height are not fully settled, and `aios.markdown` adds the heading list **later below** the editor
 * (the editor's height shrinks). CodeMirror keeps "the line visible at the top" when the size changes, so
 * a match centered earlier drifts downward, and when wrapping (`lineWrapping`) changes the width, the line heights drift too.
 * So after arm, `recenter` is called whenever the size of `target` (= `.cm-scroller`) changes.
 * ResizeObserver also fires once right after observe, and that becomes "the one call after the size is settled".
 * It stops at once if a person touches the view (wheel / pointerdown / keydown / touchstart), and at the latest after `windowMs`.
 */
export function watchRecenter(
  target: HTMLElement,
  recenter: () => void,
  options: { readonly windowMs?: number; readonly now?: () => number } = {}
): RecenterWatch {
  const windowMs = options.windowMs ?? RECENTER_WINDOW_MS
  const now = options.now ?? Date.now
  let armedAt: number | null = null
  const disarm = (): void => {
    armedAt = null
  }
  const observer =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (armedAt === null) return
          if (now() - armedAt > windowMs) {
            armedAt = null
            return
          }
          recenter()
        })
  observer?.observe(target)
  const events = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const
  for (const name of events) target.addEventListener(name, disarm, { passive: true })
  return {
    arm() {
      armedAt = now()
    },
    disarm,
    destroy() {
      armedAt = null
      observer?.disconnect()
      for (const name of events) target.removeEventListener(name, disarm)
    }
  }
}
