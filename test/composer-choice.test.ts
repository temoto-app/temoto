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
  thinkingSelectLevels,
  selectableThinkingSegments
} from '../src/renderer/src/composer-choice.js'

const MODELS = [
  { id: 'm-a', label: 'A' },
  { id: 'm-b', label: 'B' }
]

describe('resolveModelChoice (item 61)', () => {
  it('the thread\'s value wins and is kept as is even if not in the list (shown as "not in the list")', () => {
    expect(resolveModelChoice('m-b', 'm-a', MODELS)).toBe('m-b')
    expect(resolveModelChoice('m-old', 'm-a', MODELS)).toBe('m-old')
  })
  it('an unspecified thread uses the setting default, then the head of the list; there is no "default" choice', () => {
    expect(resolveModelChoice(null, 'm-b', MODELS)).toBe('m-b')
    expect(resolveModelChoice(null, null, MODELS)).toBe('m-a')
    // If the setting's default is not in the list, fall back to the first (after the table changed).
    expect(resolveModelChoice(null, 'm-gone', MODELS)).toBe('m-a')
  })
  it('null when the list is empty (a backend where the model cannot be chosen)', () => {
    expect(resolveModelChoice(null, null, [])).toBeNull()
  })
})

describe('resolveThinkingChoice (item 61)', () => {
  it('always returns a concrete level, in the order thread, setting, FALLBACK_THINKING', () => {
    expect(resolveThinkingChoice('high', 'low')).toBe('high')
    expect(resolveThinkingChoice(null, 'low')).toBe('low')
    expect(resolveThinkingChoice(null, null)).toBe(FALLBACK_THINKING)
  })
})

describe('thinkingLabelKey (item 92, owner decision 2026-09-26)', () => {
  it('a normal model keeps the level name', () => {
    expect(thinkingLabelKey('off', false)).toBe('thinking.off')
    expect(thinkingLabelKey('low', false)).toBe('thinking.low')
    expect(thinkingLabelKey('medium', false)).toBe('thinking.medium')
    expect(thinkingLabelKey('high', false)).toBe('thinking.high')
  })
  it('a two-choice model (Haiku) rewrites only FALLBACK_THINKING as "on"; "off" stays as is', () => {
    expect(thinkingLabelKey('off', true)).toBe('thinking.off')
    expect(thinkingLabelKey(FALLBACK_THINKING, true)).toBe('thinking.on')
    // low/high are stages that cannot be chosen on a two-choice model, but as keys they stay as stage names (the caller hides them as disabled).
    expect(thinkingLabelKey('low', true)).toBe('thinking.low')
    expect(thinkingLabelKey('high', true)).toBe('thinking.high')
  })
})

describe('TODO 1205: order and badges of the Thinking levels', () => {
  it('always lists "off / low / medium / high" and adds to the right the upper levels the model supports', () => {
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
  it('TODO 1295: levels the model cannot take are dropped from the row, and the row never goes empty', () => {
    const levels = thinkingSegmentLevels(['low', 'medium', 'high', 'max'])
    expect(selectableThinkingSegments(levels, ['low', 'medium', 'high', 'max'])).toEqual(['low', 'medium', 'high', 'max'])
    expect(selectableThinkingSegments(thinkingSegmentLevels(undefined), ['off', 'medium'])).toEqual(['off', 'medium'])
    expect(selectableThinkingSegments(levels, [])).toEqual(levels)
  })
  it('a named level uses the dictionary, an unnamed level uses the value as is', () => {
    const t = (key: string): string => `<${key}>`
    expect(thinkingLabel('xhigh', false, t)).toBe('<thinking.xhigh>')
    expect(thinkingLabel('max', false, t)).toBe('<thinking.max>')
    expect(thinkingLabel(FALLBACK_THINKING, true, t)).toBe('<thinking.on>')
    expect(thinkingLabel('effort:ultra', false, t)).toBe('ultra')
  })
})

describe('segmentedKeyStep (radiogroup keyboard operation)', () => {
  it('moves forward and back with arrows, wrapping at the ends', () => {
    expect(segmentedKeyStep('ArrowRight', 0, 3)).toBe(1)
    expect(segmentedKeyStep('ArrowDown', 2, 3)).toBe(0)
    expect(segmentedKeyStep('ArrowLeft', 0, 3)).toBe(2)
    expect(segmentedKeyStep('ArrowUp', 1, 3)).toBe(0)
  })
  it('Home / End go to the ends', () => {
    expect(segmentedKeyStep('Home', 2, 4)).toBe(0)
    expect(segmentedKeyStep('End', 0, 4)).toBe(3)
  })
  it('does nothing for unrelated keys and an empty list', () => {
    expect(segmentedKeyStep('Enter', 0, 3)).toBeNull()
    expect(segmentedKeyStep('a', 0, 3)).toBeNull()
    expect(segmentedKeyStep('ArrowRight', 0, 0)).toBeNull()
  })
  it('skips disabled options (item 92: thinking levels that do not apply to that model)', () => {
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

describe('switchNeedsRestart (item 95: the condition for showing "restart needed")', () => {
  it('always never restarts for always, and never restarts for never', () => {
    expect(switchNeedsRestart('always', 'low', 'high')).toBe(true)
    expect(switchNeedsRestart('never', 'off', 'high')).toBe(false)
  })
  it('thinking-on (started with "off") only when going back from "off"', () => {
    expect(switchNeedsRestart('thinking-on', 'off', 'medium')).toBe(true)
    expect(switchNeedsRestart('thinking-on', 'off', 'off')).toBe(false)
    expect(switchNeedsRestart('thinking-on', 'low', 'high')).toBe(false)
    expect(switchNeedsRestart('thinking-on', 'off', null)).toBe(false)
  })
})

describe('modelsSignature (TODO 937)', () => {
  it('a new array with the same content gives the same key', () => {
    expect(modelsSignature(MODELS)).toBe(modelsSignature(MODELS.map((m) => ({ ...m }))))
  })
  it('a changed id changes the key / null is null', () => {
    expect(modelsSignature(MODELS)).not.toBe(modelsSignature([MODELS[0]!]))
    expect(modelsSignature(null)).toBeNull()
  })
  it('a change in only label / shortLabel / thinking levels changes the key too', () => {
    const base = modelsSignature(MODELS)
    expect(modelsSignature([{ ...MODELS[0]!, label: 'A2' }, MODELS[1]!])).not.toBe(base)
    expect(modelsSignature([{ ...MODELS[0]!, shortLabel: 'a' }, MODELS[1]!])).not.toBe(base)
    expect(modelsSignature([{ ...MODELS[0]!, thinkingLevels: ['low'] }, MODELS[1]!])).not.toBe(base)
  })
})

describe('thinkingSelectLevels (wave 82 review Y-5)', () => {
  const named = ['off', 'low', 'medium', 'high', 'xhigh', 'max']
  it('only 6 levels when the saved value is a named level or unspecified', () => {
    expect(thinkingSelectLevels(null)).toEqual(named)
    expect(thinkingSelectLevels('max')).toEqual(named)
  })
  it('when the saved value is an unnamed level, appends it at the end (does not look like the leading "off" was chosen)', () => {
    const levels = thinkingSelectLevels('effort:ultra')
    expect(levels).toEqual([...named, 'effort:ultra'])
    expect(thinkingLabel('effort:ultra', false, () => 'x')).toBe('ultra')
  })
})
