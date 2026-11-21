/**
 * The common error band at the top of the window (TODO 1281, ARCHITECTURE.md 7.4.4). What it shows, in order:
 * what failed (`summary`), what to try (`recovery`, only for codes that have one), and buttons - "Show details" / "Open log" and any
 * per-code actions. "Show details" opens the technical rows (reason code, operation, error type, time) and the log file's path,
 * which can be copied. The path always comes from main (`app.getLogInfo`); the renderer never passes a path back
 * (`editor.revealLogs` takes nothing). When there is no log, or it cannot be opened, the band says so and names the next step.
 *
 * To use it from another feature: put `formatReason(code, params)` into the threads store's `error` (or throw `reasonError`
 * in a handler); see `error-notice.ts` for how to add a recovery sentence or a button.
 */
import { useEffect, useState } from 'react'
import { formatReason, type ReasonCode } from '@shared/reason.js'
import type { LogInfo } from '@shared/types.js'
import { useT, type Translate } from '../i18n/index.js'
import { buildNotice } from '../error-notice.js'
import { useThreads } from '../threadStore.js'

export interface NoticeAction {
  readonly key: string
  readonly label: string
  readonly run: () => void
}

/** Buttons that go with a reason code. Add an entry here for a new code (TODO 1281). */
export function noticeActionsFor(code: ReasonCode | null, tr: Translate): readonly NoticeAction[] {
  if (code === 'capture-permission') {
    // TODO 967: only when screen recording permission is missing. No URL is passed, only the kind.
    return [
      {
        key: 'open-settings',
        label: tr('reason.capture-permission.openSettings'),
        run: () => void window.aios.app.openSystemSettings('screen-recording')
      },
      {
        key: 'relaunch',
        label: tr('reason.capture-permission.relaunch'),
        run: () => void window.aios.app.relaunch()
      }
    ]
  }
  if (code === 'login-timeout' || code === 'login-check-failed') {
    // TODO 1282: start the login once more. Only the shown conversation's id goes to main (main re-checks it).
    return [
      {
        key: 'login-again',
        label: tr('thread.auth.loginAgain'),
        run: () => {
          const threadId = useThreads.getState().activeThreadId
          void window.aios.agent
            .startLogin(threadId)
            .then((result) => {
              if (!result.opened) useThreads.setState({ error: formatReason(result.reason) })
            })
            .catch(() => undefined)
        }
      }
    ]
  }
  return []
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function ErrorNotice({
  message,
  onDismiss
}: {
  message: string
  onDismiss: () => void
}): React.JSX.Element {
  const t = useT()
  const view = buildNotice(t, message)
  const [open, setOpen] = useState(false)
  const [logInfo, setLogInfo] = useState<LogInfo | null>(null)
  const [openFailed, setOpenFailed] = useState(false)
  const [copied, setCopied] = useState(false)

  // A new error starts collapsed again.
  useEffect(() => {
    setOpen(false)
    setOpenFailed(false)
    setCopied(false)
  }, [message])

  // The path is fetched only when the details are shown (or the log failed to open).
  useEffect(() => {
    if (!open && !openFailed) return
    let alive = true
    window.aios.app.getLogInfo().then(
      (info) => {
        if (alive) setLogInfo(info)
      },
      () => {
        if (alive) setLogInfo({ path: null, dir: null })
      }
    )
    return () => {
      alive = false
    }
  }, [open, openFailed, message])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const openLog = (): void => {
    window.aios.editor.revealLogs().then(
      (ok) => setOpenFailed(!ok),
      () => setOpenFailed(true)
    )
  }
  const actions = noticeActionsFor(view.code, t)
  const logProblem = logInfo !== null && logInfo.path === null
  const dir = logInfo?.dir ?? null

  return (
    <div className="app-error" role="alert">
      <div className="app-error-head">
        <span className="app-error-summary">{view.summary}</span>
        <span className="app-error-actions">
          {actions.map((action) => (
            <button key={action.key} type="button" className="app-error-action" onClick={action.run}>
              {action.label}
            </button>
          ))}
          <button
            type="button"
            className="app-error-action"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? t('error.details.hide') : t('error.details.show')}
          </button>
          <button type="button" className="app-error-action" onClick={openLog}>
            {t('error.log.open')}
          </button>
          <button type="button" className="app-error-action" onClick={onDismiss} aria-label={t('common.close')}>
            ×
          </button>
        </span>
      </div>
      {view.recovery !== null ? (
        <div className="app-error-recovery">
          <strong>{t('error.recovery.title')}</strong> {view.recovery}
        </div>
      ) : null}
      {openFailed ? (
        <div className="app-error-recovery">
          {dir !== null
            ? t('error.log.openFailed', { dir })
            : t('error.log.noneNoDir')}
        </div>
      ) : null}
      {open ? (
        <div className="app-error-details">
          {view.rows.length === 0 ? (
            <p>{t('error.details.noInfo')}</p>
          ) : (
            <dl className="app-error-rows">
              {view.rows.map((row) => (
                <div key={row.label} className="app-error-row">
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {view.at !== null ? <p>{t('error.details.timeHint')}</p> : null}
          <p>{t('error.log.notice')}</p>
          <dl className="app-error-rows">
          <div className="app-error-row">
            <dt>{t('error.log.title')}</dt>
            {logInfo === null ? null : logInfo.path !== null ? (
              <dd className="app-error-path">
                <code>{logInfo.path}</code>
                <button
                  type="button"
                  className="app-error-action"
                  onClick={() => {
                    if (logInfo.path === null) return
                    void copyText(logInfo.path).then((ok) => {
                      if (ok) setCopied(true)
                    })
                  }}
                >
                  {copied ? t('error.log.copied') : t('error.log.copyPath')}
                </button>
              </dd>
            ) : (
              <dd>{logProblem && dir !== null ? t('error.log.none', { dir }) : t('error.log.noneNoDir')}</dd>
            )}
          </div>
          </dl>
        </div>
      ) : null}
    </div>
  )
}
