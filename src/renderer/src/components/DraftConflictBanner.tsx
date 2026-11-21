/**
 * The draft conflict band (item 97 second half, ARCHITECTURE.md 4.5.1).
 *
 * Shown when the model tries to rewrite, with a write tool
 * (`Edit` / `Write` and so on), a file for which the user holds a draft in ViewerPane. **It has nothing to do with whether approval is granted**
 * (by default writes are auto-approved too, T40): it only informs.
 *
 * **A small observation from TODO 313 (wave 17 bundle J): the band stays one, and the actions are the two "Reload" and "Overwrite and save".**
 * During a conflict, ⌘S and the heading's "Save" button do not save (`shouldSaveByKey` blocks it), so
 * the wording was also matched to what actually happens (we dropped the warning "saving will overwrite", which
 * announced something the normal save button would actually refuse).
 *
 * It uses a frame with the same look as the existing `.viewer-banner` (unsaved confirmation / save error).
 * Changes to `ViewerPane.tsx` are kept to a few lines of "read, pass, arrange", and the contents are put here
 * (because bundle H adds the diff display to the same file).
 */
import { useT } from '../i18n/index.js'
import type { DraftConflictNotice } from '../draft-conflict.js'

export function DraftConflictBanner({
  conflict,
  onReload,
  onOverwrite,
  onDismiss
}: {
  readonly conflict: DraftConflictNotice
  readonly onReload: () => void
  readonly onOverwrite: () => void
  readonly onDismiss: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="viewer-banner draft-conflict" role="alert">
      {conflict.autoSave === true ? (
        // TODO 555: when about to auto-save, the contents on disk had changed (we do not overwrite silently).
        <span>{t('viewer.draftConflict.autoSaveSkipped')}</span>
      ) : conflict.toolName === null ? (
        // TODO 312: the disk changed while the user was away (who wrote it is unknown).
        <span>{t('viewer.draftConflict.changedWhileAway')}</span>
      ) : (
        <span title={conflict.toolName}>{t('viewer.draftConflict.message')}</span>
      )}
      <button type="button" onClick={onReload}>
        {t('viewer.draftConflict.reload')}
      </button>
      <button type="button" onClick={onOverwrite}>
        {t('viewer.draftConflict.overwrite')}
      </button>
      <button type="button" onClick={onDismiss}>
        {t('common.close')}
      </button>
    </div>
  )
}
