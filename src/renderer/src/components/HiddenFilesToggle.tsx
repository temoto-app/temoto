/**
 * The "show hidden files" toggle in the file tree heading (TODO 261, wave 15 bundle D).
 *
 * One switch, the same as Finder's ⌘⇧.. Pressing it saves to main, and the trees in all windows re-fetch
 * (`hiddenFilesStore.ts`). The keys (⇧⌘. / Ctrl+Shift+.) are added to `title` (the same practice as VS Code's tooltips,
 * item 195). While pressed (while showing), it has `aria-pressed` and `.active`.
 */
import { useHiddenFiles } from '../hiddenFilesStore.js'
import { HiddenFilesIcon } from '../icons/HiddenFilesIcon.js'
import { keyPlatformOf } from '../composer-keys.js'
import { useT } from '../i18n/index.js'
import { Tooltip } from './Tooltip.js'

const KEY_LABEL =
  keyPlatformOf(typeof navigator === 'undefined' ? '' : navigator.platform) === 'mac'
    ? '⇧⌘.'
    : 'Ctrl+Shift+.'

export function HiddenFilesToggle(): React.JSX.Element {
  const t = useT()
  const shown = useHiddenFiles((state) => state.show)
  const toggle = useHiddenFiles((state) => state.toggle)
  const label = t('sidebar.files.showHidden')
  return (
    <Tooltip content={t('sidebar.mode.withKey', { label, key: KEY_LABEL })}>
      <button
        type="button"
        className={`icon-button files-hidden-toggle${shown ? ' active' : ''}`}
        aria-pressed={shown}
        aria-label={label}
        onClick={() => void toggle()}
      >
        <HiddenFilesIcon shown={shown} />
      </button>
    </Tooltip>
  )
}
