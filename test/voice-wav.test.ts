/**
 * Renderer-side pure functions of voice input (item 226, ARCHITECTURE 4.5.10). Neither the microphone nor the helper is used.
 * - the WAV assembly (`encodeVoiceWav`) is decoded by main's gate (`parseVoiceWav`) and checked against it (it confirms with real values on both sides that constants such as 16000 do not disagree; the same form as qlm's asr_test)
 * - inserting at the cursor position (`insertAtCursor`), and the signal that stops on silence after speech (`SilenceWatch`).
 */
import { describe, expect, it } from 'vitest'
import { concatSamples, downsample, encodeVoiceWav } from '../src/renderer/src/voice-wav.js'
import { SilenceWatch, formatVoiceElapsed, insertAtCursor, rmsOf } from '../src/renderer/src/voice-input.js'
import {
  VOICE_MAX_BYTES,
  VOICE_MAX_SECONDS,
  VOICE_SAMPLE_RATE,
  VOICE_WAV_HEADER_BYTES,
  isSilentVoice,
  parseVoiceWav
} from '../src/shared/voice.js'

function tone(seconds: number, amplitude = 0.5, rate = VOICE_SAMPLE_RATE): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / rate)
  return out
}

describe('encodeVoiceWav (item 226)', () => {
  it('the header is 44 bytes, and the PCM is 16 kHz / 16 bit / mono', () => {
    const wav = encodeVoiceWav(tone(0.5))
    const view = new DataView(wav.buffer)
    const ascii = (at: number): string => String.fromCharCode(...wav.slice(at, at + 4))
    expect(VOICE_WAV_HEADER_BYTES).toBe(44)
    expect(ascii(0)).toBe('RIFF')
    expect(ascii(8)).toBe('WAVE')
    expect(ascii(12)).toBe('fmt ')
    expect(ascii(36)).toBe('data')
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(28, true)).toBe(32000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(8000 * 2)
    expect(wav.byteLength).toBe(44 + 8000 * 2)
  })

  it("when decoded at main's gate, the sample count and seconds match, and audio is not judged silent", () => {
    const parsed = parseVoiceWav(encodeVoiceWav(tone(1.25)))
    expect(parsed).not.toBeNull()
    expect(parsed?.samples).toBe(20000)
    expect(parsed?.seconds).toBeCloseTo(1.25)
    expect(parsed?.peak).toBeGreaterThan(0.45)
    expect(isSilentVoice(parsed!)).toBe(false)
  })

  it('clips out-of-range values and keeps the sign', () => {
    const wav = encodeVoiceWav(new Float32Array([2, -2, 0, 0.5]))
    const view = new DataView(wav.buffer)
    expect(view.getInt16(44, true)).toBe(32767)
    expect(view.getInt16(46, true)).toBe(-32768)
    expect(view.getInt16(48, true)).toBe(0)
    expect(view.getInt16(50, true)).toBe(Math.trunc(0.5 * 0x7fff))
  })

  it('silence and noise are caught by the gate (qlm threshold)', () => {
    expect(isSilentVoice(parseVoiceWav(encodeVoiceWav(new Float32Array(16000)))!)).toBe(true)
    expect(isSilentVoice(parseVoiceWav(encodeVoiceWav(tone(1, 0.002)))!)).toBe(true)
    expect(isSilentVoice(parseVoiceWav(encodeVoiceWav(new Float32Array(0)))!)).toBe(true)
  })

  it('exactly the limit in seconds fits within the limit in bytes', () => {
    const wav = encodeVoiceWav(new Float32Array(VOICE_SAMPLE_RATE * VOICE_MAX_SECONDS))
    expect(wav.byteLength).toBe(VOICE_MAX_BYTES)
  })

  it('the gate refuses a WAV of a wrong shape', () => {
    const wav = encodeVoiceWav(tone(0.1))
    const wrongRate = wav.slice()
    new DataView(wrongRate.buffer).setUint32(24, 44100, true)
    expect(parseVoiceWav(wrongRate)).toBeNull()
    const truncated = wav.slice(0, wav.byteLength - 2)
    expect(parseVoiceWav(truncated)).toBeNull()
    expect(parseVoiceWav(new Uint8Array(10))).toBeNull()
    const notWav = wav.slice()
    notWav[0] = 0x58
    expect(parseVoiceWav(notWav)).toBeNull()
  })

  it('concatSamples / downsample', () => {
    expect(Array.from(concatSamples([new Float32Array([1, 2]), new Float32Array([3])]))).toEqual([1, 2, 3])
    const down = downsample(tone(1, 0.5, 48000), 48000)
    expect(down.length).toBe(16000)
    expect(Array.from(downsample(new Float32Array([1, 3, 5, 7, 9, 11]), 48000))).toEqual([3, 9])
    const same = new Float32Array([1])
    expect(downsample(same, 16000)).toBe(same)
  })
})

describe('insertAtCursor (item 226)', () => {
  it('inserts at the cursor and the cursor goes after the inserted text', () => {
    expect(insertAtCursor('前後', 1, 1, '真ん中')).toEqual({ text: '前真ん中後', caret: 4 })
  })
  it('replaces the selection if there is one', () => {
    expect(insertAtCursor('abc XYZ def', 4, 7, 'hello')).toEqual({ text: 'abc hello def', caret: 9 })
  })
  it('adds a space only when letters of the alphabet touch', () => {
    expect(insertAtCursor('open', 4, 4, 'settings')).toEqual({ text: 'open settings', caret: 13 })
    expect(insertAtCursor('ab', 1, 1, 'X')).toEqual({ text: 'a X b', caret: 4 })
    expect(insertAtCursor('ファイル', 4, 4, 'settings')).toEqual({ text: 'ファイルsettings', caret: 12 })
  })
  it('drops leading and trailing whitespace and does nothing when empty', () => {
    expect(insertAtCursor('x', 1, 1, '  ')).toEqual({ text: 'x', caret: 1 })
    expect(insertAtCursor('', 0, 0, ' こんにちは ')).toEqual({ text: 'こんにちは', caret: 5 })
  })
  it('clips out-of-range and reversed positions', () => {
    expect(insertAtCursor('abc', 99, 99, '1')).toEqual({ text: 'abc 1', caret: 5 })
    expect(insertAtCursor('abc', 2, 1, '-')).toEqual({ text: 'a-c', caret: 2 })
    expect(insertAtCursor('abc', Number.NaN, Number.NaN, '-')).toEqual({ text: 'abc-', caret: 4 })
  })
})

describe('SilenceWatch (item 226)', () => {
  it('does not stop on silence before speaking', () => {
    const watch = new SilenceWatch(0.01, 1000)
    expect(watch.feed(0, 0)).toBe(false)
    expect(watch.feed(0, 5000)).toBe(false)
  })
  it('stops if silence continues after speaking; counting restarts if speech comes in between', () => {
    const watch = new SilenceWatch(0.01, 1000)
    expect(watch.feed(0.05, 0)).toBe(false)
    expect(watch.feed(0, 100)).toBe(false)
    expect(watch.feed(0, 900)).toBe(false)
    expect(watch.feed(0.05, 1000)).toBe(false)
    expect(watch.feed(0, 1200)).toBe(false)
    expect(watch.feed(0, 2199)).toBe(false)
    expect(watch.feed(0, 2200)).toBe(true)
  })
  it('rmsOf / formatVoiceElapsed', () => {
    expect(rmsOf(new Float32Array(0))).toBe(0)
    expect(rmsOf(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5)
    expect(formatVoiceElapsed(0)).toBe('0:00')
    expect(formatVoiceElapsed(3999)).toBe('0:03')
    expect(formatVoiceElapsed(61_000)).toBe('1:01')
  })
})
