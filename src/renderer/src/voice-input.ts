/**
 * Renderer-side pure functions for voice input (item 226, 4.5.10). Independent of the DOM and the microphone.
 *
 * - `insertAtCursor`: inserts the transcript at the input box's cursor (replacing the selection, if any).
 *   **It does not send** - "dictation into the input box" (the same decision as qlm, TODO 174). A single space is added only when Latin letters would touch.
 * - `SilenceWatch`: the signal to stop recording by itself when silence continues after speech. It does not stop on silence before speech
 *   (so it does not cut off between pressing and starting to talk).
 */

/** The body after inserting, and the cursor position to restore. */
export interface Inserted {
  readonly text: string
  readonly caret: number
}

const WORDISH = /[A-Za-z0-9]/

export function insertAtCursor(draft: string, start: number, end: number, inserted: string): Inserted {
  const text = inserted.trim()
  const from = clamp(Math.min(start, end), draft.length)
  const to = clamp(Math.max(start, end), draft.length)
  if (text === '') return { text: draft, caret: to }
  const before = draft.slice(0, from)
  const after = draft.slice(to)
  const prev = before.at(-1) ?? ''
  const next = after[0] ?? ''
  const lead = WORDISH.test(prev) && WORDISH.test(text[0] ?? '') ? ' ' : ''
  const trail = WORDISH.test(next) && WORDISH.test(text.at(-1) ?? '') ? ' ' : ''
  const piece = `${lead}${text}${trail}`
  return { text: `${before}${piece}${after}`, caret: before.length + piece.length }
}

function clamp(value: number, max: number): number {
  if (!Number.isFinite(value)) return max
  return Math.max(0, Math.min(Math.trunc(value), max))
}

/** The volume (rms) regarded as speech. Higher than main's silence gate (`VOICE_SILENCE_RMS`) - so breath or noise does not extend it. */
export const VOICE_SPEECH_RMS = 0.01
/** Stop when silence continues for this long after speech. */
export const VOICE_TRAILING_SILENCE_MS = 2500

export class SilenceWatch {
  private spoke = false
  private quietSince: number | null = null

  constructor(
    private readonly speechRms = VOICE_SPEECH_RMS,
    private readonly trailingMs = VOICE_TRAILING_SILENCE_MS
  ) {}

  /** Feeds one volume. true if it should stop. */
  feed(rms: number, now: number): boolean {
    if (rms >= this.speechRms) {
      this.spoke = true
      this.quietSince = null
      return false
    }
    if (!this.spoke) return false
    if (this.quietSince === null) this.quietSince = now
    return now - this.quietSince >= this.trailingMs
  }
}

/** The volume (rms) of a slice. */
export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] ?? 0
    sum += value * value
  }
  return Math.sqrt(sum / samples.length)
}

/** The elapsed-time display (`0:03`). */
export function formatVoiceElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
