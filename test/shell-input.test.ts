/**
 * The `!` in the prompt field (item 116, ARCHITECTURE.md 4.5.7).
 *
 * - `shellCommandOf` / `isShellDraft` (the check shared by the renderer and main)
 * - `formatShellContext` (fills the compat table's template; checked with **the real compat table**)
 * - `clip` / `stripAnsi` (the output limit and control sequences)
 * - `runShellCommand` with the **real /bin/zsh** (in a temp directory. Neither a model nor the CLI is called)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ShellRunPayload } from '../src/shared/agent.js'
import { isShellDraft, shellCommandOf } from '../src/shared/shell-input.js'
import { loadCompatTable } from '../src/main/session/adapter/compat.js'
import { formatShellContext, shellLimitsOf } from '../src/main/session/adapter/shell-context.js'
import { clip, runShellCommand, stripAnsi } from '../src/main/session/shell-run.js'

describe('shellCommandOf — 先頭の半角 ! だけ (項目 116)', () => {
  it('! の後ろをコマンドとして返す (前後の空白は落とす)', () => {
    expect(shellCommandOf('!ls -la')).toBe('ls -la')
    expect(shellCommandOf('! git status  ')).toBe('git status')
    expect(shellCommandOf('!echo a\necho b')).toBe('echo a\necho b')
  })

  it('! だけ・!! ・全角！・前に空白・途中の ! は対象外', () => {
    expect(shellCommandOf('!')).toBeNull()
    expect(shellCommandOf('!   ')).toBeNull()
    expect(shellCommandOf('!!')).toBeNull()
    expect(shellCommandOf('!!ls')).toBeNull()
    expect(shellCommandOf('！ls')).toBeNull()
    expect(shellCommandOf(' !ls')).toBeNull()
    expect(shellCommandOf('すごい!ls')).toBeNull()
    expect(shellCommandOf('')).toBeNull()
  })

  it('見た目の切り替えは ! 1 文字から (!! と全角は切り替えない)', () => {
    expect(isShellDraft('!')).toBe(true)
    expect(isShellDraft('!ls')).toBe(true)
    expect(isShellDraft('!!')).toBe(false)
    expect(isShellDraft('！')).toBe(false)
    expect(isShellDraft('ls')).toBe(false)
  })
})

const run = (over: Partial<ShellRunPayload>): ShellRunPayload => ({
  command: 'ls',
  stdout: '',
  stderr: '',
  exitCode: 0,
  status: 'ok',
  truncated: false,
  durationMs: 1,
  errorCode: null,
  ...over
})

describe('formatShellContext — bash モードと同じ形に包む (実物の compat 表)', () => {
  const table = loadCompatTable().shellInput

  it('caveat → 入力 → 出力 (終了コード付き) の順。複数は古い順', () => {
    const text = formatShellContext(table, [
      run({ command: 'ls', stdout: 'a\nb\n' }),
      run({ command: 'false', status: 'exit', exitCode: 1, stderr: 'oops' })
    ])
    const lines = text.split('\n')
    expect(lines[0]).toMatch(/^<local-command-caveat>.*<\/local-command-caveat>$/)
    expect(text).toContain('<bash-input>ls</bash-input>\n<bash-stdout>a\nb\n</bash-stdout><bash-stderr></bash-stderr><bash-exit-code>0</bash-exit-code>')
    expect(text).toContain('<bash-input>false</bash-input>\n<bash-stdout></bash-stdout><bash-stderr>oops</bash-stderr><bash-exit-code>1</bash-exit-code>')
    expect(text.indexOf('<bash-input>ls')).toBeLessThan(text.indexOf('<bash-input>false'))
  })

  it('cwd が無い・起動できないは Command failed の形', () => {
    expect(formatShellContext(table, [run({ status: 'no-cwd', exitCode: null })])).toContain(
      '<bash-stderr>Command failed: working directory not found</bash-stderr>'
    )
    expect(
      formatShellContext(table, [run({ status: 'failed', exitCode: null, errorCode: 'ENOENT' })])
    ).toContain('<bash-stderr>Command failed: ENOENT</bash-stderr>')
  })

  it('時間切れは stderr の末尾に秒数を添え、終了コードは空', () => {
    const text = formatShellContext(table, [
      run({ status: 'timeout', exitCode: null, stdout: 'partial', stderr: 'warn' })
    ])
    expect(text).toContain('<bash-stderr>warn\nCommand timed out after 120s</bash-stderr><bash-exit-code></bash-exit-code>')
  })

  it('出力の中の {stdout} のような文字列を二度置き換えない', () => {
    const text = formatShellContext(table, [run({ stdout: '{stderr} {exitCode}' })])
    expect(text).toContain('<bash-stdout>{stderr} {exitCode}</bash-stdout>')
  })

  it('空なら空文字列', () => {
    expect(formatShellContext(table, [])).toBe('')
  })

  it('上限は Bash ツールの既定と同じ (30,000 文字 / 120 秒)', () => {
    expect(shellLimitsOf(table)).toEqual({ maxOutputChars: 30_000, timeoutMs: 120_000 })
  })
})

describe('clip / stripAnsi — 出力の上限と色', () => {
  it('上限以下はそのまま、超えたら間を落として頭と尻を残す', () => {
    expect(clip('abc', 10)).toEqual({ text: 'abc', truncated: false })
    const long = `HEAD${'x'.repeat(100)}TAIL`
    const out = clip(long, 20)
    expect(out.truncated).toBe(true)
    expect(out.text.startsWith('HEAD')).toBe(true)
    expect(out.text.endsWith('TAIL')).toBe(true)
    expect(out.text).toMatch(/\[… 88 chars truncated …\]/)
  })

  it('サロゲートペアの途中で切らない', () => {
    const emoji = '😀'.repeat(20)
    const out = clip(emoji, 11)
    expect(out.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
    expect(out.text).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/)
  })

  it('色の制御シーケンスと CRLF を落とす', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red')
    expect(clip('a\r\nb', 100).text).toBe('a\nb')
  })
})

describe('runShellCommand — 実物の /bin/zsh (モデルは呼ばない)', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'aios-shell-D-'))
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  const limits = { maxOutputChars: 30_000, timeoutMs: 10_000 }
  /** A login shell (`-l`) start depends on local settings, so allow for the extra time it takes when all tests run in parallel. */
  const LOGIN_SHELL_SLACK_MS = 1_000

  it('cwd で走り、stdout / stderr / 終了コードを返す', async () => {
    const result = await runShellCommand({
      command: 'pwd; echo out-D; echo err-D >&2; exit 3',
      cwd: dir,
      ...limits
    })
    expect(result.status).toBe('exit')
    expect(result.exitCode).toBe(3)
    // Even if the login shell's config (`-l`) prints something, the command's output is still included.
    expect(result.stdout).toContain('out-D')
    expect(result.stdout).toContain(dir.split('/').at(-1))
    expect(result.stderr).toContain('err-D')
  })

  it('0 で終われば ok', async () => {
    const result = await runShellCommand({ command: 'true', cwd: dir, ...limits })
    expect(result).toMatchObject({ status: 'ok', exitCode: 0, errorCode: null })
  })

  it('コマンドは 1 本の引数として渡る (aios 側で文字列を組み立てない)', async () => {
    const result = await runShellCommand({ command: "printf '%s|' \"a b\" 'c'", cwd: dir, ...limits })
    expect(result.stdout).toContain('a b|c|')
  })

  it('stdin はすぐ閉じる (入力を待つコマンドで固まらない)', async () => {
    const result = await runShellCommand({ command: 'cat; echo done-D', cwd: dir, ...limits })
    expect(result.status).toBe('ok')
    expect(result.stdout).toContain('done-D')
  })

  it('cwd が無ければ走らせずに no-cwd', async () => {
    const result = await runShellCommand({ command: 'echo x', cwd: join(dir, 'missing'), ...limits })
    expect(result).toMatchObject({ status: 'no-cwd', exitCode: null, stdout: '' })
  })

  it('時間切れはプロセスグループごと止めて timeout (出力は途中まで残る)', async () => {
    const started = Date.now()
    const result = await runShellCommand({
      command: 'echo before-D; sleep 30 | cat',
      cwd: dir,
      maxOutputChars: 30_000,
      timeoutMs: 1_000
    })
    expect(result.status).toBe('timeout')
    expect(result.exitCode).toBeNull()
    expect(result.stdout).toContain('before-D')
    expect(Date.now() - started).toBeLessThan(8_000)
  })

  it('止める合図 (終了・スレッドの削除) で止まる', async () => {
    const controller = new AbortController()
    const pending = runShellCommand({ command: 'sleep 30', cwd: dir, ...limits, signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    const result = await pending
    expect(result).toMatchObject({ status: 'failed', errorCode: 'ABORTED' })
  })

  it('裏の子が管を握っても、zsh が終われば猶予 (500 ms) の後に ok で返り、裏の子は止める (TODO 576)', async () => {
    const started = Date.now()
    const result = await runShellCommand({ command: '(sleep 5 &); echo done-D', cwd: dir, ...limits })
    expect(result).toMatchObject({ status: 'ok', exitCode: 0, errorCode: null })
    expect(result.stdout).toContain('done-D')
    expect(Date.now() - started).toBeLessThan(1_000 + LOGIN_SHELL_SLACK_MS)
  })

  it('猶予の後でも zsh の終了コードを返す (TODO 576)', async () => {
    const result = await runShellCommand({ command: 'sleep 5 & echo bg-D; exit 4', cwd: dir, ...limits })
    expect(result).toMatchObject({ status: 'exit', exitCode: 4 })
    expect(result.stdout).toContain('bg-D')
    expect(result.durationMs).toBeLessThan(1_000 + LOGIN_SHELL_SLACK_MS)
  })

  it('上限を超えた出力は間を落とし、truncated を立てる', async () => {
    const result = await runShellCommand({
      command: 'seq 1 20000',
      cwd: dir,
      maxOutputChars: 1_000,
      timeoutMs: 10_000
    })
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThan(1_100)
    expect(result.stdout).toContain('20000')
  })
})
