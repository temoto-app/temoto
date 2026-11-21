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

describe('CliSelfUpdate (fake CLI)', () => {
  it('the compat table has selfUpdate (update / install subcommands)', () => {
    const s = spec()
    expect(s.updateArgs.length).toBeGreaterThan(0)
    expect(s.installArgs.length).toBeGreaterThan(0)
    expect(s.timeoutMs).toBeGreaterThan(0)
  })

  it('returns updated when the version changed (judged by --version before and after)', async () => {
    const cli = setup('2.1.280', 'newer')
    const run = await new CliSelfUpdate(table(cli), spec()).update()
    expect(run).toEqual({ outcome: 'updated', before: '2.1.280', after: '2.1.300' })
    expect(calls()).toEqual(['--version', ...spec().updateArgs, '--version'])
  })

  it('returns unchanged when exit 0 and the version did not change', async () => {
    const cli = setup('2.1.296', 'same')
    const run = await new CliSelfUpdate(table(cli), spec()).update()
    expect(run).toEqual({ outcome: 'unchanged', before: '2.1.296', after: '2.1.296' })
  })

  it('package-manager-managed, another update in progress, and admin-blocked are failed even on exit 0 (not installed)', async () => {
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

  it('no permission (npm global) is agent-update-permission; other failures carry the exit code', async () => {
    let cli = setup('2.1.280', 'permission')
    let run = await new CliSelfUpdate(table(cli), spec()).update()
    expect(run.outcome === 'failed' ? run.failure : null).toBe('agent-update-permission')
    cli = setup('2.1.280', 'fail')
    run = await new CliSelfUpdate(table(cli), spec()).update()
    expect(run).toMatchObject({ outcome: 'failed', failure: 'agent-update-failed', params: { exitCode: 1 } })
  })

  it('returns updated if the version changed even when it exits non-zero after installing', async () => {
    const cli = setup('2.1.280', 'newer-then-fail')
    const run = await new CliSelfUpdate(table(cli), spec()).update()
    expect(run).toEqual({ outcome: 'updated', before: '2.1.280', after: '2.1.300' })
  })

  it('a timeout stops it and gives agent-update-timeout', async () => {
    const cli = setup('2.1.280', 'slow')
    const started = Date.now()
    const run = await new CliSelfUpdate(table(cli), spec({ timeoutMs: 200 })).update()
    expect(run.outcome === 'failed' ? run.failure : null).toBe('agent-update-timeout')
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it('agent-update-unavailable when the executable is missing', async () => {
    const run = await new CliSelfUpdate(table(join(dir, 'missing-cli')), spec()).update()
    expect(run.outcome === 'failed' ? run.failure : null).toBe('agent-update-unavailable')
  })

  it('install is judged by whether it switched to the specified version', async () => {
    let cli = setup('2.1.300', 'ok')
    let run = await new CliSelfUpdate(table(cli), spec()).install('2.1.280')
    expect(run).toEqual({ outcome: 'updated', before: '2.1.300', after: '2.1.280' })
    expect(calls()).toContain([...spec().installArgs, '2.1.280'].join(' '))
    cli = setup('2.1.300', 'stuck')
    run = await new CliSelfUpdate(table(cli), spec()).install('2.1.280')
    expect(run).toMatchObject({ outcome: 'failed', failure: 'agent-update-not-switched', params: { version: '2.1.280' } })
  })

  it('install does not call the CLI unless the version has a version shape (no flags or subcommands slipped in)', async () => {
    const cli = setup('2.1.300', 'ok')
    const run = await new CliSelfUpdate(table(cli), spec()).install('--force')
    expect(run.outcome).toBe('failed')
    expect(calls()).toEqual([])
  })

  it("autoBlockedByBackend when the environment variable that stops the CLI's own auto-update is set", () => {
    const t = table('x')
    const names = spec().autoDisableEnv ?? []
    expect(names.length).toBeGreaterThan(0)
    expect(new CliSelfUpdate(t, spec(), { env: {} }).autoBlockedByBackend()).toBe(false)
    expect(new CliSelfUpdate(t, spec(), { env: { [names[0] ?? '']: '1' } }).autoBlockedByBackend()).toBe(true)
    expect(new CliSelfUpdate(t, spec(), { env: { [names[0] ?? '']: '0' } }).autoBlockedByBackend()).toBe(false)
  })

  it('looks up the table of known versions (unverified versions)', () => {
    const update = new CliSelfUpdate(table('x'), spec())
    expect(update.isKnownVersion('2.1.296')).toBe(true)
    expect(update.isKnownVersion('9.9.9')).toBe(false)
  })
})

describe('judge / signalFailure (pure functions)', () => {
  it('does not read the output when the table has no signals', () => {
    expect(signalFailure({ updateArgs: [], installArgs: [], timeoutMs: 1 }, 'is managed by')).toBeNull()
  })

  it('does not return updated when the previous version is unavailable and only the later one was obtained (cannot tell if it went up)', () => {
    const result = { code: 0, output: '', timedOut: false, spawnError: null }
    expect(judge(spec(), result, null, '2.1.300', null)).toEqual({ outcome: 'unchanged', before: null, after: '2.1.300' })
  })

  it('agent-update-unavailable when the version cannot be obtained and exit is 0 (does not claim it is latest)', () => {
    const result = { code: 0, output: '', timedOut: false, spawnError: null }
    expect(judge(spec(), result, '2.1.280', null, null)).toMatchObject({
      outcome: 'failed',
      failure: 'agent-update-unavailable'
    })
  })
})

describe('runCommand output (head and tail)', () => {
  it('also picks up the rest of a chunk crossing the head boundary (does not drop the word at the end)', async () => {
    const script = "process.stdout.write('a'.repeat(65000)); process.stdout.write('b'.repeat(2000) + 'is managed by')"
    const result = await runCommand(process.execPath, ['-e', script], 10_000)
    expect(result.output).toContain('is managed by')
  })
})

describe('TODO 1165: keychain attributes before and after the update', () => {
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

  it('reads once before and once after and attaches them to the log as a field (changed = true, item names are not printed)', async () => {
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

  it('the update does not stop when the read throws, and the field is null', async () => {
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

  it('keychainChanged: false when the same, null when not found', () => {
    expect(keychainChanged(meta('a'), meta('a'))).toBe(false)
    expect(keychainChanged(meta('a'), { ...meta('a'), state: 'not-found' })).toBeNull()
    expect(keychainChanged(null, meta('a'))).toBeNull()
  })
})
