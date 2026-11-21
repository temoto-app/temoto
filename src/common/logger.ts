/**
 * Structured log (one JSON line per entry). IMPLEMENTATION_BRIEF chapter 7.
 *
 * What may be logged is event names, counts, durations and paths.
 * File bodies and argument values are not logged.
 *
 * **It is also kept in a file (TODO 376, ARCHITECTURE.md 12.9.1).** Lines are written to stdout / stderr as before,
 * and are also handed to the sink plugged in with `setLogSink` (main's `LogFile`). It does not depend on electron
 * (P1, lint:index) - main decides the location. The index process and plugin-host have no sink; main relays
 * their stdout / stderr pipes and writes them to the file (`log-relay.ts`).
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogFields = Record<string, string | number | boolean | null | undefined>

/** The entry point that receives one line. A line is JSON with no newline. */
export type LogSink = (line: string, level: LogLevel) => void

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = LEVELS[(process.env['AIOS_LOG_LEVEL'] as LogLevel | undefined) ?? 'info'] ?? 20

/** The `proc` field of each line (`main` / `index` / `plugin:<id>`). If unset the field is omitted (the relay side adds it). */
let procName: string | null = null
let sink: LogSink | null = null
/**
 * Lines from before a sink is plugged in (`app.singleton.retry` right after launch, etc.). They are replayed once one is plugged in.
 * In a process with no sink (index, plugin-host) it simply stops at the limit.
 */
const EARLY_LIMIT = 64
let early: Array<{ line: string; level: LogLevel }> | null = []

export function setLogProc(name: string | null): void {
  procName = name
}

/** Sets where lines go (`null` removes it). Lines that accumulated before plugging in are handed over here. */
export function setLogSink(next: LogSink | null): void {
  sink = next
  const pending = early
  early = null
  if (next !== null && pending !== null) for (const item of pending) next(item.line, item.level)
}

/**
 * Writes an already built line to both the terminal and the sink. The relay of child-process lines (`log-relay.ts`) also goes through here.
 */
export function writeLogLine(line: string, level: LogLevel): void {
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`)
  else process.stdout.write(`${line}\n`)
  if (sink !== null) sink(line, level)
  else if (early !== null && early.length < EARLY_LIMIT) early.push({ line, level })
}

function emit(level: LogLevel, event: string, fields: LogFields = {}): void {
  if (LEVELS[level] < threshold) return
  // `proc` can be overwritten by fields (a line main writes on behalf of a plugin is `plugin:<id>`).
  const head = procName === null ? { ts: new Date().toISOString(), level } : { ts: new Date().toISOString(), level, proc: procName }
  writeLogLine(JSON.stringify({ ...head, event, ...fields }), level)
}

export const log = {
  debug: (event: string, fields?: LogFields) => emit('debug', event, fields),
  info: (event: string, fields?: LogFields) => emit('info', event, fields),
  warn: (event: string, fields?: LogFields) => emit('warn', event, fields),
  error: (event: string, fields?: LogFields) => emit('error', event, fields)
}

/** Extracts from an Error only the minimum information that may be logged. */
export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    return { err: err.name, message: err.message, code: code ?? null }
  }
  return { err: 'unknown', message: String(err) }
}
