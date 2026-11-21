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

describe('モデルの表 (項目 91)', () => {
  it('選択肢は haiku / sonnet / opus / fable の別名 4 つ、この並び。ラベルは名前だけ', () => {
    expect(table.models.list.map((e) => e.id)).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
    expect(table.models.list.map((e) => e.label)).toEqual(['Haiku', 'Sonnet', 'Opus', 'Fable'])
  })

  it('opus の reportedAs に claude-opus-5-5 がある (円グラフの分母)', () => {
    expect(entry('opus').reportedAs).toContain('claude-opus-5-5')
    expect(entry('fable').reportedAs).toContain('claude-fable-5-1')
  })

  it('旧 id (haiku の完全名) を別名に読み替える。知らない id はそのまま', () => {
    expect(canonicalModelId(table, 'claude-haiku-4-5-20251001')).toBe('haiku')
    expect(canonicalModelId(table, 'sonnet')).toBe('sonnet')
    expect(canonicalModelId(table, 'something-else')).toBe('something-else')
    // Annotation keys are not read as a translation table.
    expect(canonicalModelId(table, '$comment')).toBe('$comment')
  })
})

describe('版の読み取り (modelVersion)', () => {
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

  it('命名が崩れたもの・unavailable の仮の値は読めない (= 名前だけ)', () => {
    expect(modelVersion(table, 'cc-update-required-1')).toBeNull()
    expect(modelVersion(table, 'default')).toBeNull()
    expect(modelVersion(table, '')).toBeNull()
  })
})

describe('initialize の応答 (spike 16 の実物)', () => {
  it('応答の行は制御要求の応答として読め、アカウント情報には触れない', () => {
    const reply = readControlResponse(table.control, fixtureLine)
    expect(reply?.ok).toBe(true)
    expect(reply?.requestId).toBe('00000000-0000-4000-8000-000000000016')
  })

  it('別名ごとに完全名を覚える。fable の行は value が完全名でも族で当てる。default の行は sonnet を上書きしない', () => {
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

  it('ラベルに版が付く (「Opus 4.8」)。知らない別名は名前だけ', () => {
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

  it('選択肢に完全名を出さない (制約 6)', () => {
    const json = JSON.stringify(buildModelChoices(table, learnedFromFixture()))
    expect(json).not.toContain('claude-')
  })

  it('保存の形は往復する。表に無い別名・壊れた値は捨てる', () => {
    const learned = learnedFromFixture()
    expect(parseLearned(table, serializeLearned(learned))).toEqual(learned)
    expect(parseLearned(table, '{')).toEqual(new Map())
    expect(parseLearned(table, null)).toEqual(new Map())
    expect(
      parseLearned(table, JSON.stringify({ v: 1, models: { gone: { resolved: 'x' }, opus: { resolved: 1 } } }))
    ).toEqual(new Map())
  })
})

describe('将来の CLI 版への追従 (TODO 625、オーナー決定 (a): initialize の一覧を正にする)', () => {
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

  it('表に無い版でも、4 つの別名全部が当たり、版が名前から読める', () => {
    const learned = learnFromInitialize(table, parseReportedModels(future))
    expect([...learned.keys()].sort()).toEqual(['fable', 'haiku', 'opus', 'sonnet'])
    expect(buildModelChoices(table, learned).map((m) => m.label)).toEqual([
      'Haiku 5.0',
      'Sonnet 6',
      'Opus 6.1',
      'Fable 6'
    ])
  })

  it('表の静的な effort / thinking の既定も、応答があればそちらに従う (版が変わっても同じ経路)', () => {
    const learned = learnFromInitialize(table, parseReportedModels(future))
    const byId = new Map(buildModelChoices(table, learned).map((m) => [m.id, m.thinkingLevels]))
    // opus only lists supportsEffort: true and 3 levels in the response, so off does not appear (canDisableThinking: false).
    expect(byId.get('opus')).toEqual(['low', 'medium', 'high'])
  })
})

describe('効く thinking の段階 (項目 92)', () => {
  it('表だけ (教わる前): haiku / sonnet = 全部、opus / fable = なし以外', () => {
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

  it('完全名の上書き: CLI 2.1.207 の opus (= Opus 4.8) は thinking を切れる', () => {
    const learned = learnedFromFixture()
    const byId = new Map(buildModelChoices(table, learned).map((m) => [m.id, m.thinkingLevels]))
    // TODO 1205: among the response's levels (low to max), the ones above "high" are also appended at the end.
    expect(byId.get('opus')).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(byId.get('fable')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    // The response has no supportsEffort (haiku), so the effort's three levels are represented by one.
    expect(byId.get('haiku')).toEqual(['off', 'medium'])
  })

  it('応答が挙げた effort の段階に無いものは選べない (空にはならない)', () => {
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

  it('オーナー決定 (2026-09-26): effort が効かないモデル (Haiku 4.5) だけ「なし / あり」の 2 択の印が立つ', () => {
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

describe('nearestThinkingLevel (項目 92)', () => {
  it('選べる段階ならそのまま', () => {
    for (const level of THINKING_LEVELS) expect(nearestThinkingLevel(level, THINKING_LEVELS)).toBe(level)
  })

  it('一番近い選べる段階に寄せ、同じ距離なら深い側', () => {
    // Opus / Fable: "off" does not take effect → "low".
    expect(nearestThinkingLevel('off', ['low', 'medium', 'high'])).toBe('low')
    // Haiku: effort does not take effect → "low" and "high" become "medium"; "medium" stays as is.
    expect(nearestThinkingLevel('low', ['off', 'medium'])).toBe('medium')
    expect(nearestThinkingLevel('high', ['off', 'medium'])).toBe('medium')
    expect(nearestThinkingLevel('off', ['off', 'medium'])).toBe('off')
    expect(nearestThinkingLevel('high', ['off', 'low'])).toBe('low')
  })

  it('空の一覧では寄せない', () => {
    expect(nearestThinkingLevel('high', [])).toBe('high')
  })
})

describe('制御要求の行 (項目 91 / 94 の共通の口)', () => {
  it('要求は type / request_id / request.subtype の形で、subtype は上書きされない', () => {
    const line = controlRequestLine(table.control, 'r1', table.control.interrupt, { subtype: 'x', a: 1 })
    expect(JSON.parse(line)).toEqual({
      type: table.control.requestType,
      request_id: 'r1',
      request: { a: 1, subtype: table.control.interrupt }
    })
  })

  it('失敗の応答は ok: false と文言', () => {
    const reply = readControlResponse(
      table.control,
      JSON.stringify({
        type: table.control.responseType,
        response: { subtype: 'error', request_id: 'r2', error: 'Unsupported' }
      })
    )
    expect(reply).toEqual({ requestId: 'r2', ok: false, response: null, error: 'Unsupported' })
  })

  it('ふつうのイベントの行・本文に同じ語を含む行は応答として読まない', () => {
    expect(readControlResponse(table.control, '{"type":"result","subtype":"success"}')).toBeNull()
    const quoted = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '"control_response" と書いた' }] }
    })
    expect(readControlResponse(table.control, quoted)).toBeNull()
    expect(readControlResponse(table.control, 'not json "control_response"')).toBeNull()
  })
})

describe('TODO 1205: Thinking の段を応答の effort の一覧から組む (オーナー決定 2026-11-10)', () => {
  const known = (resolved: string, effortLevels: readonly string[] | null): LearnedModel => ({
    resolved,
    supportsEffort: true,
    effortLevels
  })

  it('「深く」より上は応答が挙げた段だけを応答の順に末尾へ。教わる前は足さない', () => {
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

  it('表に無い段は落とさず、値そのままの段 (effort:<値>) で。形の崩れた値は捨てる', () => {
    expect(
      thinkingLevelsFor(table, entry('opus'), known('claude-opus-6', ['low', 'medium', 'high', 'ultra', 'max', 'bad value!']))
    ).toEqual(['low', 'medium', 'high', 'effort:ultra', 'max'])
  })

  it('effort が効かないモデル (Haiku 4.5) には上の段を足さない', () => {
    expect(
      thinkingLevelsFor(table, entry('haiku'), {
        resolved: 'claude-haiku-4-5-20251001',
        supportsEffort: false,
        effortLevels: ['low', 'max']
      })
    ).toEqual(['off', 'medium'])
  })

  it('受け入れ条件: CLI 2.1.322 の応答のどのモデルでも、応答が返す effort の段がすべて選べる', () => {
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

  it('段の判定: 名前の付いた段と effort:<値> を通し、空・形の崩れた値は通さない', () => {
    for (const level of ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'effort:ultra', 'effort:x-2.1']) {
      expect(isThinkingLevel(level), level).toBe(true)
    }
    for (const level of ['effort:', 'effort:a b', 'ultra', 'bogus', '', null]) expect(isThinkingLevel(level)).toBe(false)
  })

  it('CLI に渡す値: xhigh / max と名前の無い段は --effort に値のまま。「なし」だけが --thinking', () => {
    expect(thinkingArgs(table, 'xhigh')).toEqual(['--effort', 'xhigh'])
    expect(thinkingArgs(table, 'max')).toEqual(['--effort', 'max'])
    expect(thinkingArgs(table, 'effort:ultra')).toEqual(['--effort', 'ultra'])
    expect(thinkingArgs(table, 'off')).toEqual(['--thinking', 'disabled'])
  })

  it('モデルを替えて段が無くなったら近い下の段 (同じ距離なら浅い側、ただし「なし」は選ばない)', () => {
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

describe('TODO 1209: 応答の supportsThinkingOff が表の canDisableThinking に勝つ (オーナー決定 2026-11-13)', () => {
  const load = (name: string): ReturnType<typeof parseReportedModels> => {
    const line = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').split('\n').join('')
    const reply = readControlResponse(table.control, line)
    if (reply === null) throw new Error('fixture did not parse')
    return parseReportedModels(reply.response)
  }

  it('2.1.322: Sonnet 5.5 / Haiku 5.5 / Fable は「なし」が選べない (表は true だった)', () => {
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

  it('欄が無い古い版 (2.1.296 の実物) は表のまま', () => {
    const learned = learnedFromFixture()
    expect(thinkingLevelsFor(table, entry('sonnet'), learned.get('sonnet'))).toContain('off')
    expect(thinkingLevelsFor(table, entry('fable'), learned.get('fable'))).not.toContain('off')
  })

  it('控え (保存と読み戻し) を通っても残る', () => {
    const learned = learnFromInitialize(table, load('initialize-response-2.1.322.json'))
    const back = parseLearned(table, serializeLearned(learned))
    expect(back.get('sonnet')?.canDisableThinking).toBe(false)
  })

  it('切れないモデルに替えると、選んでいた「なし」は一番近い段に寄る', () => {
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
