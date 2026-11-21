/**
 * Builds the WAV for voice input (item 226, 4.5.10). **Handwritten** - adds neither dependencies nor steps (the same approach as qlm).
 * The format is 16 kHz / 16 bit LE / mono / a 44-byte header only. The constants are in `shared/voice.ts` (the same source as main's gate).
 * `MediaRecorder`'s webm/opus is not used: the helper reads a PCM WAV, so it would only add a conversion step.
 */
import {
  VOICE_BITS_PER_SAMPLE,
  VOICE_CHANNELS,
  VOICE_SAMPLE_RATE,
  VOICE_WAV_HEADER_BYTES
} from '@shared/voice.js'

/** Joins the collected slices into one Float32Array. */
export function concatSamples(chunks: readonly Float32Array[]): Float32Array {
  let length = 0
  for (const chunk of chunks) length += chunk.length
  const out = new Float32Array(length)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/**
 * A fallback for when it could not be opened at 16 kHz (the same as qlm's voice.js, decimating by averaging). Chromium can open a 16 kHz
 * `AudioContext` directly (16000 confirmed in spike 28), so normally this is not reached.
 */
export function downsample(input: Float32Array, fromRate: number, toRate = VOICE_SAMPLE_RATE): Float32Array {
  if (fromRate === toRate) return input
  if (fromRate < toRate || fromRate <= 0) throw new Error(`cannot resample ${fromRate} -> ${toRate}`)
  const ratio = fromRate / toRate
  const length = Math.floor(input.length / ratio)
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j] ?? 0
    out[i] = end > start ? sum / (end - start) : 0
  }
  return out
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

/** 16 kHz mono Float32 (-1 to 1) -> WAV (16 bit LE). Values outside the range are clamped. */
export function encodeVoiceWav(samples: Float32Array): Uint8Array {
  const bytesPerSample = VOICE_BITS_PER_SAMPLE / 8
  const dataBytes = samples.length * bytesPerSample * VOICE_CHANNELS
  const buffer = new ArrayBuffer(VOICE_WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // size of fmt
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, VOICE_CHANNELS, true)
  view.setUint32(24, VOICE_SAMPLE_RATE, true)
  view.setUint32(28, VOICE_SAMPLE_RATE * bytesPerSample * VOICE_CHANNELS, true) // byte rate
  view.setUint16(32, bytesPerSample * VOICE_CHANNELS, true) // block align
  view.setUint16(34, VOICE_BITS_PER_SAMPLE, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(VOICE_WAV_HEADER_BYTES + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return new Uint8Array(buffer)
}
