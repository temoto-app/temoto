/**
 * The last line of the timeline of a thread whose answer stopped midway (TODO 521, wave 26 bundle B). Right under the end line of the stopped turn
 * (466's `timeline-note result` / the error line) it shows "The answer stopped midway (reason) [Resume]". Pressing sends the fixed text (`resumePrompt`)
 * as an ordinary send (`threads.send`), continuing the same session (main hands it to `--resume` or to the still-running process). If a response is in progress,
 * main queues it as a reservation (item 94). **No dialog is shown** (167). The Composer's draft and attachments are left alone (same as Compact, TODO 495).
 *
 * The mark (`Thread.interrupted`) does not disappear immediately after sending: main clears it when the next turn starts normally (body text has arrived).
 * So after pressing, the whole row is hidden while it runs (`showsResume` is false).
 *
 * **TODO 628**: when the reason is the usage limit (`interrupt-limit`) and the release time (`resetsAt`, the usage badge, 317) is
 * known, a "Resume after release (HH:MM)" button is also shown. Pressing it queues the fixed text for release + 5 minutes (fixed) using the
 * "once only" mechanism of 629 (internal to main; not shown in the list). It is never reserved automatically
 * (owner decision): if not pressed, nothing happens until the user presses [Resume] by hand as usual.
 */
import { useState } from 'react'
import type { InterruptReason } from '@shared/thread.js'
import { formatTimeOfDay } from '@shared/schedule.js'
import { useT } from '../i18n/index.js'
import { useThreads } from '../threadStore.js'
import { useUsage } from '../usageStore.js'
import { useSchedule } from '../scheduleStore.js'
import { interruptReasonLabel, limitResetsAtSec, resumePrompt } from '../thread/resume.js'

/** Fixed margin after the release (owner decision 2026-10-10). */
const RESUME_RESERVATION_DELAY_MS = 5 * 60_000

function timeLabel(atMs: number): string {
  const date = new Date(atMs)
  return formatTimeOfDay(date.getHours(), date.getMinutes())
}

export function ResumeBar({
  threadId,
  reason
}: {
  threadId: string
  reason: InterruptReason
}): React.JSX.Element {
  const t = useT()
  const [sending, setSending] = useState(false)
  const [reserving, setReserving] = useState(false)
  const snapshot = useUsage((state) => state.snapshot)
  const reservation = useSchedule(
    (state) => state.overview?.resumeReservations.find((r) => r.threadId === threadId) ?? null
  )

  const resume = async (): Promise<void> => {
    if (sending) return
    setSending(true)
    useThreads.getState().markSendScroll(threadId)
    try {
      await window.aios.threads.send(threadId, { text: resumePrompt(reason, t) })
    } catch (err) {
      useThreads.setState({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      setSending(false)
    }
  }

  // The `resetsAt` of the limit line itself has not been captured yet (TODO 532), so we use the release time of the window that is used up among the
  // usage badge's windows (the later one if unknown) (`limitResetsAtSec`). If there is none, no button is shown (owner decision).
  const resetsAtSec = reason === 'interrupt-limit' ? limitResetsAtSec(snapshot) : null
  const reserveAt = resetsAtSec === null ? null : resetsAtSec * 1000 + RESUME_RESERVATION_DELAY_MS

  const reserve = async (): Promise<void> => {
    if (reserveAt === null || reserving) return
    setReserving(true)
    try {
      await window.aios.schedule.reserveResume(threadId, resumePrompt(reason, t), reserveAt)
    } catch (err) {
      useThreads.setState({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      setReserving(false)
    }
  }

  const cancelReservation = async (): Promise<void> => {
    if (reservation === null) return
    try {
      await window.aios.schedule.remove(reservation.id)
    } catch (err) {
      useThreads.setState({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className="timeline-note resume" role="status">
      <span className="resume-note">
        {t('thread.resume.note', { reason: interruptReasonLabel(reason, t) })}
      </span>
      <button
        type="button"
        className="resume-button"
        title={t('thread.resume.title')}
        disabled={sending}
        onClick={() => void resume()}
      >
        {t('thread.resume.button')}
      </button>
      {reservation !== null ? (
        <span className="resume-reservation">
          {t('thread.resume.reservedAt', { time: timeLabel(reservation.at) })}
          <button
            type="button"
            className="resume-cancel-button"
            onClick={() => void cancelReservation()}
          >
            {t('thread.resume.cancelReservation')}
          </button>
        </span>
      ) : reserveAt !== null ? (
        <button
          type="button"
          className="resume-reserve-button"
          disabled={reserving}
          onClick={() => void reserve()}
        >
          {t('thread.resume.reserve', { time: timeLabel(reserveAt) })}
        </button>
      ) : null}
    </div>
  )
}
