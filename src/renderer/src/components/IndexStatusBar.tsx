/**
 * Index build progress and stop / resume (6.2 "show progress in the UI").
 *
 * Split out of `SearchMode.tsx` in TODO 52, and moved to the right side of BottomBar.
 * The subscription (`useSearch.init`) happens once at Sidebar mount and does not depend on the mode,
 * so the progress and the buttons are always visible even when the search mode is not shown.
 * The contents are the same as before the move.
 */
import { useSearch } from '../searchStore.js'
import { describeReason, useT } from '../i18n/index.js'

export function IndexStatusBar(): React.JSX.Element {
  const t = useT()
  const status = useSearch((state) => state.status)
  const pause = useSearch((state) => state.pause)
  const resume = useSearch((state) => state.resume)
  // A search or list did not return within the limit (item 87). For a while, shown ahead of the progress.
  const busy = useSearch((state) => state.indexBusy)

  if (status === null) return <div className="status-bar">…</div>

  const pending = status.pending.toLocaleString()
  const label =
    busy !== null
      ? describeReason(t, busy)
      : status.state === 'starting'
      ? // Restarting (main's IndexClient attaches the reason code `index-restarting`, 7.4.4).
        status.message === null
        ? t('index.starting')
        : describeReason(t, status.message)
      : status.state === 'building'
      ? // While the user is operating, it proceeds slowly (TODO 434, `message: 'slow'`). When idle, the previous full-speed wording.
        status.message === 'slow'
        ? t('index.buildingSlow', { pending })
        : t('index.building', { indexed: status.indexed.toLocaleString(), pending })
      : // Waiting (P4 -> TODO 434). Only when stopped by heat at `serious` or above / Low Power Mode.
        status.state === 'waiting'
        ? status.message === 'low-power'
          ? t('index.waitingLowPower', { pending })
          : t('index.waitingThermal', { pending })
        : status.state === 'paused'
          ? t('index.paused', { pending })
          : status.state === 'error'
            ? t('index.error', { message: describeReason(t, status.message) })
            : t('index.done', { indexed: status.indexed.toLocaleString() })

  return (
    <div className="status-bar">
      <span
        title={t('index.detail', {
          chunks: status.chunks.toLocaleString(),
          skipped: status.skipped.toLocaleString()
        })}
      >
        {label}
      </span>
      {status.state === 'building' || status.state === 'waiting' ? (
        <button type="button" onClick={() => void pause()}>
          {t('index.pause')}
        </button>
      ) : status.pending > 0 ? (
        <button type="button" onClick={() => void resume()}>
          {t('index.resume')}
        </button>
      ) : null}
    </div>
  )
}
