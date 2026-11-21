/**
 * TODO 1066 (ARCHITECTURE 4.6.1.2): "recommended for this PC" for local models. Shared by the create dialog and settings.
 *
 * The first is the recommendation. Fetching, and creating a derived model with a decided context length, run **only when pressed** (not automatic, owner decision 2026-10-31).
 * Nothing is shown on a backend that has none (main returns null).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LocalModelAction, LocalModelActivityRow, LocalModelAdvice as Advice, LocalModelPick } from '@shared/local-models.js'
import { describeReason, useT } from '../i18n/index.js'

const GB = 1024 ** 3

function gb(bytes: number): string {
  return (bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)
}

function contextLabel(tokens: number): string {
  return tokens >= 1024 && tokens % 1024 === 0 ? `${tokens / 1024}k` : String(tokens)
}

export function LocalModelAdvice({ backendId }: { readonly backendId: string }): React.JSX.Element | null {
  const t = useT()
  const [advice, setAdvice] = useState<Advice | null>(null)
  const [running, setRunning] = useState<{ readonly model: string; readonly action: LocalModelAction } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The running operations and their progress (a light entry point; the recommendation is not recomputed). null means "not looked at yet".
  const [activity, setActivity] = useState<readonly LocalModelActivityRow[]>([])

  // Even on failure, keep the previous value (one failure does not remove the panel).
  const load = useCallback(
    (force: boolean) => {
      void window.aios.agent
        .localAdvice(backendId, force)
        .then(setAdvice)
        .catch(() => undefined)
    },
    [backendId]
  )
  useEffect(() => {
    setAdvice(null)
    setActivity([])
    load(false)
  }, [load])

  // While an operation is running, re-fetch only the progress every second (main holds the progress of fetching, so one pressed from another window is visible too).
  // Start even in the window that pressed it (`running`) and even if advice has no row yet. When it ends (becomes empty), re-read the recommendation exactly once.
  const working = running !== null || activity.length > 0 || advice?.picks.some((p) => p.running !== null) === true
  const wasWorking = useRef(false)
  useEffect(() => {
    if (!working) {
      if (wasWorking.current) load(false)
      wasWorking.current = false
      return undefined
    }
    wasWorking.current = true
    const poll = (): void => {
      void window.aios.agent
        .localActivity(backendId)
        .then(setActivity)
        .catch(() => undefined)
    }
    poll()
    const timer = setInterval(poll, 1000)
    return () => clearInterval(timer)
  }, [working, backendId, load])

  const act = useCallback(
    (pick: LocalModelPick, action: LocalModelAction) => {
      setRunning({ model: pick.model, action })
      setError(null)
      void window.aios.agent
        .localAction(backendId, action, pick.model)
        .then((result) => {
          if (!result.ok) setError(result.code)
        })
        .catch((err: unknown) => setError(String(err)))
        .finally(() => {
          setRunning(null)
          load(false)
        })
    },
    [backendId, load]
  )

  if (advice === null) return null
  const { hardware, runtime } = advice
  return (
    <div className="local-advice">
      <h4>{t('localAdvice.title')}</h4>
      <p className="hint">
        {t('localAdvice.hardware', {
          cpu: hardware.gpu.name ?? hardware.cpu,
          memory: gb(hardware.memoryBytes),
          budget: gb(advice.budgetBytes)
        })}
        {hardware.appleChip?.neuralAccelerators === true ? `・${t('localAdvice.neural')}` : ''}
      </p>
      {advice.cpuOnly ? <p className="hint">{t('localAdvice.cpuOnly')}</p> : null}
      <p className="hint">
        {!runtime.reachable
          ? t('localAdvice.runtimeDown')
          : t(runtime.nativeFormat ? 'localAdvice.runtimeNative' : 'localAdvice.runtime', { version: runtime.version ?? '' })}
      </p>
      {advice.picks.length === 0 ? <p className="hint">{t('localAdvice.none')}</p> : null}
      <ul className="local-advice-picks">
        {advice.picks.map((pick, index) => {
          // For a running operation, look at the light entry point's value first (advice can be stale right after pressing or after one failure).
          const row = activity.find((a) => a.model === pick.model)
          const pickRunning = row?.running ?? pick.running
          const busy = pickRunning !== null || running?.model === pick.model
          const progress = row?.progress ?? pick.progress
          return (
            <li key={pick.model} className={index === 0 ? 'top' : undefined}>
              <span>
                {index === 0 ? <strong>{t('localAdvice.top')}: </strong> : null}
                {t('localAdvice.pick', {
                  model: pick.model,
                  format: pick.format,
                  context: contextLabel(pick.context),
                  size: gb(pick.estimatedBytes)
                })}
                {pick.moe ? ` (${t('localAdvice.moe')})` : ''}
              </span>
              {pick.action === 'pull' ? (
                <button type="button" disabled={running !== null || working} onClick={() => act(pick, 'pull')}>
                  {busy ? t('localAdvice.pulling') : t(pick.broken ? 'localAdvice.repull' : 'localAdvice.pull')}
                </button>
              ) : null}
              {pickRunning === 'pull' && progress !== null && progress.total > 0 ? (
                <span className="local-advice-progress">
                  <progress max={progress.total} value={progress.completed} />
                  <span className="hint">
                    {t('localAdvice.progress', {
                      done: gb(progress.completed),
                      total: gb(progress.total),
                      percent: String(Math.floor((progress.completed / progress.total) * 100))
                    })}
                  </span>
                </span>
              ) : null}
              {pick.broken ? <span className="denied">{t('localAdvice.broken', { model: pick.model })}</span> : null}
              {pick.action === 'tune' ? (
                <>
                  <button type="button" disabled={running !== null || working} onClick={() => act(pick, 'tune')}>
                    {busy ? t('localAdvice.tuning') : t('localAdvice.tune', { tuned: pick.tunedModel, context: contextLabel(pick.context) })}
                  </button>
                  {pick.tunedContext === null ? (
                    <span className="hint">{t('localAdvice.notTuned', { context: contextLabel(advice.defaultContext) })}</span>
                  ) : null}
                </>
              ) : null}
              {pick.action === null && pick.tunedContext !== null ? (
                <span className="hint">{t('localAdvice.tuned', { tuned: pick.tunedModel, context: contextLabel(pick.tunedContext) })}</span>
              ) : null}
            </li>
          )
        })}
      </ul>
      {error !== null ? <p className="denied">{describeReason(t, error)}</p> : null}
      {advice.picks.some((p) => p.action !== null) ? <p className="hint">{t('localAdvice.hint')}</p> : null}
    </div>
  )
}
