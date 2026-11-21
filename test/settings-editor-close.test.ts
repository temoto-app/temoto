// @vitest-environment jsdom
/**
 * Item 212 (wave 14 bundle L): the settings editor closes **even when the thread being shown is pressed again**.
 *
 * `threadStore.selectThread` advances `selectionSeq` even for calls that do not change `activeThreadId` (threadStore.ts). `settingsEditorStore.ts` closes on just that change, so here `useThreads.setState` triggers an update of the same shape, and only the pure store wiring is checked, without window.aios or Electron.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useThreads } from '../src/renderer/src/threadStore.js'
import { useSettingsEditor } from '../src/renderer/src/settingsEditorStore.js'

describe('conditions for the settings editor to close (item 212)', () => {
  beforeEach(() => {
    useThreads.setState({ activeThreadId: null, selectionSeq: 0 })
    useSettingsEditor.setState({ open: false })
  })

  it('closes when another thread is selected (as before)', () => {
    useThreads.setState({ activeThreadId: 'a', selectionSeq: 1 })
    useSettingsEditor.getState().openEditor()
    expect(useSettingsEditor.getState().open).toBe(true)
    useThreads.setState((state) => ({ activeThreadId: 'b', selectionSeq: state.selectionSeq + 1 }))
    expect(useSettingsEditor.getState().open).toBe(false)
  })

  it('closes even when the currently shown thread is selected again (only selectionSeq advances)', () => {
    useThreads.setState({ activeThreadId: 'a', selectionSeq: 1 })
    useSettingsEditor.getState().openEditor()
    expect(useSettingsEditor.getState().open).toBe(true)
    // Keep activeThreadId as 'a', simulating selectThread advancing only selectionSeq.
    useThreads.setState((state) => ({ activeThreadId: 'a', selectionSeq: state.selectionSeq + 1 }))
    expect(useSettingsEditor.getState().open).toBe(false)
  })

  it('also closes when jumping to the same thread from a conversation search hit (equivalent to jumpToEvent)', () => {
    useThreads.setState({ activeThreadId: 'a', selectionSeq: 1 })
    useSettingsEditor.getState().openEditor()
    // jumpToEvent just calls selectThread internally, so the same selectionSeq advance can verify it.
    useThreads.setState((state) => ({ activeThreadId: 'a', selectionSeq: state.selectionSeq + 1 }))
    expect(useSettingsEditor.getState().open).toBe(false)
  })

  it('does not close on an update where selectionSeq does not advance (a change in only other state)', () => {
    useThreads.setState({ activeThreadId: 'a', selectionSeq: 1 })
    useSettingsEditor.getState().openEditor()
    useThreads.setState({ highlightEventId: 'e1' })
    expect(useSettingsEditor.getState().open).toBe(true)
  })

  it('does not close even if selectionSeq advances while activeThreadId stays null (a state with no thread)', () => {
    useSettingsEditor.getState().openEditor()
    useThreads.setState((state) => ({ selectionSeq: state.selectionSeq + 1 }))
    expect(useSettingsEditor.getState().open).toBe(true)
  })
})
