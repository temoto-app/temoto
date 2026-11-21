/**
 * Continue in aios a conversation started in the terminal / VS Code (the backend's transcript) (item 111,
 * ARCHITECTURE.md 4.5.9). There are two entry points, and both use the components here:
 *
 * - The list in the create dialog (`TranscriptList`): most recent first. Selecting a row opens `TranscriptChoice` below
 *   (a "Continue" at the right end of the hovered row - TODO 462).
 *   If the selected folder has conversations, the latest 5 of that folder (`cwdUri` + `limit`, item 122); the list of all folders
 *   is behind the expand / collapse toggle (items 111 / 153).
 * - "Continue this conversation" on a transcript hit of the conversation search (`TranscriptContinueDialog`): fetches the conversation from main with
 *   `transcriptSession(uri)` and shows the same `TranscriptChoice` in a small window.
 *
 * `TranscriptChoice` offers two ways to continue: **continue with the same session id** (same as the stock CLI's `--resume`;
 * the continuation of the transcript is appended to the same file) and **continue as a branch** (`--fork-session`, a different
 * session id; the original transcript is untouched). If the transcript's last update is within `RECENT_MS`, it says "it may be
 * open in VS Code / the terminal" (this is the only warning about simultaneous use; owner decision 2026-09-26).
 * A conversation that an aios thread already has (`threadId`) is not continued; that thread is opened instead.
 *
 * **No paths are handled**: the location of the transcript never leaves main. Only `cwdName` and `uri` (opaque).
 */
import { useEffect, useState } from 'react'
import type { CreateThreadInput, TranscriptSession } from '@shared/thread.js'
import { useThreads } from '../threadStore.js'
import { describeReason, useT, type Translate } from '../i18n/index.js'
import { formatWhen } from '../thread/timeline.js'
import { sessionsInFolder, visibleSessions } from '../transcript-folder.js'

/** If the transcript's last update is within this, show "it may be open elsewhere". */
export const RECENT_MS = 5 * 60_000

/** Heading of one list row: the backend's title, else the first message, else "(untitled)". */
export function transcriptLabel(t: Translate, session: TranscriptSession): string {
  const title = session.title ?? session.firstPrompt
  return title.trim() === '' ? t('transcript.untitled') : title
}

/** Whether it was written recently (the condition for the simultaneous-use warning). Pure function (takes `now` for tests). */
export function isRecent(session: Pick<TranscriptSession, 'mtimeMs'>, now = Date.now()): boolean {
  return now - session.mtimeMs < RECENT_MS
}

/**
 * Creation-time values other than cwd (the dialog's backend. Strict mode was removed from the dialog in item 150, so it is
 * not passed = OFF). Omitted from search (settings defaults).
 * The model is decided by main from the transcript's last response and thinking from the settings default (owner decision of item 121), so
 * neither can be passed here.
 */
export type TranscriptChoiceInput = Omit<
  CreateThreadInput,
  'cwdUri' | 'scratch' | 'transcript' | 'modelId' | 'thinking'
>

export function TranscriptChoice({
  session,
  input,
  onDone
}: {
  readonly session: TranscriptSession
  readonly input?: TranscriptChoiceInput
  /** Called after creating (or opening). A failure is not shown here; it goes to `threadStore.error`. */
  readonly onDone: () => void
}): React.JSX.Element {
  const t = useT()
  const createThread = useThreads((state) => state.createThread)
  const selectThread = useThreads((state) => state.selectThread)
  const [busy, setBusy] = useState(false)

  const go = async (fork: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    const ok = await createThread({ ...(input ?? {}), transcript: { sessionId: session.sessionId, fork } })
    setBusy(false)
    if (ok) onDone()
  }

  if (session.threadId !== null) {
    return (
      <div className="transcript-choice">
        <p className="hint">{t('transcript.alreadyThread')}</p>
        <button
          type="button"
          className="primary"
          onClick={() => {
            void selectThread(session.threadId!)
            onDone()
          }}
        >
          {t('transcript.openThread')}
        </button>
      </div>
    )
  }
  if (!session.usable) {
    return (
      <div className="transcript-choice">
        <p className="denied">{t('transcript.unusable', { reason: describeReason(t, session.reason) })}</p>
      </div>
    )
  }
  return (
    <div className="transcript-choice">
      {isRecent(session) ? <p className="transcript-warning">{t('transcript.recentWarning')}</p> : null}
      <p className="hint">{t('transcript.choiceHint')}</p>
      <div className="transcript-choice-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void go(false)}>
          {isRecent(session) ? t('transcript.continueAnyway') : t('transcript.continue')}
        </button>
        <button type="button" disabled={busy} onClick={() => void go(true)}>
          {t('transcript.fork')}
        </button>
      </div>
    </div>
  )
}

/** The result of `threads.transcriptSessions()`. null = not arrived yet. */
export interface TranscriptSessionsState {
  readonly sessions: readonly TranscriptSession[] | null
  readonly failed: string | null
}

/**
 * Fetch the transcript list (all folders). Fetched only once, the first time `enabled` becomes true, and kept afterwards
 * (it reads the head and tail of hundreds of transcripts, so just opening the dialog does not fetch it; item 111).
 */
export function useTranscriptSessions(enabled: boolean): TranscriptSessionsState {
  const [state, setState] = useState<TranscriptSessionsState>({ sessions: null, failed: null })
  const [requested, setRequested] = useState(false)
  useEffect(() => {
    if (enabled && !requested) setRequested(true)
  }, [enabled, requested])
  useEffect(() => {
    if (!requested) return
    let cancelled = false
    window.aios.threads
      .transcriptSessions()
      .then((list) => {
        if (!cancelled) setState({ sessions: list, failed: null })
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ sessions: null, failed: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [requested])
  return state
}

/**
 * The `cwdMatchKey` of the selected folder (item 239). If `cwdUri` is null (unassigned), nothing is asked.
 * Calls main's `threads.folderMatchKey` once each time the folder is switched. Null before it arrives, and for a folder
 * that does not pass the choke point (= `TranscriptList` shows no conversations of that folder).
 */
export function useFolderMatchKey(cwdUri: string | null): string | null {
  const [state, setState] = useState<{ uri: string | null; key: string | null }>({
    uri: null,
    key: null
  })
  useEffect(() => {
    if (cwdUri === null) {
      setState({ uri: null, key: null })
      return
    }
    let cancelled = false
    window.aios.threads.folderMatchKey(cwdUri).then(
      (key) => {
        if (!cancelled) setState({ uri: cwdUri, key })
      },
      () => {
        if (!cancelled) setState({ uri: cwdUri, key: null })
      }
    )
    return () => {
      cancelled = true
    }
  }, [cwdUri])
  // Right after switching, do not present the previous folder's answer as this folder's key.
  return state.uri === cwdUri ? state.key : null
}

/**
 * The list of CLI conversations in the create dialog (items 111 / 122). Selecting a row opens `TranscriptChoice` below.
 * Conversations an aios thread already has are removed from the list by main.
 *
 * - If `source` is passed, that list is used (what the dialog fetched once); otherwise it fetches its own.
 * - If `matchKey` is passed, only that folder's conversations (matching `cwdMatchKey`, newest first; items 122 / 239).
 *   The caller passes the value it fetched once with `threads.folderMatchKey(cwdUri)`.
 * - If `limit` is passed, only that many from the top are shown and the rest expand with "Show more".
 * - `group` is the radio button `name`. Used to tell them apart when two are placed in the same dialog.
 */
export function TranscriptList({
  input,
  onDone,
  source,
  matchKey,
  limit,
  group = 'transcript'
}: {
  readonly input: TranscriptChoiceInput
  readonly onDone: () => void
  readonly source?: TranscriptSessionsState
  readonly matchKey?: string | null
  readonly limit?: number
  readonly group?: string
}): React.JSX.Element {
  const t = useT()
  const own = useTranscriptSessions(source === undefined)
  const { sessions: all, failed } = source ?? own
  const [selected, setSelected] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  if (failed !== null) return <p className="denied">{describeReason(t, failed)}</p>
  if (all === null) return <p className="hint">{t('common.loading')}</p>
  const sessions = matchKey === undefined ? all : sessionsInFolder(all, matchKey)
  if (sessions.length === 0) return <p className="hint">{t('transcript.none')}</p>
  const { shown, hidden } =
    limit === undefined ? { shown: sessions, hidden: 0 } : visibleSessions(sessions, expanded, limit)
  return (
    <div className="transcript-list">
      {shown.map((session) => (
        <div key={session.sessionId} className="transcript-entry">
          <label
            className={`cwd-row transcript-row${session.usable ? '' : ' unusable'}${
              session.sessionId === selected ? ' selected' : ''
            }`}
            title={session.firstPrompt}
          >
            <input
              type="radio"
              name={group}
              checked={session.sessionId === selected}
              onChange={() => setSelected(session.sessionId)}
            />
            <span className="cwd-name transcript-title">{transcriptLabel(t, session)}</span>
            {/* In a list filtered by folder, the folder name is the same on every row, so it is not shown. */}
            {matchKey === undefined && session.cwdName !== '' ? (
              <span className="cwd-parent">{session.cwdName}</span>
            ) : null}
            <span className="cwd-count">{formatWhen(session.mtimeMs, t)}</span>
            {!session.usable ? (
              <span className="cwd-reason">{describeReason(t, session.reason)}</span>
            ) : session.sessionId !== selected ? (
              // TODO 462: pressing a row continues. "Continue" appears at the right end of the hovered row (the hover action of a VS Code list).
              <span className="transcript-row-continue" aria-hidden="true">
                {t('newThread.transcript.rowContinue')}
              </span>
            ) : null}
          </label>
          {session.sessionId === selected ? (
            <TranscriptChoice session={session} input={input} onDone={onDone} />
          ) : null}
        </div>
      ))}
      {hidden > 0 ? (
        <button type="button" className="link-button transcript-more" onClick={() => setExpanded(true)}>
          {t('newThread.transcript.more', { count: hidden })}
        </button>
      ) : null}
    </div>
  )
}

/**
 * From a transcript hit of the conversation search (item 111). Fetches the conversation from main by `uri` and shows
 * `TranscriptChoice` in a small window. Created with the settings defaults (model, thinking, strict mode OFF).
 */
export function TranscriptContinueDialog({
  uri,
  onClose
}: {
  readonly uri: string
  readonly onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const [session, setSession] = useState<TranscriptSession | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    window.aios.threads
      .transcriptSession(uri)
      .then((found) => {
        if (!cancelled) setSession(found)
      })
      .catch(() => {
        if (!cancelled) setSession(null)
      })
    return () => {
      cancelled = true
    }
  }, [uri])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // TODO 1141: Esc during composition cancels the composition. It does not close.
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings transcript-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <span>{session === undefined || session === null ? t('transcript.continueTitle') : transcriptLabel(t, session)}</span>
          <button type="button" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
        <section>
          {session === undefined ? (
            <p className="hint">{t('common.loading')}</p>
          ) : session === null ? (
            <p className="denied">{describeReason(t, 'transcript-not-found')}</p>
          ) : (
            <>
              {session.cwdName !== '' ? <p className="hint">{t('transcript.inFolder', { folder: session.cwdName })}</p> : null}
              <TranscriptChoice session={session} onDone={onClose} />
            </>
          )}
        </section>
      </div>
    </div>
  )
}
