/**
 * Pure functions for the always-visible Model / Thinking buttons (item 61): initial selection in a world with no "default", and
 * keyboard operation of `role="radiogroup"`. No DOM is used.
 */
import { describe, expect, it } from 'vitest'
import { FALLBACK_THINKING } from '../src/shared/agent.js'
import {
  modelsSignature,
  resolveModelChoice,
  resolveThinkingChoice,
  segmentedKeyStep,
  switchNeedsRestart,
  thinkingLabel,
  thinkingLabelKey,
  thinkingSegmentLevels,
  thinkingSelectLevels
} from '../src/renderer/src/composer-choice.js'

const MODELS = [
  { id: 'm-a', label: 'A' },
  { id: 'm-b', label: 'B' }
]

describe('resolveModelChoice (項目 61)', () => {
  it('スレッドの値が最優先で、一覧に無くてもそのまま (「一覧に無い」として出す)', () => {
    expect(resolveModelChoice('m-b', 'm-a', MODELS)).toBe('m-b')
    expect(resolveModelChoice('m-old', 'm-a', MODELS)).toBe('m-old')
  })
  it('未指定のスレッドは設定の既定 → 一覧の先頭。「既定」という選択は無い', () => {
    expect(resolveModelChoice(null, 'm-b', MODELS)).toBe('m-b')
    expect(resolveModelChoice(null, null, MODELS)).toBe('m-a')
    // If the setting's default is not in the list, fall back to the first (after the table changed).
    expect(resolveModelChoice(null, 'm-gone', MODELS)).toBe('m-a')
  })
  it('一覧が空なら null (モデルを選べないバックエンド)', () => {
    expect(resolveModelChoice(null, null, [])).toBeNull()
  })
})

describe('resolveThinkingChoice (項目 61)', () => {
  it('スレッド → 設定 → FALLBACK_THINKING の順で、常に具体的な段階を返す', () => {
    expect(resolveThinkingChoice('high', 'low')).toBe('high')
    expect(resolveThinkingChoice(null, 'low')).toBe('low')
    expect(resolveThinkingChoice(null, null)).toBe(FALLBACK_THINKING)
  })
})

describe('thinkingLabelKey (項目 92、オーナー決定 2026-09-26)', () => {
  it('通常のモデルは段階名のまま', () => {
    expect(thinkingLabelKey('off', false)).toBe('thinking.off')
    expect(thinkingLabelKey('low', false)).toBe('thinking.low')
    expect(thinkingLabelKey('medium', false)).toBe('thinking.medium')
    expect(thinkingLabelKey('high', false)).toBe('thinking.high')
  })
  it('二択のモデル (Haiku) は FALLBACK_THINKING だけ「あり」に言い換える。「なし」はそのまま', () => {
    expect(thinkingLabelKey('off', true)).toBe('thinking.off')
    expect(thinkingLabelKey(FALLBACK_THINKING, true)).toBe('thinking.on')
    // low/high are stages that cannot be chosen on a two-choice model, but as keys they stay as stage names (the caller hides them as disabled).
    expect(thinkingLabelKey('low', true)).toBe('thinking.low')
    expect(thinkingLabelKey('high', true)).toBe('thinking.high')
  })
})

describe('TODO 1205: Thinking の段の並びと札', () => {
  it('「なし / 浅く / 普通 / 深く」はいつも並べ、モデルが支える上の段をその右に足す', () => {
    expect(thinkingSegmentLevels(undefined)).toEqual(['off', 'low', 'medium', 'high'])
    // Even on a model where "none" cannot be turned off, "none" is still listed (the strike-through is drawn by the caller as disabled).
    expect(thinkingSegmentLevels(['low', 'medium', 'high', 'xhigh', 'max'])).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    expect(thinkingSegmentLevels(['off', 'medium'])).toEqual(['off', 'low', 'medium', 'high'])
    expect(thinkingSegmentLevels(['low', 'high', 'effort:ultra', 'max'])).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'effort:ultra',
      'max'
    ])
  })
  it('名前の付いた段は辞書、名前の無い段は値そのまま', () => {
    const t = (key: string): string => `<${key}>`
    expect(thinkingLabel('xhigh', false, t)).toBe('<thinking.xhigh>')
    expect(thinkingLabel('max', false, t)).toBe('<thinking.max>')
    expect(thinkingLabel(FALLBACK_THINKING, true, t)).toBe('<thinking.on>')
    expect(thinkingLabel('effort:ultra', false, t)).toBe('ultra')
  })
})

describe('segmentedKeyStep (radiogroup のキーボード操作)', () => {
  it('矢印で前後に動き、端で巻き戻る', () => {
    expect(segmentedKeyStep('ArrowRight', 0, 3)).toBe(1)
    expect(segmentedKeyStep('ArrowDown', 2, 3)).toBe(0)
    expect(segmentedKeyStep('ArrowLeft', 0, 3)).toBe(2)
    expect(segmentedKeyStep('ArrowUp', 1, 3)).toBe(0)
  })
  it('Home / End で両端', () => {
    expect(segmentedKeyStep('Home', 2, 4)).toBe(0)
    expect(segmentedKeyStep('End', 0, 4)).toBe(3)
  })
  it('関係ないキーと空の一覧では何もしない', () => {
    expect(segmentedKeyStep('Enter', 0, 3)).toBeNull()
    expect(segmentedKeyStep('a', 0, 3)).toBeNull()
    expect(segmentedKeyStep('ArrowRight', 0, 0)).toBeNull()
  })
  it('無効な選択肢は飛ばす (項目 92: そのモデルで効かない thinking の段階)', () => {
    // Opus / Fable: "none" (0) is disabled.
    const opus = [false, true, true, true]
    expect(segmentedKeyStep('ArrowLeft', 1, 4, opus)).toBe(3)
    expect(segmentedKeyStep('Home', 3, 4, opus)).toBe(1)
    expect(segmentedKeyStep('End', 1, 4, opus)).toBe(3)
    // Haiku: only "none" (0) and "normal" (2) are enabled.
    const haiku = [true, false, true, false]
    expect(segmentedKeyStep('ArrowRight', 0, 4, haiku)).toBe(2)
    expect(segmentedKeyStep('ArrowRight', 2, 4, haiku)).toBe(0)
    expect(segmentedKeyStep('End', 0, 4, haiku)).toBe(2)
    // If all are disabled, nothing moves.
    expect(segmentedKeyStep('ArrowRight', 0, 2, [false, false])).toBeNull()
  })
})

describe('switchNeedsRestart (項目 95: 「再起動が要ります」を出す条件)', () => {
  it('always は常に、never は決して起こし直さない', () => {
    expect(switchNeedsRestart('always', 'low', 'high')).toBe(true)
    expect(switchNeedsRestart('never', 'off', 'high')).toBe(false)
  })
  it('thinking-on (「なし」で起動) は「なし」から戻すときだけ', () => {
    expect(switchNeedsRestart('thinking-on', 'off', 'medium')).toBe(true)
    expect(switchNeedsRestart('thinking-on', 'off', 'off')).toBe(false)
    expect(switchNeedsRestart('thinking-on', 'low', 'high')).toBe(false)
    expect(switchNeedsRestart('thinking-on', 'off', null)).toBe(false)
  })
})

describe('modelsSignature (TODO 937)', () => {
  it('中身が同じ新しい配列は同じ鍵', () => {
    expect(modelsSignature(MODELS)).toBe(modelsSignature(MODELS.map((m) => ({ ...m }))))
  })
  it('id が変われば鍵も変わる / null は null', () => {
    expect(modelsSignature(MODELS)).not.toBe(modelsSignature([MODELS[0]!]))
    expect(modelsSignature(null)).toBeNull()
  })
  it('label / shortLabel / thinking の段だけの変化でも鍵が変わる', () => {
    const base = modelsSignature(MODELS)
    expect(modelsSignature([{ ...MODELS[0]!, label: 'A2' }, MODELS[1]!])).not.toBe(base)
    expect(modelsSignature([{ ...MODELS[0]!, shortLabel: 'a' }, MODELS[1]!])).not.toBe(base)
    expect(modelsSignature([{ ...MODELS[0]!, thinkingLevels: ['low'] }, MODELS[1]!])).not.toBe(base)
  })
})

describe('thinkingSelectLevels (第 82 波 review Y-5)', () => {
  const named = ['off', 'low', 'medium', 'high', 'xhigh', 'max']
  it('保存値が名前の付いた段か未指定なら 6 段だけ', () => {
    expect(thinkingSelectLevels(null)).toEqual(named)
    expect(thinkingSelectLevels('max')).toEqual(named)
  })
  it('保存値が名前の無い段なら末尾に足す (先頭の「なし」を選んだように見せない)', () => {
    const levels = thinkingSelectLevels('effort:ultra')
    expect(levels).toEqual([...named, 'effort:ultra'])
    expect(thinkingLabel('effort:ultra', false, () => 'x')).toBe('ultra')
  })
})
