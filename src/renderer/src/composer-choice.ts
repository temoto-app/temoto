/**
 * Pure functions for the permanent Model / Thinking buttons (segmented control, item 61 / ARCHITECTURE.md 4.5.1). They depend on neither
 * the DOM nor React; `test/composer-choice.test.ts` guards against regressions.
 *
 * The "default" choice was abolished (owner decision 2026-09-23). In the button row exactly one is always selected with a
 * concrete value. Where there is no value (threads once created with "default", `model_id = null`, or nothing selected
 * in the settings screen), the **displayed** selection is decided here:
 *
 * - Model: the thread's value -> the default in settings (if it is in the list) -> the first of the list.
 * - thinking: the thread's value -> the default in settings -> `FALLBACK_THINKING`.
 *
 * The decided value is not yet in the thread's row (still null), so the Composer treats it as "changed" and
 * writes it with `settingsScope: 'thread'` on the next send. So **an old unspecified thread does not change
 * merely by being opened; it is filled with a concrete value on the next send**.
 */
import type { KnownThinkingLevel, ModelChoice, ThinkingLevel } from '@shared/agent.js'
import {
  BASE_THINKING_LEVELS,
  FALLBACK_THINKING,
  THINKING_LEVELS,
  extraThinkingValue,
  isExtraThinkingLevel
} from '@shared/agent.js'
import type { BackendChoice, SwitchRestart } from '@shared/thread.js'
import type { BackendSwitchKind } from '@shared/backend-switch.js'
import type { MessageKey } from './i18n/ja.js'

/**
 * Dictionary key used to display one Thinking button (item 92). For models where effort has no effect
 * (`ModelChoice.thinkingBinary`, Haiku), the selectable level (`FALLBACK_THINKING`) is shown with a two-way wording (`thinking.on` = "on")
 * rather than the level name (`thinking.medium` = "normal").
 * Other levels and other models use the usual `thinking.<level>`.
 */
export function thinkingLabelKey(level: KnownThinkingLevel, thinkingBinary: boolean): MessageKey {
  return thinkingBinary && level === FALLBACK_THINKING ? 'thinking.on' : (`thinking.${level}` as MessageKey)
}

/**
 * Display name of one thinking level (TODO 1205). Named levels use the dictionary (`thinkingLabelKey`); unnamed levels returned by the backend
 * (`effort:<value>`) show the value as it is (shown, not dropped).
 */
export function thinkingLabel(level: ThinkingLevel, thinkingBinary: boolean, t: (key: MessageKey) => string): string {
  return isExtraThinkingLevel(level) ? extraThinkingValue(level) : t(thinkingLabelKey(level, thinkingBinary))
}

/**
 * Levels listed in the `<select>` of the settings default / reservation Thinking (wave 82 review Y-5). The six named levels, plus, if the saved value is outside them
 * (an unnamed level `effort:<value>`), that value appended at the end: without a matching option it would look as if the first, "none", were selected,
 * and saving without touching it would produce an unintended level.
 */
export function thinkingSelectLevels(current: ThinkingLevel | null): readonly ThinkingLevel[] {
  const named: readonly ThinkingLevel[] = THINKING_LEVELS
  return current === null || named.includes(current) ? named : [...named, current]
}

/**
 * Levels listed in the Composer's Thinking (TODO 1205, owner decision 2026-11-10). The always-listed "none / low / normal / deep"
 * (shown disabled when ineffective; the strikethrough on "none" stays as it is) plus, to the right, the levels above "deep" supported by the chosen model
 * (`xhigh` / `max` / unnamed levels) in the model's own order. If the model's levels are unknown (`undefined`), only the four.
 */
export function thinkingSegmentLevels(selectable: readonly ThinkingLevel[] | undefined): readonly ThinkingLevel[] {
  const base: readonly ThinkingLevel[] = BASE_THINKING_LEVELS
  if (selectable === undefined) return base
  return [...base, ...selectable.filter((level) => !base.includes(level))]
}

/**
 * Identity key of the model list (TODO 937). `refreshBackends()` puts in a new array every time even when the contents are the same,
 * so the effect depends on this string rather than on the array reference (so the user's unsent selection is not reset).
 */
export function modelsSignature(models: readonly ModelChoice[] | null): string | null {
  // With the id alone, a list where only the label / shortLabel / thinking levels changed would be discarded (wave 49 review).
  // Everything that affects display and selection is whatever ModelChoice holds, so each element is serialized whole.
  return models === null ? null : JSON.stringify(models)
}

export function resolveModelChoice(
  threadModelId: string | null,
  settingsDefault: string | null,
  models: readonly ModelChoice[]
): string | null {
  if (threadModelId !== null) return threadModelId
  if (settingsDefault !== null && models.some((m) => m.id === settingsDefault)) return settingsDefault
  return models[0]?.id ?? null
}

export function resolveThinkingChoice(
  threadThinking: ThinkingLevel | null,
  settingsDefault: ThinkingLevel | null
): ThinkingLevel {
  return threadThinking ?? settingsDefault ?? FALLBACK_THINKING
}

/**
 * Keyboard handling of `role="radiogroup"` (following the WAI-ARIA radio group convention):
 * left / up for previous, right / down for next (wrapping at the ends), Home / End for the two ends. Anything else gives null (do nothing).
 * The selection changes along with the move (like native radio buttons).
 *
 * Passing `enabled` makes it **skip disabled choices** (item 92: thinking levels that have no effect on that model).
 * Home / End go to the enabled ends. If none is enabled, null.
 */
export function segmentedKeyStep(
  key: string,
  index: number,
  length: number,
  enabled?: readonly boolean[]
): number | null {
  if (length <= 0) return null
  const ok = (i: number): boolean => enabled === undefined || enabled[i] !== false
  const walk = (from: number, step: number): number | null => {
    for (let n = 1; n <= length; n += 1) {
      const i = (((from + step * n) % length) + length) % length
      if (ok(i)) return i
    }
    return null
  }
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return walk(index, -1)
    case 'ArrowRight':
    case 'ArrowDown':
      return walk(index, 1)
    case 'Home':
      return walk(-1, 1)
    case 'End':
      return walk(length, -1)
    default:
      return null
  }
}

/**
 * Whether sending with the current selection kills the running process and starts it again (item 95; the condition for showing
 * "switching requires restarting the session"). Called only when the selection differs from the row and a process is running.
 *
 * - `always`: this version does not support switching while running -> always restart
 * - `never`: do not restart
 * - `thinking-on`: a process started with "none". Restart only when going back from "none". The level currently in effect
 *   is approximated by the thread's row (from then on forever = written to the row at every send)
 */
export function switchNeedsRestart(
  mode: SwitchRestart,
  threadThinking: ThinkingLevel | null,
  nextThinking: ThinkingLevel | null
): boolean {
  if (mode === 'always') return true
  if (mode === 'never') return false
  return threadThinking === 'off' && nextThinking !== null && nextThinking !== 'off'
}

/**
 * Choosing how to display the name of one segment choice (item 309-1). In a narrow Composer (container 400px wide or less) the
 * short name (the version dropped, "Opus") is shown; when wide, the ordinary name ("Opus 4.8"). The switching is done by a CSS
 * container query (`.seg-full` / `.seg-short`), so this only decides "draw two or draw one".
 * If there is no short name, or it is empty or the same, `short` is null (draw only one = the same at any width).
 */
export function segmentLabels(
  label: string,
  shortLabel: string | undefined
): { readonly full: string; readonly short: string | null } {
  const short = shortLabel?.trim() ?? ''
  return { full: label, short: short === '' || short === label ? null : short }
}

/** Upper limit of aliases listed in the button row (TODO 1017). The number of aliases (4) of the default backend. */
export const MODEL_SEGMENT_MAX = 4

/**
 * TODO 1017: for a backend whose aliases exceed the limit (the second backend's list is all aliases, over 10, with long names), give up
 * the button row and use a single "current model" button plus a menu. Left as a button row it overflowed sideways, and
 * later models (Ollama etc.) and the badge of the chosen model went off screen.
 */
export function compactModelPicker(models: readonly ModelChoice[]): boolean {
  return models.filter((m) => m.pinned !== true).length > MODEL_SEGMENT_MAX
}

/**
 * Models listed in a list (settings default, reservation choice, menu) (TODO 1204). A version-pinned choice (`sameAs`)
 * pointing at the same model as the upper row is kept only while it is selected.
 */
export function listedModelChoices(models: readonly ModelChoice[], selectedId: string | null): readonly ModelChoice[] {
  return models.filter((m) => m.sameAs === undefined || m.id === selectedId)
}

/**
 * Display name of a Model choice (TODO 1204). A version-pinned choice (`sameAs`) pointing at the same model as the upper row
 * gets a "pinned" mark so it can be told apart from the upper-row button (`composer.modelPinnedSame`).
 */
export function modelChoiceLabel(
  model: Pick<ModelChoice, 'label' | 'sameAs'>,
  t: (key: 'composer.modelPinnedSame', vars: { label: string }) => string
): string {
  return model.sameAs === undefined ? model.label : t('composer.modelPinnedSame', { label: model.label })
}

/**
 * Sorting between the Model button row and the "more" menu (TODO 769).
 *
 * - Button row (`segment`): the upper-row aliases (not `pinned`). If the selected one is a version-pinned model,
 *   it is also appended at the end (so the selection does not vanish from the button row). A version-pinned choice pointing at the same model as the upper row
 *   (`sameAs`, TODO 1204) is also appended here when selected (it is not shown in the menu).
 * - Menu (`more`): version-pinned models and unusable models (`unavailable`, grayed). The order is the backend's list order.
 * - `notListed`: the selected id matches none (a thread from before the table changed). Appended to the button row as the bare id.
 */
export function splitModelChoices(
  models: readonly ModelChoice[],
  selectedId: string | null
): {
  readonly segment: readonly ModelChoice[]
  readonly more: readonly ModelChoice[]
  readonly notListed: boolean
} {
  const segment = models.filter((m) => m.pinned !== true)
  // TODO 1204: a version-pinned choice (`sameAs`) pointing at the same model as the upper row is not shown in the menu; it is added to the button row only when selected.
  const more = models.filter((m) => m.pinned === true && m.sameAs === undefined)
  const selectedPinned = models.find((m) => m.pinned === true && m.id === selectedId && m.unavailable !== true)
  return {
    segment: selectedPinned === undefined ? segment : [...segment, selectedPinned],
    more,
    notListed: selectedId !== null && !models.some((m) => m.id === selectedId)
  }
}

/**
 * Whether to write thinking in the timeline's switch row ("default changed from now on: model … · thinking …") (TODO 1018, addendum to 1017).
 * Not written if the thread's backend has no thinking levels. A backend whose list has not arrived or is not in the registry is written as before.
 */
export function settingsNoteShowsThinking(
  backends: readonly Pick<BackendChoice, 'id' | 'thinkingLevel'>[] | null,
  backendId: string | undefined
): boolean {
  if (backends === null || backendId === undefined) return true
  return backends.find((b) => b.id === backendId)?.thinkingLevel ?? true
}

/** One row of the Model menu (TODO 1018: grouped display "backend > model"). */
export interface ModelMenuEntry {
  readonly key: string
  readonly backendId: string
  /** The model to choose. For a row of a backend that cannot choose models (`modelSelect` false) it is null (= the backend's default). */
  readonly modelId: string | null
  /** The backend name in the heading (`BackendChoice.label`). Null if there is no other selectable backend (only the model name, as before). */
  readonly backendLabel: string | null
  /** Display name of the model. Null for a row whose `modelId` is null. */
  readonly modelLabel: string | null
  /** What happens when chosen (`backendSwitchKind`). A `fork` row gets a "continue in a new thread" note. */
  readonly kind: BackendSwitchKind
  readonly checked: boolean
  /** A model unusable in the current version (TODO 769, own backend only), or a row of an unusable backend (TODO 1026). */
  readonly unavailable: boolean
  /**
   * Held only by rows of an unusable backend (TODO 1026): the reason for graying out (`BackendChoice.message`, null if none).
   * A row with this mark cannot be chosen (`unavailable` is also true).
   */
  readonly backendReason?: string | null
}

/** The sentence of one row in grouped display (the form `backend > model`). Only the model name if there is no backend name. */
export function groupedModelLabel(backendLabel: string | null, modelLabel: string | null): string {
  if (backendLabel === null) return modelLabel ?? ''
  return modelLabel === null ? backendLabel : `${backendLabel} › ${modelLabel}`
}

/**
 * The rows of the Model menu (TODO 1018). First the own backend's `own` (the part shown in the menu: "more" for the button-row form,
 * everything for the single-button form), followed by the models of other backends in list order.
 *
 * - For other backends the usable ones (`available`) are listed; an unusable one is a single grayed row of just its name + the reason (TODO 1026). If models can be chosen, all usable models (not `unavailable`);
 *   if not, the backend's one default row.
 * - If no other backend is listed, no heading is added (on a machine with one backend it looks the same as before).
 * - `crossKind` is the result of a cross-backend choice (decided by the caller from the thread, `canSwitchBackendInPlace`): `in-place` if
 *   nothing has been sent yet, `fork` if there is a conversation.
 */
export function modelMenuEntries(input: {
  readonly backends: readonly BackendChoice[]
  readonly currentBackendId: string
  readonly own: readonly ModelChoice[]
  readonly value: string | null
  readonly crossKind: Exclude<BackendSwitchKind, 'same'>
}): ModelMenuEntry[] {
  const current = input.backends.find((b) => b.id === input.currentBackendId)
  const others: ModelMenuEntry[] = []
  for (const backend of input.backends) {
    if (backend.id === input.currentBackendId) continue
    if (!backend.available) {
      // TODO 1026: an unusable backend is not hidden; it is a single grayed row of just its name + the reason (matching the create dialog).
      others.push({
        key: `${backend.id}\u0000`,
        backendId: backend.id,
        backendLabel: backend.label,
        modelId: null,
        modelLabel: null,
        kind: input.crossKind,
        checked: false,
        unavailable: true,
        backendReason: backend.message
      })
      continue
    }
    const base = {
      backendId: backend.id,
      backendLabel: backend.label,
      kind: input.crossKind,
      checked: false,
      unavailable: false
    }
    if (!backend.modelSelect) {
      others.push({ ...base, key: `${backend.id}\u0000`, modelId: null, modelLabel: null })
      continue
    }
    for (const model of backend.models) {
      // TODO 1204: a version-pinned choice (`sameAs`) pointing at the same model as the upper row is not shown in other backends' rows.
      if (model.unavailable === true || model.sameAs !== undefined) continue
      others.push({ ...base, key: `${backend.id}\u0000${model.id}`, modelId: model.id, modelLabel: model.label })
    }
  }
  const ownLabel = others.length === 0 ? null : (current?.label ?? null)
  const own = input.own.map(
    (model): ModelMenuEntry => ({
      key: `${input.currentBackendId}\u0000${model.id}`,
      backendId: input.currentBackendId,
      modelId: model.id,
      backendLabel: ownLabel,
      modelLabel: model.label,
      kind: 'same',
      checked: model.id === input.value,
      unavailable: model.unavailable === true
    })
  )
  return [...own, ...others]
}
