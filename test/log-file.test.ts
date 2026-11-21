/**
 * TODO 376: writing the log to a file (ARCHITECTURE.md 12.9.1). Without electron; writes into a temporary directory.
 *
 * - Names, rotation (the latest 10), batched writes every 16 ms, synchronous writes after `close()`, `dispose()`, and the limit
 * - The logger entry point (the `proc` field, and re-sending lines written before the entry point was set)
 * - Relaying lines from child processes (a chunk cut mid-line or mid-UTF-8, reattaching `proc`, and not trusting plugins)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LogFile, isLogFileName, logFileName, pruneLogFiles } from '../src/common/log-file.js'
import { log, setLogProc, setLogSink, writeLogLine } from '../src/common/logger.js'
import { LineSplitter, createRelay, relayLine } from '../src/common/log-relay.js'
import { logDirectoryFor } from '../src/main/log-file.js'
import { revealLogFile } from '../src/main/editor/reveal.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-log-'))
  // Silence terminal output (check the line contents through the file and the entry point).
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  setLogSink(null)
  setLogProc(null)
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const read = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter((line) => line !== '')

describe('logFileName / isLogFileName', () => {
  it('aios-YYYYMMDD-HHMMSS.log by the start time (local)', () => {
    expect(logFileName(new Date(2026, 9, 3, 7, 5, 9))).toBe('aios-20261003-070509.log')
  })
  it('counts only log files', () => {
    expect(isLogFileName('aios-20261003-070509.log')).toBe(true)
    expect(isLogFileName('aios-reboot.log')).toBe(false)
    expect(isLogFileName('notes.txt')).toBe(false)
  })
})

describe('LogFile', () => {
  it('lines are batched for 16 ms and then written asynchronously; flush() writes everything out', async () => {
    const file = new LogFile({ dir, now: () => new Date(2026, 9, 3, 12, 0, 0) })
    expect(file.name).toBe('aios-20261003-120000.log')
    file.append('{"event":"a"}')
    file.append('{"event":"b"}')
    // Not written yet (it is not written synchronously)
    expect(readFileSync(file.path, 'utf8')).toBe('')
    await file.flush()
    expect(read(file.path)).toEqual(['{"event":"a"}', '{"event":"b"}'])
    file.dispose()
  })

  it('it is also written by the timer', async () => {
    const file = new LogFile({ dir, intervalMs: 1 })
    file.append('x')
    await new Promise((resolve) => setTimeout(resolve, 30))
    await file.flush()
    expect(read(file.path)).toEqual(['x'])
    file.dispose()
  })

  it('a new file per launch; keeps only 10 old ones including the new one, and does not touch other files', async () => {
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, `aios-202609${String(10 + i)}-000000.log`), 'old\n')
    writeFileSync(join(dir, 'aios-reboot.log'), 'keep\n')
    const file = new LogFile({ dir, now: () => new Date(2026, 9, 3, 12, 0, 0) })
    expect(await file.pruned).toBe(3)
    const names = readdirSync(dir).sort()
    expect(names.filter(isLogFileName)).toHaveLength(10)
    expect(names).toContain(file.name)
    expect(names).toContain('aios-reboot.log')
    // What disappeared were the three oldest
    expect(names).not.toContain('aios-20260910-000000.log')
    expect(names).not.toContain('aios-20260912-000000.log')
    expect(names).toContain('aios-20260913-000000.log')
    file.dispose()
  })

  it('pruneLogFiles does not delete current', async () => {
    writeFileSync(join(dir, 'aios-20200101-000000.log'), '')
    writeFileSync(join(dir, 'aios-20300101-000000.log'), '')
    expect(await pruneLogFiles(dir, 1, 'aios-20200101-000000.log')).toBe(0)
    expect(await pruneLogFiles(join(dir, 'missing'), 1)).toBe(0)
  })

  it('creates the location if it does not exist', async () => {
    const nested = join(dir, 'a', 'b')
    const file = new LogFile({ dir: nested })
    file.append('x')
    await file.flush()
    expect(read(file.path)).toEqual(['x'])
    file.dispose()
  })

  it('close() writes out what has accumulated, and later lines are written on the spot (lines after app.quit)', async () => {
    const file = new LogFile({ dir })
    file.append('before')
    await file.close()
    expect(read(file.path)).toEqual(['before'])
    file.append('after')
    expect(read(file.path)).toEqual(['before', 'after'])
    file.dispose()
    file.append('ignored')
    expect(read(file.path)).toEqual(['before', 'after'])
  })

  it('dispose() (process exit) writes what has accumulated synchronously and closes', () => {
    const file = new LogFile({ dir })
    file.append('pending')
    file.dispose()
    expect(read(file.path)).toEqual(['pending'])
  })

  it('past the limit, leaves one line and drops the rest', async () => {
    const file = new LogFile({ dir, maxBytes: 20 })
    file.append('0123456789')
    await file.flush()
    file.append('0123456789')
    await file.flush()
    file.append('more')
    await file.flush()
    const lines = read(file.path)
    expect(lines[0]).toBe('0123456789')
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ event: 'log.file.full' })
    expect(lines).toHaveLength(2)
    file.dispose()
  })

  it('if writing becomes impossible, notifies only once and drops the rest', async () => {
    const onError = vi.fn()
    const broken = new LogFile({ dir, onError })
    // Close the fd first (stands in for a file that was deleted or broken)
    closeSync((broken as unknown as { fd: number }).fd)
    broken.append('a')
    await broken.flush()
    broken.append('b')
    await broken.flush()
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

describe('logger sink', () => {
  it('adds the proc field and outputs to both the terminal and the sink', () => {
    const lines: string[] = []
    setLogProc('main')
    setLogSink((line) => lines.push(line))
    log.info('a.b', { n: 1 })
    log.warn('plugin.stderr', { proc: 'plugin:aios.text', bytes: 3 })
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ level: 'info', proc: 'main', event: 'a.b', n: 1 })
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ level: 'warn', proc: 'plugin:aios.text' })
    expect(process.stdout.write).toHaveBeenCalled()
    expect(process.stderr.write).toHaveBeenCalled()
  })

  it('lines before the sink is attached are buffered and flushed when it is attached', async () => {
    vi.resetModules()
    const fresh = await import('../src/common/logger.js')
    fresh.log.info('early.one')
    const lines: string[] = []
    fresh.setLogSink((line) => lines.push(line))
    fresh.log.info('later')
    expect(lines.map((line) => (JSON.parse(line) as { event: string }).event)).toEqual(['early.one', 'later'])
    fresh.setLogSink(null)
  })
})

describe("relaying a child process's lines", () => {
  it('LineSplitter joins chunks cut in the middle of a line', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('{"event":"a"}\n{"ev')).toEqual(['{"event":"a"}'])
    expect(splitter.push('ent":"b"}\n\n')).toEqual(['{"event":"b"}'])
    expect(splitter.push('tail')).toEqual([])
    expect(splitter.end()).toEqual(['tail'])
  })

  it("the child's proc is not trusted and is reattached; ts / level are the child's", () => {
    const { line, level } = relayLine('{"ts":"T","level":"error","proc":"main","event":"index.x","n":2}', {
      proc: 'index',
      fallback: 'info',
      trusted: true
    })
    expect(level).toBe('error')
    expect(JSON.parse(line)).toEqual({ ts: 'T', level: 'error', proc: 'index', event: 'index.x', n: 2 })
  })

  it('non-JSON lines are wrapped in proc.output (the index keeps the first 200 characters, a plugin only the length)', () => {
    const raw = `(node:1) Warning: ${'x'.repeat(300)}`
    const index = JSON.parse(relayLine(raw, { proc: 'index', fallback: 'warn', trusted: true }).line)
    expect(index).toMatchObject({ level: 'warn', proc: 'index', event: 'proc.output', bytes: raw.length })
    expect((index as { head: string }).head).toHaveLength(200)
    const plugin = JSON.parse(relayLine('secret value', { proc: 'plugin:p', fallback: 'info', trusted: false }).line)
    expect(plugin).toMatchObject({ proc: 'plugin:p', event: 'proc.output', bytes: 12 })
    expect(plugin).not.toHaveProperty('head')
  })

  it("a plugin's JSON lines have values cut short and nesting dropped", () => {
    const raw = JSON.stringify({ level: 'info', event: 'p.e', text: 'y'.repeat(500), nested: { a: 1 }, ok: true })
    const out = JSON.parse(relayLine(raw, { proc: 'plugin:p', fallback: 'info', trusted: false }).line) as Record<string, unknown>
    expect((out['text'] as string).length).toBe(200)
    expect(out['nested']).toBe('[dropped]')
    expect(out['ok']).toBe(true)
    expect(out['proc']).toBe('plugin:p')
  })

  it('createRelay delivers chunks cut in the middle of a UTF-8 character to the file sink without garbling them', () => {
    const lines: string[] = []
    setLogSink((line) => lines.push(line))
    const relay = createRelay({ proc: 'index', fallback: 'info', trusted: true })
    const bytes = Buffer.from('{"level":"info","event":"索引","path":"/日本語"}\n', 'utf8')
    relay.push(bytes.subarray(0, 25))
    relay.push(bytes.subarray(25))
    relay.push(Buffer.from('{"level":"info","event":"end"}', 'utf8'))
    relay.end()
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      { ts: expect.any(String), level: 'info', proc: 'index', event: '索引', path: '/日本語' },
      { ts: expect.any(String), level: 'info', proc: 'index', event: 'end' }
    ])
  })

  it('writeLogLine sends warn / error to stderr', () => {
    writeLogLine('{}', 'warn')
    expect(process.stderr.write).toHaveBeenCalledWith('{}\n')
  })
})

describe('revealLogFile (Settings 「ログのフォルダを開く」)', () => {
  it('selects the current file in Finder; false if there is none, and does not throw', () => {
    const show = vi.fn()
    expect(revealLogFile({ path: '/L/aios/aios-20261003-120000.log', show })).toBe(true)
    expect(show).toHaveBeenCalledWith('/L/aios/aios-20261003-120000.log')
    expect(revealLogFile({ path: null, show })).toBe(false)
    const fails = (): void => {
      throw new Error('no')
    }
    expect(revealLogFile({ path: '/x', show: fails })).toBe(false)
  })
})

describe('location', () => {
  it('with the default userData it is app.getPath("logs"), and a --user-data-dir copy uses <userData>/logs', () => {
    expect(logDirectoryFor({ logs: '/L/aios', userData: '/AS/aios', defaultUserData: true })).toBe('/L/aios')
    expect(logDirectoryFor({ logs: '/L/aios', userData: '/tmp/copy', defaultUserData: false })).toBe('/tmp/copy/logs')
    // 399-1: a copy does not call `app.getPath('logs')` (calling it would create an empty real ~/Library/Logs/aios/), so null comes in.
    expect(logDirectoryFor({ logs: null, userData: '/tmp/copy', defaultUserData: false })).toBe('/tmp/copy/logs')
  })
})
