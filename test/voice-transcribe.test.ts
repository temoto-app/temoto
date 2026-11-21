/**
 * The main side of voice input (item 226, ARCHITECTURE 4.5.10). The helper is not started (`execFile` is replaced with a fake).
 * - the temporary file is deleted whether it succeeds or fails (no audio is kept)
 * - failures are returned as reason codes (they do not throw): not macOS / no helper / audio of the wrong shape / too long / timeout / two at once
 * - silence does not call the helper
 * - the transcribed text does not appear in the log
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceTranscriber, asVoiceBytes, type VoiceExecFile } from '../src/main/voice/transcriber.js'
import { encodeVoiceWav } from '../src/renderer/src/voice-wav.js'
import { VOICE_SAMPLE_RATE } from '../src/shared/voice.js'

function tone(seconds: number, amplitude = 0.5): Uint8Array {
  const out = new Float32Array(Math.round(seconds * VOICE_SAMPLE_RATE))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / VOICE_SAMPLE_RATE)
  return encodeVoiceWav(out)
}

interface Call {
  file: string
  args: readonly string[]
  /** Whether the temporary file existed at the time it was called. */
  existed: boolean
}

let root: string
let calls: Call[]

function fakeRun(
  reply: (call: Call) => { error?: Error & { code?: unknown; killed?: boolean }; stdout?: string }
): VoiceExecFile {
  return (file, args, _options, callback) => {
    const call: Call = { file, args, existed: existsSync(args[1] ?? '') }
    calls.push(call)
    const { error, stdout } = reply(call)
    setImmediate(() => callback(error ?? null, stdout ?? ''))
    return undefined
  }
}

function build(
  run: VoiceExecFile,
  overrides: Partial<ConstructorParameters<typeof VoiceTranscriber>[0]> = {}
): VoiceTranscriber {
  return new VoiceTranscriber({
    helperPath: '/fake/speech-helper',
    speechLocale: () => 'ja-JP',
    run,
    platform: 'darwin',
    exists: () => true,
    tempRoot: () => root,
    ...overrides
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aios-voice-test-'))
  calls = []
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('VoiceTranscriber (項目 226)', () => {
  it('ヘルパーに言語と一時ファイルを渡し、書き起こしを返し、一時ファイルを消す', async () => {
    const transcriber = build(fakeRun(() => ({ stdout: '{"text":" 明日の会議は午後3時からです。 ","ms":300}\n' })))
    const result = await transcriber.transcribe(tone(1))
    expect(result).toEqual({ ok: true, text: '明日の会議は午後3時からです。', silent: false })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.file).toBe('/fake/speech-helper')
    expect(calls[0]?.args[0]).toBe('ja-JP')
    expect(calls[0]?.existed).toBe(true)
    expect(calls[0]?.args[1]?.startsWith(root)).toBe(true)
    expect(readdirSync(root)).toEqual([])
  })

  it('失敗でも一時ファイルを消す', async () => {
    const transcriber = build(
      fakeRun(() => ({ error: Object.assign(new Error('boom'), { code: 1 }), stdout: '{"error":"failed"}' }))
    )
    expect(await transcriber.transcribe(tone(1))).toEqual({ ok: false, reason: 'voice-failed' })
    expect(calls[0]?.existed).toBe(true)
    expect(readdirSync(root)).toEqual([])
  })

  it('言語が無ければ voice-locale-unsupported、渡した言語タグがそのまま引数に載る', async () => {
    const transcriber = build(
      fakeRun(() => ({ error: Object.assign(new Error('x'), { code: 1 }), stdout: '{"error":"locale-unsupported"}' })),
      { speechLocale: () => 'en-US' }
    )
    expect(await transcriber.transcribe(tone(1))).toEqual({ ok: false, reason: 'voice-locale-unsupported' })
    expect(calls[0]?.args[0]).toBe('en-US')
  })

  it('時間切れは voice-timeout、起こせなければ voice-helper-missing、読めない出力は voice-failed', async () => {
    const timeout = build(fakeRun(() => ({ error: Object.assign(new Error('t'), { killed: true }) })))
    expect(await timeout.transcribe(tone(1))).toEqual({ ok: false, reason: 'voice-timeout' })
    const enoent = build(fakeRun(() => ({ error: Object.assign(new Error('e'), { code: 'ENOENT' }) })))
    expect(await enoent.transcribe(tone(1))).toEqual({ ok: false, reason: 'voice-helper-missing' })
    const garbage = build(fakeRun(() => ({ stdout: 'not json' })))
    expect(await garbage.transcribe(tone(1))).toEqual({ ok: false, reason: 'voice-failed' })
    expect(readdirSync(root)).toEqual([])
  })

  it('ヘルパーが無ければ呼ばずに voice-helper-missing', async () => {
    const transcriber = build(fakeRun(() => ({ stdout: '{"text":"x"}' })), { exists: () => false })
    expect(await transcriber.transcribe(tone(1))).toEqual({ ok: false, reason: 'voice-helper-missing' })
    expect(calls).toHaveLength(0)
  })

  it('macOS 以外は voice-unsupported', async () => {
    const transcriber = build(fakeRun(() => ({ stdout: '{"text":"x"}' })), { platform: 'linux' })
    expect(await transcriber.transcribe(tone(1))).toEqual({ ok: false, reason: 'voice-unsupported' })
    expect(calls).toHaveLength(0)
  })

  it('形の違う音声・長すぎる音声はヘルパーを呼ばずに断る', async () => {
    const transcriber = build(fakeRun(() => ({ stdout: '{"text":"x"}' })))
    expect(await transcriber.transcribe('not bytes')).toEqual({ ok: false, reason: 'voice-invalid-audio' })
    expect(await transcriber.transcribe(new Uint8Array([1, 2, 3]))).toEqual({ ok: false, reason: 'voice-invalid-audio' })
    expect(await transcriber.transcribe(tone(61))).toEqual({ ok: false, reason: 'voice-too-long' })
    expect(calls).toHaveLength(0)
  })

  it('無音はヘルパーを呼ばず、空の書き起こしと silent', async () => {
    const transcriber = build(fakeRun(() => ({ stdout: '{"text":"ん"}' })))
    expect(await transcriber.transcribe(tone(2, 0))).toEqual({ ok: true, text: '', silent: true })
    expect(calls).toHaveLength(0)
  })

  it('同時に 2 本目は voice-busy (ヘルパーを並べない)', async () => {
    let release: () => void = () => undefined
    const run: VoiceExecFile = (file, args, _options, callback) => {
      calls.push({ file, args, existed: true })
      if (calls.length === 1) release = () => callback(null, '{"text":"ok"}')
      else setImmediate(() => callback(null, '{"text":"ok"}'))
      return undefined
    }
    const transcriber = build(run)
    const first = transcriber.transcribe(tone(1))
    // Wait until the temporary file is written and the helper is called.
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(await transcriber.transcribe(tone(1))).toEqual({ ok: false, reason: 'voice-busy' })
    release()
    expect(await first).toEqual({ ok: true, text: 'ok', silent: false })
    expect(await transcriber.transcribe(tone(1))).toMatchObject({ ok: true })
  })

  it('書き起こした文はログに出ない (長さだけ)', async () => {
    const lines: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk))
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk))
      return true
    })
    const transcriber = build(fakeRun(() => ({ stdout: '{"text":"秘密の合言葉は青いりんご"}' })))
    await transcriber.transcribe(tone(1))
    const joined = lines.join('')
    expect(joined).toContain('voice.transcribed')
    expect(joined).toContain('"chars":12')
    expect(joined).not.toContain('秘密の合言葉')
  })

  it('asVoiceBytes', () => {
    expect(asVoiceBytes(new ArrayBuffer(4))?.byteLength).toBe(4)
    expect(asVoiceBytes(Buffer.from([1, 2]))?.byteLength).toBe(2)
    expect(asVoiceBytes('x')).toBeNull()
  })
})

describe('終了・起動時の片付け (TODO 934)', () => {
  it('dispose は走っているヘルパーを殺して一時ディレクトリを消し、以後は断る', async () => {
    const kill = vi.fn()
    let started: () => void = () => {}
    const running = new Promise<void>((resolve) => (started = resolve))
    const run: VoiceExecFile = () => {
      started()
      return { kill } // callback is not called = transcription still in progress
    }
    const transcriber = build(run)
    void transcriber.transcribe(tone(1))
    await running
    expect(readdirSync(root).filter((n) => n.startsWith('aios-voice-'))).toHaveLength(1)
    transcriber.dispose()
    expect(kill).toHaveBeenCalledWith('SIGKILL')
    expect(readdirSync(root).filter((n) => n.startsWith('aios-voice-'))).toHaveLength(0)
    expect(await transcriber.transcribe(tone(1))).toEqual({ ok: false, reason: 'voice-failed' })
  })

  it('TODO 1134: mkdtemp / writeFile の await 中に dispose が来てもヘルパーを起こさず、WAV を残さない', async () => {
    const run = vi.fn<VoiceExecFile>(() => undefined)
    const transcriber = build(run)
    const pending = transcriber.transcribe(tone(1))
    transcriber.dispose() // transcribe is still awaiting mkdtemp
    expect(await pending).toEqual({ ok: false, reason: 'voice-failed' })
    expect(run).not.toHaveBeenCalled()
    expect(readdirSync(root).filter((n) => n.startsWith('aios-voice-'))).toHaveLength(0)
  })

  it('sweepStale は古い aios-voice-* だけ消す (新しいものと他の名前は残す)', async () => {
    const old = join(root, 'aios-voice-old')
    const fresh = join(root, 'aios-voice-fresh')
    const other = join(root, 'other')
    for (const d of [old, fresh, other]) mkdirSync(d)
    const past = new Date(Date.now() - 60 * 60_000)
    utimesSync(old, past, past)
    utimesSync(other, past, past)
    const transcriber = build(fakeRun(() => ({})))
    expect(await transcriber.sweepStale()).toBe(1)
    expect(readdirSync(root).sort()).toEqual(['aios-voice-fresh', 'other'])
  })
})
