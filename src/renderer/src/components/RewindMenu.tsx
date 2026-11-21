/**
 * "Rewind to here" (item 113, ARCHITECTURE.md 4.5.6) and the banner of a branched thread.
 *
 * - One small button on a user message row (visible on hover). Pressing it shows choices under the row:
 *   "branch conversation only" / "conversation and files". The latter waits for main's preview (`rewindPreview`), shows
 *   "what will be restored", and runs on consent. In both cases **the original thread is untouched** and a new branched
 *   thread is opened (owner decision 2026-09-27).
 * - Not shown while responding, starting, or awaiting approval (main also refuses with `rewind-busy`; the final decision is main's).
 * - A branched thread can jump to the original message from the banner under its heading. Past history is not copied (4.5.6).
 *
 * Kept in a separate file from ThreadPane.tsx (parallel bundles touch the same file).
 */
import { useEffect, useState } from 'react'
import type { ForkOrigin, RewindPreview } from '@shared/thread.js'
import { TRANSCRIPT_EVENT_ID_PREFIX } from '@shared/thread.js'
import { useThreads } from '../threadStore.js'
import { describeReason, useT } from '../i18n/index.js'
import { threadTitleLabel } from '../thread/title.js'

/** States that can be rewound. Not shown while responding (`running` / `starting` / `stopping`) or awaiting approval. */
const REWINDABLE_STATES: ReadonlySet<string> = new Set(['idle', 'error'])

type Phase =
  | { readonly kind: 'closed' }
  | { readonly kind: 'choose' }
  | { readonly kind: 'previewing' }
  | { readonly kind: 'preview'; readonly preview: RewindPreview }
  | { readonly kind: 'working' }
  | { readonly kind: 'failed'; readonly message: string }

/** The tail of a `file://` URI (the file name and the parent directory name). The path is for display only. */
function tailOf(uri: string): string {
  const segments = uri.replace(/\/+$/, '').split('/')
  const name = decodeURIComponent(segments[segments.length - 1] ?? '')
  const parent = decodeURIComponent(segments[segments.length - 2] ?? '')
  return parent === '' ? name : `${parent}/${name}`
}

export function RewindMenu({ eventId }: { eventId: string }): React.JSX.Element | null {
  const t = useT()
  const threadId = useThreads((state) => state.activeThreadId)
  const thread = useThreads((state) =>
    threadId === null ? undefined : state.threadsById[threadId]?.thread
  )
  const runtimeState = useThreads((state) =>
    threadId === null ? undefined : state.threadsById[threadId]?.runtime.state
  )
  const backends = useThreads((state) => state.backends)
  const rewind = useThreads((state) => state.rewind)
  const [phase, setPhase] = useState<Phase>({ kind: 'closed' })

  // Close when the thread is switched (a row id has no meaning in another thread).
  useEffect(() => {
    setPhase({ kind: 'closed' })
  }, [threadId, eventId])

  if (threadId === null || thread === undefined || runtimeState === undefined) return null
  // Past history read from a transcript (item 111) is not a `thread_events` row, so it cannot be a rewind origin.
  if (eventId.startsWith(TRANSCRIPT_EVENT_ID_PREFIX)) return null
  const supported =
    backends === null ? true : (backends.find((b) => b.id === thread.backend)?.rewind ?? true)
  const rewindable = REWINDABLE_STATES.has(runtimeState)
  // TODO 987: for a backend that cannot rewind, do not hide the button; show a gray one that gives the reason.
  if (!supported) {
    return (
      <button
        type="button"
        className="rewind-button unsupported"
        title={t('rewind.unsupported')}
        aria-label={t('rewind.unsupported')}
        disabled
      >
        ⟲
      </button>
    )
  }

  const previewFiles = (): void => {
    setPhase({ kind: 'previewing' })
    void window.aios.threads
      .rewindPreview(threadId, eventId)
      .then((preview) => setPhase({ kind: 'preview', preview }))
      .catch((err: unknown) => setPhase({ kind: 'failed', message: describeReason(t, messageOf(err)) }))
  }

  const run = (files: boolean): void => {
    setPhase({ kind: 'working' })
    void rewind(threadId, eventId, files).then((ok) => {
      if (!ok) setPhase({ kind: 'failed', message: useThreads.getState().error ?? '' })
    })
  }

  if (phase.kind === 'closed') {
    return rewindable ? (
      <button
        type="button"
        className="rewind-button"
        title={t('rewind.button')}
        aria-label={t('rewind.button')}
        onClick={() => setPhase({ kind: 'choose' })}
      >
        ⟲
      </button>
    ) : null
  }

  return (
    <div className="rewind-panel" onClick={(event) => event.stopPropagation()}>
      {phase.kind === 'choose' ? (
        <>
          <span>{t('rewind.prompt')}</span>
          <button type="button" onClick={() => run(false)}>
            {t('rewind.conversation')}
          </button>
          <button type="button" onClick={previewFiles}>
            {t('rewind.conversationAndFiles')}
          </button>
        </>
      ) : null}
      {phase.kind === 'previewing' ? <span>{t('rewind.previewing')}</span> : null}
      {phase.kind === 'preview' ? (
        phase.preview.canRewind ? (
          <>
            <span>
              {t('rewind.previewSummary', {
                count: phase.preview.files.length,
                insertions: phase.preview.insertions,
                deletions: phase.preview.deletions
              })}
            </span>
            {phase.preview.files.length > 0 ? (
              <ul className="rewind-files">
                {phase.preview.files.map((uri) => (
                  <li key={uri} title={uri}>
                    {tailOf(uri)}
                  </li>
                ))}
              </ul>
            ) : null}
            <button type="button" className="danger" onClick={() => run(true)}>
              {t('rewind.confirmFiles')}
            </button>
          </>
        ) : (
          <>
            <span className="rewind-note">
              {t('rewind.filesUnavailable', { reason: describeReason(t, phase.preview.reason) })}
            </span>
            <button type="button" onClick={() => run(false)}>
              {t('rewind.conversation')}
            </button>
          </>
        )
      ) : null}
      {phase.kind === 'working' ? <span>{t('rewind.working')}</span> : null}
      {phase.kind === 'failed' ? <span className="rewind-note">{phase.message}</span> : null}
      {phase.kind !== 'working' ? (
        <button type="button" onClick={() => setPhase({ kind: 'closed' })}>
          {t('common.cancel')}
        </button>
      ) : null}
    </div>
  )
}

/**
 * The banner of a branched thread (item 113). Jumps to the original message. If the original thread is gone, no title.
 * A thread from "lighten and continue in a new conversation" (TODO 961, `origin.handoff`) uses the same banner with only the sentence changed (it jumps to the original's last message).
 */
export function ForkBanner({
  origin,
  backend
}: {
  origin: ForkOrigin
  /** This thread's backend (TODO 1018: if it differs from the original, the sentence says "continued from another agent"). */
  backend?: string
}): React.JSX.Element {
  const t = useT()
  const source = useThreads((state) => state.threadsById[origin.threadId]?.thread)
  const jumpToEvent = useThreads((state) => state.jumpToEvent)
  const backends = useThreads((state) => state.backends)
  const title = source === undefined ? t('rewind.forkedFromMissing') : threadTitleLabel(t, source.title)
  // The name is `BackendChoice.label` (constraint 6). If it is not in the registry, the id is used as it is.
  const labelOf = (id: string): string => backends?.find((choice) => choice.id === id)?.label ?? id
  const switched = origin.handoff === true && source !== undefined && backend !== undefined && source.backend !== backend
  return (
    <div className="thread-banner fork">
      {switched
        ? t('rewind.switchFrom', { title, from: labelOf(source.backend), to: labelOf(backend) })
        : origin.handoff === true
          ? t('rewind.handoffFrom', { title })
          : origin.files
            ? t('rewind.forkedFromWithFiles', { title })
            : t('rewind.forkedFrom', { title })}
      {source !== undefined ? (
        <button
          type="button"
          className="link-button"
          onClick={() => void jumpToEvent(origin.threadId, origin.eventId)}
        >
          {t('rewind.openOrigin')}
        </button>
      ) : null}
    </div>
  )
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    const match = /Error:\s*(.*)$/.exec(err.message)
    return match?.[1]?.trim() ?? err.message
  }
  return String(err)
}
