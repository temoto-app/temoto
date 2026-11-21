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

describe('一時表示 (項目 104)', () => {
  beforeEach(() => {
    useStore.setState({ selectedUri: null, highlightQuery: null, transient: null, viewerSelection: null })
  })

  it('toDiffPayload は言語のヒントを整え、空なら null にする', () => {
    expect(toDiffPayload(input)).toEqual({
      kind: 'diff',
      before: { name: 'a.ts', text: 'const a = 1\n', language: null },
      after: { name: 'a.ts', text: 'const a = 2\n', language: 'typescript' }
    })
    expect(toDiffPayload({ before: { ...input.before, language: '  ' }, after: input.after }).before.language).toBeNull()
  })

  it('openDiff は裏のファイルに触らず、closeTransient でそのファイルに戻る', () => {
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

  it('ファイルが開いていなくても一時表示だけで開ける (閉じれば何も無い状態に戻る)', () => {
    useStore.getState().openDiff(input)
    expect(useStore.getState().transient).not.toBeNull()
    expect(useStore.getState().selectedUri).toBeNull()
    useStore.getState().closeTransient()
    expect(useStore.getState().transient).toBeNull()
  })

  it('ファイルを選ぶと一時表示は閉じる', () => {
    useStore.getState().openDiff(input)
    useStore.getState().select('file:///x/b.ts')
    expect(useStore.getState().transient).toBeNull()
    expect(useStore.getState().selectedUri).toBe('file:///x/b.ts')
  })

  it('開け閉めでスレッドの記憶の対象 (selectedUri / highlightQuery) は動かない', () => {
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
