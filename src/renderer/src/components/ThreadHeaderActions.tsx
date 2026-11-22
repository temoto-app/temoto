/**
 * The icon buttons at the top right of the thread heading (TODO 865, wave 43). Three buttons that used to be text
 * buttons inside the ... menu (`ThreadSettingsMenu`) are lined up to the left of the magnifier (icon + tooltip, like
 * the actions in a VS Code editor heading):
 *
 * - A new tab in the viewer (TODO 771. A blank tab + URL field, same as Cmd+T. Since TODO 1297 ViewerPane is always
 *   shown, so the button decides what it shows rather than opening it)
 * - Open the working folder in the external editor (item 255 / TODO 633. For a conversation moved to a worktree, that
 *   worktree. Not shown for threads with no cwd or in the scratch area. The label is the name from the external editor
 *   setting, item 115)
 * - Export the whole conversation (TODO 818). Pressing it shows a small menu "Save as PDF..." / "Save as HTML..."
 *   (TODO 866, `ExportMenu`)
 *
 * It is a separate file from ThreadPane.tsx (same reason as RewindMenu: parallel bundles touch the same file).
 * It returns a fragment, and the buttons become direct children of `.thread-header` (the no-shrink rule of
 * `.thread-header > button` applies. The export is inside `.menu-anchor`, and the anchor is `flex: 0 0 auto`). The
 * classes are `thread-action-*`; the names were split because the old `.thread-open-editor` rules (the size of the
 * button inside the cwd, item 115) remain.
 */
import { workingCwdUri } from '@shared/thread.js'
import { EDITOR_LABELS } from '@shared/editor.js'
import { useThreads } from '../threadStore.js'
import { useEditor } from '../editorStore.js'
import { useT } from '../i18n/index.js'
import { openBlankTab } from '../webStore.js'
import { Tooltip } from './Tooltip.js'
import { ExportMenu } from './ExportMenu.js'
import { ViewerOpenIcon } from '../icons/ViewerOpenIcon.js'
import { OpenExternalIcon } from '../icons/OpenExternalIcon.js'

export function ThreadHeaderActions({ threadId }: { threadId: string }): React.JSX.Element | null {
  const t = useT()
  const thread = useThreads((state) => state.threadsById[threadId]?.thread)
  const editorId = useEditor((state) => state.id)
  const openInEditor = useEditor((state) => state.open)
  if (thread === undefined) return null
  // Old rows with no cwd (`cwdName === ''`) and the scratch area (unassigned) have nowhere to open.
  const canOpenCwd = thread.cwdName !== '' && thread.cwdUri !== ''
  const editorLabel = t('threadSettings.openInEditor', { editor: EDITOR_LABELS[editorId] })

  return (
    <>
      <Tooltip content={t('threadSettings.openViewer')}>
        <button
          type="button"
          className="icon-button thread-action thread-action-viewer"
          aria-label={t('threadSettings.openViewer')}
          onClick={() => openBlankTab()}
        >
          <ViewerOpenIcon />
        </button>
      </Tooltip>
      {canOpenCwd ? (
        <Tooltip content={editorLabel}>
          <button
            type="button"
            className="icon-button thread-action thread-action-editor"
            aria-label={editorLabel}
            onClick={() => void openInEditor(workingCwdUri(thread), { asDirectory: true })}
          >
            <OpenExternalIcon />
          </button>
        </Tooltip>
      ) : null}
      <ExportMenu
        threadId={thread.id}
        target={{ kind: 'all' }}
        className="thread-action-export"
        buttonClassName="thread-action"
      />
    </>
  )
}
