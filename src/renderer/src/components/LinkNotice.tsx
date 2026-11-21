/**
 * The band for a link that could not be opened (TODO 808 / 816, ARCHITECTURE.md 5.1). Shown in the same place as the `app-error` at the top of the window,
 * with the sentence for the reason and the next steps:
 *
 * - Multiple candidates (`link-ambiguous`): a list in order of closeness to the cwd. Pressing a candidate opens it in ViewerPane (modeled on VS Code's
 *   Quick Pick for "multiple definitions", one path per row).
 * - Not found (`link-not-found`): the paths tried (a collapsed `<details>`) and "search by name" (puts the name in the Cmd+P field).
 * - An excluded place (`link-excluded`): "Open in external editor" and "Show in Finder". aios does not read it and only hands it to an outside app
 *   (main's `'handoff'` choke point checks again).
 * - A deleted conversation (`thread-link-deleted`, TODO 1155): "Restore and open". It restores through the same entry point as "Restore" in the deleted list,
 *   then jumps to that message.
 *
 * It stays until dismissed (x / Esc / the next link / choosing a candidate or handing it off).
 */
import { useEffect } from 'react'
import { displayPath } from '@shared/uri.js'
import { useStore } from '../store.js'
import { describeReason, useT } from '../i18n/index.js'
import { useLinkNotice } from '../linkNoticeStore.js'
import { applyThreadLinkStep, notify } from '../markdown-link.js'
import { useThreads } from '../threadStore.js'
import { searchFileName } from '../shortcut-actions.js'
import { CloseIcon } from '../icons/CloseIcon.js'
import { revealLabelKey } from './PathActions.js'
import { Tooltip } from './Tooltip.js'

export function LinkNotice(): React.JSX.Element | null {
  const t = useT()
  const notice = useLinkNotice((state) => state.notice)
  const clear = useLinkNotice((state) => state.clear)
  const homeUri = useStore((state) => state.appInfo?.homeUri ?? '')
  const platform = useStore((state) => state.appInfo?.platform)

  useEffect(() => {
    if (notice === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.isComposing) clear()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [notice, clear])

  if (notice === null) return null
  const choices = notice.choices ?? []
  const tried = notice.tried ?? []
  const handoff = notice.handoffUri
  const asDirectory = notice.handoffDirectory === true
  const restore = notice.restoreThread
  return (
    <div className="link-notice" role="alert">
      <div className="link-notice-head">
        <span className="link-notice-reason">{describeReason(t, notice.reason)}</span>
        <Tooltip content={t('common.close')}>
          <button type="button" className="icon-button link-notice-close" aria-label={t('common.close')} onClick={clear}>
            <CloseIcon />
          </button>
        </Tooltip>
      </div>
      {choices.length > 0 ? (
        <ul className="link-notice-choices" aria-label={t('linkNotice.choicesLabel')}>
          {choices.map((choice) => (
            <li key={choice.uri}>
              <button
                type="button"
                className="link-notice-choice"
                onClick={() => {
                  clear()
                  useStore.getState().select(choice.uri, { line: choice.line ?? null, column: choice.column ?? null })
                }}
              >
                {displayPath(choice.uri, homeUri)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {tried.length > 0 ? (
        <details className="link-notice-tried">
          <summary>
            {t('linkNotice.tried')} ({tried.length})
          </summary>
          <ul>
            {tried.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {notice.searchName !== undefined || handoff !== undefined || restore !== undefined ? (
        <div className="link-notice-actions">
          {restore !== undefined ? (
            <button
              type="button"
              className="link-notice-action"
              onClick={() => {
                clear()
                void useThreads
                  .getState()
                  .restoreThread(restore.threadId)
                  .then(
                    (restored) => {
                      if (!restored) {
                        notify('thread-link-not-found')
                        return
                      }
                      applyThreadLinkStep(
                        restore.eventId === null
                          ? { kind: 'open', threadId: restore.threadId, reason: null }
                          : { kind: 'jump', threadId: restore.threadId, eventId: restore.eventId }
                      )
                    },
                    (err: unknown) => notify(err instanceof Error ? err.message : String(err))
                  )
              }}
            >
              {t('linkNotice.restoreThread')}
            </button>
          ) : null}
          {notice.searchName !== undefined ? (
            <button
              type="button"
              className="link-notice-action"
              onClick={() => {
                const name = notice.searchName ?? ''
                clear()
                searchFileName(name)
              }}
            >
              {t('linkNotice.searchByName')}
            </button>
          ) : null}
          {handoff !== undefined && !asDirectory ? (
            <button
              type="button"
              className="link-notice-action"
              onClick={() => {
                clear()
                void window.aios.editor.openHandoff(handoff)
              }}
            >
              {/* An excluded place (the `'handoff'` choke point) is not sent to the default app even if its extension is in the table (code-review of TODO 1214). */}
              {t('linkNotice.openInEditor')}
            </button>
          ) : null}
          {handoff !== undefined ? (
            <button
              type="button"
              className="link-notice-action"
              onClick={() => {
                clear()
                void window.aios.editor.reveal(handoff, asDirectory)
              }}
            >
              {t(revealLabelKey(platform))}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
