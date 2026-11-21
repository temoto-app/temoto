/**
 * Model choices, and the "alias → full name, effective levels" learned from the CLI (items 91 / 92, ARCHITECTURE.md 4.6.2).
 *
 * The upper tier of choices (the four aliases and their order) is decided by the `compat/` table. **Version-pinned
 * models** (rows that are not aliases, such as `claude-opus-4-8`) and **models unavailable in the current version**
 * (`unavailable_models`) are not written in the table: the `initialize` response becomes the lower tier as is
 * (TODO 769: when Anthropic releases a new model, a CLI update alone lists it without editing the table).
 * The version (the 4.8 in "Opus 4.8") and how effort works **vary with the CLI version** (spike 16: with CLI 2.1.207,
 * opus = Opus 4.8), so they are not in the table; they are learned from the `initialize` control response
 * (`models[]`) at session start or from `model` (full name) in `system/init`. Before they are learned, only the
 * name is shown (owner decision 2026-09-24).
 *
 * Pure functions only. Full names and the response's field names never leave the adapter (constraint 6):
 * `buildModelChoices` returns `ModelChoice` (an opaque id, display name, selectable levels).
 */
import type { KnownThinkingLevel, ModelChoice, ThinkingLevel } from '@shared/agent.js'
import { BASE_THINKING_LEVELS, FALLBACK_THINKING, THINKING_LEVELS, extraThinkingLevel } from '@shared/agent.js'
import type { CompatTable, ModelEntry, ModelOverride } from './compat.js'

/** What was learned from the CLI about one alias. Null where the response lacks it. */
export interface LearnedModel {
  /** Full name (`resolvedModel` / `model` in init). */
  readonly resolved: string
  /** Whether effort has an effect. Only present in the initialize response (init cannot tell: null). */
  readonly supportsEffort: boolean | null
  /** The effort levels that work (the CLI's own vocabulary). Null if absent from the response. */
  readonly effortLevels: readonly string[] | null
  /**
   * Whether thinking can be turned off (TODO 1209). The response's `supportsThinkingOff` (CLI 2.1.319+). **Wins over the
   * table's `canDisableThinking` when present.** Omitted for older versions without the field and for init (falls back to the table).
   */
  readonly canDisableThinking?: boolean | null
}

/** Alias → what was learned. */
export type LearnedModels = ReadonlyMap<string, LearnedModel>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The table's contents without the annotation key (`$comment`). */
function entriesOf<T>(record: Readonly<Record<string, T>> | undefined): [string, T][] {
  if (record === undefined) return []
  return Object.entries(record).filter(([key]) => !key.startsWith('$'))
}

/**
 * Maps an id from an earlier table onto today's alias (item 91, no migration).
 * An id not in the table is returned as is (treated as an opaque value).
 */
export function canonicalModelId(table: CompatTable, id: string): string {
  for (const [legacy, current] of entriesOf(table.models.legacyIds)) {
    if (legacy === id && typeof current === 'string') return current
  }
  return id
}

/**
 * Reads the version from a full name (`claude-opus-4-8` → `4.8`, `claude-haiku-4-5-20251001` → `4.5`,
 * `claude-sonnet-5` → `5`). The rule is the table's `versionPattern` (the first capture is the `-`-separated version).
 * Null if the naming is irregular and nothing matches (= show only the name).
 */
export function modelVersion(table: CompatTable, resolved: string): string | null {
  const pattern = table.models.versionPattern
  if (pattern === undefined) return null
  let match: RegExpExecArray | null
  try {
    match = new RegExp(pattern).exec(resolved)
  } catch {
    return null
  }
  const raw = match?.[1]
  return raw === undefined || raw === '' ? null : raw.split('-').join('.')
}

/**
 * Extracts one row per selectable model from the `initialize` response (item 91). Elements with the wrong shape are
 * dropped silently. **Other fields of the response (account info etc.) are not touched.**
 */
export interface ReportedModel {
  /** The value passed to `--model` (an alias, or a full name with a suffix). */
  readonly value: string
  readonly resolved: string
  readonly supportsEffort: boolean
  readonly effortLevels: readonly string[] | null
  /** The response's `supportsThinkingOff` (TODO 1209). Omitted if the field is absent. */
  readonly canDisableThinking?: boolean
  /**
   * The response's display name (TODO 769). CLI 2.1.296 includes the version, as in "Sonnet 5.5"; 2.1.280 has only the
   * name, "Sonnet". Null if absent.
   */
  readonly displayName: string | null
}

export function parseReportedModels(response: unknown): readonly ReportedModel[] {
  if (!isRecord(response)) return []
  const models = response['models']
  if (!Array.isArray(models)) return []
  const out: ReportedModel[] = []
  for (const item of models) {
    if (!isRecord(item)) continue
    const value = item['value']
    const resolved = item['resolvedModel']
    if (typeof value !== 'string' || typeof resolved !== 'string' || resolved === '') continue
    const levels = item['supportedEffortLevels']
    out.push({
      value,
      resolved,
      // For models where effort has no effect the field is absent altogether (spike 16: haiku).
      supportsEffort: item['supportsEffort'] === true,
      effortLevels: Array.isArray(levels)
        ? levels.filter((level): level is string => typeof level === 'string')
        : null,
      ...(typeof item['supportsThinkingOff'] === 'boolean' ? { canDisableThinking: item['supportsThinkingOff'] } : {}),
      displayName: typeof item['displayName'] === 'string' && item['displayName'] !== '' ? item['displayName'] : null
    })
  }
  return out
}

/**
 * A version-pinned model (TODO 769): a row of the `initialize` response that was not taken as an alias row.
 * `value` is passed to `--model` as is (it is also the choice's id).
 */
export interface PinnedModel {
  readonly value: string
  readonly resolved: string
  readonly displayName: string | null
  readonly supportsEffort: boolean
  readonly effortLevels: readonly string[] | null
  /** The response's `supportsThinkingOff` (TODO 1209). Omitted if the field is absent. */
  readonly canDisableThinking?: boolean
}

/** A model unavailable in the current version (TODO 769, `unavailable_models` in spike 16). Shown as a grayed-out row only. */
export interface UnavailableModel {
  /** The response's `value` (spike 16: `cc-update-required-N`). Used only as the choice's id; never passed to `--model`. */
  readonly value: string
  readonly label: string
}

/** The lower tier of choices (TODO 769). Kept separately from the aliases (`LearnedModels`). */
export interface ModelCatalog {
  readonly pinned: readonly PinnedModel[]
  readonly unavailable: readonly UnavailableModel[]
}

export const EMPTY_CATALOG: ModelCatalog = { pinned: [], unavailable: [] }

/**
 * `unavailable_models` in the `initialize` response (spike 16: present in CLI 2.1.207, the field is absent in 2.1.280 / 2.1.296).
 * Rows without a display name are dropped.
 */
export function parseUnavailableModels(response: unknown): readonly UnavailableModel[] {
  if (!isRecord(response)) return []
  const rows = response['unavailable_models']
  if (!Array.isArray(rows)) return []
  const out: UnavailableModel[] = []
  for (const item of rows) {
    if (!isRecord(item)) continue
    const value = item['value']
    const label = item['displayName']
    if (typeof value !== 'string' || value === '' || typeof label !== 'string' || label === '') continue
    if (out.some((row) => row.value === value)) continue
    // Drop the trailing " (disabled)" from the display name: the renderer adds that it is unavailable in its own words.
    out.push({ value, label: label.replace(/\s*\(disabled\)$/i, '') || label })
  }
  return out
}

/**
 * Which table alias a response row corresponds to: the alias itself if `value` is an alias, otherwise the alias whose
 * `reportedAs` is in the same family (the name minus the version) as the full name. **An alias may be replaced by a
 * full name in the response** (spike 16: the fable row's `value` is the full name + `[1m]`).
 */
function entryForReported(table: CompatTable, reported: ReportedModel): ModelEntry | undefined {
  const byValue = table.models.list.find((entry) => entry.id === reported.value)
  if (byValue !== undefined) return byValue
  const family = familyOf(table, reported.resolved)
  if (family === null) return undefined
  return table.models.list.find((entry) =>
    (entry.reportedAs ?? []).some((name) => familyOf(table, name) === family)
  )
}

/** The head of a full name with the version part dropped (`claude-opus-4-8` → `claude-opus`). */
function familyOf(table: CompatTable, resolved: string): string | null {
  const version = modelVersion(table, resolved)
  if (version === null) return null
  const tail = version.split('.').join('-')
  const at = resolved.indexOf(`-${tail}`)
  return at > 0 ? resolved.slice(0, at) : null
}

/**
 * Folds the `initialize` response into "alias → what was learned". Models not in the table (such as "default", which
 * only the response has) are dropped. If two rows hit the same alias, the row whose `value` is the alias itself wins.
 */
export function learnFromInitialize(
  table: CompatTable,
  reported: readonly ReportedModel[]
): Map<string, LearnedModel> {
  const out = new Map<string, LearnedModel>()
  const exact = new Set<string>()
  for (const row of reported) {
    const entry = entryForReported(table, row)
    if (entry === undefined) continue
    const isExact = row.value === entry.id
    if (out.has(entry.id) && (exact.has(entry.id) || !isExact)) continue
    if (isExact) exact.add(entry.id)
    out.set(entry.id, {
      resolved: row.resolved,
      supportsEffort: row.supportsEffort,
      effortLevels: row.effortLevels,
      ...(row.canDisableThinking === undefined ? {} : { canDisableThinking: row.canDisableThinking })
    })
  }
  return out
}

const stripSuffix = (name: string): string => name.replace(/\[[^\]]*\]$/, '')

/**
 * The list of version-pinned models (TODO 769): the response rows that (1) are not the table's `hiddenValues` ("default"),
 * (2) whose `value` is not an alias itself, and (3) are not the same model as what any alias points to (the full names in `aliases`).
 * Because of (3), a row that appeared with a full name in place of an alias (fable in CLI 2.1.280 = `claude-fable-5-1[1m]`) does not
 * overlap the lower tier. Order follows the response; for duplicate `value`s only the first row is kept.
 */
export function pinnedFromInitialize(
  table: CompatTable,
  reported: readonly ReportedModel[],
  aliases: LearnedModels
): readonly PinnedModel[] {
  const hidden = new Set(table.models.hiddenValues ?? [])
  const ids = new Set(table.models.list.map((entry) => entry.id))
  const aliasTargets = new Set([...aliases.values()].map((known) => stripSuffix(known.resolved)))
  const out: PinnedModel[] = []
  for (const row of reported) {
    if (hidden.has(row.value) || ids.has(row.value)) continue
    if (aliasTargets.has(stripSuffix(row.resolved))) continue
    if (out.some((pinned) => pinned.value === row.value)) continue
    out.push({
      value: row.value,
      resolved: row.resolved,
      displayName: row.displayName,
      supportsEffort: row.supportsEffort,
      effortLevels: row.effortLevels,
      ...(row.canDisableThinking === undefined ? {} : { canDisableThinking: row.canDisableThinking })
    })
  }
  return out
}

/** Which table alias's family a full name belongs to (TODO 769: a pinned model borrows its thinking defaults from the alias row). */
function familyEntry(table: CompatTable, resolved: string): ModelEntry | undefined {
  const family = familyOf(table, stripSuffix(resolved))
  if (family === null) return undefined
  return table.models.list.find((entry) =>
    (entry.reportedAs ?? []).some((name) => familyOf(table, name) === family)
  )
}

// ---- Newer versions in the same family (TODO 1204, ARCHITECTURE 4.6.2 (12)) ----

/** A model name split into family, version and variant (TODO 1204). */
export interface ModelName {
  /** The head without the version (`claude-fable-5-2` → `claude-fable`). */
  readonly family: string
  /** The sequence of version numbers (`5.10` → `[5, 10]`). The trailing 8-digit date is not included (`versionPattern` drops it). */
  readonly version: readonly number[]
  /** The trailing `[…]` (`[1m]` = a context-window-size variant). Empty if absent. */
  readonly variant: string
}

const variantOf = (name: string): string => /\[[^\]]*\]$/.exec(name)?.[0] ?? ''

/**
 * Splits a name into family, version and variant (TODO 1204). Names without a version (`default`, `claude-foo`) and names
 * with broken naming give null: they take no part in the "newer version" comparison. A date suffix (`-20251001`) does not
 * count as a version (it is another snapshot of the same version).
 */
export function parseModelName(table: CompatTable, name: string): ModelName | null {
  const bare = stripSuffix(name)
  const version = modelVersion(table, bare)
  const family = familyOf(table, bare)
  if (version === null || family === null) return null
  const parts = version.split('.').map((part) => Number(part))
  if (parts.some((part) => !Number.isInteger(part))) return null
  return { family, version: parts, variant: variantOf(name) }
}

/** Compares version number sequences (TODO 1204). Compared component by component, so `5.2 < 5.10`; missing components are 0 (`5` = `5.0`). */
export function compareModelVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * The rows that replace a tier's (upper alias's) badge (TODO 1204, owner decision 2026-11-10). For each alias, the newest
 * row among the version-pinned models (`catalog.pinned`) that is **in the same family, has the same variant, and is a newer
 * version than what the CLI's alias points to**. If there is none, the alias is not listed (it stays the CLI's alias).
 *
 * - The family is `familyOf` (the head without the version) and versions are compared numerically (`compareModelVersions`).
 *   Model names are not hard-coded individually.
 * - A row whose variant (a suffix such as `[1m]`; taken from `value` if present, otherwise from `resolved`) differs from what the
 *   alias points to is not taken, so a model with a different window size is not mistaken for a "newer version".
 * - Names whose version cannot be read, and the same version differing only by date, do not count as "newer".
 * - An alias whose target has not been learned yet (not in `learned`) is not replaced.
 */
export function aliasUpgrades(
  table: CompatTable,
  learned: LearnedModels,
  catalog: ModelCatalog
): Map<string, PinnedModel> {
  const out = new Map<string, PinnedModel>()
  for (const entry of table.models.list) {
    const known = learned.get(entry.id)
    if (known === undefined) continue
    const base = parseModelName(table, known.resolved)
    if (base === null) continue
    let best: { row: PinnedModel; version: readonly number[] } | null = null
    for (const row of catalog.pinned) {
      const name = parseModelName(table, row.resolved)
      if (name === null || name.family !== base.family) continue
      const variant = variantOf(row.value) || name.variant
      if (variant !== base.variant) continue
      if (compareModelVersions(name.version, best?.version ?? base.version) > 0) {
        best = { row, version: name.version }
      }
    }
    if (best !== null) out.set(entry.id, best.row)
  }
  return out
}

/** Turns a version-pinned model row into the "what was learned" shape (used to compute thinking levels). */
function learnedOfPinned(row: PinnedModel): LearnedModel {
  return {
    resolved: row.resolved,
    supportsEffort: row.supportsEffort,
    effortLevels: row.effortLevels,
    ...(row.canDisableThinking === undefined ? {} : { canDisableThinking: row.canDisableThinking })
  }
}

/**
 * What a tier's alias badge points to (TODO 1204): the row of the newer version in the same family if there is one,
 * otherwise what the CLI's alias points to. Undefined before it is learned.
 */
export function effectiveAliasTarget(
  learned: LearnedModels,
  upgrades: ReadonlyMap<string, PinnedModel>,
  aliasId: string
): LearnedModel | undefined {
  const upgrade = upgrades.get(aliasId)
  return upgrade === undefined ? learned.get(aliasId) : learnedOfPinned(upgrade)
}

/**
 * Display name of a version-pinned model (TODO 769). If the response's display name contains the version, that (2.1.296:
 * "Opus 4.8"); if it is only a name, the family's `label` + the full name's version; if neither, `value` itself.
 */
export function pinnedLabel(table: CompatTable, pinned: PinnedModel): string {
  if (pinned.displayName !== null && /\d/.test(pinned.displayName)) return pinned.displayName
  const version = modelVersion(table, stripSuffix(pinned.resolved))
  const name = familyEntry(table, pinned.resolved)?.label ?? pinned.displayName
  if (name !== null && version !== null) return `${name} ${version}`
  return pinned.displayName ?? pinned.value
}

/**
 * Maps a reported full name (`message.model` of the transcript's last response, `model` of init / the response) onto a
 * choice's alias (item 140, ARCHITECTURE.md 4.5.9). In order:
 *
 * 1. An id from an earlier table (`legacyIds`) or an alias itself → that alias.
 * 2. A full-name match (with or without `[1m]` treated as the same): the full name learned from the CLI (`learned`) → the table's `reportedAs`.
 * 3. A family match (the head without the version): an old version such as `claude-opus-4-7` also hits `opus`. **The version may change**:
 *    what an alias points to is up to the CLI (the same as choosing "Opus" in the Composer).
 * 4. If nothing matches, null (a family not in the table, or broken naming). The caller falls back to the setting's default.
 */
export function modelIdForReported(
  table: CompatTable,
  learned: LearnedModels,
  reported: string
): string | null {
  const ids = table.models.list.map((entry) => entry.id)
  const legacy = canonicalModelId(table, reported)
  if (ids.includes(legacy)) return legacy
  const bare = reported.replace(/\[[^\]]*\]$/, '')
  const sameName = (name: string): boolean => name.replace(/\[[^\]]*\]$/, '') === bare
  for (const entry of table.models.list) {
    const known = learned.get(entry.id)?.resolved
    if (known !== undefined && sameName(known)) return entry.id
  }
  for (const entry of table.models.list) {
    if ((entry.reportedAs ?? []).some(sameName)) return entry.id
  }
  const family = familyOf(table, bare)
  if (family === null) return null
  for (const entry of table.models.list) {
    const names = [...(entry.reportedAs ?? [])]
    const known = learned.get(entry.id)?.resolved
    if (known !== undefined) names.push(known)
    if (names.some((name) => familyOf(table, name.replace(/\[[^\]]*\]$/, '')) === family)) return entry.id
  }
  return null
}

function overrideFor(table: CompatTable, resolved: string | undefined): ModelOverride {
  if (resolved === undefined) return {}
  // Notation variation (with or without `[1m]`) is treated as the same model.
  const bare = resolved.replace(/\[[^\]]*\]$/, '')
  for (const [name, value] of entriesOf(table.models.resolvedOverrides)) {
    if ((name === resolved || name === bare) && isRecord(value)) return value as ModelOverride
  }
  return {}
}

/** The "does effort work" check shared by `thinkingLevelsFor` and `isBinaryThinkingModel`. */
function supportsEffortFor(
  table: CompatTable,
  entry: ModelEntry,
  learned: LearnedModel | undefined
): boolean {
  const override = overrideFor(table, learned?.resolved)
  return learned?.supportsEffort ?? override.supportsEffort ?? entry.supportsEffort ?? true
}

/**
 * Whether the model is one where effort has no effect (item 92, Haiku). When true, `thinkingLevelsFor` effectively returns a
 * two-way "off / on" choice (no level names); the caller (Composer) reads `ModelChoice.thinkingBinary` and
 * rewords the label to `thinking.on`.
 */
export function isBinaryThinkingModel(
  table: CompatTable,
  entry: ModelEntry,
  learned: LearnedModel | undefined
): boolean {
  return !supportsEffortFor(table, entry, learned)
}

/**
 * The thinking levels that work for this model (item 92).
 *
 * - "Off": only when thinking can be turned off (full-name override → alias table → true).
 * - "Shallow / normal / deep": when effort works, only those included in the levels the CLI listed
 *   (response → full-name override → alias table → true).
 * - For a model where effort has no effect (Haiku) all three behave the same (the CLI's default thinking), so
 *   **only one representative (`FALLBACK_THINKING`) is kept as "on"**. Whether to make Haiku a two-way choice or to build
 *   levels from a budget is undecided (TODO 92); here the only rule is not to line up three buttons that behave the same.
 * - Never empty (if everything drops out, the one representative).
 * - TODO 1205: levels above "deep" (xhigh = "deeper", max = "maximum", and values not in the table) are appended to the end, in the
 *   order listed, only when effort works and the CLI listed levels. Before they are learned, they are not added (levels
 *   that are not supported are not shown).
 *
 * Order: "off" → the named levels from shallowest → the higher levels (in response order).
 */
export function thinkingLevelsFor(
  table: CompatTable,
  entry: ModelEntry,
  learned: LearnedModel | undefined
): readonly ThinkingLevel[] {
  const override = overrideFor(table, learned?.resolved)
  // TODO 1209: the response's `supportsThinkingOff` wins. For older versions without the field, and for init only, use the table (full-name override → alias row → true).
  const canDisable = learned?.canDisableThinking ?? override.canDisableThinking ?? entry.canDisableThinking ?? true
  const supportsEffort = supportsEffortFor(table, entry, learned)
  const effortLevels = learned?.effortLevels ?? null
  const out: ThinkingLevel[] = []
  for (const level of BASE_THINKING_LEVELS) {
    if (level === 'off') {
      if (canDisable) out.push(level)
      continue
    }
    if (supportsEffort) {
      const sent = table.thinkingLevels[level].effort
      if (effortLevels === null || sent === undefined || effortLevels.includes(sent)) out.push(level)
    } else if (level === FALLBACK_THINKING) {
      out.push(level)
    }
  }
  if (!out.some((level) => level !== 'off') && !out.includes(FALLBACK_THINKING)) {
    // If there is no "on" level at all (the response's levels do not match the table), add the representative.
    const at = out.indexOf('off') + 1
    out.splice(at, 0, FALLBACK_THINKING)
  }
  // TODO 1205: above "deep", add only the levels the response listed, in response order (not before they are learned, and not for models where effort has no effect).
  // Table levels (xhigh / max) use their names; values not in the table become a level of the raw value (`effort:<value>`).
  if (supportsEffort && effortLevels !== null) {
    for (const value of effortLevels) {
      const level = levelForEffort(table, value) ?? extraThinkingLevel(value)
      if (level === null || BASE_THINKING_LEVELS.includes(level as KnownThinkingLevel) || out.includes(level)) continue
      out.push(level)
    }
  }
  return out
}

/** CLI effort value → the table's named level (TODO 1205). Null if not in the table. */
function levelForEffort(table: CompatTable, value: string): KnownThinkingLevel | null {
  return THINKING_LEVELS.find((level) => table.thinkingLevels[level]?.effort === value) ?? null
}

/** Display name. "Opus 4.8" if the version is known, only the name otherwise. */
export function modelLabel(table: CompatTable, entry: ModelEntry, learned: LearnedModel | undefined): string {
  const version = learned === undefined ? null : modelVersion(table, learned.resolved)
  return version === null ? entry.label : `${entry.label} ${version}`
}

/**
 * Reported model name (full name `claude-sonnet-5` or alias `sonnet`) → display name `Sonnet 5` (TODO 403, the subagent
 * list). Written the same way as the choices of the Model switch (item 91): the table's `label` + version. For a full name the version
 * is read from the name; for an alias, from the full name learned from the CLI (only the name before it is learned). Null if it hits no
 * alias in the table (the caller decides whether to show the full name as is or not at all).
 */
export function reportedModelLabel(
  table: CompatTable,
  learned: LearnedModels,
  reported: string
): string | null {
  const id = modelIdForReported(table, learned, reported)
  if (id === null) return null
  const entry = table.models.list.find((candidate) => candidate.id === id)
  if (entry === undefined) return null
  const version = modelVersion(table, reported.replace(/\[[^\]]*\]$/, ''))
  return version === null ? modelLabel(table, entry, learned.get(id)) : `${entry.label} ${version}`
}

/**
 * The choices passed to the renderer. Full names are dropped (constraint 6): a version-pinned model's id is the value passed to `--model`
 * and is an opaque string to the renderer. Order: upper tier (the table's aliases) → version-pinned models → unavailable models (TODO 769)
 * → version-pinned choices that point to the same model as the upper tier (`sameAs`, TODO 1204).
 *
 * TODO 1204: if the lower tier has a newer version in the same family (`aliasUpgrades`), the upper tier's alias badge and thinking levels
 * are those of the newer version (passed to the CLI as a full name: the adapter's `cliModelValue`). The newer version's row is removed from the lower tier (▾)
 * and moved to the end with a `sameAs` mark, and in its place the CLI's default version that dropped out of the tier is shown as a version-pinned row (so
 * it can be pinned to 5.1 via ▾). The alias's own target (with no row in the lower tier) is also placed at the end with `sameAs`: even if a version
 * pinned earlier via ▾ later becomes the alias's target, that thread's badge does not become "not in the list".
 */
export function buildModelChoices(
  table: CompatTable,
  learned: LearnedModels,
  catalog: ModelCatalog = EMPTY_CATALOG
): readonly ModelChoice[] {
  return buildModelView(table, learned, catalog).choices
}

/**
 * Values derived from what was learned (`learned` + `catalog`) (wave 82 review Y). The adapter builds this once, when `learned` / `catalog`
 * change, and keeps it: it is not rebuilt in things like `contextWindow`, which is called on every usage update.
 */
export interface ModelView {
  /** Aliases whose tier badge is replaced by a newer version in the same family (`aliasUpgrades`). */
  readonly upgrades: ReadonlyMap<string, PinnedModel>
  /** The choices passed to the renderer (`buildModelChoices`). */
  readonly choices: readonly ModelChoice[]
  /**
   * Id of a version-pinned choice → full name (wave 82 review Y-1). Besides the lower-tier rows (`catalog.pinned`), it includes the
   * CLI's default version that dropped out of the tier (displaced) and the version-pinned choices that point to the same model as the upper tier (`sameAs`).
   * Ids here are not mapped onto `legacyIds` aliases (a version chosen via ▾ stays pinned: pinning to 4.5 must not end up running a newer version).
   * Rows of unavailable models are not included.
   */
  readonly fixed: ReadonlyMap<string, string>
}

export function buildModelView(
  table: CompatTable,
  learned: LearnedModels,
  catalog: ModelCatalog = EMPTY_CATALOG
): ModelView {
  const upgrades = aliasUpgrades(table, learned, catalog)
  const fixed = new Map<string, string>()
  const aliases = table.models.list.map((entry): ModelChoice => {
    const known = effectiveAliasTarget(learned, upgrades, entry.id)
    return {
      id: entry.id,
      label: modelLabel(table, entry, known),
      // In a narrow Composer the version is dropped (item 309-1). The table's `label` is only the name (the version is added from initialize).
      shortLabel: entry.label,
      thinkingLevels: thinkingLevelsFor(table, entry, known),
      thinkingBinary: isBinaryThinkingModel(table, entry, known)
    }
  })
  const pinnedChoice = (value: string, label: string, known: LearnedModel): ModelChoice => {
    // The thinking defaults (whether it can be turned off) are borrowed from the alias row of the same family. A model of unknown family gets the default (true).
    const entry: ModelEntry = familyEntry(table, known.resolved) ?? { id: value, label: value }
    if (!fixed.has(value)) fixed.set(value, known.resolved)
    return {
      id: value,
      label,
      pinned: true,
      thinkingLevels: thinkingLevelsFor(table, entry, known),
      thinkingBinary: isBinaryThinkingModel(table, entry, known)
    }
  }
  const upgradedBy = new Map<string, string>()
  for (const [alias, row] of upgrades) upgradedBy.set(row.value, alias)
  const listed = new Set(catalog.pinned.map((row) => stripSuffix(row.resolved)))
  const ids = new Set(table.models.list.map((entry) => entry.id))
  const pinned: ModelChoice[] = []
  const same: ModelChoice[] = []
  for (const row of catalog.pinned) {
    const alias = upgradedBy.get(row.value)
    if (alias === undefined) {
      pinned.push(pinnedChoice(row.value, pinnedLabel(table, row), learnedOfPinned(row)))
      continue
    }
    same.push({ ...pinnedChoice(row.value, pinnedLabel(table, row), learnedOfPinned(row)), sameAs: alias })
    // Show the CLI's default version that dropped out of the tier (e.g. alias fable = 5.1, tier 5.2) as a version-pinned row at the position where the newer version was.
    const displaced = learned.get(alias)
    if (displaced !== undefined && !listed.has(stripSuffix(displaced.resolved))) {
      const value = displaced.resolved
      const row: PinnedModel = {
        value,
        resolved: displaced.resolved,
        displayName: null,
        supportsEffort: displaced.supportsEffort ?? true,
        effortLevels: displaced.effortLevels,
        ...(typeof displaced.canDisableThinking === 'boolean' ? { canDisableThinking: displaced.canDisableThinking } : {})
      }
      pinned.push(pinnedChoice(value, pinnedLabel(table, row), displaced))
      listed.add(stripSuffix(value))
    }
  }
  // The alias target's own `sameAs` is only for CLI versions that list version-pinned models (an empty lower tier = a version with no
  // choice pinned by full name, where a thread never holds a full name either. Full names are not shown to the renderer: constraint 6).
  for (const entry of catalog.pinned.length === 0 ? [] : table.models.list) {
    if (upgrades.has(entry.id)) continue
    const known = learned.get(entry.id)
    if (known === undefined) continue
    const value = stripSuffix(known.resolved)
    if (value === '' || ids.has(value) || listed.has(value)) continue
    if (same.some((choice) => choice.id === value)) continue
    same.push({ ...pinnedChoice(value, modelLabel(table, entry, known), known), sameAs: entry.id })
  }
  const unavailable = catalog.unavailable.map(
    (row): ModelChoice => ({ id: row.value, label: row.label, pinned: true, unavailable: true })
  )
  return { upgrades, choices: [...aliases, ...pinned, ...unavailable, ...same], fixed }
}

/**
 * The full name of a version-pinned model (TODO 769), looked up by `value` or full name. Used to look up the pie chart's denominator
 * (`contextWindow`) via the full-name override. Null if nothing matches.
 */
export function pinnedResolved(catalog: ModelCatalog, model: string): string | null {
  const bare = stripSuffix(model)
  const row = catalog.pinned.find(
    (pinned) => pinned.value === model || stripSuffix(pinned.resolved) === bare
  )
  return row === undefined ? null : row.resolved
}

/** The pie chart's denominator per full name (TODO 769, `contextWindow` in `resolvedOverrides`). Null if absent. */
export function contextWindowOverride(table: CompatTable, resolved: string): number | null {
  const value = overrideFor(table, resolved).contextWindow
  return typeof value === 'number' && value > 0 ? value : null
}

// ---- Stored form (one `app_settings` key; only the adapter knows its contents) ----

/** The JSON to store: what was learned for each alias. */
export function serializeLearned(
  learned: LearnedModels,
  commands: readonly string[] | null = null,
  catalog: ModelCatalog = EMPTY_CATALOG
): string {
  const models: Record<string, LearnedModel> = {}
  for (const [id, value] of learned) models[id] = value
  // Item 95: the command list goes into the same cache too (an old cache without the field reads as null).
  // TODO 769: the lower tier of choices also goes into the same cache (an old cache without the field reads as empty). Not written when empty (the same string as the old form).
  return JSON.stringify({
    v: 1,
    models,
    ...(commands === null ? {} : { commands }),
    ...(catalog.pinned.length === 0 ? {} : { pinned: catalog.pinned }),
    ...(catalog.unavailable.length === 0 ? {} : { unavailable: catalog.unavailable })
  })
}

/** Reads the lower tier of choices from the cache (TODO 769). Empty if absent or broken. Rows of the wrong shape are dropped. */
export function parseCachedCatalog(raw: string | null): ModelCatalog {
  if (raw === null || raw === '') return EMPTY_CATALOG
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_CATALOG
  }
  if (!isRecord(parsed)) return EMPTY_CATALOG
  const pinned: PinnedModel[] = []
  for (const item of Array.isArray(parsed['pinned']) ? parsed['pinned'] : []) {
    if (!isRecord(item)) continue
    const { value, resolved, displayName, supportsEffort, effortLevels, canDisableThinking } = item
    if (typeof value !== 'string' || value === '' || typeof resolved !== 'string' || resolved === '') continue
    pinned.push({
      value,
      resolved,
      displayName: typeof displayName === 'string' && displayName !== '' ? displayName : null,
      supportsEffort: supportsEffort === true,
      effortLevels: Array.isArray(effortLevels)
        ? effortLevels.filter((level): level is string => typeof level === 'string')
        : null,
      ...(typeof canDisableThinking === 'boolean' ? { canDisableThinking } : {})
    })
  }
  const unavailable: UnavailableModel[] = []
  for (const item of Array.isArray(parsed['unavailable']) ? parsed['unavailable'] : []) {
    if (!isRecord(item)) continue
    const { value, label } = item
    if (typeof value !== 'string' || value === '' || typeof label !== 'string' || label === '') continue
    unavailable.push({ value, label })
  }
  return pinned.length === 0 && unavailable.length === 0 ? EMPTY_CATALOG : { pinned, unavailable }
}

/** Reads the command list from the cache (item 95). Null if absent or broken (= unknown). */
export function parseCachedCommands(raw: string | null): readonly string[] | null {
  if (raw === null || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['commands'])) return null
  return parsed['commands'].filter((name): name is string => typeof name === 'string' && name !== '')
}

/**
 * Extracts command names from the `initialize` response (items 68 / 95). Each element is
 * `{ name, description, argumentHint, … }`, and the name has the same form as the list in `system/init`
 * (no leading `/`; spike 18: 54 entries matched exactly with CLI 2.1.280). Null if the field is absent or empty.
 */
export function parseReportedCommands(response: unknown): readonly string[] | null {
  if (!isRecord(response)) return null
  const commands = response['commands']
  if (!Array.isArray(commands)) return null
  const names: string[] = []
  for (const item of commands) {
    const name = typeof item === 'string' ? item : isRecord(item) ? item['name'] : undefined
    if (typeof name === 'string' && name !== '') names.push(name.replace(/^\//, ''))
  }
  // An empty list is treated the same as "unknown" (trusting an empty one would make the Composer block every `/xxx`).
  return names.length === 0 ? null : names
}

/** Empty if broken (= it merely falls back to showing names only). Aliases not in the table are dropped. */
export function parseLearned(table: CompatTable, raw: string | null): Map<string, LearnedModel> {
  const out = new Map<string, LearnedModel>()
  if (raw === null || raw === '') return out
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  if (!isRecord(parsed) || !isRecord(parsed['models'])) return out
  for (const [id, value] of Object.entries(parsed['models'])) {
    if (!table.models.list.some((entry) => entry.id === id) || !isRecord(value)) continue
    const resolved = value['resolved']
    if (typeof resolved !== 'string' || resolved === '') continue
    const supportsEffort = value['supportsEffort']
    const levels = value['effortLevels']
    const canDisableThinking = value['canDisableThinking']
    out.set(id, {
      resolved,
      supportsEffort: typeof supportsEffort === 'boolean' ? supportsEffort : null,
      effortLevels: Array.isArray(levels)
        ? levels.filter((level): level is string => typeof level === 'string')
        : null,
      ...(typeof canDisableThinking === 'boolean' ? { canDisableThinking } : {})
    })
  }
  return out
}

/** Whether two "learned" values are the same (to skip saving and notifying). */
export function sameLearned(a: LearnedModels, b: LearnedModels): boolean {
  return serializeLearned(a) === serializeLearned(b)
}

/** Whether two lower tiers of choices are the same (TODO 769). */
export function sameCatalog(a: ModelCatalog, b: ModelCatalog): boolean {
  return serializeLearned(new Map(), null, a) === serializeLearned(new Map(), null, b)
}
