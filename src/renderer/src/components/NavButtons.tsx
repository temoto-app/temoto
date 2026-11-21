import { useT } from '../i18n/index.js'
import { Tooltip } from './Tooltip.js'
import { ViewerBackIcon } from '../icons/ViewerBackIcon.js'
import { ViewerForwardIcon } from '../icons/ViewerForwardIcon.js'
import { globalNavKeyLabel, type GlobalNavId } from '../shortcuts.js'
import { keyPlatformOf } from '../composer-keys.js'
import { runGlobalNav, useGlobalNavState } from '../navHistory.js'

/** The key convention attached to the popover (mac / other). Decided once at launch. */
const KEY_PLATFORM = keyPlatformOf(typeof navigator === 'undefined' ? '' : navigator.platform)

function NavButton({ id, enabled }: { readonly id: GlobalNavId; readonly enabled: boolean }): React.JSX.Element {
  const t = useT()
  const label = t(id === 'navBack' ? 'nav.back' : 'nav.forward')
  const tip = `${label} (${globalNavKeyLabel(id, KEY_PLATFORM)})`
  return (
    <Tooltip content={tip}>
      <span className="nav-slot">
        <button
          type="button"
          className={`icon-button nav-button ${id === 'navBack' ? 'nav-back' : 'nav-forward'}`}
          disabled={!enabled}
          onClick={() => runGlobalNav(id)}
          aria-label={label}
        >
          {id === 'navBack' ? <ViewerBackIcon /> : <ViewerForwardIcon />}
        </button>
      </span>
    </Tooltip>
  )
}

/**
 * The aios-wide back / forward at the top left of the title bar (TODO 801, ARCHITECTURE 5.4). Separate from the viewer heading's left / right arrows (TODO 369), and
 * told apart by the framed round buttons and the popover wording ("Go back to the previous conversation", TODO 1257). The history is in `navHistory.ts` (per window, in memory only).
 */
export function NavButtons(): React.JSX.Element {
  const nav = useGlobalNavState()
  return (
    <div className={`titlebar-nav ${KEY_PLATFORM}`}>
      <NavButton id="navBack" enabled={nav.back} />
      <NavButton id="navForward" enabled={nav.forward} />
    </div>
  )
}
