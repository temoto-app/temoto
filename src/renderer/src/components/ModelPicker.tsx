/**
 * The Composer's Model selection (item 61 / 91, TODO 769). The top-level aliases ("always the latest") stay as a button row, and
 * version-pinned models and unavailable models go in the "Other" menu on the right (the same contents as the CLI's `/model` list in VS Code).
 * The split is a pure function (`splitModelChoices`).
 *
 * TODO 1018: if other backends are available, the menu is shown as groups "backend > model" and lists the models of other
 * backends too (`modelMenuEntries`). A row that crosses backends in a thread with a conversation gets "continue in a new thread" attached,
 * and choosing it branches without confirmation (owner decision 2026-10-26, the no-dialog policy). For a thread that has not been sent to yet,
 * the backend is switched on the spot.
 */
import type { ModelChoice } from '@shared/agent.js'
import type { BackendChoice } from '@shared/thread.js'
import { useT } from '../i18n/index.js'
import {
  compactModelPicker,
  groupedModelLabel,
  listedModelChoices,
  modelChoiceLabel,
  modelMenuEntries,
  splitModelChoices,
  type ModelMenuEntry
} from '../composer-choice.js'
import { SegmentedControl } from './SegmentedControl.js'
import { ContextMenu, useContextMenuState } from './ContextMenu.js'
import { Tooltip } from './Tooltip.js'

export function ModelPicker({
  models,
  value,
  onChange,
  backends = [],
  backendId = null,
  crossKind = 'fork',
  onSwitchBackend
}: {
  readonly models: readonly ModelChoice[]
  readonly value: string | null
  readonly onChange: (id: string) => void
  /** All backends (TODO 1018). If omitted or only itself, the same appearance as before. */
  readonly backends?: readonly BackendChoice[]
  /** This thread's backend. */
  readonly backendId?: string | null
  /** The result of a cross-backend choice (the caller decides with `canSwitchBackendInPlace`). */
  readonly crossKind?: 'in-place' | 'fork'
  readonly onSwitchBackend?: (backendId: string, modelId: string | null) => void
}): React.JSX.Element {
  const t = useT()
  const menu = useContextMenuState()
  const { segment, more, notListed } = splitModelChoices(models, value)

  const compact = compactModelPicker(models)

  const entriesFor = (own: readonly ModelChoice[]): ModelMenuEntry[] =>
    backendId === null || onSwitchBackend === undefined
      ? modelMenuEntries({ backends: [], currentBackendId: '', own, value, crossKind })
      : modelMenuEntries({ backends, currentBackendId: backendId, own, value, crossKind })
  // Whether to show "Other" (the down triangle) in the button-row shape. If there are rows of other backends, show it even with no version-pinned models.
  const moreEntries = entriesFor(more)
  // TODO 1204: a version-pinned choice pointing at the same model as the top row (`sameAs`) is listed only when it is selected.
  const listed = listedModelChoices(models, value)
  const ownLabel = entriesFor(listed)[0]?.backendLabel ?? null

  const openMenu = (event: React.MouseEvent<HTMLButtonElement>, entries: readonly ModelMenuEntry[]): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    // Opens from the button's upper left (the Composer is at the window's bottom edge, so `placeContextMenu` flips it upward).
    menu.openMenu(
      {
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation(),
        clientX: rect.left,
        clientY: rect.top
      },
      entries.map((entry) => {
        const modelText =
          entry.unavailable && entry.modelLabel !== null
            ? t('composer.modelUnavailable', { label: entry.modelLabel })
            : entry.modelLabel
        return {
          key: entry.key,
          label: groupedModelLabel(entry.backendLabel, modelText),
          ...(entry.unavailable ? { disabled: true } : {}),
          ...(entry.checked ? { checked: true } : {}),
          // TODO 1026: a row of an unusable backend gets a reason attached (a generic sentence if there is no message).
          ...(entry.backendReason !== undefined
            ? { hint: entry.backendReason ?? t('composer.backendUnavailable') }
            : entry.kind === 'fork'
              ? { hint: t('composer.modelNewThread') }
              : {}),
          onSelect: () => {
            if (entry.kind === 'same') {
              if (entry.modelId !== null) onChange(entry.modelId)
            } else onSwitchBackend?.(entry.backendId, entry.modelId)
          }
        }
      })
    )
  }

  if (compact) {
    // TODO 1017: a backend with many aliases uses a single "current model" button. The menu lists everything in list order.
    const current = models.find((m) => m.id === value)
    const label = current === undefined ? (value ?? t('common.model')) : modelChoiceLabel(current, t)
    const full = groupedModelLabel(ownLabel, label)
    return (
      <>
        <Tooltip placement="top" content={`${t('common.model')}: ${full}`}>
          <button
            type="button"
            className="composer-model-menu"
            aria-haspopup="menu"
            aria-label={`${t('common.model')}: ${full}`}
            onClick={(event) => openMenu(event, entriesFor(listed))}
          >
            <span className="composer-model-menu-label">{current?.shortLabel ?? label}</span>
            <span aria-hidden="true">▾</span>
          </button>
        </Tooltip>
        <ContextMenu point={menu.point} items={menu.items} onClose={menu.closeMenu} />
      </>
    )
  }

  const moreLabel = moreEntries.some((entry) => entry.kind !== 'same')
    ? t('composer.moreModelsOtherAgents')
    : t('composer.moreModels')
  return (
    <>
      <SegmentedControl
        label={t('common.model')}
        value={value}
        onChange={onChange}
        options={[
          ...segment.map((m) => ({
            value: m.id,
            // TODO 1204: a version-pinned choice pointing at the same model as the top row gets a "pinned" marker (to tell it from the top row's button).
            label: modelChoiceLabel(m, t),
            // In a narrow Composer, drop the version (item 309-1).
            ...(m.shortLabel === undefined ? {} : { shortLabel: m.shortLabel }),
            title: `${t('common.model')}: ${groupedModelLabel(ownLabel, modelChoiceLabel(m, t))}`
          })),
          // A thread whose id is not in the list (after the table changed) also gets one added, so the selection does not vanish.
          ...(notListed && value !== null
            ? [{ value, label: value, title: t('common.modelNotListed', { id: value }) }]
            : [])
        ]}
      />
      {moreEntries.length === 0 ? null : (
        <Tooltip placement="top" content={moreLabel}>
          <button
            type="button"
            className="composer-more-models"
            aria-haspopup="menu"
            aria-label={moreLabel}
            onClick={(event) => openMenu(event, moreEntries)}
          >
            ▾
          </button>
        </Tooltip>
      )}
      <ContextMenu point={menu.point} items={menu.items} onClose={menu.closeMenu} />
    </>
  )
}
