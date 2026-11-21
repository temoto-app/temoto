/**
 * Copy button for code blocks on the viewer side (ARCHITECTURE.md 5.1.2.1, T25).
 *
 * ThreadPane overlays the button on `.code-block` with a React portal, but a viewer is
 * **plugin code running inside a sandboxed iframe of a different origin**, so the same thing is
 * done here with plain DOM. This is `plugins/_shared/`, so it cannot touch the host's privileged API or
 * main's code (constraint 8, watched by `lint:plugins`. **That word itself is
 * a forbidden term, so do not write the name of the host's entry point in comments either**).
 *
 * **There are two routes to the clipboard** (measured in T25, see the repository guide):
 *  1. `navigator.clipboard.writeText`. Works even in an opaque-origin iframe, but
 *     **the host-side iframe needs `allow="clipboard-write"`** (without it, `NotAllowedError` from the Permissions
 *     Policy). In addition, **the iframe itself must have focus**. Both are
 *     satisfied when the button is actually clicked.
 *  2. `document.execCommand('copy')` when that fails. We measured that **it needs neither the Permissions
 *     Policy nor focus, as long as there is a user gesture**. We are inside the click
 *     handler, so this condition is met.
 *
 * Appearance and feedback (a checkmark for 1.5 seconds) match ThreadPane.
 * Colors come only from `viewer.css` variables (7.4.1).
 */
import { decodeCodeBlock } from '@shared/markdown/render.js'
import { vt } from './i18n.js'

const SVG = 'http://www.w3.org/2000/svg'

/** Inline SVG in the same format as T14 / T17 (`fill="none"`, color only through `currentColor`). */
function icon(paths: readonly (readonly [string, Record<string, string>])[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  for (const [name, value] of Object.entries({
    width: '16',
    height: '16',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.75',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true'
  })) {
    svg.setAttribute(name, value)
  }
  for (const [tag, attrs] of paths) {
    const node = document.createElementNS(SVG, tag)
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
    svg.append(node)
  }
  return svg
}

/** Same shape as `CopyIcon.tsx` (two overlapping rectangles). */
const copyIcon = (): SVGSVGElement =>
  icon([
    ['rect', { x: '9', y: '9', width: '11', height: '11', rx: '2' }],
    ['path', { d: 'M15 5.5a1.5 1.5 0 0 0-1.5-1.5h-7A2.5 2.5 0 0 0 4 6.5v7A1.5 1.5 0 0 0 5.5 15' }]
  ])

/** Same shape as `CheckIcon.tsx`. */
const checkIcon = (): SVGSVGElement => icon([['path', { d: 'M5 12.5l4.5 4.5L19 7' }]])

/**
 * Puts text on the clipboard. Returns whether it went in (does not throw on failure).
 * **Call it synchronously from a user-gesture handler** - route 2 requires that.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // We get here on a Permissions Policy denial (no `allow="clipboard-write"`) or when the iframe has no
    // focus. The user gesture is still valid, so execCommand works.
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    // Select it without showing it on screen. It cannot be selected with `display: none`.
    area.setAttribute('aria-hidden', 'true')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

function createButton(code: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'code-copy'
  // The label comes from the viewer's small dictionary (7.4.4). The button is rebuilt every time the body is redrawn,
  // so a language change is reflected at that point.
  button.title = vt('copyCode')
  button.setAttribute('aria-label', vt('copyCode'))
  button.append(copyIcon())
  let timer: ReturnType<typeof setTimeout> | null = null
  button.addEventListener('click', () => {
    void copyText(code).then((ok) => {
      if (!ok) return
      button.textContent = ''
      button.append(checkIcon())
      button.classList.add('copied')
      button.title = vt('copied')
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        button.textContent = ''
        button.append(copyIcon())
        button.classList.remove('copied')
        button.title = vt('copyCode')
      }, 1500)
    })
  })
  return button
}

/**
 * Puts one button into each `.code-block` under `root` (the wrapper render.ts produced).
 * **Call it right after rewriting the body**. Buttons already present are skipped so none is added twice.
 */
export function attachCopyButtons(root: HTMLElement): void {
  for (const block of Array.from(root.querySelectorAll<HTMLElement>('.code-block'))) {
    if (block.querySelector(':scope > .code-copy') !== null) continue
    block.append(createButton(decodeCodeBlock(block.dataset['code'])))
  }
}
