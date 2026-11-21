/**
 * Badges for recent files (TODO 1172, ARCHITECTURE.md 4.5.12). A widening of 999's "new screenshot badge": regardless of the screenshot
 * location, it shows files of every kind that match the definition of "recent" (999: only updates by the user and the AI) within the last 5 minutes (`RECENT_OFFER_MS`),
 * up to 12 (`RECENT_OFFER_MAX`), newest first, above the Composer (like a messenger's "photos you just took" badge).
 *
 * - Badges = an excerpt of the first 12 items of the "Recent" popup (`RecentFiles.tsx`). The filters (AI, bulk, git) are re-applied by main (`recent.offers`).
 * - Images, videos and PDFs use the QuickLook thumbnail (`useThumbnail`); others show the file icon and name. One item is shown large (name, location, time and
 *   [Attach]); two or three are lined up sideways and shrunk; four or more become a wrapping grid (up to 2 rows, then scroll).
 *   The row gets a small heading "Recent files" and a dotted border to distinguish it from attached chips (TODO 1197). Clicking a badge (or [Attach]) attaches it, and the close mark dismisses it.
 * - It is shown **only while aios is in the foreground** (`document.hasFocus()`). It asks main again when the window comes to the front, or when a file that could appear in "Recent"
 *   changes within the 5 minute window (the watch diff's mtime is new and it is not a dismissed badge, `batchTouchesOffers`) (empty if turned off in settings).
 *   A badge past 5 minutes removes itself. Main returns a generous number of candidates (`RECENT_OFFER_FETCH`) and cuts to 12 after removing dismissed and attached ones.
 * - A badge that was dismissed or attached is not shown again for the same file (app-wide memory, `offerKey`). Files currently attached are not shown either.
 * - Attaching uses the same route as Drop and the paperclip (`attachUris`).
 */
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { RecentFile } from '@shared/recent-files.js'
import { useThreads } from '../threadStore.js'
import { attachUris } from '../dropStore.js'
import { useT } from '../i18n/index.js'
import { useLocale } from '../localeStore.js'
import { formatRowTime, rowClockNow, subscribeRowClock } from '../row-time.js'
import {
  batchTouchesOffers,
  nextOfferExpiry,
  offerKey,
  recentBridge,
  recentLocation,
  subscribeFileChanges,
  visibleOffers
} from '../recent-files.js'
import { useStore } from '../store.js'
import { FileIcon } from '../icons/file-icons/FileIcon.js'
import { useThumbnail } from './RecentFiles.js'

/** Dismissed or attached badges (`offerKey`). One per window (switching threads does not bring the same badge back). */
const dismissed = new Set<string>()
const NO_ATTACHMENTS: readonly { readonly uri: string }[] = []
const NO_OFFERS: readonly RecentFile[] = []
/** Throttle before re-asking on a watch diff (same as the popup. Right after a save or capture, a temporary file -> rename makes diffs continue). */
const REFRESH_DEBOUNCE_MS = 500

export function RecentOffers({
  threadId,
  hidden
}: {
  readonly threadId: string
  readonly hidden: boolean
}): React.JSX.Element | null {
  const t = useT()
  const idBase = useId()
  const [offers, setOffers] = useState<readonly RecentFile[]>(NO_OFFERS)
  const [now, setNow] = useState(() => Date.now())
  const [, setDismissedTick] = useState(0)
  const attachments = useThreads((state) => state.attachments[threadId] ?? NO_ATTACHMENTS)

  // TODO 1136 (4): if blur happens during a query, a new query is made, or the badge is detached, the old response is discarded (the promise is that badges show only in the foreground).
  const askSeq = useRef(0)
  const refresh = useCallback(() => {
    const mine = ++askSeq.current
    if (hidden || !document.hasFocus()) {
      setOffers(NO_OFFERS)
      return
    }
    const ask = recentBridge()?.offers
    if (ask === undefined) return
    void ask()
      .then((next) => {
        if (mine !== askSeq.current || !document.hasFocus()) return
        setNow(Date.now())
        setOffers(Array.isArray(next) ? next : NO_OFFERS)
      })
      .catch(() => {
        if (mine === askSeq.current) setOffers(NO_OFFERS)
      })
  }, [hidden])

  useEffect(() => {
    refresh()
    let timer: ReturnType<typeof setTimeout> | undefined
    const onBlur = (): void => {
      askSeq.current += 1
      setOffers(NO_OFFERS)
    }
    window.addEventListener('focus', refresh)
    window.addEventListener('blur', onBlur)
    const unsubscribe = subscribeFileChanges((batch) => {
      // Do not re-ask unless there is a create/update newer than the badge window (5 minutes), so every AI edit does not run an index scan + git status.
      if (!batchTouchesOffers(batch, Date.now(), dismissed)) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(refresh, REFRESH_DEBOUNCE_MS)
    })
    return () => {
      askSeq.current += 1
      if (timer !== undefined) clearTimeout(timer)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('blur', onBlur)
      unsubscribe()
    }
  }, [refresh])

  const shown = visibleOffers(
    offers,
    now,
    dismissed,
    attachments.map((attachment) => attachment.uri)
  )
  // Redraw at the time the earliest of the currently shown badges passes 5 minutes (expired ones are dropped by `visibleOffers`).
  const expiry = nextOfferExpiry(shown)
  useEffect(() => {
    if (expiry === null) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expiry - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [expiry])

  if (hidden || shown.length === 0) return null

  const forget = (file: RecentFile): void => {
    dismissed.add(offerKey(file))
    setDismissedTick((n) => n + 1)
  }
  const attach = (file: RecentFile): void => {
    forget(file)
    void attachUris(threadId, [file.uri])
  }
  const single = shown.length === 1
  // The container's name points to the visible heading (also putting the same text in aria-label would be read twice). A grid containing buttons does not get role="status".
  const headingId = `${idBase}-heading`
  // TODO 1197 / 1198: four or more become a grid wrapping sideways (small pictures, up to 2 rows, then scroll).
  const grid = shown.length > 3
  return (
    <div
      className={`composer-recent-offers${single ? ' single' : ''}${grid ? ' grid' : ''}`}
      role="group"
      aria-labelledby={headingId}
      data-count={shown.length}
    >
      <div className="recent-offers-heading" id={headingId}>{t('recent.offer.heading')}</div>
      <div className="recent-offers-list">
        {shown.map((file) => (
          <RecentOfferCard key={file.uri} file={file} single={single} onAttach={attach} onDismiss={forget} />
        ))}
      </div>
    </div>
  )
}

function RecentOfferCard({
  file,
  single,
  onAttach,
  onDismiss
}: {
  readonly file: RecentFile
  readonly single: boolean
  readonly onAttach: (file: RecentFile) => void
  readonly onDismiss: (file: RecentFile) => void
}): React.JSX.Element {
  const t = useT()
  const locale = useLocale((state) => state.resolved)
  const clock = useSyncExternalStore(subscribeRowClock, rowClockNow)
  const homeUri = useStore((state) => state.appInfo?.homeUri ?? '')
  const thumbnail = useThumbnail(file)
  const location = recentLocation(file, homeUri)
  return (
    <div className={`recent-offer${single ? ' single' : ''}`}>
      <button
        type="button"
        className="recent-offer-pick"
        title={`${t('recent.offer.attachHint')}\n${location}/${file.name}`}
        onClick={() => onAttach(file)}
      >
        <span className="recent-offer-thumb">
          {thumbnail !== null ? (
            <img src={thumbnail} alt="" draggable={false} />
          ) : (
            <FileIcon name={file.name} isDirectory={false} />
          )}
          {file.ai ? <span className="recent-tile-ai">{t('recent.ai')}</span> : null}
        </span>
        <span className="recent-offer-text">
          {single ? <span className="recent-offer-label">{t('recent.offer.label')}</span> : null}
          <span className="recent-offer-name">{file.name}</span>
          {single ? (
            <span className="recent-offer-meta">
              {location} · {formatRowTime(file.mtimeMs, clock, locale, t)}
            </span>
          ) : null}
        </span>
      </button>
      {single ? (
        <button type="button" className="recent-offer-attach" onClick={() => onAttach(file)}>
          {t('recent.offer.attach')}
        </button>
      ) : null}
      <button
        type="button"
        className="recent-offer-dismiss"
        onClick={() => onDismiss(file)}
        aria-label={t('recent.offer.dismiss')}
        title={t('recent.offer.dismiss')}
      >
        ×
      </button>
    </div>
  )
}
