// @vitest-environment jsdom
/**
 * TODO 677: make the rows of the Files tree draggable to other apps (Terminal, Finder, etc.).
 *
 * `dragstart` stops the browser's default DnD (`preventDefault`) and calls main's `fs.startDrag` to start the OS native drag. At the same time it has `files-drag.ts` remember "the URI carried now" (the mechanism shared with 443), and forgets it on `dragend`. Read-only rows such as folders and the trash can also be handed over (owner decision: what goes out is just a copy).
 * Draws `FileMode`, and the virtual list is a fake that draws all rows (the same as `tree-context-menu.test.ts`).
 * Uses neither the model nor the real Electron.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FileEntry } from '../src/shared/types.js'
import { useStore } from '../src/renderer/src/store.js'
import { currentFilesDrag } from '../src/renderer/src/files-drag.js'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; estimateSize: (index: number) => number }) => ({
    getTotalSize: () => options.count * 24,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        start: index * 24,
        size: options.estimateSize(index),
        key: index
      })),
    scrollToIndex: () => undefined
  })
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROOT = 'file:///w'
function entry(uri: string, isDirectory: boolean, parentUri: string | null): FileEntry {
  const name = uri.slice(uri.lastIndexOf('/') + 1)
  return { uri, parentUri, name, isDirectory, size: 0, mtimeMs: 0, ext: '' }
}
const root = entry(ROOT, true, null)
const dirA = entry(`${ROOT}/a`, true, ROOT)
const fileB = entry(`${ROOT}/b.ts`, false, ROOT)

let reactRoot: Root
let host: HTMLDivElement
let startDrag: ReturnType<typeof vi.fn>

beforeEach(async () => {
  startDrag = vi.fn()
  ;(window as unknown as { aios: unknown }).aios = {
    editor: { reveal: vi.fn() },
    app: { onMenuCommand: () => () => undefined },
    fs: { startDrag }
  }
  useStore.setState({
    roots: [root],
    children: { [ROOT]: [dirA, fileB] },
    expanded: new Set([ROOT]),
    loading: new Set(),
    results: null,
    selectedUri: null,
    revealedUri: null,
    revealTick: 0,
    revealTarget: null,
    select: () => undefined,
    toggle: async () => undefined,
    setQuery: () => undefined
  })
  host = document.createElement('div')
  document.body.append(host)
  reactRoot = createRoot(host)
  const { FileMode } = await import('../src/renderer/src/components/Sidebar.js')
  act(() => reactRoot.render(createElement(FileMode)))
})

afterEach(() => {
  act(() => reactRoot.unmount())
  host.remove()
})

function rowOf(name: string): HTMLElement {
  const row = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
    (el) => el.querySelector('.row-name')?.textContent === name
  )
  if (row === undefined) throw new Error(`no row ${name}`)
  return row
}

function fireDrag(target: Element, type: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { setData: () => undefined, effectAllowed: '' } })
  act(() => target.dispatchEvent(event))
  return event
}

describe('TODO 677: native drag of Files tree rows', () => {
  it("a file row is draggable, and dragstart stops the default, calls main's startDrag, and holds the remembered URI", () => {
    const row = rowOf('b.ts')
    expect(row.getAttribute('draggable')).toBe('true')
    const event = fireDrag(row, 'dragstart')
    expect(event.defaultPrevented).toBe(true)
    expect(startDrag).toHaveBeenCalledWith([`${ROOT}/b.ts`])
    expect(currentFilesDrag()).toEqual([`${ROOT}/b.ts`])
    fireDrag(row, 'dragend')
    expect(currentFilesDrag()).toBeNull()
  })

  it('a folder row is draggable too (owner decision: a folder can also be handed over as is)', () => {
    const row = rowOf('a')
    expect(row.getAttribute('draggable')).toBe('true')
    fireDrag(row, 'dragstart')
    expect(startDrag).toHaveBeenCalledWith([`${ROOT}/a`])
    fireDrag(row, 'dragend')
    expect(currentFilesDrag()).toBeNull()
  })
})
