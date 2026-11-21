/**
 * The contract between the renderer and main for voice input (item 226, ARCHITECTURE.md 4.5.10).
 *
 * The renderer builds a 16 kHz / 16 bit / mono WAV, and main receives it and passes it to the macOS on-device recognition
 * helper (a child process). **Audio is saved nowhere** (main writes a temporary file and always deletes it
 * after transcription), and **the transcribed text is not logged** (only its length).
 *
 * The shape constants (16000 / 16 bit / 1 ch / the maximum seconds) are taken from here by both sides. If written separately, changing only one
 * produces a mismatch where "the renderer can build it but main refuses" (the same reason as qlm's asr_test).
 */
import type { ReasonCode } from './reason.js'

export const VOICE_SAMPLE_RATE = 16000
export const VOICE_BITS_PER_SAMPLE = 16
export const VOICE_CHANNELS = 1
/** Size of the WAV header (the RIFF + fmt + data headers, no extensions). */
export const VOICE_WAV_HEADER_BYTES = 44
/** Upper bound for one recording. The renderer stops itself at this many seconds, and main refuses anything longer. */
export const VOICE_MAX_SECONDS = 60
/** The size derived from the maximum seconds. If held separately, a mismatch appears where "the seconds pass but the bytes fail". */
export const VOICE_MAX_BYTES =
  VOICE_WAV_HEADER_BYTES + VOICE_SAMPLE_RATE * (VOICE_BITS_PER_SAMPLE / 8) * VOICE_CHANNELS * VOICE_MAX_SECONDS

/**
 * The silence gate (a threshold measured in qlm). **The decision is made in one place, in main** (having it in the renderer too would let them disagree).
 * If the gate catches it, the helper is not called and an empty transcription + `silent: true` is returned.
 */
export const VOICE_SILENCE_PEAK = 0.02
export const VOICE_SILENCE_RMS = 0.002

/**
 * The result of transcription. **It does not throw**: a failure is returned as a reason code (making an ordinary, expected failure a reject
 * would print Electron's `Error occurred in handler` in main's log every time. The same decision as `viewer.command` of item 149).
 */
export type VoiceTranscribeResult =
  | { readonly ok: true; readonly text: string; readonly silent: boolean }
  | { readonly ok: false; readonly reason: ReasonCode }

/** The contents of a WAV (PCM after the header is validated). Used by main's gate and by test cross-checks. */
export interface ParsedVoiceWav {
  /** Number of 16 bit LE samples. */
  readonly samples: number
  readonly seconds: number
  readonly peak: number
  readonly rms: number
}

function ascii(view: DataView, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i))
  return out
}

/**
 * Accept only a WAV built by the renderer (16 kHz / 16 bit / mono, 44-byte header). **The decision is by contents**:
 * the file name and type are not trusted. null if the shape is wrong (no loosening: the only sender is this app's Composer, so
 * no unverified code is added for inputs that never actually arrive; qlm's decision, as is).
 */
export function parseVoiceWav(bytes: Uint8Array): ParsedVoiceWav | null {
  if (bytes.byteLength < VOICE_WAV_HEADER_BYTES) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (ascii(view, 0, 4) !== 'RIFF' || ascii(view, 8, 4) !== 'WAVE') return null
  if (ascii(view, 12, 4) !== 'fmt ' || view.getUint32(16, true) !== 16) return null
  if (view.getUint16(20, true) !== 1) return null // PCM
  if (view.getUint16(22, true) !== VOICE_CHANNELS) return null
  if (view.getUint32(24, true) !== VOICE_SAMPLE_RATE) return null
  if (view.getUint16(34, true) !== VOICE_BITS_PER_SAMPLE) return null
  if (ascii(view, 36, 4) !== 'data') return null
  const dataBytes = view.getUint32(40, true)
  if (dataBytes % 2 !== 0 || VOICE_WAV_HEADER_BYTES + dataBytes !== bytes.byteLength) return null
  const samples = dataBytes / 2
  let peak = 0
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const value = view.getInt16(VOICE_WAV_HEADER_BYTES + i * 2, true) / 32768
    const abs = Math.abs(value)
    if (abs > peak) peak = abs
    sum += value * value
  }
  return {
    samples,
    seconds: samples / VOICE_SAMPLE_RATE,
    peak,
    rms: samples === 0 ? 0 : Math.sqrt(sum / samples)
  }
}

/** The silence gate (same as qlm: silent if either peak or rms is below the threshold). */
export function isSilentVoice(parsed: Pick<ParsedVoiceWav, 'peak' | 'rms' | 'samples'>): boolean {
  return parsed.samples === 0 || parsed.peak < VOICE_SILENCE_PEAK || parsed.rms < VOICE_SILENCE_RMS
}
