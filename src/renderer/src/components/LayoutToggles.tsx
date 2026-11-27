/**
 * The layout toggles at the right of the title bar (TODO 1327, ARCHITECTURE 5.5.1): VS Code's "Toggle Primary Side Bar" and
 * "Toggle Secondary Side Bar" (in aios the secondary one is ViewerPane). Pressing hides the pane, pressing again shows it; the icon's
 * filled column says which state it is in, and `aria-pressed` says the same to a screen reader. The same commands are in the View
 * menu (Cmd+B / Alt+Cmd+B). The state is the window layout's (`windowLayout.ts`); App passes it in and owns the actions.
 */
import { useT } from '../i18n/index.js'
import { Tooltip } from './Tooltip.js'
import { LayoutSidebarIcon } from '../icons/LayoutSidebarIcon.js'
import { LayoutViewerIcon } from '../icons/LayoutViewerIcon.js'
import { keyPlatformOf } from '../composer-keys.js'
import { layoutToggleKeyLabel, type LayoutToggleId } from '../shortcuts.js'

/** The key convention of the tooltip (mac / other). Decided once at launch. */
const KEY_PLATFORM = keyPlatformOf(typeof navigator === 'undefined' ? '' : navigator.platform)

function LayoutToggle({
  id,
  shown,
  onToggle
}: {
  readonly id: LayoutToggleId
  readonly shown: boolean
  readonly onToggle: () => void
}): React.JSX.Element {
  const t = useT()
  const label = t(id === 'sidebar' ? 'layout.toggleSidebar' : 'layout.toggleViewer')
  return (
    <Tooltip content={() => `${label} (${layoutToggleKeyLabel(id, KEY_PLATFORM)})`}>
      <button
        type="button"
        className={`icon-button layout-toggle layout-toggle-${id}`}
        aria-label={label}
        aria-pressed={shown}
        onClick={onToggle}
      >
        {id === 'sidebar' ? <LayoutSidebarIcon shown={shown} /> : <LayoutViewerIcon shown={shown} />}
      </button>
    </Tooltip>
  )
}

export function LayoutToggles(props: {
  readonly sidebarShown: boolean
  readonly viewerShown: boolean
  readonly onToggleSidebar: () => void
  readonly onToggleViewer: () => void
}): React.JSX.Element {
  return (
    <div className="titlebar-layout">
      <LayoutToggle id="sidebar" shown={props.sidebarShown} onToggle={props.onToggleSidebar} />
      <LayoutToggle id="viewer" shown={props.viewerShown} onToggle={props.onToggleViewer} />
    </div>
  )
}
