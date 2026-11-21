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

describe('shellCommandOf - only a leading half-width ! (item 116)', () => {
  it('returns what follows ! as the command (surrounding whitespace dropped)', () => {
    expect(shellCommandOf('!ls -la')).toBe('ls -la')
    expect(shellCommandOf('! git status  ')).toBe('git status')
    expect(shellCommandOf('!echo a\necho b')).toBe('echo a\necho b')
  })

  it('! alone, !!, full-width !, a leading space and a ! in the middle are out of scope', () => {
    expect(shellCommandOf('!')).toBeNull()
    expect(shellCommandOf('!   ')).toBeNull()
    expect(shellCommandOf('!!')).toBeNull()
    expect(shellCommandOf('!!ls')).toBeNull()
    expect(shellCommandOf('！ls')).toBeNull()
    expect(shellCommandOf(' !ls')).toBeNull()
    expect(shellCommandOf('すごい!ls')).toBeNull()
    expect(shellCommandOf('')).toBeNull()
  })

  it('the look switches from the single character ! (!! and full-width do not switch)', () => {
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

describe('formatShellContext - wraps in the same form as bash mode (the real compat table)', () => {
  const table = loadCompatTable().shellInput

  it('in the order caveat -> input -> output (with exit code). Multiple ones are oldest first', () => {
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

  it('no cwd or unable to start takes the Command failed form', () => {
    expect(formatShellContext(table, [run({ status: 'no-cwd', exitCode: null })])).toContain(
      '<bash-stderr>Command failed: working directory not found</bash-stderr>'
    )
    expect(
      formatShellContext(table, [run({ status: 'failed', exitCode: null, errorCode: 'ENOENT' })])
    ).toContain('<bash-stderr>Command failed: ENOENT</bash-stderr>')
  })

  it('a timeout adds the seconds to the end of stderr, and the exit code is empty', () => {
    const text = formatShellContext(table, [
      run({ status: 'timeout', exitCode: null, stdout: 'partial', stderr: 'warn' })
    ])
    expect(text).toContain('<bash-stderr>warn\nCommand timed out after 120s</bash-stderr><bash-exit-code></bash-exit-code>')
  })

  it('does not replace twice a string like {stdout} inside the output', () => {
    const text = formatShellContext(table, [run({ stdout: '{stderr} {exitCode}' })])
    expect(text).toContain('<bash-stdout>{stderr} {exitCode}</bash-stdout>')
  })

  it('an empty string if empty', () => {
    expect(formatShellContext(table, [])).toBe('')
  })

  it('the limit is the same as the Bash tool default (30,000 characters / 120 seconds)', () => {
    expect(shellLimitsOf(table)).toEqual({ maxOutputChars: 30_000, timeoutMs: 120_000 })
  })
})

describe('clip / stripAnsi - output limit and colors', () => {
  it('at or below the limit it is as is, and above it drops the middle and keeps the head and tail', () => {
    expect(clip('abc', 10)).toEqual({ text: 'abc', truncated: false })
    const long = `HEAD${'x'.repeat(100)}TAIL`
    const out = clip(long, 20)
    expect(out.truncated).toBe(true)
    expect(out.text.startsWith('HEAD')).toBe(true)
    expect(out.text.endsWith('TAIL')).toBe(true)
    expect(out.text).toMatch(/\[… 88 chars truncated …\]/)
  })

  it('does not cut in the middle of a surrogate pair', () => {
    const emoji = '😀'.repeat(20)
    const out = clip(emoji, 11)
    expect(out.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
    expect(out.text).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/)
  })

  it('drops color control sequences and CRLF', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red')
    expect(clip('a\r\nb', 100).text).toBe('a\nb')
  })
})

describe('runShellCommand - the real /bin/zsh (does not call the model)', () => {
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

  it('runs in cwd and returns stdout / stderr / exit code', async () => {
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

  it('ok when it ends with 0', async () => {
    const result = await runShellCommand({ command: 'true', cwd: dir, ...limits })
    expect(result).toMatchObject({ status: 'ok', exitCode: 0, errorCode: null })
  })

  it('the command is passed as one argument (aios does not build the string)', async () => {
    const result = await runShellCommand({ command: "printf '%s|' \"a b\" 'c'", cwd: dir, ...limits })
    expect(result.stdout).toContain('a b|c|')
  })

  it('stdin is closed immediately (does not hang on a command that waits for input)', async () => {
    const result = await runShellCommand({ command: 'cat; echo done-D', cwd: dir, ...limits })
    expect(result.status).toBe('ok')
    expect(result.stdout).toContain('done-D')
  })

  it('without cwd it does not run and returns no-cwd', async () => {
    const result = await runShellCommand({ command: 'echo x', cwd: join(dir, 'missing'), ...limits })
    expect(result).toMatchObject({ status: 'no-cwd', exitCode: null, stdout: '' })
  })

  it('a timeout stops the whole process group and returns timeout (output remains up to that point)', async () => {
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

  it('stops on a stop signal (exit, thread deletion)', async () => {
    const controller = new AbortController()
    const pending = runShellCommand({ command: 'sleep 30', cwd: dir, ...limits, signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    const result = await pending
    expect(result).toMatchObject({ status: 'failed', errorCode: 'ABORTED' })
  })

  it('even if a background child holds the pipe, once zsh ends it returns ok after a grace period (500 ms) and stops the background child (TODO 576)', async () => {
    const started = Date.now()
    const result = await runShellCommand({ command: '(sleep 5 &); echo done-D', cwd: dir, ...limits })
    expect(result).toMatchObject({ status: 'ok', exitCode: 0, errorCode: null })
    expect(result.stdout).toContain('done-D')
    expect(Date.now() - started).toBeLessThan(1_000 + LOGIN_SHELL_SLACK_MS)
  })

  it("returns zsh's exit code even after the grace period (TODO 576)", async () => {
    const result = await runShellCommand({ command: 'sleep 5 & echo bg-D; exit 4', cwd: dir, ...limits })
    expect(result).toMatchObject({ status: 'exit', exitCode: 4 })
    expect(result.stdout).toContain('bg-D')
    expect(result.durationMs).toBeLessThan(1_000 + LOGIN_SHELL_SLACK_MS)
  })

  it('output over the limit drops the middle and sets truncated', async () => {
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
