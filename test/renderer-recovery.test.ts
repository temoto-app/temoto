/**
 * TODO 1308: the decision of the automatic renderer reload (pure) and the masked problem report.
 */
import { describe, expect, it } from 'vitest'
import {
  decideRecovery,
  RECOVERY_MAX_RELOADS,
  RECOVERY_WINDOW_MS
} from '../src/main/renderer-recovery.js'
import { buildProblemReport, problemReportFileName, sanitizeLogLine } from '../src/common/problem-report.js'
import { NATIVE_DICTIONARIES } from '../src/main/i18n-native.js'

describe('decideRecovery', () => {
  const base = { now: 1_000_000, history: [] as number[], shuttingDown: false }

  it.each(['crashed', 'abnormal-exit', 'killed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'])(
    'reloads after %s',
    (reason) => {
      const d = decideRecovery({ ...base, reason })
      expect(d.action).toBe('reload')
      expect(d.history).toEqual([base.now])
    }
  )

  it('never reloads a clean exit', () => {
    expect(decideRecovery({ ...base, reason: 'clean-exit' }).action).toBe('skip')
  })

  it('never reloads while the app or the window is shutting down', () => {
    expect(decideRecovery({ ...base, reason: 'crashed', shuttingDown: true }).action).toBe('skip')
  })

  it('gives up after repeated crashes inside the window', () => {
    let history: readonly number[] = []
    for (let i = 0; i < RECOVERY_MAX_RELOADS; i++) {
      const d = decideRecovery({ reason: 'crashed', now: 1000 + i, history, shuttingDown: false })
      expect(d.action).toBe('reload')
      history = d.history
    }
    const last = decideRecovery({ reason: 'crashed', now: 2000, history, shuttingDown: false })
    expect(last.action).toBe('give-up')
    expect(last.history).toEqual(history)
  })

  it('forgets old reloads so a rare crash is always recovered', () => {
    const old = [1000, 1001, 1002]
    const d = decideRecovery({ reason: 'crashed', now: 1002 + RECOVERY_WINDOW_MS, history: old, shuttingDown: false })
    expect(d.action).toBe('reload')
    expect(d.history).toEqual([1002 + RECOVERY_WINDOW_MS])
  })
})

describe('problem report', () => {
  const HOME = '/Users/alice'
  const build = { version: '0.99.0', commit: 'abc123', dirty: false, date: '2026-11-22T10:00:00+09:00' }
  const runtime = { electron: '40.0.0', chromium: '140', node: '24', v8: '14', os: 'Darwin arm64 25.6.0' }
  const row = (o: Record<string, unknown>): string => JSON.stringify({ ts: '2026-11-22T01:00:00Z', level: 'info', ...o })
  const make = (lines: string[], extra: Partial<Parameters<typeof buildProblemReport>[0]> = {}): Promise<string> =>
    buildProblemReport({
      productName: 'Temoto',
      build,
      runtime,
      logs: [{ name: 'aios-20261122-100000.log', text: lines.join('\n') }],
      homeDir: HOME,
      userName: 'alice',
      now: new Date(2026, 10, 22, 12, 0, 0),
      ...extra
    })

  it('masks the home directory, other users, secrets and e-mail addresses', async () => {
    const text = await make([
      row({ event: 'file.read', path: '/Users/alice/git/secret-project/a.ts' }),
      row({ event: 'x', path: '/Users/bob/doc.txt', note: 'contact alice@example.com' }),
      row({ event: 'auth', message: 'Authorization: Bearer abcdefghijklmnop1234567890' }),
      row({ event: 'k', message: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' })
    ])
    expect(text).toContain('~/git/secret-project/a.ts')
    expect(text).not.toContain('alice')
    expect(text).not.toContain('bob')
    expect(text).not.toContain('example.com')
    expect(text).not.toContain('abcdefghijklmnop1234567890')
    expect(text).not.toContain('sk-ant-api03')
  })

  it('never includes conversation text, tool results, prompts or credentials fields', async () => {
    const text = await make([
      row({ event: 'turn', text: 'MY PRIVATE PROMPT', prompt: 'SECRET PROMPT', body: 'BODY', content: 'CONTENT' }),
      row({ event: 'tool', tool_result: 'RESULT DATA', toolResult: 'RESULT2', result: 'RESULT3', input: 'INPUT', args: 'ARGS' }),
      row({ event: 'cred', token: 'TOK', password: 'PW', apiKey: 'KEY', cookie: 'COOKIE', authorization: 'AUTH' })
    ])
    for (const leaked of ['PRIVATE PROMPT', 'SECRET PROMPT', 'BODY', 'CONTENT', 'RESULT', 'INPUT', 'ARGS', 'TOK"', 'PW', 'KEY"', 'COOKIE', 'AUTH"']) {
      expect(text).not.toContain(leaked)
    }
    expect(text).toContain('"event":"turn"')
  })

  it('drops lines that are not JSON log rows (they could hold anything) and counts them', async () => {
    const text = await make(['Some raw stderr with a user message', 'not json {', row({ event: 'ok' })])
    expect(text).not.toContain('raw stderr')
    expect(text).toContain('2 non-log lines left out')
  })

  it('lists crash records in their own section with the reason code', async () => {
    const text = await make([
      row({ event: 'window.opened' }),
      row({ level: 'warn', event: 'window.renderer.gone', reason: 'crashed', exitCode: 11, action: 'reload' }),
      row({ level: 'warn', event: 'process.child.gone', type: 'GPU', reason: 'killed', exitCode: 9 })
    ])
    const section = text.split('## Recent log')[0] ?? ''
    expect(section).toContain('"reason":"crashed"')
    expect(section).toContain('"type":"GPU"')
    expect(section).not.toContain('window.opened')
  })

  it('has the version, build and OS, and says nothing was sent', async () => {
    const text = await make([])
    expect(text).toContain('version: 0.99.0')
    expect(text).toContain('commit: abc123')
    expect(text).toContain('os: Darwin arm64 25.6.0')
    expect(text).toContain('Nothing in this file was sent anywhere')
    expect(text).toContain('(none in the kept logs)')
  })

  it('keeps the newest lines when over the budget', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => row({ event: `e${i}` }))
    const text = await make(lines, { budgetBytes: 400 })
    expect(text).toContain('older lines left out')
    expect(text).toContain('"event":"e49"')
    expect(text).not.toContain('"event":"e0"')
  })

  it('sanitizeLogLine returns null for non-objects', () => {
    expect(sanitizeLogLine('[1,2]', HOME, 'alice')).toBeNull()
    expect(sanitizeLogLine('plain', HOME, 'alice')).toBeNull()
  })

  it('file name sorts by time', () => {
    expect(problemReportFileName(new Date(2026, 10, 22, 9, 5, 7))).toBe('problem-report-20261122-090507.txt')
  })

  it('has EN and JA words for the Help menu item', () => {
    expect(NATIVE_DICTIONARIES.en['menu.reportProblem']).toBe('Report a Problem')
    expect(NATIVE_DICTIONARIES.ja['menu.reportProblem']).toBe('問題を報告')
  })
})
