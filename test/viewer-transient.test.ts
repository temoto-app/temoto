/**
 * The renderer-side state of ViewerPane's transient view (item 104, ARCHITECTURE.md 7.4.6).
 *
 *  - `openDiff` only sets `transient`, and does not touch `selectedUri` (the file behind)
 *  - `closeTransient` returns to the file behind
 *  - choosing a file (`select`) removes the transient view
 *  - the values watched by the per-thread memory listener (item 63) (`selectedUri` / `highlightQuery`) do not move when the transient view is opened or closed, so nothing is written to memory
 *
 * No DOM is needed (the Zustand store is used directly).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { toDiffPayload, useStore } from '../src/renderer/src/store.js'

const input = {
  before: { name: 'a.ts', text: 'const a = 1\n' },
  after: { name: 'a.ts', text: 'const a = 2\n', language: ' typescript ' }
}

describe('temporary display (item 104)', () => {
  beforeEach(() => {
    useStore.setState({ selectedUri: null, highlightQuery: null, transient: null, viewerSelection: null })
  })

  it('toDiffPayload tidies the language hint and makes it null when empty', () => {
    expect(toDiffPayload(input)).toEqual({
      kind: 'diff',
      before: { name: 'a.ts', text: 'const a = 1\n', language: null },
      after: { name: 'a.ts', text: 'const a = 2\n', language: 'typescript' }
    })
    expect(toDiffPayload({ before: { ...input.before, language: '  ' }, after: input.after }).before.language).toBeNull()
  })

  it('openDiff does not touch the file behind, and closeTransient returns to that file', () => {
    useStore.getState().select('file:///x/a.ts', { highlight: 'foo' })
    useStore.getState().openDiff(input)
    let state = useStore.getState()
    expect(state.transient?.kind).toBe('diff')
    expect(state.selectedUri).toBe('file:///x/a.ts')
    expect(state.highlightQuery).toBe('foo')

    useStore.getState().closeTransient()
    state = useStore.getState()
    expect(state.transient).toBeNull()
    expect(state.selectedUri).toBe('file:///x/a.ts')
    expect(state.highlightQuery).toBe('foo')
  })

  it('can open with only a temporary display even when no file is open (closing returns to nothing)', () => {
    useStore.getState().openDiff(input)
    expect(useStore.getState().transient).not.toBeNull()
    expect(useStore.getState().selectedUri).toBeNull()
    useStore.getState().closeTransient()
    expect(useStore.getState().transient).toBeNull()
  })

  it('selecting a file closes the temporary display', () => {
    useStore.getState().openDiff(input)
    useStore.getState().select('file:///x/b.ts')
    expect(useStore.getState().transient).toBeNull()
    expect(useStore.getState().selectedUri).toBe('file:///x/b.ts')
  })

  it('opening and closing does not move the thread memory targets (selectedUri / highlightQuery)', () => {
    useStore.getState().select('file:///x/a.ts')
    const seen: string[] = []
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.selectedUri !== previous.selectedUri || state.highlightQuery !== previous.highlightQuery) {
        seen.push(String(state.selectedUri))
      }
    })
    useStore.getState().openDiff(input)
    useStore.getState().openDiff({ ...input, after: { name: 'a.ts', text: 'x' } })
    useStore.getState().closeTransient()
    useStore.getState().closeTransient()
    unsubscribe()
    expect(seen).toEqual([])
  })
})
