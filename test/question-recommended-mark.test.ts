import { describe, expect, it } from 'vitest'
import { withoutRecommendedMark } from '../src/renderer/src/components/QuestionPrompt.js'

describe('withoutRecommendedMark (TODO 1194)', () => {
  it('札の末尾の推奨の印を表示から外す', () => {
    expect(withoutRecommendedMark('Use Postgres (Recommended)')).toBe('Use Postgres')
    expect(withoutRecommendedMark('既存のセット (推奨)')).toBe('既存のセット')
    expect(withoutRecommendedMark('全角（推奨）')).toBe('全角')
  })
  it('印が無い・印だけの札はそのまま', () => {
    expect(withoutRecommendedMark('Plain')).toBe('Plain')
    expect(withoutRecommendedMark('(Recommended)')).toBe('(Recommended)')
  })
})
