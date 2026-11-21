import { describe, expect, it } from 'vitest'
import { atAnswerOutcome } from '../src/renderer/src/composer-at-search.js'

describe('atAnswerOutcome (第 49 波 review / TODO 942)', () => {
  it('追い越された応答は捨てる', () => {
    expect(atAnswerOutcome(false, false)).toBe('ignore')
    expect(atAnswerOutcome(true, false)).toBe('ignore')
  })
  it('いまの依頼の cancelled は候補を消して語を確定させる (stale のまま古い候補を残さない)', () => {
    expect(atAnswerOutcome(true, true)).toBe('clear')
  })
  it('いまの依頼の成功は候補を入れる', () => {
    expect(atAnswerOutcome(false, true)).toBe('apply')
  })
})
