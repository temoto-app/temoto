import { useT } from '../i18n/index.js'
import { Tooltip } from './Tooltip.js'
import { ViewerBackIcon } from '../icons/ViewerBackIcon.js'
import { ViewerForwardIcon } from '../icons/ViewerForwardIcon.js'
import { navigateFiler, useFilerNavState } from '../filerHistory.js'
import type { FilerDirection } from '../filer-history.js'

/**
 * The Files back / forward (TODO 1257, ARCHITECTURE 5.4). Same parts as the viewer heading's ← → (TODO 369): icon
 * buttons whose tooltip is caught by the outer span, because a disabled button gets no mouseenter. No key (buttons
 * only). History is `filerHistory.ts` (per conversation, memory only).
 */
function FilerNavButton({
  direction,
  enabled
}: {
  readonly direction: FilerDirection
  readonly enabled: boolean
}): React.JSX.Element {
  const t = useT()
  const label = t(direction === 'back' ? 'files.back' : 'files.forward')
  return (
    <Tooltip content={label}>
      <span className="files-nav-slot">
        <button
          type="button"
          className={`icon-button files-nav ${direction === 'back' ? 'files-back' : 'files-forward'}`}
          disabled={!enabled}
          onClick={() => void navigateFiler(direction)}
          aria-label={label}
        >
          {direction === 'back' ? <ViewerBackIcon /> : <ViewerForwardIcon />}
        </button>
      </span>
    </Tooltip>
  )
}

export function FilerNavButtons(): React.JSX.Element {
  const nav = useFilerNavState()
  return (
    <span className="files-nav-group">
      <FilerNavButton direction="back" enabled={nav.back} />
      <FilerNavButton direction="forward" enabled={nav.forward} />
    </span>
  )
}
