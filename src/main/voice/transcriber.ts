/**
 * Transcription for voice input (item 226, ARCHITECTURE.md 4.5.10). The only entry point in main.
 *
 * It receives the renderer's WAV, validates it (gates on shape, limits, and silence), writes it to a temporary file under `os.tmpdir()`, and calls
 * macOS's on-device recognition helper (`tools/speech-helper/`, `out/speech-helper/` via `npm run build:speech`) with `execFile`
 * **as a child process**. Transcription (CPU-heavy work) is not run on main's JS thread
 * (in the spirit of constraint 8.1).
 *
 * - **Audio is stored nowhere.** The temporary file is always deleted, on success or failure (the whole directory). At quit the running child is
 *   killed and the file removed (`dispose`), and leftovers from a previous quit or crash are removed at startup (`sweepStale`, TODO 934).
 * - **The transcribed text is not logged.** Only byte counts, seconds, elapsed time, and character counts are kept.
 * - **Never throws.** A failure is returned as a reason code (`voice-*` in `shared/reason.ts`).
 * - Only one at a time (helpers are not launched side by side). A second one is refused with `voice-busy`.
 */
import { execFile } from 'node:child_process'
import type { ExecFileOptions } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReasonCode } from '@shared/reason.js'
import {
  VOICE_MAX_BYTES,
  VOICE_MAX_SECONDS,
  isSilentVoice,
  parseVoiceWav,
  type VoiceTranscribeResult
} from '@shared/voice.js'
import { log, errorFields } from '../../common/logger.js'
import { hostPlatform, isMac } from '../../common/os/platform.js'

/**
 * Time allowed for one transcription. A 10 s utterance takes around 1 s (spike 28), but for a language used for the first time the helper
 * downloads the OS assets (16.7 s for en_US). The limit is set longer to allow for that.
 */
export const VOICE_TRANSCRIBE_TIMEOUT_MS = 120_000

/** The minimum age of leftover temporary directories removed by the startup cleanup. So it does not delete ones another aios (a verification build, etc.) is using right now. */
export const VOICE_STALE_TMP_MS = 10 * 60_000
const VOICE_TMP_PREFIX = 'aios-voice-'

/** Upper bound on the helper's stdout. Small, since it is one line of JSON for the transcription. */
const MAX_STDOUT_BYTES = 1024 * 1024

export type VoiceExecFile = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: (error: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null, stdout: string) => void
) => unknown

export interface VoiceTranscriberDeps {
  /** Absolute path of the helper binary (`<appPath>/out/speech-helper/speech-helper`). */
  readonly helperPath: string
  /**
   * The recognition language tag passed to the helper (`ja-JP` / `en-US` / …, TODO 626). The caller decides it from a setting separate from the display language
   * (`VoiceLocalePreferenceStore` + `resolveVoiceSpeechLocale`).
   */
  readonly speechLocale: () => string
  /** A replacement for tests. */
  readonly run?: VoiceExecFile
  readonly platform?: NodeJS.Platform
  readonly exists?: (path: string) => boolean
  readonly tempRoot?: () => string
}

/** Turn a value arriving over IPC into bytes. Only ArrayBuffer and typed arrays (including Buffer) are accepted. */
export function asVoiceBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return null
}

/** The helper output's `error` -> a reason code. */
function reasonOfHelperError(code: unknown): ReasonCode {
  return code === 'locale-unsupported' ? 'voice-locale-unsupported' : 'voice-failed'
}

export class VoiceTranscriber {
  private busy = false
  private disposed = false
  /** The helper and temporary directory currently running (so they can be killed and removed at quit. TODO 934). */
  private child: unknown = null
  private dir: string | null = null

  constructor(private readonly deps: VoiceTranscriberDeps) {}

  async transcribe(input: unknown): Promise<VoiceTranscribeResult> {
    if (!isMac(this.deps.platform ?? hostPlatform())) return fail('voice-unsupported')
    const bytes = asVoiceBytes(input)
    if (bytes === null) return fail('voice-invalid-audio')
    if (bytes.byteLength > VOICE_MAX_BYTES) return fail('voice-too-long')
    const parsed = parseVoiceWav(bytes)
    if (parsed === null) return fail('voice-invalid-audio')
    if (parsed.seconds > VOICE_MAX_SECONDS) return fail('voice-too-long')
    // The silence gate (measured with qlm). Text appearing when nobody spoke is the worst behavior, so the helper is not called.
    if (isSilentVoice(parsed)) {
      log.info('voice.silent', { bytes: bytes.byteLength, seconds: round(parsed.seconds) })
      return { ok: true, text: '', silent: true }
    }
    const helper = this.deps.helperPath
    if (!(this.deps.exists ?? existsSync)(helper)) {
      log.warn('voice.helper.missing', { path: helper })
      return fail('voice-helper-missing')
    }
    if (this.disposed) return fail('voice-failed')
    if (this.busy) return fail('voice-busy')
    this.busy = true
    const started = Date.now()
    let dir: string | null = null
    try {
      dir = await mkdtemp(join((this.deps.tempRoot ?? tmpdir)(), VOICE_TMP_PREFIX))
      this.dir = dir
      const file = join(dir, 'input.wav')
      // TODO 1134: if dispose arrived during the await (overlapping quit), `dir` at that point is unregistered and not yet deleted.
      // Do not launch the helper, and delete it synchronously so it does not remain even if main finishes first.
      if (this.disposed) return this.abortDisposed(dir)
      await writeFile(file, bytes, { mode: 0o600 })
      if (this.disposed) return this.abortDisposed(dir)
      const outcome = await this.runHelper(helper, [this.deps.speechLocale(), file])
      const ms = Date.now() - started
      if (!outcome.ok) {
        log.warn('voice.failed', { reason: outcome.reason, ms, seconds: round(parsed.seconds) })
        return outcome
      }
      // The body is not logged (length only).
      log.info('voice.transcribed', {
        bytes: bytes.byteLength,
        seconds: round(parsed.seconds),
        ms,
        chars: outcome.text.length
      })
      return outcome
    } catch (err) {
      log.warn('voice.failed', { reason: 'voice-failed', ...errorFields(err) })
      return fail('voice-failed')
    } finally {
      this.busy = false
      this.child = null
      this.dir = null
      if (dir !== null) {
        await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
          log.warn('voice.tmp.cleanupFailed', errorFields(err))
        })
      }
    }
  }

  /** Refuse a transcription that overlaps quit. Synchronously delete the temporary folder holding the recorded WAV (TODO 1134). */
  private abortDisposed(dir: string): VoiceTranscribeResult {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      log.warn('voice.tmp.cleanupFailed', errorFields(err))
    }
    return fail('voice-failed')
  }

  /**
   * Quit (TODO 934): kill the running helper and synchronously delete the temporary directory (the recorded WAV). The helper is a child started
   * with `execFile`, and it is not killed when main ends. Later transcriptions are refused.
   */
  dispose(): void {
    this.disposed = true
    const child = this.child
    if (child !== null && typeof (child as { kill?: unknown }).kill === 'function') {
      try {
        ;(child as { kill: (signal: string) => unknown }).kill('SIGKILL')
      } catch {
        // Already finished
      }
    }
    this.child = null
    const dir = this.dir
    this.dir = null
    if (dir !== null) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        log.warn('voice.tmp.cleanupFailed', errorFields(err))
      }
    }
  }

  /**
   * Startup cleanup (TODO 934): remove `aios-voice-*` left by a previous quit or crash. Only old ones
   * (older than `VOICE_STALE_TMP_MS`) — ones another aios is using right now are not removed. Returns the number removed.
   */
  async sweepStale(now: number = Date.now()): Promise<number> {
    const root = (this.deps.tempRoot ?? tmpdir)()
    let removed = 0
    try {
      for (const name of await readdir(root)) {
        if (!name.startsWith(VOICE_TMP_PREFIX)) continue
        const path = join(root, name)
        try {
          const info = await stat(path)
          if (!info.isDirectory() || now - info.mtimeMs < VOICE_STALE_TMP_MS) continue
          await rm(path, { recursive: true, force: true })
          removed++
        } catch (err) {
          log.warn('voice.tmp.sweepFailed', errorFields(err))
        }
      }
    } catch (err) {
      log.warn('voice.tmp.sweepFailed', errorFields(err))
    }
    if (removed > 0) log.info('voice.tmp.swept', { removed })
    return removed
  }

  private runHelper(helper: string, args: readonly string[]): Promise<VoiceTranscribeResult> {
    const run = this.deps.run ?? (execFile as unknown as VoiceExecFile)
    return new Promise((resolve) => {
      this.child = run(
        helper,
        args,
        { timeout: VOICE_TRANSCRIBE_TIMEOUT_MS, maxBuffer: MAX_STDOUT_BYTES, encoding: 'utf8' },
        (error, stdout) => {
          const reply = readReply(stdout)
          if (error !== null) {
            // The message contains the command line and stderr, so it goes only to debug (the lesson of 5.6).
            log.debug('voice.helper.error', errorFields(error))
            if (error.killed === true || error.signal === 'SIGTERM') return resolve(fail('voice-timeout'))
            if (error.code === 'ENOENT' || error.code === 'EACCES') return resolve(fail('voice-helper-missing'))
            return resolve(fail(reply?.error !== undefined ? reasonOfHelperError(reply.error) : 'voice-failed'))
          }
          if (reply === null) return resolve(fail('voice-failed'))
          if (typeof reply.text === 'string') return resolve({ ok: true, text: reply.text.trim(), silent: false })
          resolve(fail(reasonOfHelperError(reply.error)))
        }
      )
    })
  }
}

/** The helper's output is one line of JSON (`{"text": …}` or `{"error": …}`). Null if unreadable. */
function readReply(stdout: unknown): { text?: unknown; error?: unknown } | null {
  if (typeof stdout !== 'string') return null
  const line = stdout.trim().split('\n').at(-1) ?? ''
  if (line === '') return null
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === 'object' && parsed !== null ? (parsed as { text?: unknown; error?: unknown }) : null
  } catch {
    return null
  }
}

function fail(reason: ReasonCode): VoiceTranscribeResult {
  return { ok: false, reason }
}

function round(seconds: number): number {
  return Math.round(seconds * 10) / 10
}
