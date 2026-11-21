/**
 * item 91 / 92 (ARCHITECTURE.md 4.6.2 / 4.5.1): the model choices, versions, the thinking levels that take effect, and building and reading
 * the control-request rows. **Neither the CLI nor any model is started.**
 *
 * `test/fixtures/initialize-response.json` is a real `initialize` response from spike 16 (CLI 2.1.207), with account information removed. In this
 * version opus = Opus 4.8 and fable = Fable 5, and Opus 5.5 / Fable 5.1 appear in unavailable_models as "upgrade the CLI".
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { THINKING_LEVELS, isThinkingLevel, nearestThinkingLevel } from '../src/shared/agent.js'
import { loadCompatTable, thinkingArgs } from '../src/main/session/adapter/compat.js'
import {
  buildModelChoices,
  canonicalModelId,
  isBinaryThinkingModel,
  learnFromInitialize,
  modelVersion,
  parseLearned,
  parseReportedModels,
  pinnedFromInitialize,
  serializeLearned,
  thinkingLevelsFor,
  type LearnedModel
} from '../src/main/session/adapter/models.js'
import { controlRequestLine, readControlResponse } from '../src/main/session/adapter/control.js'

const table = loadCompatTable()
const fixtureLine = readFileSync(new URL('./fixtures/initialize-response.json', import.meta.url), 'utf8')
  .split('\n')
  .join('')
const entry = (id: string): (typeof table.models.list)[number] => {
  const found = table.models.list.find((e) => e.id === id)
  if (found === undefined) throw new Error(`no entry ${id}`)
  return found
}

function learnedFromFixture(): Map<string, LearnedModel> {
  const reply = readControlResponse(table.control, fixtureLine)
  if (reply === null) throw new Error('fixture did not parse')
  return learnFromInitialize(table, parseReportedModels(reply.response))
}

describe('model table (item 91)', () => {
  it('choices are the 4 aliases haiku / sonnet / opus / fable in this order; labels are names only', () => {
    expect(table.models.list.map((e) => e.id)).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
    expect(table.models.list.map((e) => e.label)).toEqual(['Haiku', 'Sonnet', 'Opus', 'Fable'])
  })

  it('opus reportedAs has claude-opus-5-5 (the pie chart denominator)', () => {
    expect(entry('opus').reportedAs).toContain('claude-opus-5-5')
    expect(entry('fable').reportedAs).toContain('claude-fable-5-1')
  })

  it('maps an old id (the full name of haiku) to the alias; unknown ids stay as they are', () => {
    expect(canonicalModelId(table, 'claude-haiku-4-5-20251001')).toBe('haiku')
    expect(canonicalModelId(table, 'sonnet')).toBe('sonnet')
    expect(canonicalModelId(table, 'something-else')).toBe('something-else')
    // Annotation keys are not read as a translation table.
    expect(canonicalModelId(table, '$comment')).toBe('$comment')
  })
})

describe('reading the version (modelVersion)', () => {
  it.each([
    ['claude-opus-5-5', '5.5'],
    ['claude-opus-4-8', '4.8'],
    ['claude-fable-5-1', '5.1'],
    ['claude-fable-5', '5'],
    ['claude-sonnet-5', '5'],
    ['claude-haiku-4-5-20251001', '4.5'],
    ['claude-fable-5[1m]', '5']
  ])('%s → %s', (resolved, version) => {
    expect(modelVersion(table, resolved)).toBe(version)
  })

  it('cannot read broken names and the placeholder value of unavailable (= name only)', () => {
    expect(modelVersion(table, 'cc-update-required-1')).toBeNull()
    expect(modelVersion(table, 'default')).toBeNull()
    expect(modelVersion(table, '')).toBeNull()
  })
})

describe('initialize response (the real one from spike 16)', () => {
  it('reads the response rows as control request responses and does not touch account information', () => {
    const reply = readControlResponse(table.control, fixtureLine)
    expect(reply?.ok).toBe(true)
    expect(reply?.requestId).toBe('00000000-0000-4000-8000-000000000016')
  })

  it('remembers the full name per alias; matches the fable row by family even if value is a full name; the default row does not overwrite sonnet', () => {
    const learned = learnedFromFixture()
    expect([...learned.keys()].sort()).toEqual(['fable', 'haiku', 'opus', 'sonnet'])
    expect(learned.get('opus')?.resolved).toBe('claude-opus-4-8')
    expect(learned.get('fable')?.resolved).toBe('claude-fable-5')
    expect(learned.get('sonnet')?.resolved).toBe('claude-sonnet-5')
    expect(learned.get('haiku')).toEqual({
      resolved: 'claude-haiku-4-5-20251001',
      supportsEffort: false,
      effortLevels: null
    })
  })

  it('adds the version to the label (「Opus 4.8」); unknown aliases get the name only', () => {
    const learned = learnedFromFixture()
    expect(buildModelChoices(table, learned).map((m) => m.label)).toEqual([
      'Haiku 4.5',
      'Sonnet 5',
      'Opus 4.8',
      'Fable 5'
    ])
    const partial = new Map([...learned].filter(([id]) => id === 'opus'))
    expect(buildModelChoices(table, partial).map((m) => m.label)).toEqual([
      'Haiku',
      'Sonnet',
      'Opus 4.8',
      'Fable'
    ])
    expect(buildModelChoices(table, new Map()).map((m) => m.label)).toEqual([
      'Haiku',
      'Sonnet',
      'Opus',
      'Fable'
    ])
  })

  it('does not show full names in choices (constraint 6)', () => {
    const json = JSON.stringify(buildModelChoices(table, learnedFromFixture()))
    expect(json).not.toContain('claude-')
  })

  it('the stored form round-trips; aliases not in the table and broken values are dropped', () => {
    const learned = learnedFromFixture()
    expect(parseLearned(table, serializeLearned(learned))).toEqual(learned)
    expect(parseLearned(table, '{')).toEqual(new Map())
    expect(parseLearned(table, null)).toEqual(new Map())
    expect(
      parseLearned(table, JSON.stringify({ v: 1, models: { gone: { resolved: 'x' }, opus: { resolved: 1 } } }))
    ).toEqual(new Map())
  })
})

describe('following future CLI versions (TODO 625, owner decision (a): the initialize list is the source of truth)', () => {
  // A hypothetical "next" version (a version and value that do not exist). The table (`compat/claude-code.json`) is not rewritten at all:
  // only the response is made newer, to check whether the version display follows automatically (= whether the table needs no hand edits).
  const future = {
    models: [
      { value: 'haiku', resolvedModel: 'claude-haiku-5-0-20270101', displayName: 'Haiku' },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-6', displayName: 'Sonnet' },
      {
        value: 'opus',
        resolvedModel: 'claude-opus-6-1',
        displayName: 'Opus',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high']
      },
      // fable has the same shape as the real one: value is the full name + [1m], not an alias (the path that matches by family).
      { value: 'claude-fable-6[1m]', resolvedModel: 'claude-fable-6', displayName: 'Fable' }
    ]
  }

  it('even for versions not in the table, all 4 aliases match and the version can be read from the name', () => {
    const learned = learnFromInitialize(table, parseReportedModels(future))
    expect([...learned.keys()].sort()).toEqual(['fable', 'haiku', 'opus', 'sonnet'])
    expect(buildModelChoices(table, learned).map((m) => m.label)).toEqual([
      'Haiku 5.0',
      'Sonnet 6',
      'Opus 6.1',
      'Fable 6'
    ])
  })

  it("the table's static effort / thinking defaults also follow the response when present (same path when the version changes)", () => {
    const learned = learnFromInitialize(table, parseReportedModels(future))
    const byId = new Map(buildModelChoices(table, learned).map((m) => [m.id, m.thinkingLevels]))
    // opus only lists supportsEffort: true and 3 levels in the response, so off does not appear (canDisableThinking: false).
    expect(byId.get('opus')).toEqual(['low', 'medium', 'high'])
  })
})

describe('effective thinking levels (item 92)', () => {
  it('table only (before being told): haiku / sonnet = all, opus / fable = all except off', () => {
    const levels = (id: string): readonly string[] => thinkingLevelsFor(table, entry(id), undefined)
    // TODO 769: the default of the alias haiku is Haiku 5.5 (CLI 2.1.296, where effort takes effect). Haiku 4.5 is the side where effort does not take effect through a full-name override.
    expect(levels('haiku')).toEqual(['off', 'low', 'medium', 'high'])
    expect(
      thinkingLevelsFor(table, entry('haiku'), {
        resolved: 'claude-haiku-4-5-20251001',
        supportsEffort: null,
        effortLevels: null
      })
    ).toEqual(['off', 'medium'])
    expect(levels('sonnet')).toEqual(['off', 'low', 'medium', 'high'])
    expect(levels('opus')).toEqual(['low', 'medium', 'high'])
    expect(levels('fable')).toEqual(['low', 'medium', 'high'])
  })

  it('full-name override: opus of CLI 2.1.207 (= Opus 4.8) can turn thinking off', () => {
    const learned = learnedFromFixture()
    const byId = new Map(buildModelChoices(table, learned).map((m) => [m.id, m.thinkingLevels]))
    // TODO 1205: among the response's levels (low to max), the ones above "high" are also appended at the end.
    expect(byId.get('opus')).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(byId.get('fable')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    // The response has no supportsEffort (haiku), so the effort's three levels are represented by one.
    expect(byId.get('haiku')).toEqual(['off', 'medium'])
  })

  it('levels not in the effort levels listed by the response cannot be chosen (never becomes empty)', () => {
    const only = thinkingLevelsFor(table, entry('sonnet'), {
      resolved: 'claude-sonnet-5',
      supportsEffort: true,
      effortLevels: ['high']
    })
    expect(only).toEqual(['off', 'high'])
    const none = thinkingLevelsFor(table, entry('opus'), {
      resolved: 'claude-opus-5-5',
      supportsEffort: true,
      effortLevels: []
    })
    expect(none.length).toBeGreaterThan(0)
  })

  it('owner decision (2026-09-26): only models where effort has no effect (Haiku 4.5) get the 「なし / あり」 two-way mark', () => {
    // TODO 769: when the alias haiku is known to point at Haiku 4.5 (the passive path of init, supportsEffort unknown), it is a two-way choice via a full-name override.
    expect(
      isBinaryThinkingModel(table, entry('haiku'), {
        resolved: 'claude-haiku-4-5-20251001',
        supportsEffort: null,
        effortLevels: null
      })
    ).toBe(true)
    // Before the alias haiku is taught anything, it is Haiku 5.5's default (effort takes effect).
    expect(isBinaryThinkingModel(table, entry('haiku'), undefined)).toBe(false)
    expect(isBinaryThinkingModel(table, entry('sonnet'), undefined)).toBe(false)
    expect(isBinaryThinkingModel(table, entry('opus'), undefined)).toBe(false)
    expect(isBinaryThinkingModel(table, entry('fable'), undefined)).toBe(false)
    // Even if the response says supportsEffort, the value decides (unless a full-name override exists).
    expect(
      isBinaryThinkingModel(table, entry('sonnet'), {
        resolved: 'claude-sonnet-5',
        supportsEffort: false,
        effortLevels: null
      })
    ).toBe(true)
    // The same mark applies to each row of buildModelChoices.
    const byId = new Map(buildModelChoices(table, learnedFromFixture()).map((m) => [m.id, m.thinkingBinary]))
    expect(byId.get('haiku')).toBe(true)
    expect(byId.get('sonnet')).toBe(false)
    expect(byId.get('opus')).toBe(false)
    expect(byId.get('fable')).toBe(false)
  })
})

describe('nearestThinkingLevel (item 92)', () => {
  it('keeps a selectable level as it is', () => {
    for (const level of THINKING_LEVELS) expect(nearestThinkingLevel(level, THINKING_LEVELS)).toBe(level)
  })

  it('snaps to the nearest selectable level, and to the deeper side at equal distance', () => {
    // Opus / Fable: "off" does not take effect → "low".
    expect(nearestThinkingLevel('off', ['low', 'medium', 'high'])).toBe('low')
    // Haiku: effort does not take effect → "low" and "high" become "medium"; "medium" stays as is.
    expect(nearestThinkingLevel('low', ['off', 'medium'])).toBe('medium')
    expect(nearestThinkingLevel('high', ['off', 'medium'])).toBe('medium')
    expect(nearestThinkingLevel('off', ['off', 'medium'])).toBe('off')
    expect(nearestThinkingLevel('high', ['off', 'low'])).toBe('low')
  })

  it('does not snap with an empty list', () => {
    expect(nearestThinkingLevel('high', [])).toBe('high')
  })
})

describe('control request rows (common entry for items 91 / 94)', () => {
  it('a request has the shape type / request_id / request.subtype and subtype is not overwritten', () => {
    const line = controlRequestLine(table.control, 'r1', table.control.interrupt, { subtype: 'x', a: 1 })
    expect(JSON.parse(line)).toEqual({
      type: table.control.requestType,
      request_id: 'r1',
      request: { a: 1, subtype: table.control.interrupt }
    })
  })

  it('a failure response has ok: false and a message', () => {
    const reply = readControlResponse(
      table.control,
      JSON.stringify({
        type: table.control.responseType,
        response: { subtype: 'error', request_id: 'r2', error: 'Unsupported' }
      })
    )
    expect(reply).toEqual({ requestId: 'r2', ok: false, response: null, error: 'Unsupported' })
  })

  it('does not read ordinary event rows or rows with the same word in the body as responses', () => {
    expect(readControlResponse(table.control, '{"type":"result","subtype":"success"}')).toBeNull()
    const quoted = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '"control_response" と書いた' }] }
    })
    expect(readControlResponse(table.control, quoted)).toBeNull()
    expect(readControlResponse(table.control, 'not json "control_response"')).toBeNull()
  })
})

describe("TODO 1205: build the Thinking levels from the response's effort list (owner decision 2026-11-10)", () => {
  const known = (resolved: string, effortLevels: readonly string[] | null): LearnedModel => ({
    resolved,
    supportsEffort: true,
    effortLevels
  })

  it('appends only the levels the response lists above 「深く」 at the end in response order; adds none before being told', () => {
    expect(thinkingLevelsFor(table, entry('sonnet'), known('claude-sonnet-5-5', ['low', 'medium', 'high', 'xhigh', 'max']))).toEqual(
      ['off', 'low', 'medium', 'high', 'xhigh', 'max']
    )
    // The 4.6 series has no xhigh.
    expect(thinkingLevelsFor(table, entry('sonnet'), known('claude-sonnet-4-6', ['low', 'medium', 'high', 'max']))).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'max'
    ])
    expect(thinkingLevelsFor(table, entry('sonnet'), known('claude-sonnet-5-5', null))).toEqual(['off', 'low', 'medium', 'high'])
    expect(thinkingLevelsFor(table, entry('sonnet'), undefined)).toEqual(['off', 'low', 'medium', 'high'])
  })

  it('does not drop levels not in the table but makes them value-as-is levels (effort:<value>); drops malformed values', () => {
    expect(
      thinkingLevelsFor(table, entry('opus'), known('claude-opus-6', ['low', 'medium', 'high', 'ultra', 'max', 'bad value!']))
    ).toEqual(['low', 'medium', 'high', 'effort:ultra', 'max'])
  })

  it('does not add the upper levels to models where effort has no effect (Haiku 4.5)', () => {
    expect(
      thinkingLevelsFor(table, entry('haiku'), {
        resolved: 'claude-haiku-4-5-20251001',
        supportsEffort: false,
        effortLevels: ['low', 'max']
      })
    ).toEqual(['off', 'medium'])
  })

  it('acceptance: for every model in the CLI 2.1.322 response, all effort levels the response returns are selectable', () => {
    const line = readFileSync(new URL('./fixtures/initialize-response-2.1.322.json', import.meta.url), 'utf8')
      .split('\n')
      .join('')
    const reply = readControlResponse(table.control, line)
    if (reply === null) throw new Error('fixture did not parse')
    const reported = parseReportedModels(reply.response)
    const learned = learnFromInitialize(table, reported)
    const catalog = { pinned: pinnedFromInitialize(table, reported, learned), unavailable: [] }
    const choices = buildModelChoices(table, learned, catalog)
    const levelOf = (value: string): string =>
      (Object.entries(table.thinkingLevels).find(([key, e]) => key !== 'probe' && typeof e === 'object' && e.effort === value)?.[0] ??
        `effort:${value}`)
    let checked = 0
    for (const row of reported) {
      if (!row.supportsEffort || row.effortLevels === null || row.value === 'default') continue
      const choice = choices.find((m) => m.id === row.value || learned.get(m.id)?.resolved === row.resolved)
      expect(choice, row.value).toBeDefined()
      for (const value of row.effortLevels) expect(choice?.thinkingLevels, `${row.value} ${value}`).toContain(levelOf(value))
      checked += 1
    }
    expect(checked).toBeGreaterThan(10)
  })

  it('level check: passes named levels and effort:<value>, and rejects empty and malformed values', () => {
    for (const level of ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'effort:ultra', 'effort:x-2.1']) {
      expect(isThinkingLevel(level), level).toBe(true)
    }
    for (const level of ['effort:', 'effort:a b', 'ultra', 'bogus', '', null]) expect(isThinkingLevel(level)).toBe(false)
  })

  it('values passed to the CLI: xhigh / max and unnamed levels go to --effort as the value; only 「なし」 is --thinking', () => {
    expect(thinkingArgs(table, 'xhigh')).toEqual(['--effort', 'xhigh'])
    expect(thinkingArgs(table, 'max')).toEqual(['--effort', 'max'])
    expect(thinkingArgs(table, 'effort:ultra')).toEqual(['--effort', 'ultra'])
    expect(thinkingArgs(table, 'off')).toEqual(['--thinking', 'disabled'])
  })

  it('when a model change removes the level, moves to the nearest lower level (shallower at equal distance, but never 「なし」)', () => {
    // 4.6 series without xhigh: "even deeper" → "high" (not max).
    expect(nearestThinkingLevel('xhigh', ['low', 'medium', 'high', 'max'])).toBe('high')
    // A model with no level above: max → high.
    expect(nearestThinkingLevel('max', ['off', 'low', 'medium', 'high'])).toBe('high')
    expect(nearestThinkingLevel('max', ['off', 'medium'])).toBe('medium')
    // A level with no name is treated as the deepest side.
    expect(nearestThinkingLevel('effort:ultra', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('max')
    expect(nearestThinkingLevel('max', ['low', 'medium', 'high', 'effort:ultra'])).toBe('effort:ultra')
    // "off" is not chosen even at the same distance.
    expect(nearestThinkingLevel('low', ['off', 'medium'])).toBe('medium')
    expect(nearestThinkingLevel('medium', ['off', 'low', 'high'])).toBe('low')
  })
})

describe("TODO 1209: the response's supportsThinkingOff wins over the table's canDisableThinking (owner decision 2026-11-13)", () => {
  const load = (name: string): ReturnType<typeof parseReportedModels> => {
    const line = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').split('\n').join('')
    const reply = readControlResponse(table.control, line)
    if (reply === null) throw new Error('fixture did not parse')
    return parseReportedModels(reply.response)
  }

  it('2.1.322: Sonnet 5.5 / Haiku 5.5 / Fable cannot choose 「なし」 (the table said true)', () => {
    const reported = load('initialize-response-2.1.322.json')
    const learned = learnFromInitialize(table, reported)
    const choices = buildModelChoices(table, learned, { pinned: pinnedFromInitialize(table, reported, learned), unavailable: [] })
    for (const id of ['sonnet', 'haiku', 'opus', 'fable']) {
      expect(choices.find((m) => m.id === id)?.thinkingLevels, id).not.toContain('off')
    }
    // Pinned-version rows are also values from the response: Sonnet 5 / Opus 4.8 can be turned off, Fable 5 cannot.
    expect(choices.find((m) => m.id === 'claude-sonnet-5')?.thinkingLevels).toContain('off')
    expect(choices.find((m) => m.id === 'claude-opus-4-8')?.thinkingLevels).toContain('off')
    expect(choices.find((m) => m.id === 'claude-fable-5')?.thinkingLevels).not.toContain('off')
  })

  it('an old version without the field (the real 2.1.296) follows the table', () => {
    const learned = learnedFromFixture()
    expect(thinkingLevelsFor(table, entry('sonnet'), learned.get('sonnet'))).toContain('off')
    expect(thinkingLevelsFor(table, entry('fable'), learned.get('fable'))).not.toContain('off')
  })

  it('survives the backup (save and read back)', () => {
    const learned = learnFromInitialize(table, load('initialize-response-2.1.322.json'))
    const back = parseLearned(table, serializeLearned(learned))
    expect(back.get('sonnet')?.canDisableThinking).toBe(false)
  })

  it('switching to a model that cannot turn it off moves a selected 「なし」 to the nearest level', () => {
    const levels = thinkingLevelsFor(table, entry('sonnet'), {
      resolved: 'claude-sonnet-5-5',
      supportsEffort: true,
      effortLevels: ['low', 'medium', 'high'],
      canDisableThinking: false
    })
    expect(levels).not.toContain('off')
    expect(nearestThinkingLevel('off', levels)).toBe('low')
  })
})
