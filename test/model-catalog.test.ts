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

describe('CLI 2.1.296 response (TODO 769)', () => {
  const { learned, catalog } = catalogOf('initialize-response-2.1.296.json')

  it('alias targets: sonnet = Sonnet 5.5, haiku = Haiku 5.5', () => {
    expect(learned.get('sonnet')?.resolved).toBe('claude-sonnet-5-5')
    expect(learned.get('haiku')?.resolved).toBe('claude-haiku-5-5')
    expect(learned.get('opus')?.resolved).toBe('claude-opus-5-5')
    expect(learned.get('fable')?.resolved).toBe('claude-fable-5-1')
  })

  it('the lower row is the 8 non-alias rows in response order; 「default」 is not shown (owner decision 2026-10-12)', () => {
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

  it("choices: the upper 4 are versioned names, the lower ones use the response's display name with a pinned mark", () => {
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

  it('thinking: Haiku 5.5 honors effort, while Haiku 4.5 (no supportsEffort in the response) gets a 2-way choice', () => {
    const byLabel = new Map(buildModelChoices(table, learned, catalog).map((m) => [m.label, m]))
    expect(byLabel.get('Haiku 5.5')?.thinkingBinary).toBe(false)
    expect(byLabel.get('Haiku 4.5')?.thinkingBinary).toBe(true)
    // Opus 4.8 can turn thinking off through a full-name override. Opus 4.6 has no xhigh among the response's levels (TODO 1205: only max is added).
    expect(byLabel.get('Opus 4.8')?.thinkingLevels).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(byLabel.get('Opus 4.6')?.thinkingLevels).toEqual(['low', 'medium', 'high', 'max'])
  })
})

describe('CLI 2.1.207 response (spike 16)', () => {
  const { learned, catalog } = catalogOf('initialize-response.json')

  it('takes the fable row (value is the full name + [1m]) as the alias fable and does not duplicate it in the lower row', () => {
    expect(learned.get('fable')?.resolved).toBe('claude-fable-5')
    expect(catalog.pinned).toEqual([])
  })

  it('unavailable_models are gray rows; the 「 (disabled)」 in the display name is dropped', () => {
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

describe('display name supplement (pinnedLabel)', () => {
  it("uses the family name + full-name version when the response's display name has no version", () => {
    const row = { value: 'claude-opus-4-8', resolved: 'claude-opus-4-8', supportsEffort: true, effortLevels: null }
    expect(pinnedLabel(table, { ...row, displayName: 'Opus' })).toBe('Opus 4.8')
    expect(pinnedLabel(table, { ...row, displayName: null })).toBe('Opus 4.8')
    expect(pinnedLabel(table, { ...row, displayName: 'Opus 4.8' })).toBe('Opus 4.8')
  })

  it('uses the display name when neither family nor version is known, and value when there is no display name either', () => {
    const row = { value: 'mystery', resolved: 'mystery', supportsEffort: false, effortLevels: null }
    expect(pinnedLabel(table, { ...row, displayName: 'Mystery' })).toBe('Mystery')
    expect(pinnedLabel(table, { ...row, displayName: null })).toBe('mystery')
  })
})

describe('backup (TODO 769)', () => {
  it('keeps the lower row in the same backup and reads it back; commands and aliases are kept as they are', () => {
    const { learned, catalog } = catalogOf('initialize-response-2.1.296.json')
    const raw = serializeLearned(learned, ['compact'], catalog)
    expect(parseCachedCatalog(raw)).toEqual(catalog)
    expect(parseCachedCommands(raw)).toEqual(['compact'])
    expect(parseLearned(table, raw).get('sonnet')?.resolved).toBe('claude-sonnet-5-5')
  })

  it('an old backup without a lower-row field and a broken backup are empty', () => {
    expect(parseCachedCatalog(serializeLearned(new Map(), null))).toBe(EMPTY_CATALOG)
    expect(parseCachedCatalog('{')).toBe(EMPTY_CATALOG)
    expect(parseCachedCatalog(null)).toBe(EMPTY_CATALOG)
    // If the bottom section is empty, the string is the same as before (it does not cause the backup to be rewritten).
    expect(serializeLearned(new Map(), null, EMPTY_CATALOG)).toBe('{"v":1,"models":{}}')
  })
})

describe('adapter: version-pinned model id (TODO 769)', () => {
  const { learned, catalog } = catalogOf('initialize-response-2.1.296.json')
  const raw = serializeLearned(learned, null, catalog)
  const adapter = new ClaudeCodeAdapter({ read: () => null, write: () => {}, readModels: () => raw })

  it('does not map an old id in the lower row (legacyIds claude-haiku-4-5-20251001) to an alias', () => {
    expect(adapter.canonicalModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
    expect(adapter.canonicalModelId('haiku')).toBe('haiku')
  })

  it('maps an old id to an alias as before when there is no lower row', () => {
    const bare = new ClaudeCodeAdapter({ read: () => null, write: () => {}, readModels: () => null })
    expect(bare.canonicalModelId('claude-haiku-4-5-20251001')).toBe('haiku')
  })

  it('pie chart denominator: alias haiku (= Haiku 5.5) is 1M and Haiku 4.5 in the lower row is 200K by a full-name override', () => {
    expect(adapter.contextWindow('haiku')).toBe(1_000_000)
    expect(adapter.contextWindow('claude-haiku-5-5')).toBe(1_000_000)
    expect(adapter.contextWindow('claude-haiku-4-5-20251001')).toBe(200_000)
    expect(adapter.contextWindow('claude-sonnet-5-5')).toBe(1_000_000)
    // The denominator for a family or version not in the table is unknown (it is filled in by result.modelUsage of the first turn).
    expect(adapter.contextWindow('claude-unknown-9')).toBeNull()
  })
})

describe('Composer split (splitModelChoices)', () => {
  const { learned, catalog } = catalogOf('initialize-response-2.1.296.json')
  const models = buildModelChoices(table, learned, catalog)

  it('puts the upper 4 in the button row and the lower ones in the menu', () => {
    const split = splitModelChoices(models, 'sonnet')
    expect(split.segment.map((m) => m.id)).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
    expect(split.more.length).toBe(8)
    expect(split.notListed).toBe(false)
  })

  it('also shows the selected lower-row model at the end of the button row', () => {
    const split = splitModelChoices(models, 'claude-opus-4-8')
    expect(split.segment.map((m) => m.label)).toEqual(['Haiku 5.5', 'Sonnet 5.5', 'Opus 5.5', 'Fable 5.1', 'Opus 4.8'])
  })

  it('an id that matches none is notListed', () => {
    expect(splitModelChoices(models, 'gone').notListed).toBe(true)
    expect(splitModelChoices(models, null).notListed).toBe(false)
  })

  it('TODO 1017: makes a single menu button only for backends with more than 4 aliases', () => {
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
describe('TODO 1204: update the stage label to a newer version of the same family', () => {
  it('name parsing: family, version (number list), variant; a name without a version is null and a date suffix does not count as a version', () => {
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

  it('version comparison is per-separator numbers: 5.1 < 5.2 < 5.10, 5 = 5.0', () => {
    expect(compareModelVersions([5, 1], [5, 2])).toBeLessThan(0)
    expect(compareModelVersions([5, 10], [5, 2])).toBeGreaterThan(0)
    expect(compareModelVersions([5], [5, 0])).toBe(0)
    expect(compareModelVersions([6], [5, 10])).toBeGreaterThan(0)
  })

  describe('real CLI 2.1.319 output (alias fable = 5.1, Fable 5.2 is a version-pinned row)', () => {
    const { learned, catalog } = catalogOf('initialize-response-2.1.319.json')
    const models = buildModelChoices(table, learned, catalog)

    it('review Y-1: version-pinned ids (fixed) include all lower-row rows, versions dropped from the stage, and sameAs, and exclude aliases and unusable rows', () => {
      const view = buildModelView(table, learned, catalog)
      expect(view.choices).toEqual(models)
      const pinnedIds = models.filter((m) => m.pinned === true && m.unavailable !== true).map((m) => m.id)
      expect([...view.fixed.keys()].sort()).toEqual([...pinnedIds].sort())
      expect(view.fixed.get('claude-fable-5-1')).toBe('claude-fable-5-1')
      expect(view.fixed.has('claude-fable-5-2')).toBe(true)
      expect(view.fixed.has('fable')).toBe(false)
      expect(view.upgrades.get('fable')?.value).toBe('claude-fable-5-2')
    })

    it('only fable is replaced with 5.2; for other families the alias target of the CLI is the latest', () => {
      const upgrades = aliasUpgrades(table, learned, catalog)
      expect([...upgrades.keys()]).toEqual(['fable'])
      expect(upgrades.get('fable')?.value).toBe('claude-fable-5-2')
    })

    it('the stage is Fable 5.2, the ▾ has no Fable 5.2, and Fable 5.1 dropped from the stage appears where 5.2 was', () => {
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

    it('a thread pinned to 5.2 via ▾ gets a "pinned" choice added to the stage separate from the stage\'s alias (it does not become "not in the list")', () => {
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

  describe('real CLI 2.1.322 output (alias fable = 5.2, Fable 5.1 is a version-pinned row)', () => {
    const { learned, catalog } = catalogOf('initialize-response-2.1.322.json')
    const models = buildModelChoices(table, learned, catalog)

    it('no replacement happens and the stage and ▾ look the same as after replacement in 2.1.319', () => {
      expect(aliasUpgrades(table, learned, catalog).size).toBe(0)
      const split = splitModelChoices(models, 'fable')
      expect(split.segment.map((m) => m.label)).toEqual(['Haiku 5.5', 'Sonnet 5.5', 'Opus 5.5', 'Fable 5.2'])
      expect(split.more[0]?.label).toBe('Fable 5.1')
      expect(split.more.some((m) => m.label === 'Fable 5.2')).toBe(false)
    })

    it('a thread pinned to 5.2 via ▾ under 2.1.319 does not become 「一覧に無い」 either', () => {
      const split = splitModelChoices(models, 'claude-fable-5-2')
      expect(split.notListed).toBe(false)
      expect(split.segment.at(-1)?.sameAs).toBe('fable')
    })
  })

  describe('synthesized list (variants, names without a version, even newer versions)', () => {
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

    it('a row with a different window-size variant ([1m]) does not count as a newer version', () => {
      expect(upgradeOf([row('claude-fable-5-2[1m]', 'claude-fable-5-2')])).toBeUndefined()
      expect(upgradeOf([row('claude-fable-5-2[1m]')])).toBeUndefined()
    })

    it('names with an unreadable version, other families, older versions, and the same version differing only in date do not count', () => {
      expect(upgradeOf([row('claude-fable-preview')])).toBeUndefined()
      expect(upgradeOf([row('claude-opus-6')])).toBeUndefined()
      expect(upgradeOf([row('claude-fable-5')])).toBeUndefined()
      expect(upgradeOf([row('claude-fable-5-1-20261101')])).toBeUndefined()
    })

    it('takes the newest version (5.10 > 5.2, independent of order)', () => {
      expect(upgradeOf([row('claude-fable-5-10'), row('claude-fable-5-2')])).toBe('claude-fable-5-10')
      expect(upgradeOf([row('claude-fable-5-2'), row('claude-fable-5-10'), row('claude-fable-5-3')])).toBe(
        'claude-fable-5-10'
      )
    })

    it('does not replace before the alias targets are known', () => {
      expect(aliasUpgrades(table, new Map(), { pinned: [row('claude-fable-9')], unavailable: [] }).size).toBe(0)
    })
  })
})

describe('TODO 1204: values the adapter passes to the CLI (unpinned choices get the newest version, pinned versions are not replaced)', () => {
  const { learned, catalog } = catalogOf('initialize-response-2.1.319.json')
  const adapterWith = (pinned: readonly PinnedModel[]): ClaudeCodeAdapter => {
    const raw = serializeLearned(learned, null, { pinned, unavailable: [] })
    return new ClaudeCodeAdapter({ read: () => null, write: () => {}, readModels: () => raw })
  }

  it("a thread saved with an alias (fable) starts with the newest version's full name and the row stays as the alias", () => {
    const adapter = adapterWith(catalog.pinned)
    expect(adapter.cliModelValue('fable')).toBe('claude-fable-5-2')
    expect(adapter.canonicalModelId('fable')).toBe('fable')
    // A series with no replacement is passed as the alias.
    expect(adapter.cliModelValue('opus')).toBe('opus')
    expect(adapter.contextWindow('fable')).toBe(1_000_000)
  })

  it('passes versions pinned via ▾ (5.2, and 5.1 dropped from the stage) as they are', () => {
    const adapter = adapterWith(catalog.pinned)
    expect(adapter.cliModelValue('claude-fable-5-2')).toBe('claude-fable-5-2')
    expect(adapter.cliModelValue('claude-fable-5-1')).toBe('claude-fable-5-1')
  })

  it('when an even newer version (5.3) joins the list, only alias threads follow and a thread pinned to 5.2 does not change', () => {
    const adapter = adapterWith([
      ...catalog.pinned,
      { value: 'claude-fable-5-3', resolved: 'claude-fable-5-3', displayName: 'Fable 5.3', supportsEffort: true, effortLevels: null }
    ])
    expect(adapter.cliModelValue('fable')).toBe('claude-fable-5-3')
    expect(adapter.cliModelValue('claude-fable-5-2')).toBe('claude-fable-5-2')
  })
})
