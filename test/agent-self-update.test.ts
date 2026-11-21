/**
 * TODO 774 (wave 36 bundle D): the entry point for the CLI's own update (`src/main/session/adapter/self-update.ts`).
 *
 * **The real CLI is not called** — the table's `command` is replaced with a fake CLI (a sh script) placed in a temp directory. The fake answers the version
 * with `--version` from the state file, and rewrites the state file on `update` / `install <version>` (the script is chosen by a `mode` file next to
 * the state file, not by an environment variable — the runner does not pass env).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCompatTable, type CompatTable, type SelfUpdateTable } from '../src/main/session/adapter/compat.js'
import { setLogSink } from '../src/common/logger.js'
import type { KeychainMeta } from '../src/main/session/adapter/auth-diagnostics.js'
import { CliSelfUpdate, judge, keychainChanged, runCommand, signalFailure } from '../src/main/session/adapter/self-update.js'

let dir = ''

const SCRIPT = `#!/bin/sh
here="$(dirname "$0")"
state="$here/version"
mode="$(cat "$here/mode" 2>/dev/null)"
echo "$*" >> "$here/calls"
if [ "$1" = "--version" ]; then
  if [ "$mode" = "noversion" ]; then exit 1; fi
  echo "$(cat "$state") (Fake Code)"
  exit 0
fi
if [ "$1" = "update" ]; then
  case "$mode" in
    newer) echo "Current version: $(cat "$state")"; echo "2.1.300" > "$state"; echo "Successfully updated"; exit 0 ;;
    same) echo "Claude Code is up to date"; exit 0 ;;
    managed) echo "Claude is managed by Homebrew."; echo "To update, run: brew upgrade"; exit 0 ;;
    busy) echo "Another Claude process (PID 1) is currently running. Please try again in a moment."; exit 0 ;;
    disabled) echo "Updates are disabled by your administrator."; exit 0 ;;
    permission) echo "Error: Insufficient permissions to install update" >&2; exit 1 ;;
    fail) echo "Failed to check for updates" >&2; exit 1 ;;
    slow) sleep 5; exit 0 ;;
    newer-then-fail) echo "2.1.300" > "$state"; exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = "install" ]; then
  if [ "$mode" = "stuck" ]; then exit 0; fi
  echo "$2" > "$state"
  exit 0
fi
exit 2
`

function table(command: string): CompatTable {
  // Do not call the real `security`: the keychain item name is left out ('unconfigured').
  const { authFailure: _unused, ...base } = loadCompatTable()
  void _unused
  return { ...base, command }
}

function spec(overrides: Partial<SelfUpdateTable> = {}): SelfUpdateTable {
  const base = loadCompatTable().selfUpdate
  if (base === undefined) throw new Error('compat の selfUpdate が無い')
  return { ...base, ...overrides }
}

function setup(version: string, mode: string): string {
  writeFileSync(join(dir, 'version'), `${version}\n`)
  writeFileSync(join(dir, 'mode'), mode)
  const cli = join(dir, 'fake-cli')
  writeFileSync(cli, SCRIPT)
  chmodSync(cli, 0o755)
  return cli
}

function calls(): string[] {
  try {
    return readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')
  } catch {
    return []
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-774-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('CliSelfUpdate (偽の CLI)', () => {
  it('compat の表に selfUpdate がある (update / install のサブコマンド)', () => {
    const s = spec()
    expect(s.updateArgs.length).toBeGreaterThan(0)
    expect(s.installArgs.length).toBeGreaterThan(0)
    expect(s.timeoutMs).toBeGreaterThan(0)
  })

  it('版が変わったら updated (前後の --version で判定)', async () => {
    const cli = setup('2.1.280', 'newer')
    const run = await new CliSelfUpdate(table(cli), spec()).update()
    expect(run).toEqual({ outcome: 'updated', before: '2.1.280', after: '2.1.300' })
    expect(calls()).toEqual(['--version', ...spec().updateArgs, '--version'])
  })

  it('exit 0 で版が変わらなければ unchanged', async () => {
    const cli = setup('2.1.296', 'same')
    const run = await new CliSelfUpdate(table(cli), spec()).update()
    expect(run).toEqual({ outcome: 'unchanged', before: '2.1.296', after: '2.1.296' })
  })

  it('パッケージマネージャの管理・別の更新中・管理者の停止は exit 0 でも failed (入れていない)', async () => {
    for (const [mode, failure] of [
      ['managed', 'agent-update-managed'],
      ['busy', 'agent-update-busy'],
      ['disabled', 'agent-update-disabled']
    ] as const) {
      const cli = setup('2.1.280', mode)
      const run = await new CliSelfUpdate(table(cli), spec()).update()
      expect(run.outcome).toBe('failed')
      expect(run.outcome === 'failed' ? run.failure : null).toBe(failure)
    }
  })

  it('権限が無い (npm の global) は agent-update-permission、それ以外の失敗は終了コード付き', async () => {
    let cli = setup('2.1.280', 'permission')
    let run = await new CliSelfUpdate(table(cli), spec()).update()
    expect(run.outcome === 'failed' ? run.failure : null).toBe('agent-update-permission')
    cli = setup('2.1.280', 'fail')
    run = await new CliSelfUpdate(table(cli), spec()).update()
    expect(run).toMatchObject({ outcome: 'failed', failure: 'agent-update-failed', params: { exitCode: 1 } })
  })

  it('入れ終わってから非 0 で終わっても、版が変わっていれば updated', async () => {
    const cli = setup('2.1.280', 'newer-then-fail')
    const run = await new CliSelfUpdate(table(cli), spec()).update()
    expect(run).toEqual({ outcome: 'updated', before: '2.1.280', after: '2.1.300' })
  })

  it('時間切れは止めて agent-update-timeout', async () => {
    const cli = setup('2.1.280', 'slow')
    const started = Date.now()
    const run = await new CliSelfUpdate(table(cli), spec({ timeoutMs: 200 })).update()
    expect(run.outcome === 'failed' ? run.failure : null).toBe('agent-update-timeout')
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('実行ファイルが無ければ agent-update-unavailable', async () => {
    const run = await new CliSelfUpdate(table(join(dir, 'missing-cli')), spec()).update()
    expect(run.outcome === 'failed' ? run.failure : null).toBe('agent-update-unavailable')
  })

  it('install は指定した版に切り替わったかで判定する', async () => {
    let cli = setup('2.1.300', 'ok')
    let run = await new CliSelfUpdate(table(cli), spec()).install('2.1.280')
    expect(run).toEqual({ outcome: 'updated', before: '2.1.300', after: '2.1.280' })
    expect(calls()).toContain([...spec().installArgs, '2.1.280'].join(' '))
    cli = setup('2.1.300', 'stuck')
    run = await new CliSelfUpdate(table(cli), spec()).install('2.1.280')
    expect(run).toMatchObject({ outcome: 'failed', failure: 'agent-update-not-switched', params: { version: '2.1.280' } })
  })

  it('install は版の形でなければ CLI を呼ばない (旗やサブコマンドを紛れ込ませない)', async () => {
    const cli = setup('2.1.300', 'ok')
    const run = await new CliSelfUpdate(table(cli), spec()).install('--force')
    expect(run.outcome).toBe('failed')
    expect(calls()).toEqual([])
  })

  it('CLI 自身の自動更新を止める環境変数があれば autoBlockedByBackend', () => {
    const t = table('x')
    const names = spec().autoDisableEnv ?? []
    expect(names.length).toBeGreaterThan(0)
    expect(new CliSelfUpdate(t, spec(), { env: {} }).autoBlockedByBackend()).toBe(false)
    expect(new CliSelfUpdate(t, spec(), { env: { [names[0] ?? '']: '1' } }).autoBlockedByBackend()).toBe(true)
    expect(new CliSelfUpdate(t, spec(), { env: { [names[0] ?? '']: '0' } }).autoBlockedByBackend()).toBe(false)
  })

  it('既知の版の表を引く (未検証の版)', () => {
    const update = new CliSelfUpdate(table('x'), spec())
    expect(update.isKnownVersion('2.1.296')).toBe(true)
    expect(update.isKnownVersion('9.9.9')).toBe(false)
  })
})

describe('judge / signalFailure (純関数)', () => {
  it('表の signals が無ければ出力を読まない', () => {
    expect(signalFailure({ updateArgs: [], installArgs: [], timeoutMs: 1 }, 'is managed by')).toBeNull()
  })

  it('前の版が取れず後が取れただけでは updated にしない (上がったか分からない)', () => {
    const result = { code: 0, output: '', timedOut: false, spawnError: null }
    expect(judge(spec(), result, null, '2.1.300', null)).toEqual({ outcome: 'unchanged', before: null, after: '2.1.300' })
  })

  it('版が取れず exit 0 なら agent-update-unavailable (最新とは言わない)', () => {
    const result = { code: 0, output: '', timedOut: false, spawnError: null }
    expect(judge(spec(), result, '2.1.280', null, null)).toMatchObject({
      outcome: 'failed',
      failure: 'agent-update-unavailable'
    })
  })
})

describe('runCommand の出力 (head と tail)', () => {
  it('head の境界をまたぐ塊の残りも拾う (末尾の語を取りこぼさない)', async () => {
    const script = "process.stdout.write('a'.repeat(65000)); process.stdout.write('b'.repeat(2000) + 'is managed by')"
    const result = await runCommand(process.execPath, ['-e', script], 10_000)
    expect(result.output).toContain('is managed by')
  })
})

describe('TODO 1165: 更新の前後のキーチェーンの属性', () => {
  const meta = (modifiedAt: string): KeychainMeta => ({
    state: 'found',
    service: 'secret-service-name',
    modifiedAt,
    createdAt: '2026-01-01T00:00:00Z',
    exitCode: 0
  })

  function capture(): { lines: Record<string, unknown>[]; restore: () => void } {
    const lines: Record<string, unknown>[] = []
    setLogSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>))
    return { lines, restore: () => setLogSink(null) }
  }

  it('前後に 1 回ずつ読み、ログに欄として添える (変わった=true、項目名は出さない)', async () => {
    const cli = setup('2.1.280', 'newer')
    const reads = [meta('2026-11-06T13:00:00Z'), meta('2026-11-06T13:50:31Z')]
    let n = 0
    const cap = capture()
    try {
      const run = await new CliSelfUpdate(table(cli), spec(), { readKeychain: async () => reads[n++] as KeychainMeta }).update()
      expect(run.outcome).toBe('updated')
    } finally {
      cap.restore()
    }
    expect(n).toBe(2)
    const line = cap.lines.filter((l) => l['event'] === 'agent.selfUpdate').at(-1)
    expect(line).toMatchObject({
      keychainBefore: 'found',
      keychainBeforeModifiedAt: '2026-11-06T13:00:00Z',
      keychainAfter: 'found',
      keychainAfterModifiedAt: '2026-11-06T13:50:31Z',
      keychainChanged: true
    })
    expect(JSON.stringify(line)).not.toContain('secret-service-name')
  })

  it('読みが投げても更新は止まらず、欄は null', async () => {
    const cli = setup('2.1.280', 'newer')
    const cap = capture()
    let run
    try {
      run = await new CliSelfUpdate(table(cli), spec(), {
        readKeychain: async () => {
          throw new Error('boom')
        }
      }).update()
    } finally {
      cap.restore()
    }
    expect(run.outcome).toBe('updated')
    const line = cap.lines.filter((l) => l['event'] === 'agent.selfUpdate').at(-1)
    expect(line).toMatchObject({ keychainBefore: null, keychainAfter: null, keychainChanged: null })
  })

  it('keychainChanged: 同じなら false、見つからなければ null', () => {
    expect(keychainChanged(meta('a'), meta('a'))).toBe(false)
    expect(keychainChanged(meta('a'), { ...meta('a'), state: 'not-found' })).toBeNull()
    expect(keychainChanged(null, meta('a'))).toBeNull()
  })
})
