/**
 * TODO 769 (ARCHITECTURE.md 4.6.2): makes the Model choices follow every model the CLI knows about.
 * The top section is the 4 alias rows of the table; the bottom section is the non-alias rows of the `initialize` response (models with a fixed version)
 * and `unavailable_models` (models that cannot be used). **Neither the CLI nor any model is started.**
 *
 * `test/fixtures/initialize-response-2.1.296.json` is a real response of CLI 2.1.296 (2026-10-12), with account information removed:
 * sonnet = Sonnet 5.5, haiku = Haiku 5.5, and 8 non-alias rows. `test/fixtures/initialize-response.json` is from spike 16 (CLI 2.1.207): it has no
 * non-alias rows, and the fable row's `value` is the full name + `[1m]`, with 2 rows in `unavailable_models`.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadCompatTable } from '../src/main/session/adapter/compat.js'
import { readControlResponse } from '../src/main/session/adapter/control.js'
import {
  EMPTY_CATALOG,
  aliasUpgrades,
  buildModelChoices,
  buildModelView,
  compareModelVersions,
  learnFromInitialize,
  parseCachedCatalog,
  parseCachedCommands,
  parseLearned,
  parseModelName,
  parseReportedModels,
  parseUnavailableModels,
  pinnedFromInitialize,
  pinnedLabel,
  serializeLearned,
  type ModelCatalog,
  type PinnedModel
} from '../src/main/session/adapter/models.js'
import { ClaudeCodeAdapter } from '../src/main/session/adapter/index.js'
import {
  compactModelPicker,
  listedModelChoices,
  modelChoiceLabel,
  splitModelChoices
} from '../src/renderer/src/composer-choice.js'

const table = loadCompatTable()

function responseOf(name: string): unknown {
  const line = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').split('\n').join('')
  const reply = readControlResponse(table.control, line)
  if (reply === null) throw new Error(`${name} did not parse`)
  return reply.response
}

function catalogOf(name: string): {
  learned: ReturnType<typeof learnFromInitialize>
  catalog: ModelCatalog
} {
  const response = responseOf(name)
  const reported = parseReportedModels(response)
  const learned = learnFromInitialize(table, reported)
  return {
    learned,
    catalog: {
      pinned: pinnedFromInitialize(table, reported, learned),
      unavailable: parseUnavailableModels(response)
    }
  }
}

describe('CLI 2.1.296 の応答 (TODO 769)', () => {
  const { learned, catalog } = catalogOf('initialize-response-2.1.296.json')

  it('別名の指す先: sonnet = Sonnet 5.5、haiku = Haiku 5.5', () => {
    expect(learned.get('sonnet')?.resolved).toBe('claude-sonnet-5-5')
    expect(learned.get('haiku')?.resolved).toBe('claude-haiku-5-5')
    expect(learned.get('opus')?.resolved).toBe('claude-opus-5-5')
    expect(learned.get('fable')?.resolved).toBe('claude-fable-5-1')
  })

  it('下段は別名でない 8 行を応答の順に。「default」は出さない (オーナー決定 2026-10-12)', () => {
    expect(catalog.pinned.map((row) => row.value)).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6'
    ])
    expect(catalog.unavailable).toEqual([])
  })

  it('選択肢: 上段 4 つは版付きの名前、下段は応答の表示名で pinned の印', () => {
    const choices = buildModelChoices(table, learned, catalog)
    expect(choices.filter((m) => m.pinned !== true).map((m) => m.label)).toEqual([
      'Haiku 5.5',
      'Sonnet 5.5',
      'Opus 5.5',
      'Fable 5.1'
    ])
    expect(choices.filter((m) => m.pinned === true && m.sameAs === undefined).map((m) => m.label)).toEqual([
      'Haiku 4.5',
      'Sonnet 5',
      'Opus 5',
      'Fable 5',
      'Opus 4.8',
      'Opus 4.7',
      'Opus 4.6',
      'Sonnet 4.6'
    ])
    // The id is the value passed straight to `--model`.
    expect(choices.find((m) => m.label === 'Opus 4.8')?.id).toBe('claude-opus-4-8')
    // TODO 1204: the target an alias points to is marked with `sameAs` at the end (it does not appear in the menu). There is no newer version, so the top section stays as the CLI's aliases.
    expect(choices.filter((m) => m.sameAs !== undefined).map((m) => [m.id, m.sameAs])).toEqual([
      ['claude-haiku-5-5', 'haiku'],
      ['claude-sonnet-5-5', 'sonnet'],
      ['claude-opus-5-5', 'opus'],
      ['claude-fable-5-1', 'fable']
    ])
  })

  it('thinking: Haiku 5.5 は effort が効き、Haiku 4.5 (応答に supportsEffort が無い) は 2 択', () => {
    const byLabel = new Map(buildModelChoices(table, learned, catalog).map((m) => [m.label, m]))
    expect(byLabel.get('Haiku 5.5')?.thinkingBinary).toBe(false)
    expect(byLabel.get('Haiku 4.5')?.thinkingBinary).toBe(true)
    // Opus 4.8 can turn thinking off through a full-name override. Opus 4.6 has no xhigh among the response's levels (TODO 1205: only max is added).
    expect(byLabel.get('Opus 4.8')?.thinkingLevels).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(byLabel.get('Opus 4.6')?.thinkingLevels).toEqual(['low', 'medium', 'high', 'max'])
  })
})

describe('CLI 2.1.207 の応答 (spike 16)', () => {
  const { learned, catalog } = catalogOf('initialize-response.json')

  it('fable の行 (value が完全名 + [1m]) は別名 fable に採られ、下段に重ならない', () => {
    expect(learned.get('fable')?.resolved).toBe('claude-fable-5')
    expect(catalog.pinned).toEqual([])
  })

  it('unavailable_models は灰色の行。表示名の「 (disabled)」は落とす', () => {
    expect(catalog.unavailable).toEqual([
      { value: 'cc-update-required-1', label: 'Fable 5.1' },
      { value: 'cc-update-required-2', label: 'Opus 5.5' }
    ])
    const rows = buildModelChoices(table, learned, catalog).filter((m) => m.unavailable === true)
    expect(rows.map((m) => [m.label, m.pinned])).toEqual([
      ['Fable 5.1', true],
      ['Opus 5.5', true]
    ])
  })
})

describe('表示名の補い (pinnedLabel)', () => {
  it('応答の表示名に版が無ければ、族の名前 + 完全名の版', () => {
    const row = { value: 'claude-opus-4-8', resolved: 'claude-opus-4-8', supportsEffort: true, effortLevels: null }
    expect(pinnedLabel(table, { ...row, displayName: 'Opus' })).toBe('Opus 4.8')
    expect(pinnedLabel(table, { ...row, displayName: null })).toBe('Opus 4.8')
    expect(pinnedLabel(table, { ...row, displayName: 'Opus 4.8' })).toBe('Opus 4.8')
  })

  it('族も版も分からなければ表示名、それも無ければ value', () => {
    const row = { value: 'mystery', resolved: 'mystery', supportsEffort: false, effortLevels: null }
    expect(pinnedLabel(table, { ...row, displayName: 'Mystery' })).toBe('Mystery')
    expect(pinnedLabel(table, { ...row, displayName: null })).toBe('mystery')
  })
})

describe('控え (TODO 769)', () => {
  it('下段も同じ控えに残り、読み戻せる。コマンドと別名もそのまま', () => {
    const { learned, catalog } = catalogOf('initialize-response-2.1.296.json')
    const raw = serializeLearned(learned, ['compact'], catalog)
    expect(parseCachedCatalog(raw)).toEqual(catalog)
    expect(parseCachedCommands(raw)).toEqual(['compact'])
    expect(parseLearned(table, raw).get('sonnet')?.resolved).toBe('claude-sonnet-5-5')
  })

  it('下段の欄が無い古い控え・壊れた控えは空', () => {
    expect(parseCachedCatalog(serializeLearned(new Map(), null))).toBe(EMPTY_CATALOG)
    expect(parseCachedCatalog('{')).toBe(EMPTY_CATALOG)
    expect(parseCachedCatalog(null)).toBe(EMPTY_CATALOG)
    // If the bottom section is empty, the string is the same as before (it does not cause the backup to be rewritten).
    expect(serializeLearned(new Map(), null, EMPTY_CATALOG)).toBe('{"v":1,"models":{}}')
  })
})

describe('adapter: 版を固定したモデルの id (TODO 769)', () => {
  const { learned, catalog } = catalogOf('initialize-response-2.1.296.json')
  const raw = serializeLearned(learned, null, catalog)
  const adapter = new ClaudeCodeAdapter({ read: () => null, write: () => {}, readModels: () => raw })

  it('下段にある旧 id (legacyIds の claude-haiku-4-5-20251001) は別名に読み替えない', () => {
    expect(adapter.canonicalModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
    expect(adapter.canonicalModelId('haiku')).toBe('haiku')
  })

  it('下段が無ければ今までどおり旧 id を別名に読み替える', () => {
    const bare = new ClaudeCodeAdapter({ read: () => null, write: () => {}, readModels: () => null })
    expect(bare.canonicalModelId('claude-haiku-4-5-20251001')).toBe('haiku')
  })

  it('円グラフの分母: 別名 haiku (= Haiku 5.5) は 1M、下段の Haiku 4.5 は完全名の上書きで 200K', () => {
    expect(adapter.contextWindow('haiku')).toBe(1_000_000)
    expect(adapter.contextWindow('claude-haiku-5-5')).toBe(1_000_000)
    expect(adapter.contextWindow('claude-haiku-4-5-20251001')).toBe(200_000)
    expect(adapter.contextWindow('claude-sonnet-5-5')).toBe(1_000_000)
    // The denominator for a family or version not in the table is unknown (it is filled in by result.modelUsage of the first turn).
    expect(adapter.contextWindow('claude-unknown-9')).toBeNull()
  })
})

describe('Composer の振り分け (splitModelChoices)', () => {
  const { learned, catalog } = catalogOf('initialize-response-2.1.296.json')
  const models = buildModelChoices(table, learned, catalog)

  it('ボタン列は上段 4 つ、メニューは下段', () => {
    const split = splitModelChoices(models, 'sonnet')
    expect(split.segment.map((m) => m.id)).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
    expect(split.more.length).toBe(8)
    expect(split.notListed).toBe(false)
  })

  it('下段のモデルを選んでいれば、ボタン列の末尾にそれも出す', () => {
    const split = splitModelChoices(models, 'claude-opus-4-8')
    expect(split.segment.map((m) => m.label)).toEqual(['Haiku 5.5', 'Sonnet 5.5', 'Opus 5.5', 'Fable 5.1', 'Opus 4.8'])
  })

  it('どれにも当たらない id は notListed', () => {
    expect(splitModelChoices(models, 'gone').notListed).toBe(true)
    expect(splitModelChoices(models, null).notListed).toBe(false)
  })

  it('TODO 1017: 別名が 4 個を越えるバックエンドだけメニューの 1 ボタンにする', () => {
    expect(compactModelPicker(models)).toBe(false)
    const many = ['a', 'b', 'c', 'd', 'ollama/gpt-oss:20b'].map((id) => ({ id, label: id }))
    expect(compactModelPicker(many)).toBe(true)
    expect(compactModelPicker(many.slice(0, 4))).toBe(false)
  })
})

/**
 * TODO 1204 (owner decision 2026-11-10). `initialize-response-2.1.319.json` / `-2.1.322.json` are real responses (account information removed):
 * in 2.1.319 the alias fable = Fable 5.1 and the row pinned to Fable 5.2; in 2.1.322 the alias fable = Fable 5.2 and the row pinned to Fable 5.1.
 */
describe('TODO 1204: 段の札を同じ系列の新しい版に', () => {
  it('名前の解析: 系列・版 (数の列)・変種。版の無い名前は null、日付の接尾辞は版に数えない', () => {
    expect(parseModelName(table, 'claude-fable-5-2')).toEqual({ family: 'claude-fable', version: [5, 2], variant: '' })
    expect(parseModelName(table, 'claude-fable-5-1[1m]')).toEqual({
      family: 'claude-fable',
      version: [5, 1],
      variant: '[1m]'
    })
    expect(parseModelName(table, 'claude-haiku-4-5-20251001')).toEqual({
      family: 'claude-haiku',
      version: [4, 5],
      variant: ''
    })
    expect(parseModelName(table, 'claude-sonnet-5')?.version).toEqual([5])
    expect(parseModelName(table, 'default')).toBeNull()
    expect(parseModelName(table, 'claude-foo')).toBeNull()
  })

  it('版の比較は区切りごとの数: 5.1 < 5.2 < 5.10、5 = 5.0', () => {
    expect(compareModelVersions([5, 1], [5, 2])).toBeLessThan(0)
    expect(compareModelVersions([5, 10], [5, 2])).toBeGreaterThan(0)
    expect(compareModelVersions([5], [5, 0])).toBe(0)
    expect(compareModelVersions([6], [5, 10])).toBeGreaterThan(0)
  })

  describe('CLI 2.1.319 の実物 (別名 fable = 5.1、Fable 5.2 は版を固定した行)', () => {
    const { learned, catalog } = catalogOf('initialize-response-2.1.319.json')
    const models = buildModelChoices(table, learned, catalog)

    it('review Y-1: 版固定の id (fixed) は下段の行・段から外れた版・sameAs を全部含み、別名と使えない行は含まない', () => {
      const view = buildModelView(table, learned, catalog)
      expect(view.choices).toEqual(models)
      const pinnedIds = models.filter((m) => m.pinned === true && m.unavailable !== true).map((m) => m.id)
      expect([...view.fixed.keys()].sort()).toEqual([...pinnedIds].sort())
      expect(view.fixed.get('claude-fable-5-1')).toBe('claude-fable-5-1')
      expect(view.fixed.has('claude-fable-5-2')).toBe(true)
      expect(view.fixed.has('fable')).toBe(false)
      expect(view.upgrades.get('fable')?.value).toBe('claude-fable-5-2')
    })

    it('fable だけ 5.2 に差し替わる。他の系列は CLI の別名の指す先が最新', () => {
      const upgrades = aliasUpgrades(table, learned, catalog)
      expect([...upgrades.keys()]).toEqual(['fable'])
      expect(upgrades.get('fable')?.value).toBe('claude-fable-5-2')
    })

    it('段は Fable 5.2、▾ には Fable 5.2 が無く、段から外れた Fable 5.1 が 5.2 のいた位置に出る', () => {
      const split = splitModelChoices(models, 'fable')
      expect(split.segment.map((m) => m.label)).toEqual(['Haiku 5.5', 'Sonnet 5.5', 'Opus 5.5', 'Fable 5.2'])
      expect(split.more.map((m) => m.label)).toEqual([
        'Fable 5.1',
        'Haiku 4.5',
        'Sonnet 5',
        'Opus 5',
        'Fable 5',
        'Opus 4.8',
        'Opus 4.7',
        'Opus 4.6',
        'Sonnet 4.6'
      ])
      expect(split.more.find((m) => m.label === 'Fable 5.1')?.id).toBe('claude-fable-5-1')
      // The thinking levels on the stage badge come from the newer version's row.
      expect(models.find((m) => m.id === 'fable')?.thinkingLevels).toEqual(
        models.find((m) => m.id === 'claude-fable-5-2')?.thinkingLevels
      )
    })

    it('▾ で 5.2 に固定していたスレッドは、段の別名とは別の「固定」の選択肢として段に足される (一覧に無いにならない)', () => {
      const split = splitModelChoices(models, 'claude-fable-5-2')
      expect(split.notListed).toBe(false)
      const last = split.segment.at(-1)
      expect(last?.id).toBe('claude-fable-5-2')
      expect(last?.sameAs).toBe('fable')
      expect(modelChoiceLabel(last ?? { label: '' }, (_key, vars) => `${vars.label} (pinned)`)).toBe('Fable 5.2 (pinned)')
      // If not selected, it is not listed in the lists either (settings and reservation).
      expect(listedModelChoices(models, 'fable').some((m) => m.id === 'claude-fable-5-2')).toBe(false)
      expect(listedModelChoices(models, 'claude-fable-5-2').some((m) => m.id === 'claude-fable-5-2')).toBe(true)
    })
  })

  describe('CLI 2.1.322 の実物 (別名 fable = 5.2、Fable 5.1 は版を固定した行)', () => {
    const { learned, catalog } = catalogOf('initialize-response-2.1.322.json')
    const models = buildModelChoices(table, learned, catalog)

    it('差し替えは無く、段と ▾ の見え方は 2.1.319 の差し替え後と同じ', () => {
      expect(aliasUpgrades(table, learned, catalog).size).toBe(0)
      const split = splitModelChoices(models, 'fable')
      expect(split.segment.map((m) => m.label)).toEqual(['Haiku 5.5', 'Sonnet 5.5', 'Opus 5.5', 'Fable 5.2'])
      expect(split.more[0]?.label).toBe('Fable 5.1')
      expect(split.more.some((m) => m.label === 'Fable 5.2')).toBe(false)
    })

    it('2.1.319 のときに ▾ で 5.2 に固定したスレッドも「一覧に無い」にならない', () => {
      const split = splitModelChoices(models, 'claude-fable-5-2')
      expect(split.notListed).toBe(false)
      expect(split.segment.at(-1)?.sameAs).toBe('fable')
    })
  })

  describe('合成した一覧 (変種・版の無い名前・さらに新しい版)', () => {
    const learned = new Map([['fable', { resolved: 'claude-fable-5-1', supportsEffort: true, effortLevels: null }]])
    const row = (value: string, resolved = value): PinnedModel => ({
      value,
      resolved,
      displayName: null,
      supportsEffort: true,
      effortLevels: null
    })
    const upgradeOf = (rows: PinnedModel[]): string | undefined =>
      aliasUpgrades(table, learned, { pinned: rows, unavailable: [] }).get('fable')?.value

    it('窓の広さの変種 ([1m]) が違う行は新しい版に数えない', () => {
      expect(upgradeOf([row('claude-fable-5-2[1m]', 'claude-fable-5-2')])).toBeUndefined()
      expect(upgradeOf([row('claude-fable-5-2[1m]')])).toBeUndefined()
    })

    it('版の読めない名前・別の系列・古い版・日付だけ違う同じ版は数えない', () => {
      expect(upgradeOf([row('claude-fable-preview')])).toBeUndefined()
      expect(upgradeOf([row('claude-opus-6')])).toBeUndefined()
      expect(upgradeOf([row('claude-fable-5')])).toBeUndefined()
      expect(upgradeOf([row('claude-fable-5-1-20261101')])).toBeUndefined()
    })

    it('いちばん新しい版を採る (5.10 > 5.2、並びに依らない)', () => {
      expect(upgradeOf([row('claude-fable-5-10'), row('claude-fable-5-2')])).toBe('claude-fable-5-10')
      expect(upgradeOf([row('claude-fable-5-2'), row('claude-fable-5-10'), row('claude-fable-5-3')])).toBe(
        'claude-fable-5-10'
      )
    })

    it('別名の指す先を教わる前は差し替えない', () => {
      expect(aliasUpgrades(table, new Map(), { pinned: [row('claude-fable-9')], unavailable: [] }).size).toBe(0)
    })
  })
})

describe('TODO 1204: adapter が CLI に渡す値 (固定していない選択は最新の版、固定した版は替えない)', () => {
  const { learned, catalog } = catalogOf('initialize-response-2.1.319.json')
  const adapterWith = (pinned: readonly PinnedModel[]): ClaudeCodeAdapter => {
    const raw = serializeLearned(learned, null, { pinned, unavailable: [] })
    return new ClaudeCodeAdapter({ read: () => null, write: () => {}, readModels: () => raw })
  }

  it('別名で保存されたスレッド (fable) は最新の版の完全名で起動し、行は別名のまま', () => {
    const adapter = adapterWith(catalog.pinned)
    expect(adapter.cliModelValue('fable')).toBe('claude-fable-5-2')
    expect(adapter.canonicalModelId('fable')).toBe('fable')
    // A series with no replacement is passed as the alias.
    expect(adapter.cliModelValue('opus')).toBe('opus')
    expect(adapter.contextWindow('fable')).toBe(1_000_000)
  })

  it('▾ で固定した版 (5.2・段から外れた 5.1) はそのまま渡す', () => {
    const adapter = adapterWith(catalog.pinned)
    expect(adapter.cliModelValue('claude-fable-5-2')).toBe('claude-fable-5-2')
    expect(adapter.cliModelValue('claude-fable-5-1')).toBe('claude-fable-5-1')
  })

  it('さらに新しい版 (5.3) が一覧に加わると、別名のスレッドだけが追従し、5.2 に固定したスレッドは替わらない', () => {
    const adapter = adapterWith([
      ...catalog.pinned,
      { value: 'claude-fable-5-3', resolved: 'claude-fable-5-3', displayName: 'Fable 5.3', supportsEffort: true, effortLevels: null }
    ])
    expect(adapter.cliModelValue('fable')).toBe('claude-fable-5-3')
    expect(adapter.cliModelValue('claude-fable-5-2')).toBe('claude-fable-5-2')
  })
})
