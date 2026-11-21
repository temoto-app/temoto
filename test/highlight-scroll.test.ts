import { describe, expect, it } from 'vitest'
import { shouldScrollToHighlight } from '../src/renderer/src/thread/highlight-scroll.js'

describe('shouldScrollToHighlight (TODO 940)', () => {
  it('強調が無ければ動かさない', () => {
    expect(shouldScrollToHighlight(null, null)).toBe(false)
  })
  it('まだ飛んでいない強調へは飛ぶ', () => {
    expect(shouldScrollToHighlight(null, 'e1')).toBe(true)
  })
  it('飛んだ後は項目が増えても動かさない', () => {
    expect(shouldScrollToHighlight('e1', 'e1')).toBe(false)
  })
  it('別の強調には飛ぶ', () => {
    expect(shouldScrollToHighlight('e1', 'e2')).toBe(true)
  })
})
