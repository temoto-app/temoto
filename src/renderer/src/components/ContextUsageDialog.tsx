/**
 * The dialog for the context usage breakdown (item 155 / ARCHITECTURE.md 4.5.1). It appears when the donut (item 60)
 * is pressed. The model is the "Context usage" of the VS Code extension.
 *
 * - Heading: the model's full name and "218.3k / 1.0M tokens (22%)", and a horizontal bar color-coded per category.
 * - A table of categories (name, token count, share) and the list of memory files (paths are folded to `~`, and pressing one opens it in the viewer.
 *   Ones that hit an exclusion rule (for example under the backend's settings location) look unpressable, and the reason is shown in the tooltip).
 * - It queries main every time it opens. If a process is running it fetches on the spot (no model call, spike 26),
 *   otherwise it shows the last breakdown fetched together with "when the breakdown is from". If it was never fetched, only the same
 *   total as the donut. **No process is started for the breakdown** (owner decision 2026-09-27).
 * - The look matches the create dialog (item 153): closed with the x, and the headings, table headings and category names stay in English.
 * - Colors are only CSS variables (7.4.1). The category colors are `--ctx-*` (in the order that passed the dataviz check, 4.5.1).
 */
import { useCallback, useEffect, useState } from 'react'
import type { ContextBreakdownResult } from '@shared/context-breakdown.js'
import { displayPath } from '@shared/uri.js'
import { useThreads } from '../threadStore.js'
import { useStore } from '../store.js'
import { useT } from '../i18n/index.js'
import { breakdownColor, breakdownView, headerFromUsage, type BreakdownHeader } from '../context-breakdown.js'
import { formatTokens } from '../context-usage.js'
import { formatWhen } from '../thread/timeline.js'
import { CloseIcon } from '../icons/CloseIcon.js'
import { Tooltip } from './Tooltip.js'

type Load =
  | { readonly state: 'loading'; readonly result: ContextBreakdownResult | null }
  | { readonly state: 'done'; readonly result: ContextBreakdownResult }
  | { readonly state: 'failed'; readonly result: ContextBreakdownResult | null }

export function ContextUsageDialog({
  threadId,
  onClose
}: {
  readonly threadId: string
  readonly onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const usage = useThreads((state) => state.threadsById[threadId]?.runtime.contextUsage ?? null)
  const homeUri = useStore((state) => state.appInfo?.homeUri ?? '')
  const select = useStore((state) => state.select)
  const compact = useThreads((state) => state.compact)
  const [load, setLoad] = useState<Load>({ state: 'loading', result: null })

  // TODO 495: Compact (just sends `/compact` to that thread). If a response is in progress, main puts it in the queue (item 94).
  // On press, the dialog closes at once and progress is shown in the timeline (owner decision 2026-10-06).
  const handleCompact = useCallback(() => {
    onClose()
    void compact(threadId)
  }, [compact, threadId, onClose])

  const fetch = useCallback(() => {
    let cancelled = false
    setLoad((current) => ({ state: 'loading', result: current.result }))
    window.aios.threads.contextBreakdown(threadId).then(
      (result) => {
        if (!cancelled) setLoad({ state: 'done', result })
      },
      () => {
        if (!cancelled) setLoad((current) => ({ state: 'failed', result: current.result }))
      }
    )
    return () => {
      cancelled = true
    }
  }, [threadId])

  useEffect(() => fetch(), [fetch])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const breakdown = load.result?.breakdown ?? null
  const view = breakdown === null ? null : breakdownView(breakdown)
  const header: BreakdownHeader | null = view?.header ?? headerFromUsage(usage)

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings context-dialog"
        role="dialog"
        aria-label={t('contextDialog.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-header">
          <span>{t('contextDialog.title')}</span>
          <span className="context-dialog-tools">
            <Tooltip content={t('contextDialog.compactTooltip')}>
              <button
                type="button"
                className="context-dialog-compact"
                onClick={handleCompact}
                aria-label={t('contextDialog.compactTooltip')}
              >
                {t('contextDialog.compact')}
              </button>
            </Tooltip>
            {/* Item 354 (a missed move found when the check missed it): the shared popover, not title. */}
            <Tooltip content={t('contextDialog.refresh')}>
              <button
                type="button"
                className="icon-button"
                onClick={() => fetch()}
                disabled={load.state === 'loading'}
                aria-label={t('contextDialog.refresh')}
              >
                <span aria-hidden="true">⟳</span>
              </button>
            </Tooltip>
            <Tooltip content={t('common.close')}>
              <button type="button" className="icon-button" onClick={onClose} aria-label={t('common.close')}>
                <CloseIcon />
              </button>
            </Tooltip>
          </span>
        </div>

        <section className="context-dialog-head">
          {header === null ? (
            <p className="hint">{load.state === 'loading' ? t('common.loading') : t('contextDialog.none')}</p>
          ) : (
            <>
              {header.model !== null ? <div className="context-dialog-model">{header.model}</div> : null}
              <div className="context-dialog-total">
                {t('contextDialog.tokens', { used: header.used, max: header.max, percent: header.percent })}
              </div>
            </>
          )}
          {view !== null ? (
            <div className="context-bar" role="img" aria-label={t('contextDialog.barLabel')}>
              {view.bar.map((segment) => (
                <span
                  key={segment.key}
                  className={`context-bar-seg ${segment.kind}`}
                  style={{ flexGrow: segment.fraction, background: breakdownColor(segment.kind, segment.tone) }}
                  title={segment.name}
                />
              ))}
            </div>
          ) : null}
          {load.result !== null && !load.result.fresh && breakdown !== null ? (
            <p className="hint" title={new Date(breakdown.at).toLocaleString()}>
              {t('contextDialog.asOf', { when: formatWhen(breakdown.at, t) })}
            </p>
          ) : null}
          {breakdown === null && load.state !== 'loading' && header !== null ? (
            <p className="hint">{t('contextDialog.none')}</p>
          ) : null}
          {load.state === 'failed' ? <p className="denied">{t('contextDialog.failed')}</p> : null}
        </section>

        {view !== null && view.rows.length > 0 ? (
          <section>
            <table className="context-table">
              <thead>
                <tr>
                  <th>{t('contextDialog.col.category')}</th>
                  <th className="num">{t('contextDialog.col.tokens')}</th>
                  <th className="num">{t('contextDialog.col.share')}</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.map((row) => (
                  <tr key={row.key} className={row.kind}>
                    <td>
                      <span
                        className="context-swatch"
                        style={{ background: breakdownColor(row.kind, row.tone) }}
                        aria-hidden="true"
                      />
                      {row.name}
                    </td>
                    <td className="num">{row.tokens}</td>
                    <td className="num" title={row.share === null ? t('contextDialog.deferredHint') : undefined}>
                      {row.share ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        {breakdown !== null && breakdown.memoryFiles.length > 0 ? (
          <section>
            <h3>{t('contextDialog.memoryFiles')}</h3>
            <ul className="context-memory">
              {breakdown.memoryFiles.map((file) => (
                <li key={file.uri}>
                  <button
                    type="button"
                    className="context-memory-path"
                    disabled={!file.openable}
                    title={file.openable ? undefined : t('contextDialog.notOpenable')}
                    onClick={() => {
                      select(file.uri)
                      onClose()
                    }}
                  >
                    {displayPath(file.uri, homeUri)}
                  </button>
                  {file.type !== '' ? <span className="context-memory-type">{file.type}</span> : null}
                  <span className="context-memory-tokens">{formatTokens(file.tokens)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  )
}
