// @vitest-environment jsdom
/**
 * Item 212 (wave 14 bundle L): the settings editor closes **even when the thread being shown is pressed again**.
 *
 * `threadStore.selectThread` advances `selectionSeq` even for calls that do not change `activeThreadId` (threadStore.ts). `settingsEditorStore.ts` closes on just that change, so here `useThreads.setState` triggers an update of the same shape, and only the pure store wiring is checked, without window.aios or Electron.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useThreads } from '../src/renderer/src/threadStore.js'
import { useSettingsEditor } from '../src/renderer/src/settingsEditorStore.js'

describe('設定エディタが閉じる条件 (項目 212)', () => {
  beforeEach(() => {
    useThreads.setState({ activeThreadId: null, selectionSeq: 0 })
    useSettingsEditor.setState({ open: false })
  })

  it('別のスレッドを選ぶと閉じる (従来どおり)', () => {
    useThreads.setState({ activeThreadId: 'a', selectionSeq: 1 })
    useSettingsEditor.getState().openEditor()
    expect(useSettingsEditor.getState().open).toBe(true)
    useThreads.setState((state) => ({ activeThreadId: 'b', selectionSeq: state.selectionSeq + 1 }))
    expect(useSettingsEditor.getState().open).toBe(false)
  })

  it('いま表示中と同じスレッドをもう一度選んでも閉じる (selectionSeq だけ進む)', () => {
    useThreads.setState({ activeThreadId: 'a', selectionSeq: 1 })
    useSettingsEditor.getState().openEditor()
    expect(useSettingsEditor.getState().open).toBe(true)
    // Keep activeThreadId as 'a', simulating selectThread advancing only selectionSeq.
    useThreads.setState((state) => ({ activeThreadId: 'a', selectionSeq: state.selectionSeq + 1 }))
    expect(useSettingsEditor.getState().open).toBe(false)
  })

  it('会話検索のヒットから同じスレッドへ飛んだとき (jumpToEvent 相当) も閉じる', () => {
    useThreads.setState({ activeThreadId: 'a', selectionSeq: 1 })
    useSettingsEditor.getState().openEditor()
    // jumpToEvent just calls selectThread internally, so the same selectionSeq advance can verify it.
    useThreads.setState((state) => ({ activeThreadId: 'a', selectionSeq: state.selectionSeq + 1 }))
    expect(useSettingsEditor.getState().open).toBe(false)
  })

  it('selectionSeq が進まない更新 (他の state だけの変化) では閉じない', () => {
    useThreads.setState({ activeThreadId: 'a', selectionSeq: 1 })
    useSettingsEditor.getState().openEditor()
    useThreads.setState({ highlightEventId: 'e1' })
    expect(useSettingsEditor.getState().open).toBe(true)
  })

  it('activeThreadId が null のまま selectionSeq が進んでも閉じない (スレッドが無い状態)', () => {
    useSettingsEditor.getState().openEditor()
    useThreads.setState((state) => ({ selectionSeq: state.selectionSeq + 1 }))
    expect(useSettingsEditor.getState().open).toBe(true)
  })
})
