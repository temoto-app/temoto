/**
 * The microphone of the prompt field (item 226, ARCHITECTURE.md 4.5.10, wave 14 bundle M).
 *
 * Press -> record (`getUserMedia` + a 16 kHz `AudioContext`) -> stops when pressed again / silence continues after speaking /
 * the limit in seconds is reached, becomes a WAV and goes to main. Main transcribes it with a macOS on-device recognition helper, and
 * the text is **only inserted at the cursor of the input field** (`onText`). Sending is done by the person pressing Enter (the same "dictation" as qlm,
 * the decision of TODO 174 - do not "send immediately when recognized"). Esc discards the recording.
 *
 * It is placed next to the clip at the left of the lower row - so the position of the send button does not move (the decision of item 161).
 * Audio is not saved. The recorded samples are released at the moment they are handed over as WAV.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { VOICE_MAX_SECONDS } from '@shared/voice.js'
import { VoiceRecorder } from '../voice-recorder.js'
import { encodeVoiceWav } from '../voice-wav.js'
import { SilenceWatch, formatVoiceElapsed } from '../voice-input.js'
import { ComposerMicIcon } from '../icons/ComposerMicIcon.js'
import { ComposerStopIcon } from '../icons/ComposerStopIcon.js'
import { Spinner } from './Spinner.js'
import { Tooltip } from './Tooltip.js'
import { describeReason, useT } from '../i18n/index.js'
import { currentKeybindings, dictateKeyLabel } from '../shortcuts.js'
import { useThreads } from '../threadStore.js'

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing'

export function VoiceButton({
  threadId,
  onText,
  onNotice,
  toggleRef
}: {
  threadId: string
  /** The transcribed text. Never empty. */
  onText: (text: string) => void
  /** A notice shown in the band (null clears it). */
  onNotice: (message: string | null) => void
  /** TODO 1268: the Composer's keyboard shortcut calls this to start / stop recording (the same as pressing the button). */
  toggleRef?: React.MutableRefObject<(() => void) | null>
}): React.JSX.Element {
  const t = useT()
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const recorder = useRef<VoiceRecorder | null>(null)
  /** A marker per recording. So that switching threads or Esc discards the result of an old recording. */
  const session = useRef(0)
  const startedAt = useRef(0)
  const latest = useRef({ onText, onNotice, t })
  latest.current = { onText, onNotice, t }

  const discard = useCallback(() => {
    session.current += 1
    const current = recorder.current
    recorder.current = null
    if (current !== null) void current.cancel()
    setPhase('idle')
  }, [])

  const finish = useCallback(async () => {
    const current = recorder.current
    if (current === null) return
    recorder.current = null
    const mine = session.current
    setPhase('transcribing')
    try {
      const samples = await current.stop()
      const wav = encodeVoiceWav(samples)
      const result = await window.aios.voice.transcribe(wav)
      if (session.current !== mine) return
      const { onText: emit, onNotice: notice, t: tr } = latest.current
      if (!result.ok) notice(describeReason(tr, result.reason))
      else if (result.silent || result.text === '') notice(tr('composer.voice.silent'))
      else emit(result.text)
    } catch {
      if (session.current === mine) latest.current.onNotice(latest.current.t('reason.voice-failed'))
    } finally {
      if (session.current === mine) setPhase('idle')
    }
  }, [])

  const start = useCallback(async () => {
    const mine = ++session.current
    latest.current.onNotice(null)
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      latest.current.onNotice(latest.current.t('composer.voice.micUnavailable'))
      return
    }
    setPhase('starting')
    const watch = new SilenceWatch()
    try {
      const opened = await VoiceRecorder.start((rms) => {
        setLevel(rms)
        // Stop by itself when silence continues after speaking.
        if (watch.feed(rms, performance.now()) && session.current === mine) void finish()
      })
      if (session.current !== mine) {
        void opened.cancel()
        return
      }
      recorder.current = opened
      startedAt.current = performance.now()
      setElapsed(0)
      setLevel(0)
      setPhase('recording')
    } catch (err) {
      if (session.current !== mine) return
      setPhase('idle')
      const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
      latest.current.onNotice(latest.current.t(denied ? 'composer.voice.micDenied' : 'composer.voice.micUnavailable'))
    }
  }, [finish])

  // Display of elapsed time and the limit (it stops by itself at the limit; main also refuses at the same number of seconds).
  useEffect(() => {
    if (phase !== 'recording') return
    const timer = window.setInterval(() => {
      const ms = performance.now() - startedAt.current
      setElapsed(ms)
      if (ms >= VOICE_MAX_SECONDS * 1000) void finish()
    }, 250)
    return () => window.clearInterval(timer)
  }, [phase, finish])

  // Esc discards the recording. Taken before the input field's Esc (stopping the response, item 161) (window capture).
  // Esc during composition cancels the composition, so it is not picked up.
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'starting') return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      discard()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [phase, discard])

  // When the thread is switched or the component is detached, discard both the recording and the transcription result.
  useEffect(() => discard, [threadId, discard])

  const recording = phase === 'recording'
  // TODO 1268: the shortcut does what the button does (nothing while starting / transcribing). Assigned in an effect (not during render) that re-runs on every
  // render so it sees the current phase; its cleanup clears it. StrictMode's mount -> cleanup -> mount replays effects, so the assignment is re-made.
  useLayoutEffect(() => {
    if (toggleRef === undefined) return
    toggleRef.current = () => {
      if (recording) void finish()
      else if (phase === 'idle') void start()
    }
    return () => {
      toggleRef.current = null
    }
  })
  // TODO 1267: the dictation hotkey asked to start. Same path as the button: only from idle (already recording or busy = do nothing, never stop).
  const dictateRequested = useThreads((state) => state.dictateRequest?.threadId === threadId)
  useEffect(() => {
    if (!dictateRequested) return
    if (!useThreads.getState().takeDictateRequest(threadId)) return
    if (phase === 'idle') void start()
  }, [dictateRequested, threadId, phase, start])
  const dictateKey = dictateKeyLabel(currentKeybindings().platform)
  const busy = phase === 'starting' || phase === 'transcribing'
  const title = recording
    ? t('composer.voice.stopHint')
    : phase === 'transcribing'
      ? t('composer.voice.transcribing')
      : `${t('composer.voice.start')}${dictateKey === null ? '' : ` (${dictateKey})`}\n${t('composer.voice.osDictationHint')}`
  return (
    <>
      {/* Item 373: the description is the common balloon (item 320), not the OS title. During `starting` it is
          `disabled`, so it is wrapped in a `span`, which receives mouseenter / focus even when the button is disabled
          (the same approach as the reservation, interrupt and primary button in Composer.tsx). */}
      <Tooltip placement="top" content={title}>
        <span className="composer-icon-tip" aria-disabled={busy || undefined}>
          <button
            type="button"
            className={`composer-voice${recording ? ' recording' : ''}`}
            data-phase={phase}
            onClick={() => {
              if (recording) void finish()
              else if (phase === 'idle') void start()
            }}
            disabled={busy}
            aria-pressed={recording}
            aria-label={recording ? t('composer.voice.stop') : t('composer.voice.start')}
          >
            {recording ? <ComposerStopIcon /> : phase === 'transcribing' ? <Spinner className="in-row" /> : <ComposerMicIcon />}
          </button>
        </span>
      </Tooltip>
      {recording ? (
        <span className="composer-voice-status" role="status">
          <span className="composer-voice-dot" aria-hidden="true" />
          <span className="composer-voice-elapsed">{formatVoiceElapsed(elapsed)}</span>
          <span className="composer-voice-level" aria-hidden="true">
            <span style={{ width: `${Math.min(100, Math.round(level * 400))}%` }} />
          </span>
        </span>
      ) : phase === 'transcribing' ? (
        <span className="composer-voice-status" role="status">
          {t('composer.voice.transcribing')}
        </span>
      ) : null}
    </>
  )
}
