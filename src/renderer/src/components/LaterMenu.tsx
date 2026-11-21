/**
 * "Send later" (TODO 989, wave 53 bundle C). The small frame opened by the clock button next to the Composer's send button, and
 * the list that shows and cancels the placed reservations (`LaterList`).
 *
 * - The entries are three: "in N hours" (common numbers + free input), "specify a time", and "after the limit is lifted (HH:MM)". "After lifted" cannot
 *   be chosen unless the usage badge's `resetsAt` (+ 5 minutes, same as 628) is known.
 * - Choosing one puts the input's body and attachments into a main reservation and **empties the input**. When the time comes main
 *   sends to the same thread as a normal send (if it is not running, it catches up once at the next launch). **No confirmation dialog is shown** (167).
 *   It is not reserved automatically just because the limit was hit.
 * - Attachments are put in as references, and main re-reads them at send time (`src/main/schedule/later-attachments.ts`). Only pasted
 *   images carry base64. The selection (ViewerPane) and `!` are not put in a reservation (for `!` the menu is disabled).
 */
import { useState } from 'react'
import type { LaterAttachment } from '@shared/schedule.js'
import { CLIPBOARD_ATTACHMENT_PREFIX, type Attachment } from '@shared/thread.js'
import { isShellDraft } from '@shared/shell-input.js'
import { useT } from '../i18n/index.js'
import { useThreads, type MessageSettings } from '../threadStore.js'
import { withThumbnails } from '../attachment-thumbnail.js'
import { useUsage } from '../usageStore.js'
import { useSchedule } from '../scheduleStore.js'
import { ComposerLaterIcon } from '../icons/ComposerLaterIcon.js'
import {
  LATER_MAX_HOURS,
  laterAfterHours,
  laterAfterLimit,
  laterAtTimeOfDay,
  laterTimeLabel
} from '../thread/later.js'
import { MenuPopover } from './MenuPopover.js'
import { Tooltip } from './Tooltip.js'

const PRESET_HOURS: readonly number[] = [1, 2, 3, 5]
const NO_ATTACHMENTS: readonly Attachment[] = []

/** Turns send-ready attachments into the form put in a reservation (the reduced version is dropped, and only pasted images keep base64). */
export function toLaterAttachments(attachments: readonly Attachment[]): LaterAttachment[] {
  return attachments.map((a) => ({
    uri: a.uri,
    name: a.name,
    kind: a.kind,
    mediaType: a.mediaType,
    bytes: a.bytes,
    ...(a.kind === 'image' && a.uri.startsWith(CLIPBOARD_ATTACHMENT_PREFIX) && a.base64 !== undefined
      ? { base64: a.base64 }
      : {}),
    // TODO 550: as with a normal send, attach the reduced version shown in the timeline after sending (the one `withThumbnails` added).
    ...(a.thumbnail === undefined ? {} : { thumbnail: a.thumbnail })
  }))
}

/** Puts the input's body and attachments into a reservation at `at`, and empties the field on success. */
async function reserveFromComposer(
  threadId: string,
  at: number,
  settings: MessageSettings | undefined
): Promise<void> {
  const state = useThreads.getState()
  const text = state.drafts[threadId] ?? ''
  const attachments = state.attachments[threadId] ?? NO_ATTACHMENTS
  if (text.trim() === '' && attachments.length === 0) return
  try {
    // As with a normal send (`threadStore.send`), carry the per-message model / thinking and the reduced versions.
    const withThumbs = await withThumbnails(attachments)
    await window.aios.schedule.reserveLater(threadId, {
      text,
      attachments: toLaterAttachments(withThumbs),
      at,
      ...(settings ?? {})
    })
  } catch (err) {
    useThreads.setState({ error: err instanceof Error ? err.message : String(err) })
    return
  }
  // Do not erase what was typed in while it was being queued (empty it only if it equals the body that was queued).
  useThreads.setState((s) => ({
    drafts: (s.drafts[threadId] ?? '') === text ? { ...s.drafts, [threadId]: '' } : s.drafts,
    attachments: {
      ...s.attachments,
      [threadId]: (s.attachments[threadId] ?? []).filter((a) => !attachments.some((b) => b.uri === a.uri))
    }
  }))
}

export function LaterMenu({
  threadId,
  settings
}: {
  threadId: string
  /** The model / thinking change chosen in the Composer (the same as the send button's `overrides`). */
  settings?: MessageSettings
}): React.JSX.Element {
  const t = useT()
  const draft = useThreads((state) => state.drafts[threadId] ?? '')
  const attachments = useThreads((state) => state.attachments[threadId] ?? NO_ATTACHMENTS)
  const snapshot = useUsage((state) => state.snapshot)
  const [hours, setHours] = useState('')
  const [clock, setClock] = useState('')
  const empty = draft.trim() === '' && attachments.length === 0
  const disabled = empty || isShellDraft(draft)
  const limitAt = laterAfterLimit(snapshot)
  const now = Date.now()

  const reserve = (close: () => void, at: number | null): void => {
    if (at === null) return
    close()
    void reserveFromComposer(threadId, at, settings)
  }

  return (
    <MenuPopover
      label={t(disabled ? 'composer.later.disabled' : 'composer.later')}
      icon={<ComposerLaterIcon />}
      className="later-menu"
      buttonClassName="composer-later"
      role="dialog"
      align="right"
      above
      disabled={disabled}
    >
      {(close) => (
        <div className="later-panel">
          <div className="later-heading">{t('composer.later.heading')}</div>
          {PRESET_HOURS.map((h) => (
            <button
              key={h}
              type="button"
              className="later-item"
              onClick={() => reserve(close, laterAfterHours(Date.now(), h))}
            >
              {t('composer.later.inHours', { hours: h })}
            </button>
          ))}
          <form
            className="later-custom"
            onSubmit={(event) => {
              event.preventDefault()
              reserve(close, laterAfterHours(Date.now(), Number(hours)))
            }}
          >
            <input
              type="number"
              min="0.5"
              max={LATER_MAX_HOURS}
              step="0.5"
              value={hours}
              placeholder={t('composer.later.hoursPlaceholder')}
              aria-label={t('composer.later.hoursLabel')}
              onChange={(event) => setHours(event.target.value)}
            />
            <button type="submit" className="later-item" disabled={hours === '' || laterAfterHours(now, Number(hours)) === null}>
              {t('composer.later.hoursGo')}
            </button>
          </form>
          <form
            className="later-custom"
            onSubmit={(event) => {
              event.preventDefault()
              reserve(close, laterAtTimeOfDay(Date.now(), clock))
            }}
          >
            <input
              type="time"
              value={clock}
              aria-label={t('composer.later.timeLabel')}
              onChange={(event) => setClock(event.target.value)}
            />
            <button type="submit" className="later-item" disabled={laterAtTimeOfDay(now, clock) === null}>
              {t('composer.later.timeGo')}
            </button>
          </form>
          <Tooltip
            placement="top"
            content={limitAt === null ? t('composer.later.limitUnknown') : t('composer.later.limitHint')}
          >
            <span className="composer-icon-tip" aria-disabled={limitAt === null || undefined}>
              <button
                type="button"
                className="later-item later-limit"
                disabled={limitAt === null}
                onClick={() => reserve(close, limitAt)}
              >
                {limitAt === null
                  ? t('composer.later.afterLimitUnknown')
                  : t('composer.later.afterLimit', { time: laterTimeLabel(limitAt, now) })}
              </button>
            </span>
          </Tooltip>
        </div>
      )}
    </MenuPopover>
  )
}

/** Returns a reservation that could not be sent to the input (the row disappears). The body is added before the current draft, and the attachments are re-added. */
async function restoreToComposer(threadId: string, id: string): Promise<void> {
  try {
    const taken = await window.aios.schedule.takeLater(id)
    if (taken === null) return
    useThreads.setState((s) => {
      const current = s.drafts[threadId] ?? ''
      return {
        drafts: { ...s.drafts, [threadId]: current === '' ? taken.text : `${taken.text}\n${current}` }
      }
    })
    for (const a of taken.attachments) {
      if (a.uri.startsWith(CLIPBOARD_ATTACHMENT_PREFIX)) {
        if (a.kind !== 'image' || a.base64 === undefined) continue
        const restored: Attachment = {
          uri: a.uri,
          name: a.name,
          kind: 'image',
          mediaType: a.mediaType,
          base64: a.base64,
          bytes: a.bytes,
          ...(a.thumbnail === undefined ? {} : { thumbnail: a.thumbnail })
        }
        useThreads.setState((s) => ({
          attachments: { ...s.attachments, [threadId]: [...(s.attachments[threadId] ?? []), restored] }
        }))
      } else {
        // The same check as at send time (exclusion, existence, size). An attachment that fails is dropped, only that one.
        await useThreads.getState().addAttachment(threadId, a.uri)
      }
    }
  } catch (err) {
    useThreads.setState({ error: err instanceof Error ? err.message : String(err) })
  }
}

/** The "send later" reservations of this thread. With a time; cancelled with the x (`schedule.remove`). */
export function LaterList({ threadId }: { threadId: string }): React.JSX.Element | null {
  const t = useT()
  const all = useSchedule((state) => state.overview?.laterSends)
  const items = (all ?? []).filter((item) => item.threadId === threadId)
  if (items.length === 0) return null
  const now = Date.now()
  return (
    <ol className="composer-reservations later-list" aria-label={t('composer.later.list')}>
      {items.map((item) => (
        <li key={item.id} className={item.failed ? 'chip reservation later failed' : 'chip reservation later'}>
          <span className="reservation-kind">
            {item.failed
              ? t('composer.later.failed')
              : t('composer.later.at', { time: laterTimeLabel(item.at, now) })}
          </span>
          <span className="reservation-text">{item.preview}</span>
          {item.attachments > 0 ? (
            <span className="reservation-attachments">
              {t('composer.reservation.attachments', { count: item.attachments })}
            </span>
          ) : null}
          {item.failed ? (
            <>
              <Tooltip placement="top" content={item.error ?? t('composer.later.retry')}>
                <button
                  type="button"
                  className="reservation-action"
                  onClick={() => {
                    void window.aios.schedule.retryLater(item.id).catch((err: unknown) => {
                      useThreads.setState({ error: err instanceof Error ? err.message : String(err) })
                    })
                  }}
                >
                  {t('composer.later.retry')}
                </button>
              </Tooltip>
              <button
                type="button"
                className="reservation-action"
                onClick={() => {
                  void restoreToComposer(threadId, item.id)
                }}
              >
                {t('composer.later.restore')}
              </button>
            </>
          ) : null}
          <Tooltip placement="top" content={t('composer.later.cancel')}>
            <button
              type="button"
              className="reservation-action"
              aria-label={t('composer.later.cancel')}
              onClick={() => {
                void window.aios.schedule.remove(item.id).catch((err: unknown) => {
                  useThreads.setState({ error: err instanceof Error ? err.message : String(err) })
                })
              }}
            >
              ×
            </button>
          </Tooltip>
        </li>
      ))}
    </ol>
  )
}
