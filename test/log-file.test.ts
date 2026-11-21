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
  it('起動の時刻 (手元) で aios-YYYYMMDD-HHMMSS.log', () => {
    expect(logFileName(new Date(2026, 9, 3, 7, 5, 9))).toBe('aios-20261003-070509.log')
  })
  it('ログのファイルだけを数える', () => {
    expect(isLogFileName('aios-20261003-070509.log')).toBe(true)
    expect(isLogFileName('aios-reboot.log')).toBe(false)
    expect(isLogFileName('notes.txt')).toBe(false)
  })
})

describe('LogFile', () => {
  it('行は 16 ms まとめてから非同期に書く。flush() で書き切る', async () => {
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

  it('タイマーでも書かれる', async () => {
    const file = new LogFile({ dir, intervalMs: 1 })
    file.append('x')
    await new Promise((resolve) => setTimeout(resolve, 30))
    await file.flush()
    expect(read(file.path)).toEqual(['x'])
    file.dispose()
  })

  it('起動ごとに新しいファイル。古いものは新しいものを含めて 10 個だけ残し、ほかのファイルは触らない', async () => {
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

  it('pruneLogFiles は current を消さない', async () => {
    writeFileSync(join(dir, 'aios-20200101-000000.log'), '')
    writeFileSync(join(dir, 'aios-20300101-000000.log'), '')
    expect(await pruneLogFiles(dir, 1, 'aios-20200101-000000.log')).toBe(0)
    expect(await pruneLogFiles(join(dir, 'missing'), 1)).toBe(0)
  })

  it('置き場が無ければ作る', async () => {
    const nested = join(dir, 'a', 'b')
    const file = new LogFile({ dir: nested })
    file.append('x')
    await file.flush()
    expect(read(file.path)).toEqual(['x'])
    file.dispose()
  })

  it('close() は溜まった分を書き切り、以後の行はその場で書く (app.quit の後の行)', async () => {
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

  it('dispose() (process の exit) は溜まった分を同期で書いて閉じる', () => {
    const file = new LogFile({ dir })
    file.append('pending')
    file.dispose()
    expect(read(file.path)).toEqual(['pending'])
  })

  it('上限を超えたら 1 行残して以後は捨てる', async () => {
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

  it('書けなくなったら 1 回だけ知らせて以後は捨てる', async () => {
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

describe('logger の口', () => {
  it('proc 欄を付け、端末と口の両方に出す', () => {
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

  it('口を差す前の行は溜めておき、差したときに流す', async () => {
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

describe('子プロセスの行の中継', () => {
  it('LineSplitter は行の途中で切れた chunk を繋ぐ', () => {
    const splitter = new LineSplitter()
    expect(splitter.push('{"event":"a"}\n{"ev')).toEqual(['{"event":"a"}'])
    expect(splitter.push('ent":"b"}\n\n')).toEqual(['{"event":"b"}'])
    expect(splitter.push('tail')).toEqual([])
    expect(splitter.end()).toEqual(['tail'])
  })

  it('子の proc は信じず付け直す。ts / level は子のもの', () => {
    const { line, level } = relayLine('{"ts":"T","level":"error","proc":"main","event":"index.x","n":2}', {
      proc: 'index',
      fallback: 'info',
      trusted: true
    })
    expect(level).toBe('error')
    expect(JSON.parse(line)).toEqual({ ts: 'T', level: 'error', proc: 'index', event: 'index.x', n: 2 })
  })

  it('JSON でない行は proc.output で包む (索引は先頭 200 文字、plugin は長さだけ)', () => {
    const raw = `(node:1) Warning: ${'x'.repeat(300)}`
    const index = JSON.parse(relayLine(raw, { proc: 'index', fallback: 'warn', trusted: true }).line)
    expect(index).toMatchObject({ level: 'warn', proc: 'index', event: 'proc.output', bytes: raw.length })
    expect((index as { head: string }).head).toHaveLength(200)
    const plugin = JSON.parse(relayLine('secret value', { proc: 'plugin:p', fallback: 'info', trusted: false }).line)
    expect(plugin).toMatchObject({ proc: 'plugin:p', event: 'proc.output', bytes: 12 })
    expect(plugin).not.toHaveProperty('head')
  })

  it('plugin の JSON の行は値を短く切り、入れ子は捨てる', () => {
    const raw = JSON.stringify({ level: 'info', event: 'p.e', text: 'y'.repeat(500), nested: { a: 1 }, ok: true })
    const out = JSON.parse(relayLine(raw, { proc: 'plugin:p', fallback: 'info', trusted: false }).line) as Record<string, unknown>
    expect((out['text'] as string).length).toBe(200)
    expect(out['nested']).toBe('[dropped]')
    expect(out['ok']).toBe(true)
    expect(out['proc']).toBe('plugin:p')
  })

  it('createRelay は UTF-8 の文字の途中で切れた chunk を化けさせず、ファイルの口まで届ける', () => {
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

  it('writeLogLine は warn / error を stderr に', () => {
    writeLogLine('{}', 'warn')
    expect(process.stderr.write).toHaveBeenCalledWith('{}\n')
  })
})

describe('revealLogFile (設定の「ログのフォルダを開く」)', () => {
  it('いまのファイルを Finder で選ぶ。無ければ false、投げない', () => {
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

describe('置き場', () => {
  it('既定の userData なら app.getPath("logs")、--user-data-dir の複製は <userData>/logs', () => {
    expect(logDirectoryFor({ logs: '/L/aios', userData: '/AS/aios', defaultUserData: true })).toBe('/L/aios')
    expect(logDirectoryFor({ logs: '/L/aios', userData: '/tmp/copy', defaultUserData: false })).toBe('/tmp/copy/logs')
    // 399-1: a copy does not call `app.getPath('logs')` (calling it would create an empty real ~/Library/Logs/aios/), so null comes in.
    expect(logDirectoryFor({ logs: null, userData: '/tmp/copy', defaultUserData: false })).toBe('/tmp/copy/logs')
  })
})
