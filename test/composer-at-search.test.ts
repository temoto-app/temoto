import { describe, expect, it } from 'vitest'
import { atAnswerOutcome } from '../src/renderer/src/composer-at-search.js'

describe('atAnswerOutcome (wave 49 review / TODO 942)', () => {
  it('drops a response that was overtaken', () => {
    expect(atAnswerOutcome(false, false)).toBe('ignore')
    expect(atAnswerOutcome(true, false)).toBe('ignore')
  })
  it('a cancelled for the current request clears the candidates and settles the word (does not leave stale candidates)', () => {
    expect(atAnswerOutcome(true, true)).toBe('clear')
  })
  it('a success for the current request inserts the candidates', () => {
    expect(atAnswerOutcome(false, true)).toBe('apply')
  })
})
