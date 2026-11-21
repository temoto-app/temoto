/**
 * The "+ New" dialog (T5 / TODO 2 + 6, ARCHITECTURE.md 4.3.2).
 *
 * **Quick Pick form since TODO 742 (2026-10-12, owner request)**: the history is a one-item-per-row list modeled on VS Code's Quick Pick,
 * with a band at the left edge in the same cwd rainbow color as the Sidebar's Threads (`Thread.rainbow` /
 * item 108). **Pressing a row / Enter creates the thread right away and closes the dialog**:
 * there are no "Cancel" / "+ New" at the lower right (closing is only the x and Esc). A folder chosen with "Open Folder..." and a Drop onto
 * the dotted frame also create right away once chosen (`pick` / `onDrop`). To avoid creating twice, the list cannot be pressed while `busy`.
 *
 * **The entry for continuing from a CLI conversation (transcript) is only the "Conversation" button at the right end of the hovered row**
 * (owner decision 2026-10-12): since pressing a row creates at once, the lost means of just looking or just choosing
 * is filled by this button. Pressing it puts that folder in the selected state (does not create), so the
 * "Continue from this folder's CLI conversations" field below opens (item 122). The conversations of all folders are a collapsible
 * toggle (item 153). The arrow keys can do the same "choose only" (it does not create until Enter).
 *
 * What is chosen: the working directory (**no affiliation (disposable) is the default**: T19, + history + "Open Folder..."),
 * and the backend (not shown if there is only one).
 * **The model and thinking are not chosen here** (item 121): it is created with the defaults from settings, and to change them use the Composer's
 * standing buttons (item 61 / 95). When continuing from a CLI conversation, the model is the transcript's last response and
 * thinking is the settings default, which main uses (so it does not clash with the dialog's values).
 * **Strict mode is not chosen either** (item 150): a new thread is always created OFF, and switching is only in the settings screen's
 * "Approval" section (owner decision 2026-09-27).
 *
 * History (TODO 462): most-used first (main's SQL), counts are not shown, at most 100. The filter field under "no affiliation"
 * narrows by part of the path; on open the field gets focus, the arrow keys move between rows and Enter creates (the practice of `list-keys.ts`).
 * The "remove from history" x and the "Conversation" button appear only on the hovered row. **Only the history field stretches and scrolls**;
 * the heading, "no affiliation", the field, "Open Folder..." with the dotted frame, and the CLI conversation field are fixed (the dialog is nearly
 * the full window height). Each CLI conversation list has its own maximum height and scrolls inside.
 *
 * Look (item 153, closer to VS Code and less text): closing is the x, no description text is shown (the scratch area's description is in the
 * tooltip of the "no affiliation" row, and the note about a folder's project settings is the band of item 123), history shows full paths,
 * and **only** the dotted frame under "Open Folder..." accepts a folder Drop. The button text is English even in Japanese display.
 *
 * - No affiliation makes the cwd a thread-specific scratch area (`~/aios/scratch/<id>`). The renderer does not
 *   know that place and only sends `scratch: true`. The home folder is demoted to one history item.
 * - The model / thinking are made concrete from settings (`SessionSettings.defaultModelId` / `defaultThinking`) with
 *   `resolveModelChoice` / `resolveThinkingChoice` and sent (item 61).
 * - Unavailable features are not shown, and the degradation reasons (`degradations`) are shown small (4.6).
 * - Colors are only CSS variables (7.4.1). `rainbowStyle` / `rainbowVar` (`../rainbow.js`).
 * - **The rainbow color is applied only to rows in the history (`useCount > 0`).** For folders with no thread yet
 *   (just chosen with "Open Folder..." and the home pseudo-row), main does not hand out a number, because
 *   merely closing the dialog would consume a color that is never used (see the comment on `CwdHistoryEntry.rainbow`
 *   and `rainbowIndexFor` in `src/main/session/store.ts`).
 */
import { useEffect, useRef, useState } from 'react'
import type { BackendChoice, CwdHistoryEntry, ThreadCreateOptions } from '@shared/thread.js'
import { useThreads } from '../threadStore.js'
import { useStore } from '../store.js'
import { DATA_NAME } from '@shared/product.js'
import { resolveModelChoice, resolveThinkingChoice } from '../composer-choice.js'
import { describeReason, useT } from '../i18n/index.js'
import { BackendCapabilityList } from './BackendCapabilityList.js'
import { LocalModelAdvice } from './LocalModelAdvice.js'
import { carriesFiles, droppedUris } from '../drop-uris.js'
import { currentFilesDrag, endFilesDrag, filesDragActive } from '../files-drag.js'
import { TranscriptList, useFolderMatchKey, useTranscriptSessions } from './TranscriptContinue.js'
import { FOLDER_TRANSCRIPT_LIMIT, sessionsInFolder, transcriptEntryMode } from '../transcript-folder.js'
import {
  SCRATCH_CHOICE,
  bareCwdEntry,
  cwdKeyStep,
  cwdRows,
  filterCwdRows,
  firstUsableUri
} from '../new-thread-cwd.js'
import { navKey } from '../list-keys.js'
import { FolderNotice } from './FolderNotice.js'
import { CloseIcon } from '../icons/CloseIcon.js'
import { ASCII_INPUT } from '@shared/ascii-input.js'
import { rainbowStyle } from '../rainbow.js'

/**
 * How to handle the places in the dialog that do not accept Drop (outside the dotted frame). It is drawn as a child of the list (ThreadList), so
 * unless stopped the drop slips through to the list's receiver and creates a thread (the lesson of item 98). It calls `preventDefault` and sets
 * `dropEffect = 'none'`, showing with the cursor that dropping does nothing.
 */
function swallowDrag(event: React.DragEvent<HTMLElement>): void {
  event.stopPropagation()
  if (!carriesFiles(Array.from(event.dataTransfer.types)) && !filesDragActive()) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'none'
}

/**
 * The history filter field (TODO 462). Focused when opened. This is the only field component: shared behavior of search fields
 * (such as the English letter input of TODO 463) is added to this component.
 */
function CwdFilter({
  value,
  onChange,
  onKeyDown
}: {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
}): React.JSX.Element {
  const t = useT()
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <input
      ref={ref}
      type="search"
      {...ASCII_INPUT}
      className="new-thread-filter"
      value={value}
      placeholder={t('newThread.cwd.filter')}
      aria-label={t('newThread.cwd.filter')}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
    />
  )
}

export function NewThreadDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const t = useT()
  // TODO 1263: the scratch areas live under `~/<data name>/scratch` (`aios` or `Temoto`).
  const dataName = useStore((state) => state.appInfo?.dataName ?? DATA_NAME)
  const settings = useThreads((state) => state.settings)
  const createThread = useThreads((state) => state.createThread)
  const createThreadFromDrop = useThreads((state) => state.createThreadFromDrop)
  const [options, setOptions] = useState<ThreadCreateOptions | null>(null)
  // The selected cwd: `SCRATCH_CHOICE` or a `file://` URI. The default is no affiliation (disposable) (T19).
  const [cwdUri, setCwdUri] = useState<string>(SCRATCH_CHOICE)
  const [backendId, setBackendId] = useState<string | null>(null)
  // A folder Drop (item 98 (b)). The only receiver is the dotted frame (item 153).
  const [dropping, setDropping] = useState(false)
  const [picked, setPicked] = useState<CwdHistoryEntry | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The list of all folders for "from a CLI conversation" (item 111). Opened with the collapsible toggle (item 153).
  const [fromTranscript, setFromTranscript] = useState(false)
  // The history filter (TODO 462).
  const [query, setQuery] = useState('')
  const historyRef = useRef<HTMLDivElement>(null)

  const load = async (): Promise<void> => {
    const next = await window.aios.threads.createOptions()
    setOptions(next)
    setBackendId((current) => current ?? next.defaultBackend)
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // TODO 1141: an Esc during conversion cancels the conversion. The dialog does not close.
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const backend: BackendChoice | undefined =
    options?.backends.find((b) => b.id === backendId) ?? options?.backends[0]
  const rows = options === null ? [] : cwdRows(options.cwdHistory, options.homeUri, picked)
  const visible = filterCwdRows(rows, query)
  const filtering = query.trim() !== ''
  const scratch = cwdUri === SCRATCH_CHOICE
  // CLI conversations (item 111 / 122). Fetched only once, when a folder is chosen (or the all-folders list is opened), and
  // narrowing by folder is done in the renderer (an exact URI match).
  const transcripts = useTranscriptSessions(!scratch || fromTranscript)
  // Match by real path + folding (item 239). Fetch the chosen folder's key from main once.
  const folderMatchKey = useFolderMatchKey(scratch ? null : cwdUri)
  const inFolder = scratch ? [] : sessionsInFolder(transcripts.sessions ?? [], folderMatchKey)
  const entry = transcriptEntryMode(scratch, inFolder.length)

  // Bring the chosen row into the visible part of the history field (when a row outside the field is chosen by the arrow keys or "Open Folder...").
  useEffect(() => {
    const row = historyRef.current?.querySelector<HTMLElement>('.cwd-row.selected')
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [cwdUri, query, options])

  // When a word is typed, choose the first matching (usable) row (same as Quick Open). If nothing matches, the selection does not move
  // (Enter does nothing, so a typo does not create a scratch thread).
  const changeQuery = (next: string): void => {
    setQuery(next)
    if (next.trim() === '') return
    const first = firstUsableUri(filterCwdRows(rows, next))
    if (first !== null) setCwdUri(first)
  }

  const onFilterKey = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    const key = navKey(event)
    if (key === null) return
    if (key === 'Enter') {
      event.preventDefault()
      if (filtering && firstUsableUri(visible) === null) return
      void submit()
      return
    }
    const next = cwdKeyStep(key, cwdUri, visible)
    if (next === null) return
    event.preventDefault()
    setCwdUri(next)
  }

  /**
   * The currently chosen values other than cwd (shared by a row press, Enter and Drop). The model / thinking are
   * not chosen in the dialog (item 121); the settings defaults are made concrete and sent (item 61's "always a concrete id").
   * Strict mode is not sent (item 150, omitted = OFF).
   */
  const chosen = (current: BackendChoice) => ({
    backend: current.id,
    modelId: current.modelSelect
      ? resolveModelChoice(null, settings?.defaultModelId ?? null, current.models)
      : null,
    thinking: current.thinkingLevel ? resolveThinkingChoice(null, settings?.defaultThinking ?? null) : null
  })

  /**
   * TODO 742: creates right away with the given cwd (`SCRATCH_CHOICE` or a URI) and closes. A row press, Enter and
   * "Open Folder..." all call it with the same value; it does not rely on the `cwdUri` state (right after a click
   * it may not be updated yet, because React's setState is not synchronous).
   */
  const submitWith = async (target: string): Promise<void> => {
    if (busy || backend === undefined) return
    setBusy(true)
    const ok = await createThread({
      // No affiliation sends only `scratch: true` (main decides the cwd). Anything else is the URI.
      ...(target === SCRATCH_CHOICE ? { scratch: true } : { cwdUri: target }),
      ...chosen(backend)
    })
    setBusy(false)
    if (ok) onClose()
  }

  // Enter (in the filter field) creates with the current selection (`cwdUri`).
  const submit = (): Promise<void> => submitWith(cwdUri)

  // TODO 742: a folder chosen with "Open Folder..." is created right away once chosen (without making the user press the lower-right button).
  // The selection state is updated first so it can be chosen even on failure (the dialog stays open).
  const pick = async (): Promise<void> => {
    const result = await window.aios.fs.pickDirectory()
    if (result.uri === null) {
      if (result.reason !== null) setNotice(result.reason)
      return
    }
    setNotice(null)
    // Clear the word so the chosen folder is not hidden by the filter.
    setQuery('')
    setPicked(bareCwdEntry(result.uri, Date.now()))
    setCwdUri(result.uri)
    await submitWith(result.uri)
  }

  // When a folder is dropped on the dotted frame, make that folder the cwd and create right away with the current selection and close
  // (item 98 (b), owner decision 2. It does not merely fill in the cwd field).
  const onDrop = async (event: React.DragEvent<HTMLDivElement>): Promise<void> => {
    // Do not let it reach the receiver of the list below (ThreadList) (so it does not create twice).
    event.stopPropagation()
    if (!carriesFiles(Array.from(event.dataTransfer.types)) && !filesDragActive()) return
    event.preventDefault()
    setDropping(false)
    if (busy || backend === undefined) return
    const uris = droppedUris(event.dataTransfer, window.aios.drop.uriFor, currentFilesDrag())
    // Use it up on this drop (a fix from the code-review, TODO 677; `event.stopPropagation()` keeps it from reaching the window's
    // fallback).
    endFilesDrag()
    if (uris.length === 0) return
    setBusy(true)
    const ok = await createThreadFromDrop(uris, chosen(backend))
    setBusy(false)
    if (ok) onClose()
  }

  return (
    <div
      className="settings-backdrop"
      onClick={onClose}
      onDragEnter={swallowDrag}
      onDragOver={swallowDrag}
      onDragLeave={(event) => event.stopPropagation()}
      onDrop={(event) => {
        event.stopPropagation()
        event.preventDefault()
      }}
    >
      <div className="settings new-thread" onClick={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <span>{t('newThread.title')}</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('common.close')}>
            <CloseIcon />
          </button>
        </div>

        <section className="new-thread-cwd">
          {options === null ? (
            <p className="hint">{t('common.loading')}</p>
          ) : (
            <>
              {/* TODO 742: Quick Pick form. Pressing a row creates that thread right away (there is no lower-right button).
                  While `busy` the list cannot be pressed (so it does not create twice: submitWith guards itself too,
                  but it should also look unpressable). */}
              <CwdFilter value={query} onChange={changeQuery} onKeyDown={onFilterKey} />
              <div
                role="option"
                aria-selected={scratch}
                aria-disabled={busy}
                className={`cwd-row scratch${scratch ? ' selected' : ''}${busy ? ' busy' : ''}`}
                title={t('newThread.cwd.scratchHint', { folder: `${dataName}/scratch` })}
                // TODO 815: make it a "pressable row" like the others so it does not look like a heading (frame, hover, focus; Enter / Space creates).
                tabIndex={busy ? -1 : 0}
                onClick={() => {
                  if (!busy) void submitWith(SCRATCH_CHOICE)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  if (!busy) void submitWith(SCRATCH_CHOICE)
                }}
              >
                <span className="cwd-name">{t('newThread.cwd.scratch')}</span>
                <span className="cwd-note">{t('newThread.cwd.scratchNote')}</span>
              </div>
              {/* Only this field stretches and scrolls (TODO 462). */}
              <div className={`cwd-list new-thread-history${busy ? ' busy' : ''}`} ref={historyRef}>
                {visible.length === 0 ? <p className="hint new-thread-nomatch">{t('newThread.cwd.noMatch')}</p> : null}
                {visible.map(({ entry: row, path }) => (
                  <div
                    key={row.uri}
                    role="option"
                    aria-selected={row.uri === cwdUri}
                    aria-disabled={!row.usable || busy}
                    className={`cwd-row${row.usable ? '' : ' unusable'}${row.uri === cwdUri ? ' selected' : ''}`}
                    title={row.usable ? path : `${path} — ${describeReason(t, row.reason)}`}
                    // TODO 742: the rainbow color is the same `--thread-accent` as the Sidebar's Threads (null for a row not in the history).
                    style={rainbowStyle(row.rainbow)}
                    onClick={() => {
                      if (row.usable && !busy) void submitWith(row.uri)
                    }}
                  >
                    <span className="cwd-name cwd-path">{path}</span>
                    {!row.usable ? <span className="cwd-reason">{describeReason(t, row.reason)}</span> : null}
                    <span className="cwd-row-actions">
                      {/* TODO 742: the only entry for continuing from a CLI conversation is this button shown on hover. Pressing it does not create;
                          it only puts that row in the selected state (the "Continue from this folder's CLI conversations" field below opens). */}
                      {row.usable ? (
                        <button
                          type="button"
                          className="cwd-transcripts"
                          title={t('newThread.transcript.openForFolder')}
                          aria-label={t('newThread.transcript.openForFolder')}
                          onClick={(event) => {
                            event.stopPropagation()
                            setQuery('')
                            setCwdUri(row.uri)
                          }}
                        >
                          {t('newThread.transcript.openForFolder')}
                        </button>
                      ) : null}
                      {/* Only rows in the history can be removed (the home pseudo-row and a just-chosen folder have a count of 0). The x appears only on the hovered row. */}
                      {row.useCount > 0 ? (
                        <button
                          type="button"
                          className="cwd-remove"
                          title={t('cwd.removeFromHistory')}
                          aria-label={t('cwd.removeFromHistory')}
                          onClick={(event) => {
                            event.stopPropagation()
                            event.preventDefault()
                            void window.aios.threads.removeCwdHistory(row.uri).then(load)
                            if (cwdUri === row.uri) setCwdUri(SCRATCH_CHOICE)
                          }}
                        >
                          ×
                        </button>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
              <div className="cwd-list new-thread-open-row">
                <button type="button" className="new-thread-open" disabled={busy} onClick={() => void pick()}>
                  {t('newThread.cwd.pick')}
                </button>
              </div>
              <div
                className={`new-thread-drop${dropping ? ' dropping' : ''}`}
                onDragEnter={(event) => {
                  event.stopPropagation()
                  if (!carriesFiles(Array.from(event.dataTransfer.types)) && !filesDragActive()) return
                  event.preventDefault()
                  setDropping(true)
                }}
                onDragOver={(event) => {
                  event.stopPropagation()
                  if (!carriesFiles(Array.from(event.dataTransfer.types)) && !filesDragActive()) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'copy'
                  setDropping(true)
                }}
                onDragLeave={(event) => {
                  event.stopPropagation()
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                  setDropping(false)
                }}
                onDrop={(event) => void onDrop(event)}
              >
                {t('newThread.dropZone')}
              </div>
              {notice !== null ? <p className="denied">{describeReason(t, notice)}</p> : null}
            </>
          )}
          <FolderNotice cwdUri={scratch ? null : cwdUri} />
        </section>

        {options !== null && options.backends.length > 1 ? (
          <section>
            <h3>{t('newThread.backend')}</h3>
            <label>
              <select value={backend?.id ?? ''} onChange={(event) => setBackendId(event.target.value)}>
                {options.backends.map((b) => (
                  <option key={b.id} value={b.id} disabled={!b.available}>
                    {b.label}
                    {b.available ? '' : ` ${t('newThread.backendUnavailable')}`}
                  </option>
                ))}
              </select>
            </label>
          </section>
        ) : null}

        {/* TODO 1066: if the chosen backend handles local models, show this PC's recommendation first. */}
        {backend !== undefined && backend.available ? <LocalModelAdvice key={backend.id} backendId={backend.id} /> : null}

        {backend !== undefined ? (
          <section className="new-thread-transcripts">
            {entry.mode === 'folder' ? (
              <>
                {/* Starting something new is pressing a row of the list above (TODO 742). This is where you choose a conversation to continue. */}
                <h3>{t('newThread.transcript.folderHeading')}</h3>
                <TranscriptList
                  key={cwdUri}
                  input={{ backend: backend.id }}
                  onDone={onClose}
                  source={transcripts}
                  matchKey={folderMatchKey}
                  limit={FOLDER_TRANSCRIPT_LIMIT}
                  group="transcript-folder"
                />
              </>
            ) : null}
            <button
              type="button"
              className="new-thread-disclosure"
              aria-expanded={fromTranscript}
              onClick={() => setFromTranscript((open) => !open)}
            >
              <span className="new-thread-caret" aria-hidden="true">
                {fromTranscript ? '▾' : '▸'}
              </span>
              {entry.link === 'otherFolders'
                ? t('newThread.transcript.otherFolders')
                : t('newThread.transcript.heading')}
            </button>
            {fromTranscript ? (
              <>
                <p className="hint">{t('newThread.transcript.hint')}</p>
                <TranscriptList
                  input={{ backend: backend.id }}
                  onDone={onClose}
                  source={transcripts}
                  group="transcript-all"
                />
              </>
            ) : null}
          </section>
        ) : null}

        {backend !== undefined ? (
          <section>
            <h3>{t('backendCaps.title')}</h3>
            <BackendCapabilityList capabilities={backend.capabilities} />
          </section>
        ) : null}

        {backend !== undefined && backend.degradations.length > 0 ? (
          <section>
            <ul className="degradations">
              {backend.degradations.map((d) => (
                <li key={d.feature}>
                  {d.feature}: {describeReason(t, d.code) || d.reason}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {backend !== undefined && !backend.available ? (
          <section>
            <p className="denied">{describeReason(t, backend.message)}</p>
          </section>
        ) : null}
      </div>
    </div>
  )
}
