/**
 * TODO 908 (wave 48 bundle A): 'Open in terminal' on the expired-login badge (`src/main/editor/terminal.ts`).
 *
 * - Only the cwd and the CLI name decided by main are passed. The cwd goes through the choke point (`assertAllowed`); when refused, nothing happens.
 * - The script closes with single quotes (a `'` or space in the cwd does not become an injection). Newlines and NUL are not included.
 * - Does nothing on anything other than macOS. The real Terminal is not started (`openInTerminal` is replaced).
 * - The Adapter returns the CLI name from the compat table, and SessionManager builds the target together with the conversation's cwd.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTerminalWithCli, shellQuote, terminalScript } from '../src/main/editor/terminal.js'
import { ClaudeCodeAdapter } from '../src/main/session/adapter/index.js'
import { loadCompatTable } from '../src/main/session/adapter/compat.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aios-terminal-test-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('shellQuote / terminalScript', () => {
  it('1 引用符で閉じ、中の 1 引用符は閉じ直す', () => {
    expect(shellQuote('/a b/c')).toBe("'/a b/c'")
    expect(shellQuote("/it's")).toBe("'/it'\\''s'")
    const script = terminalScript("/x/'; rm -rf ~; '", 'tool')
    expect(script.startsWith('#!/bin/zsh -il\n')).toBe(true)
    expect(script).toContain("cd -- '/x/'\\''; rm -rf ~; '\\''' || exit 1")
    expect(script).toContain("exec 'tool'")
    // Delete itself and the temp directory first.
    expect(script).toContain('rm -f -- "$0"')
  })
})

describe('openTerminalWithCli', () => {
  const allow = (uri: string): string => decodeURIComponent(new URL(uri).pathname)

  it('関門を通った cwd で .command を書き (0700)、Terminal へ渡す', async () => {
    const opened = vi.fn<(path: string) => Promise<void>>(async () => undefined)
    const ok = await openTerminalWithCli(
      { assertAllowed: allow, platform: 'darwin', tmpRoot: root, openInTerminal: opened },
      { cwd: '/Users/me/my project', command: 'tool' }
    )
    expect(ok).toEqual({ opened: true })
    expect(opened).toHaveBeenCalledTimes(1)
    const path = opened.mock.calls[0]![0]
    expect(path.startsWith(root)).toBe(true)
    expect(path.endsWith('.command')).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o700)
    const body = readFileSync(path, 'utf8')
    expect(body).toContain("cd -- '/Users/me/my project' || exit 1")
    expect(body).toContain("exec 'tool'")
    // `/login` is not typed (we do not perform the login on the user's behalf).
    expect(body).not.toContain('/login')
  })

  it('関門に断られたら何も書かず何も起こさない', async () => {
    const opened = vi.fn<(path: string) => Promise<void>>(async () => undefined)
    const ok = await openTerminalWithCli(
      {
        assertAllowed: () => {
          throw new Error('path-excluded')
        },
        platform: 'darwin',
        tmpRoot: root,
        openInTerminal: opened
      },
      { cwd: '/Users/me/.ssh', command: 'tool' }
    )
    expect(ok).toEqual({ opened: false, reason: 'terminal-cwd-denied' })
    expect(opened).not.toHaveBeenCalled()
    expect(readdirSync(root)).toEqual([])
  })

  it('macOS 以外・対象なし・改行や NUL を含む値は、理由つきで何もしない', async () => {
    const opened = vi.fn<(path: string) => Promise<void>>(async () => undefined)
    const deps = { assertAllowed: allow, tmpRoot: root, openInTerminal: opened }
    const run = (platform: NodeJS.Platform, target: Parameters<typeof openTerminalWithCli>[1]) =>
      openTerminalWithCli({ ...deps, platform }, target)
    const no = (reason: string) => ({ opened: false, reason })
    expect(await run('linux', { cwd: '/a', command: 'tool' })).toEqual(no('terminal-unsupported'))
    expect(await run('darwin', null)).toEqual(no('terminal-no-cwd'))
    expect(await run('darwin', { reason: 'terminal-no-cwd' })).toEqual(no('terminal-no-cwd'))
    expect(await run('darwin', { reason: 'terminal-no-command' })).toEqual(no('terminal-no-command'))
    expect(await run('darwin', { cwd: '/a\nrm -rf ~', command: 'tool' })).toEqual(no('terminal-cwd-denied'))
    expect(await run('darwin', { cwd: '/a', command: 'to\0ol' })).toEqual(no('terminal-no-command'))
    expect(await run('darwin', { cwd: '', command: 'tool' })).toEqual(no('terminal-cwd-denied'))
    expect(opened).not.toHaveBeenCalled()
  })

  it('渡せなかったら一時ディレクトリを自分で消して false', async () => {
    const ok = await openTerminalWithCli(
      {
        assertAllowed: allow,
        platform: 'darwin',
        tmpRoot: root,
        openInTerminal: async () => {
          throw new Error('open failed')
        }
      },
      { cwd: '/a', command: 'tool' }
    )
    expect(ok).toEqual({ opened: false, reason: 'terminal-open-failed' })
    expect(readdirSync(root)).toEqual([])
  })
})

describe('Adapter の terminalCommand', () => {
  it('CLI の名前は compat 表のもの (制約 6: 名前は Adapter と compat だけが知る)', () => {
    expect(new ClaudeCodeAdapter().terminalCommand()).toBe(loadCompatTable().command)
  })
})
