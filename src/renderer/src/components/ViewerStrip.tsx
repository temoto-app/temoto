/**
 * The thin strip a folded ViewerPane leaves behind (TODO 1297, `viewer-collapse.ts`). The pane is never absent: the
 * whole strip is one button that brings the viewer back. What the viewer shows (`selectedUri`, the temporary view) is
 * untouched while folded; only ViewerPane is unmounted (drafts stay in the store's table, TODO 312, and Web views are
 * hidden and kept alive as when switching to a file, TODO 580).
 */
import { useT } from '../i18n/index.js'
import { Tooltip } from './Tooltip.js'
import { ViewerOpenIcon } from '../icons/ViewerOpenIcon.js'

export function ViewerStrip({ onExpand }: { readonly onExpand: () => void }): React.JSX.Element {
  const t = useT()
  return (
    <div className="viewer-strip">
      <Tooltip content={t('viewer.expand')}>
        <button type="button" className="viewer-strip-button" onClick={onExpand} aria-label={t('viewer.expand')}>
          <ViewerOpenIcon />
        </button>
      </Tooltip>
    </div>
  )
}
