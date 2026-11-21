import { describe, expect, it } from 'vitest'
import { shouldScrollToHighlight } from '../src/renderer/src/thread/highlight-scroll.js'

describe('shouldScrollToHighlight (TODO 940)', () => {
  it('does not scroll if there is no highlight', () => {
    expect(shouldScrollToHighlight(null, null)).toBe(false)
  })
  it('scrolls to a highlight not yet scrolled to', () => {
    expect(shouldScrollToHighlight(null, 'e1')).toBe(true)
  })
  it('after scrolling, does not move even if items increase', () => {
    expect(shouldScrollToHighlight('e1', 'e1')).toBe(false)
  })
  it('scrolls to a different highlight', () => {
    expect(shouldScrollToHighlight('e1', 'e2')).toBe(true)
  })
})
