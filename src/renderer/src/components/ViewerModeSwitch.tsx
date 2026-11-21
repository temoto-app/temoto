/**
 * The "view switch" in the viewer heading (TODO 969, ARCHITECTURE 7.4.12). Draws the Source / Preview of `aios.markdown` / `aios.html` with the same
 * component (`SegmentedControl`) as the Composer's Model selection (`ModelPicker`). The selectable views are those the viewer reported with `view-modes`
 * (only the host vocabulary `ViewerViewMode`, already checked by `acceptViewModes`). Text is looked up in the host's dictionary.
 *
 * TODO 1200 (wave 81 bundle C): the scaling interpolation (Nearest / Bilinear) of `aios.image` / `aios.video` is drawn through the same entry point. The screen reader name is
 * told apart by group (`viewModeGroup`), and each interpolation option gets a description (title).
 */
import { viewModeGroup, type ViewerViewMode, type ViewerViewModeGroup, type ViewModesReport } from '@shared/viewer-view-mode.js'
import { useT, type MessageKey } from '../i18n/index.js'
import { SegmentedControl } from './SegmentedControl.js'

const MODE_LABEL: Record<ViewerViewMode, MessageKey> = {
  preview: 'viewer.mode.preview',
  source: 'viewer.mode.source',
  table: 'viewer.mode.table',
  text: 'viewer.mode.text',
  nearest: 'viewer.mode.nearest',
  bilinear: 'viewer.mode.bilinear'
}

const MODE_TITLE: Partial<Record<ViewerViewMode, MessageKey>> = {
  nearest: 'viewer.mode.nearestHint',
  bilinear: 'viewer.mode.bilinearHint'
}

const GROUP_LABEL: Record<ViewerViewModeGroup, MessageKey> = {
  display: 'viewer.mode.label',
  filter: 'viewer.mode.filterLabel'
}

export function ViewerModeSwitch({
  report,
  onChange
}: {
  readonly report: ViewModesReport
  readonly onChange: (mode: ViewerViewMode) => void
}): React.JSX.Element {
  const t = useT()
  const first = report.modes[0]
  const group: ViewerViewModeGroup = first === undefined ? 'display' : viewModeGroup(first)
  return (
    <SegmentedControl
      className="viewer-mode-switch"
      label={t(GROUP_LABEL[group])}
      value={report.current}
      onChange={onChange}
      options={report.modes.map((mode) => {
        const title = MODE_TITLE[mode]
        return { value: mode, label: t(MODE_LABEL[mode]), ...(title === undefined ? {} : { title: t(title) }) }
      })}
    />
  )
}
