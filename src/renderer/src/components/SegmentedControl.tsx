/**
 * An N-way segmented control (item 61 / ARCHITECTURE.md 4.5.1).
 *
 * A generalization to N options of the reference image (a two-option rounded toggle). The options are laid out in place and
 * switch on click, without opening a menu. The keyboard behavior that `<select>` had is provided by
 * `role="radiogroup"` + `role="radio"` (arrows move = select, Home / End go to the ends,
 * Tab passes through in one stop as a single group = roving tabindex).
 * The decision is `segmentedKeyStep` in `composer-choice.ts` (a pure function).
 *
 * Colors are CSS variables only (7.4.1): the base is `--segment-bg`, and the selected one is raised with `--segment-on-bg`.
 */
import { Fragment, useRef } from 'react'
import { segmentLabels, segmentedKeyStep } from '../composer-choice.js'
import { Tooltip } from './Tooltip.js'

export interface SegmentedOption<T extends string> {
  readonly value: T
  readonly label: string
  readonly title?: string
  /**
   * A short name shown instead in a narrow Composer (item 309-1, the model name without the version). Both it and `label` are drawn, and
   * which one is visible is decided by a CSS container query (`.seg-full` / `.seg-short`).
   */
  readonly shortLabel?: string
  /**
   * An option that cannot be pressed (item 92: a thinking level that has no effect on that model). It is **kept in the row** as disabled, and
   * keyboard movement skips it. Even if selected it cannot be pressed (the caller adjusts to a selectable value).
   */
  readonly disabled?: boolean
  /**
   * An icon drawn instead of text (the sort order of item 152). When passed, `label` becomes `aria-label`, and
   * if there is no `title`, `label` is also used as the title (an icon alone cannot be read).
   */
  readonly icon?: React.ReactNode
}

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  className
}: {
  /** The group's name for screen readers (`aria-label`). */
  readonly label: string
  readonly options: readonly SegmentedOption<T>[]
  readonly value: T | null
  readonly onChange: (value: T) => void
  /** An extra class (added to `segmented`). */
  readonly className?: string
}): React.JSX.Element {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const selected = options.findIndex((o) => o.value === value)
  const enabled = options.map((o) => o.disabled !== true)
  // If nothing is selected, the first enabled option is where Tab lands (the selection is not changed).
  const firstEnabled = Math.max(0, enabled.indexOf(true))
  const focusable = selected >= 0 && enabled[selected] === true ? selected : firstEnabled

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = segmentedKeyStep(event.key, index, options.length, enabled)
    if (next === null) return
    event.preventDefault()
    const option = options[next]
    if (option === undefined) return
    if (option.value !== value) onChange(option.value)
    buttons.current[next]?.focus()
  }

  return (
    <div
      className={className === undefined ? 'segmented' : `segmented ${className}`}
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option, index) => {
        // Items 320 / 354: text options keep the OS title, and icon-only options move to the common tooltip
        // (Tooltip) (no title is written).
        const iconTitle = option.title ?? option.label
        const button = (
          <button
            ref={(el) => {
              buttons.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={index === selected}
            tabIndex={index === focusable ? 0 : -1}
            className={index === selected ? 'on' : undefined}
            title={option.icon === undefined ? option.title : undefined}
            aria-label={option.icon === undefined ? undefined : option.label}
            disabled={option.disabled === true}
            aria-disabled={option.disabled === true ? true : undefined}
            onClick={() => {
              if (option.disabled !== true && option.value !== value) onChange(option.value)
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.icon ?? <SegmentText label={option.label} shortLabel={option.shortLabel} />}
          </button>
        )
        return option.icon === undefined ? (
          <Fragment key={option.value}>{button}</Fragment>
        ) : (
          <Tooltip key={option.value} content={iconTitle}>
            {button}
          </Tooltip>
        )
      })}
    </div>
  )
}

/** The text of an option (item 309-1). If there is a short name, both are drawn and CSS hides one of them depending on the width. */
function SegmentText({
  label,
  shortLabel
}: {
  readonly label: string
  readonly shortLabel: string | undefined
}): React.JSX.Element {
  const { full, short } = segmentLabels(label, shortLabel)
  if (short === null) return <>{full}</>
  return (
    <>
      <span className="seg-full">{full}</span>
      {/* The hidden one is removed from screen readers by display: none, so aria-hidden is not added. */}
      <span className="seg-short">{short}</span>
    </>
  )
}
