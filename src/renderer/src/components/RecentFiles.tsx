/**
 * "Recent files" (TODO 999, ARCHITECTURE.md 4.5.12). The "Recent" button (an icon of overlapping badges) next to the Composer's paperclip, and the popup
 * it opens (a grid of thumbnails, last 7 days, at most 200 items, newest first, filterable by kind). Only one component is placed in Composer.tsx,
 * so it does not touch the same place as a parallel bundle (the Composer's send button).
 *
 * - Choosing attaches through the same route as Drop and the paperclip (`attachUris` -> `threads.resolveAttachment`): an image is attached to the body,
 *   anything else becomes an `@<path>` reference (main's `composeText`). No new route is added (owner decision). With Cmd held, the popup stays open.
 * - While open it subscribes to watch diffs (`fs.onFileChanges`) and reloads when a file that could appear in "Recent" changes
 *   (the new one comes first). The filters (git / bulk update / AI) are re-applied by main every time.
 * - Images, videos and PDFs use main's QuickLook thumbnail; others show the file icon, name, location and time. In TODO 1172 the tile became
 *   twice that of 999 (200 px wide, 144 px tall picture; main also generates at 384 px).
 * - The popup is portaled to `document.body` with `position: fixed` (so it is not clipped by `.composer-frame`'s `overflow: hidden`).
 *   It closes on Esc or an outside click. Colors are CSS variables only (7.4.1).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { RECENT_KINDS, hasRecentThumbnail, type RecentFile, type RecentKind } from '@shared/recent-files.js'
import { attachUris } from '../dropStore.js'
import { useT } from '../i18n/index.js'
import { useLocale } from '../localeStore.js'
import { formatRowTime, rowClockNow, subscribeRowClock } from '../row-time.js'
import { batchTouchesRecent, recentLocation } from '../recent-files.js'
import { useStore } from '../store.js'
import { ComposerRecentIcon } from '../icons/ComposerRecentIcon.js'
import { FileIcon } from '../icons/file-icons/FileIcon.js'
import { Tooltip } from './Tooltip.js'

/** Throttle for reloading when diffs keep coming. */
const REFRESH_DEBOUNCE_MS = 500
/** TODO 1172: tiles are twice the size of 999 (192 px), so the width fits three columns. */
const POPUP_WIDTH = 640
const MARGIN = 8

type KindFilter = RecentKind | 'all'

const KIND_LABELS: Readonly<Record<KindFilter, 'recent.kind.all' | `recent.kind.${RecentKind}`>> = {
  all: 'recent.kind.all',
  image: 'recent.kind.image',
  video: 'recent.kind.video',
  document: 'recent.kind.document',
  code: 'recent.kind.code'
}

export function RecentFilesButton({ threadId }: { readonly threadId: string }): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)
  const close = useCallback(() => setOpen(false), [])
  return (
    <>
      <Tooltip placement="top" content={t('recent.hint')}>
        <button
          ref={anchor}
          type="button"
          className={`composer-attach${open ? ' active' : ''}`}
          onClick={() => setOpen((value) => !value)}
          aria-label={t('recent.open')}
          aria-expanded={open}
          aria-haspopup="dialog"
        >
          <ComposerRecentIcon />
        </button>
      </Tooltip>
      {open ? <RecentFilesPopup threadId={threadId} anchor={anchor.current} onClose={close} /> : null}
    </>
  )
}

function RecentFilesPopup({
  threadId,
  anchor,
  onClose
}: {
  readonly threadId: string
  readonly anchor: HTMLElement | null
  readonly onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const [filter, setFilter] = useState<KindFilter>('all')
  const [files, setFiles] = useState<readonly RecentFile[] | null>(null)
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null)
  const popup = useRef<HTMLDivElement | null>(null)
  const request = useRef(0)

  const load = useCallback(() => {
    request.current += 1
    const mine = request.current
    void window.aios.recent
      .list(filter === 'all' ? {} : { kinds: [filter] })
      .then((next) => {
        if (mine === request.current) setFiles(next)
      })
      .catch(() => {
        if (mine === request.current) setFiles([])
      })
  }, [filter])

  useEffect(() => {
    setFiles(null)
    load()
  }, [load])

  // Subscribe to watch diffs only while open (the same entry point as the file list's diff delivery in 75/79).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = window.aios.fs.onFileChanges((batch) => {
      if (!batchTouchesRecent(batch)) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(load, REFRESH_DEBOUNCE_MS)
    })
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
    }
  }, [load])

  useLayoutEffect(() => {
    if (anchor === null) return
    const rect = anchor.getBoundingClientRect()
    const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - POPUP_WIDTH - MARGIN))
    setPosition({ left, bottom: window.innerHeight - rect.top + 6 })
  }, [anchor])

  // Close on Esc or an outside click (grab it first in the capture phase, as ContextMenu does). A click on the button itself is left to the button's open/close.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (popup.current?.contains(target) === true || anchor?.contains(target) === true) return
      onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [anchor, onClose])

  const pick = (file: RecentFile, keepOpen: boolean): void => {
    void attachUris(threadId, [file.uri])
    if (!keepOpen) onClose()
  }

  return createPortal(
    <div
      ref={popup}
      className="recent-files"
      role="dialog"
      aria-label={t('recent.title')}
      style={
        position === null
          ? { visibility: 'hidden', width: POPUP_WIDTH }
          : { left: position.left, bottom: position.bottom, width: POPUP_WIDTH }
      }
    >
      <div className="recent-files-head">
        <span className="recent-files-title">{t('recent.title')}</span>
        <div className="recent-files-filter" role="group" aria-label={t('recent.filter')}>
          {(['all', ...RECENT_KINDS] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className={filter === kind ? 'active' : undefined}
              aria-pressed={filter === kind}
              onClick={() => setFilter(kind)}
            >
              {t(KIND_LABELS[kind])}
            </button>
          ))}
        </div>
      </div>
      {files === null ? (
        <div className="recent-files-empty">{t('common.loading')}</div>
      ) : files.length === 0 ? (
        <div className="recent-files-empty">{t('recent.empty')}</div>
      ) : (
        <div className="recent-files-grid">
          {files.map((file) => (
            <RecentTile key={file.uri} file={file} onPick={pick} />
          ))}
        </div>
      )}
      <div className="recent-files-foot">{t('recent.foot')}</div>
    </div>,
    document.body
  )
}

function RecentTile({
  file,
  onPick
}: {
  readonly file: RecentFile
  readonly onPick: (file: RecentFile, keepOpen: boolean) => void
}): React.JSX.Element {
  const t = useT()
  const locale = useLocale((state) => state.resolved)
  const now = useSyncExternalStore(subscribeRowClock, rowClockNow)
  const homeUri = useStore((state) => state.appInfo?.homeUri ?? '')
  const thumbnail = useThumbnail(file)
  const location = recentLocation(file, homeUri)
  return (
    <button
      type="button"
      className="recent-tile"
      title={`${location}/${file.name}`}
      onClick={(event) => onPick(file, event.metaKey || event.ctrlKey)}
    >
      <span className="recent-tile-thumb">
        {thumbnail !== null ? (
          <img src={thumbnail} alt="" draggable={false} />
        ) : (
          <FileIcon name={file.name} isDirectory={false} />
        )}
        {file.ai ? <span className="recent-tile-ai">{t('recent.ai')}</span> : null}
      </span>
      <span className="recent-tile-name">{file.name}</span>
      <span className="recent-tile-meta">{location}</span>
      <span className="recent-tile-meta">{formatRowTime(file.mtimeMs, now, locale, t)}</span>
    </button>
  )
}

/** Thumbnail of an image, video or PDF (main remembers it by path + mtime). null if it cannot be obtained (the icon stays). */
export function useThumbnail(file: Pick<RecentFile, 'uri' | 'ext' | 'mtimeMs'>): string | null {
  const [image, setImage] = useState<string | null>(null)
  useEffect(() => {
    setImage(null)
    if (!hasRecentThumbnail(file.ext)) return
    let alive = true
    void window.aios.recent
      .thumbnail(file.uri)
      .then((next) => {
        if (alive) setImage(next)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [file.uri, file.ext, file.mtimeMs])
  return image
}
