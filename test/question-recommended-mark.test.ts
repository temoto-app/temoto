import { describe, expect, it } from 'vitest'
import { withoutRecommendedMark } from '../src/renderer/src/components/QuestionPrompt.js'

describe('withoutRecommendedMark (TODO 1194)', () => {
  it('removes the recommendation mark at the end of the badge from the display', () => {
    expect(withoutRecommendedMark('Use Postgres (Recommended)')).toBe('Use Postgres')
    expect(withoutRecommendedMark('既存のセット (推奨)')).toBe('既存のセット')
    expect(withoutRecommendedMark('全角（推奨）')).toBe('全角')
  })
  it('a badge without the mark or with only the mark is left as it is', () => {
    expect(withoutRecommendedMark('Plain')).toBe('Plain')
    expect(withoutRecommendedMark('(Recommended)')).toBe('(Recommended)')
  })
})
