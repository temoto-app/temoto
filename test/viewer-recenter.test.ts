/**
 * @vitest-environment jsdom
 *
 * Pressing the same hit again in the body search makes the viewer re-center it (TODO 446, wave 23 bundle G, ARCHITECTURE.md 7.4.3).
 *
 *  - renderer: each `select` with a search word sets a one-time instruction (`viewerRecenter`, with a nonce). When the same file and the same search word are pressed again,
 *    `resource` is coalesced by `samePush` (before, nothing was sent), but the number advances
 *  - host (ViewerPane's sending point `recenterMessageFor`): once per number, after the viewer has drawn the file of the instruction
 *  - viewer (bridge's `acceptRecenter`): drops a file other than the one displayed
 *  - editor: after moving to another match with the box, re-applying the same search word returns the current match to the first in the document and shows it in the center
 *
 * Neither the model nor Electron is started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { createEditor } from '../plugins/_shared/editor.js'
import { acceptRecenter } from '../plugins/_shared/bridge.js'
import { samePush, type PushedResource } from '../src/renderer/src/viewer-route.js'
import { recenterMessageFor, viewerRecenterRequest } from '../src/renderer/src/viewer-line.js'
import { useStore } from '../src/renderer/src/store.js'

describe('renderer: re-center requests (viewerRecenterRequest / recenterMessageFor)', () => {
  it('raised only when there are search terms', () => {
    expect(viewerRecenterRequest('file:///a', 'foo', 1)).toEqual({ uri: 'file:///a', nonce: 1 })
    expect(viewerRecenterRequest('file:///a', '', 1)).toBeNull()
    expect(viewerRecenterRequest(null, 'foo', 1)).toBeNull()
  })

  it('only once per number after the viewer has drawn the requested file', () => {
    const request = { uri: 'file:///a', nonce: 4 }
    expect(recenterMessageFor(request, null, 0)).toBeNull()
    expect(recenterMessageFor(request, 'file:///b', 0)).toBeNull()
    expect(recenterMessageFor(request, 'file:///a', 0)).toEqual({ type: 'recenter', uri: 'file:///a' })
    expect(recenterMessageFor(request, 'file:///a', 4)).toBeNull()
    expect(recenterMessageFor(null, 'file:///a', 0)).toBeNull()
  })
})

describe('renderer: re-center of store.select (TODO 446)', () => {
  beforeEach(() => {
    // So that `select`'s auto reveal (item 264) does not go to fetch the tree list, it is put in the searching form.
    useStore.setState({
      selectedUri: null,
      highlightQuery: null,
      viewerLine: null,
      viewerRecenter: null,
      results: { items: [], truncated: false } as never
    })
  })

  it('selecting the same file and search terms again advances the number even if the resource is the same (samePush)', () => {
    useStore.getState().select('file:///a', { highlight: 'foo' })
    const first = useStore.getState()
    useStore.getState().select('file:///a', { highlight: 'foo' })
    const second = useStore.getState()
    expect(second.selectedUri).toBe(first.selectedUri)
    expect(second.highlightQuery).toBe(first.highlightQuery)
    expect(first.viewerRecenter).toMatchObject({ uri: 'file:///a' })
    expect(second.viewerRecenter!.nonce).toBeGreaterThan(first.viewerRecenter!.nonce)
    // The contents of the resource the host sends do not change (before, nothing arrived here).
    const pushed = (state: typeof first): PushedResource => ({
      port: 'p',
      uri: state.selectedUri!,
      revision: 1,
      editable: true,
      theme: 'light',
      locale: 'ja',
      highlightQuery: state.highlightQuery
    })
    expect(samePush(pushed(first), pushed(second))).toBe(true)
    // The re-center message is sent with the second number.
    expect(recenterMessageFor(second.viewerRecenter, 'file:///a', first.viewerRecenter!.nonce)).toEqual({
      type: 'recenter',
      uri: 'file:///a'
    })
  })

  it('a select without search terms (tree, file name search) does not raise one and clears the previous request', () => {
    useStore.getState().select('file:///a', { highlight: 'foo' })
    useStore.getState().select('file:///a')
    expect(useStore.getState().viewerRecenter).toBeNull()
    useStore.getState().select('file:///a', { highlight: '   ' })
    expect(useStore.getState().viewerRecenter).toBeNull()
  })

  it('the value watched by the memory (item 63) subscription does not move on a re-press', () => {
    useStore.getState().select('file:///a', { highlight: 'foo' })
    const seen: string[] = []
    const off = useStore.subscribe((state, previous) => {
      if (state.selectedUri !== previous.selectedUri || state.highlightQuery !== previous.highlightQuery) {
        seen.push(String(state.selectedUri))
      }
    })
    useStore.getState().select('file:///a', { highlight: 'foo' })
    off()
    expect(seen).toEqual([])
  })
})

describe('viewer: validates the host\'s "re-center" (acceptRecenter)', () => {
  it('only those addressed to the shown file', () => {
    expect(acceptRecenter({ uri: 'file:///a' }, 'file:///a')).toEqual({ uri: 'file:///a' })
    expect(acceptRecenter({ uri: 'file:///b' }, 'file:///a')).toBeNull()
    expect(acceptRecenter({ uri: 42 }, 'file:///a')).toBeNull()
    expect(acceptRecenter({ uri: 'file:///a' }, null)).toBeNull()
  })
})

describe('editor: reapplying the same search terms returns to the first match and centers it', () => {
  let parent: HTMLElement
  beforeEach(() => {
    parent = document.createElement('div')
    document.body.append(parent)
  })
  afterEach(() => {
    parent.remove()
    vi.restoreAllMocks()
  })

  it('after moving to the third match with the box, setHighlight(same terms) makes the first match current and re-centers on it', () => {
    const lines = Array.from({ length: 60 }, (_, i) => (i % 20 === 5 ? `line ${i} needle` : `line ${i}`))
    const editor = createEditor(parent, {
      value: lines.join('\n'),
      filename: 'a.txt',
      readOnly: false,
      theme: 'light',
      onChange: () => {}
    })
    editor.setHighlight('needle')
    const box = parent.querySelector<HTMLElement>('.hit-nav')!
    box.querySelector<HTMLButtonElement>('[data-step="last"]')!.click()
    expect(box.querySelector('.hit-nav-pos')!.textContent).toBe('3 / 3')

    const spy = vi.spyOn(EditorView, 'scrollIntoView')
    editor.setHighlight('needle')
    expect(box.querySelector('.hit-nav-pos')!.textContent).toBe('1 / 3')
    const firstPos = lines.slice(0, 5).join('\n').length + 1 + 'line 5 '.length
    expect(spy).toHaveBeenCalledWith(firstPos, expect.objectContaining({ y: 'center' }))
    editor.destroy()
  })
})
