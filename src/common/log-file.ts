/**
 * The log file (TODO 376, ARCHITECTURE.md 12.9.1). Does not depend on electron - main decides the location and passes it.
 *
 * - **A new file per launch**: `aios-YYYYMMDD-HHMMSS.log` (local time). When opening, old ones are
 *   deleted, keeping only the latest `keep` including the new one (default 10).
 * - **The only writer is main.** Lines from the index process and plugin-host are relayed by main through a pipe
 *   (`log-relay.ts`). Even with O_APPEND from several processes a single write() did not interleave (wave20 note), but
 *   plugin-host cannot write files under the permission model, so everything was unified on the relay.
 * - **Normally main is not stalled**: lines are batched for 16 ms by a `Batcher` and written with `fs.write` (a libuv thread).
 *   Writes are chained into one sequence so the order is not broken.
 * - **Shutdown**: `close()` waits for what is queued and what is mid-write, then **switches to synchronous writes**. Later lines
 *   (such as index-process lines arriving from the pipe after `app.quit`) are `writeSync`ed on the spot - the
 *   process is about to end, so stalling it does not matter. The fd is closed on `process.on('exit')` (`dispose()`).
 * - If writing becomes impossible (disk full, file deleted), later lines are silently dropped. It says so once on stderr.
 */
import { closeSync, mkdirSync, openSync, write as fsWrite, writeSync } from 'node:fs'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Batcher, FLUSH_INTERVAL_MS } from './batch.js'

export const LOG_FILE_KEEP = 10
/** Upper bound for one file. So a runaway loop does not fill ~/Library/Logs. When exceeded, one line is left and later lines are dropped. */
export const LOG_FILE_MAX_BYTES = 64 * 1024 * 1024
/**
 * The pattern of aios log file names. `exclusions.ts` also uses it to leave them out of the index (owner decision of TODO 376
 * 2026-10-04: a `dev:instance` copy writes to `<userData>/logs/` = `~/aios-dev-data/logs/`, which is not in
 * the exclusions, so they are excluded by name so the dogfood aios does not reindex on every write).
 */
export const LOG_FILE_NAME_PATTERN = /^aios-\d{8}-\d{6}(?:-\d+)?\.log$/
const NAME_PATTERN = LOG_FILE_NAME_PATTERN

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** `aios-20261003-142501.log` (local time. A name a person reads sorted in Finder). */
export function logFileName(date: Date): string {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `aios-${day}-${time}.log`
}

/** Whether it is a log file (judged by name; other files are not touched). */
export function isLogFileName(name: string): boolean {
  return NAME_PATTERN.test(name)
}

/**
 * Deletes old logs, keeping only `keep`. Name order = time order. `current` is counted but not deleted.
 * Returns the number deleted. Files that cannot be read or deleted are skipped (log cleanup must not stop launch).
 */
export async function pruneLogFiles(dir: string, keep: number, current?: string): Promise<number> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter(isLogFileName)
  } catch {
    return 0
  }
  names.sort().reverse()
  let removed = 0
  for (const name of names.slice(Math.max(0, keep))) {
    if (name === current) continue
    try {
      await unlink(join(dir, name))
      removed += 1
    } catch {
      // Someone else deleted it first, etc. Next.
    }
  }
  return removed
}

export interface LogFileOptions {
  readonly dir: string
  readonly keep?: number
  readonly now?: () => Date
  readonly intervalMs?: number
  readonly maxBytes?: number
  /** Called only once when writing becomes impossible (default: one line on stderr). */
  readonly onError?: (err: unknown) => void
}

export class LogFile {
  readonly path: string
  readonly name: string
  private fd: number | null
  private readonly batcher: Batcher<string>
  /** The write chain. `flush()` waits for its tail. */
  private chain: Promise<void> = Promise.resolve()
  /** If true, later writes are synchronous and on the spot (after shutdown). */
  private syncMode = false
  /** Do not write any more (the limit was reached or writing became impossible). */
  private broken = false
  private failed = false
  private bytes = 0
  private readonly maxBytes: number
  private readonly onError: (err: unknown) => void
  /** The end of the cleanup at launch (for tests). */
  readonly pruned: Promise<number>

  /** Creates the location and opens a new file. Cleanup of old files is asynchronous (it can be awaited with `pruned`). */
  constructor(options: LogFileOptions) {
    const now = options.now ?? (() => new Date())
    const keep = options.keep ?? LOG_FILE_KEEP
    this.maxBytes = options.maxBytes ?? LOG_FILE_MAX_BYTES
    this.onError =
      options.onError ??
      ((err) => {
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'warn', event: 'log.file.failed', message })}\n`)
      })
    mkdirSync(options.dir, { recursive: true })
    this.name = logFileName(now())
    this.path = join(options.dir, this.name)
    this.fd = openSync(this.path, 'a', 0o600)
    this.batcher = new Batcher<string>((lines) => this.enqueue(lines.join('')), {
      intervalMs: options.intervalMs ?? FLUSH_INTERVAL_MS
    })
    this.pruned = pruneLogFiles(options.dir, keep, this.name)
  }

  /** Adds one line (without a newline). */
  append(line: string): void {
    if (this.broken || this.fd === null) return
    const text = `${line}\n`
    if (this.syncMode) {
      this.writeNow(text)
      return
    }
    this.batcher.push(text)
  }

  /** Writes what has accumulated and waits until everything, including what is mid-write, is done. */
  flush(): Promise<void> {
    this.batcher.flushNow()
    return this.chain
  }

  /**
   * The entry point that plugs into the shutdown sequence (12.9). Finishes writing what has accumulated, then switches to synchronous writes.
   * The fd is not closed yet - more lines will come after this (index-process lines after `app.quit`).
   */
  async close(): Promise<void> {
    await this.flush()
    this.syncMode = true
    this.batcher.dispose()
  }

  /**
   * The end of the process (`process.on('exit')`). Asynchronous writes can no longer finish here, so
   * write the rest synchronously and close the fd. It is also the safety net for when `close()` was not run (abnormal exit) -
   * in that case, if a `fs.write` is mid-flight, the ordering of its data is not guaranteed.
   */
  dispose(): void {
    if (this.fd === null) return
    this.syncMode = true
    this.batcher.flushNow()
    this.batcher.dispose()
    try {
      closeSync(this.fd)
    } catch {
      // Already closed.
    }
    this.fd = null
  }

  private enqueue(text: string): void {
    if (this.syncMode) {
      this.writeNow(text)
      return
    }
    this.chain = this.chain.then(() => this.writeAsync(text))
  }

  private admit(text: string): Buffer | null {
    if (this.broken || this.fd === null) return null
    const buffer = Buffer.from(text, 'utf8')
    if (this.bytes + buffer.byteLength > this.maxBytes) {
      // The limit. Leave one line and drop the rest.
      this.broken = true
      const note = `${JSON.stringify({ ts: new Date().toISOString(), level: 'warn', event: 'log.file.full', bytes: this.bytes })}\n`
      return Buffer.from(note, 'utf8')
    }
    this.bytes += buffer.byteLength
    return buffer
  }

  private writeAsync(text: string): Promise<void> {
    const buffer = this.admit(text)
    const fd = this.fd
    if (buffer === null || fd === null) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const step = (offset: number): void => {
        fsWrite(fd, buffer, offset, buffer.byteLength - offset, null, (err, written) => {
          if (err !== null) {
            this.fail(err)
            resolve()
            return
          }
          // A partial write almost never happens on a regular file, but if it does, write the rest.
          if (offset + written < buffer.byteLength) step(offset + written)
          else resolve()
        })
      }
      step(0)
    })
  }

  private writeNow(text: string): void {
    const buffer = this.admit(text)
    const fd = this.fd
    if (buffer === null || fd === null) return
    try {
      let offset = 0
      while (offset < buffer.byteLength) offset += writeSync(fd, buffer, offset, buffer.byteLength - offset)
    } catch (err) {
      this.fail(err)
    }
  }

  private fail(err: unknown): void {
    if (this.failed) return
    this.failed = true
    this.broken = true
    this.onError(err)
  }
}
