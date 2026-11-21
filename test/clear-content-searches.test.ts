// @vitest-environment jsdom
/**
 * TODO 1065 (wave 59 bundle B): when a word is typed into ⌘P (file name search), clear the in-file search highlight and the
 * in-conversation search word and window. Merely opening does not clear it (only the field's onChange calls it).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { clearContentSearches } from '../src/renderer/src/shortcut-actions.js'
import { useStore } from '../src/renderer/src/store.js'
import { useThreadFind } from '../src/renderer/src/threadFindStore.js'

describe('clearContentSearches', () => {
  beforeEach(() => {
    useStore.setState({ highlightQuery: 'needle' })
    useThreadFind.setState({ open: true })
    useThreadFind.getState().setQuery('foo bar')
  })

  it('clears the in-file search words and the conversation search words and windows', () => {
    clearContentSearches()
    expect(useStore.getState().highlightQuery).toBeNull()
    expect(useThreadFind.getState().query).toBe('')
    expect(useThreadFind.getState().terms).toEqual([])
    expect(useThreadFind.getState().open).toBe(false)
  })

  it('does nothing when there is nothing (may be called twice)', () => {
    clearContentSearches()
    clearContentSearches()
    expect(useStore.getState().highlightQuery).toBeNull()
    expect(useThreadFind.getState().open).toBe(false)
  })
})
