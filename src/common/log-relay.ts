/**
 * Relays the stdout / stderr of child processes (index process, plugin-host) into main's log (TODO 376, 12.9.1).
 *
 * Children do not write files. main reads the pipe and, line by line, **re-attaches** the `proc` field
 * (a child's self-report is not trusted) and hands the line to `writeLogLine`. Output to both the terminal and the file happens from there on.
 *
 * - **A pipe's `data` can be cut in the middle of a line.** The earlier relay (`relay` in `client.ts`) did a
 *   `split('\n')` per chunk, so a line spanning 64 KiB or a line during backpressure became two broken lines.
 *   `LineSplitter` carries the partial line to the next chunk.
 * - **Lines that are not JSON** (Node's own warnings, output of native modules) are wrapped as `proc.output`.
 *   They may contain values, so only the first 200 characters are kept (same idea as 12.9's "only the first line of a plugin's stderr").
 * - **Plugin lines are not trusted** (`trusted: false`): plugin code runs in the same process and
 *   can print anything with `console.log`. For a non-JSON line only the length is kept, and for a JSON line the field values are cut short.
 */
import { writeLogLine, type LogLevel } from './logger.js'
import { LineReader } from './line-reader.js'

const HEAD_CHARS = 200
/** If the partial line exceeds this (a huge output with no newline), it is cut there as one line. */
const MAX_PENDING_CHARS = 64 * 1024

/** Assembles string chunks into lines (the partial line is carried to the next). The body is `line-reader.ts` (shared in TODO 565). */
export class LineSplitter extends LineReader {
  constructor() {
    super({ maxPendingChars: MAX_PENDING_CHARS, overflow: 'split' })
  }
}

const LEVEL_NAMES: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

function isLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LEVEL_NAMES as readonly string[]).includes(value)
}

export interface RelayOptions {
  /** The `proc` to attach (`index` / `plugin:<id>`). It overwrites a `proc` that the child's line may carry. */
  readonly proc: string
  /** Level for lines that are not JSON or have no `level` (stdout is info, stderr is warn). */
  readonly fallback: LogLevel
  /** Whether to trust the child's code. false for plugins (values are cut short, and a non-JSON line keeps only its length). */
  readonly trusted: boolean
}

/** Rebuilds one child line into one line of main's log. */
export function relayLine(raw: string, options: RelayOptions): { line: string; level: LogLevel } {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
  let parsed: unknown = null
  if (line.startsWith('{')) {
    try {
      parsed = JSON.parse(line)
    } catch {
      parsed = null
    }
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    if (typeof record['event'] === 'string') {
      const level = isLevel(record['level']) ? record['level'] : options.fallback
      const out: Record<string, unknown> = {
        ts: typeof record['ts'] === 'string' ? record['ts'] : new Date().toISOString(),
        level,
        proc: options.proc
      }
      for (const [key, value] of Object.entries(record)) {
        if (key === 'ts' || key === 'level' || key === 'proc') continue
        if (options.trusted) out[key] = value
        else out[key] = untrustedValue(value)
      }
      return { line: JSON.stringify(out), level }
    }
  }
  const out: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level: options.fallback,
    proc: options.proc,
    event: 'proc.output',
    bytes: Buffer.byteLength(line, 'utf8')
  }
  if (options.trusted) out['head'] = line.slice(0, HEAD_CHARS)
  return { line: JSON.stringify(out), level: options.fallback }
}

/** A plugin's field value: plain values only, strings cut to the first 200 characters. Nested values are dropped. */
function untrustedValue(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, HEAD_CHARS)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  return '[dropped]'
}

/**
 * Creates the entry point that relays one child pipe. Pass `data` chunks to the returned function.
 * `end()` is for when the pipe closes (it flushes the partial line).
 */
export function createRelay(options: RelayOptions): { push(chunk: Buffer | string): void; end(): void } {
  // A chunk boundary can fall in the middle of a UTF-8 character. `toString` would garble both sides.
  // `LineSplitter` (= `LineReader`) holds a `StringDecoder`.
  const splitter = new LineSplitter()
  const write = (raw: string): void => {
    const { line, level } = relayLine(raw, options)
    writeLogLine(line, level)
  }
  return {
    push(chunk) {
      for (const raw of splitter.push(chunk)) write(raw)
    },
    end() {
      for (const raw of splitter.end()) write(raw)
    }
  }
}
