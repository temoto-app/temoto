/**
 * The pure parts of `npm run smoke` (TODO 1307, `scripts/smoke/lib.mjs`). Electron is never started here: the step table, the
 * launch arguments and environment, the wait loop, the target choice, the process-tree arithmetic of the cleanup and the
 * log check for side effects outside the disposable profile.
 */
import { describe, expect, it } from 'vitest'
import { showsInactive, SHOW_INACTIVE_ENV } from '../src/main/windows.js'
// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import * as lib from '../scripts/smoke/lib.mjs'

const {
  REQUIRED_BUILD_FILES,
  SMOKE_STEPS,
  WaitAbort,
  WaitTimeout,
  devToolsPortOf,
  electronArgs,
  linkPrompt,
  missingBuildFiles,
  ownedProcesses,
  pageTargetOf,
  parsePs,
  replyProbe,
  runDirName,
  runsToPrune,
  screenshotName,
  sideEffectsIn,
  smokeEnv,
  socketPathFits,
  survivors,
  viewerTargetOf,
  waitFor
} = lib

describe('smoke - the step table', () => {
  it('confirms the four owner-chosen things in order, each with its own bound', () => {
    expect(SMOKE_STEPS.map((s: { id: string }) => s.id)).toEqual(['window', 'reply', 'viewer', 'settings'])
    for (const step of SMOKE_STEPS) expect(step.timeoutMs).toBeGreaterThan(0)
  })
})

describe('smoke - launch arguments and environment', () => {
  it('always passes a disposable user-data-dir, the mock keychain and a loopback DevTools port', () => {
    const args = electronArgs({ appDir: '/repo', userDataDir: '/tmp/aios-smoke-x/ud', port: 9555 })
    expect(args[0]).toBe('/repo')
    expect(args).toContain('--user-data-dir=/tmp/aios-smoke-x/ud')
    expect(args).toContain('--use-mock-keychain')
    expect(args).toContain('--remote-debugging-port=9555')
    expect(args).toContain('--remote-debugging-address=127.0.0.1')
  })

  it('drops ELECTRON_RUN_AS_NODE, puts the fake backend first on PATH and keeps HOME as it is', () => {
    const base = { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin:/bin', HOME: '/Users/me' }
    const env = smokeEnv(base, { fakeBinDir: '/tmp/s/bin', fixturesDir: '/repo/test/fixtures', fakeLog: '/tmp/s/fake.log' })
    expect('ELECTRON_RUN_AS_NODE' in env).toBe(false)
    expect(env.PATH).toBe('/tmp/s/bin:/usr/bin:/bin')
    expect(env.HOME).toBe('/Users/me')
    expect(env.AIOS_FIXTURES).toBe('/repo/test/fixtures')
    expect(env.AIOS_FAKE_LOG).toBe('/tmp/s/fake.log')
    expect(env[SHOW_INACTIVE_ENV]).toBe('1')
    // The caller's environment is not modified.
    expect(base.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('the inactive window is honoured only off the default userData', () => {
    expect(showsInactive({ [SHOW_INACTIVE_ENV]: '1' }, false)).toBe(true)
    expect(showsInactive({ [SHOW_INACTIVE_ENV]: '1' }, true)).toBe(false)
    expect(showsInactive({}, false)).toBe(false)
    expect(showsInactive({ [SHOW_INACTIVE_ENV]: 'true' }, false)).toBe(false)
  })

  it('checks the gateway socket path against the macOS limit', () => {
    expect(socketPathFits('/tmp/aios-smoke-abcdef/ud')).toBe(true)
    expect(socketPathFits(`/tmp/${'x'.repeat(100)}`)).toBe(false)
  })

  it('reports the missing build files', () => {
    expect(missingBuildFiles(() => true)).toEqual([])
    expect(missingBuildFiles((rel: string) => rel !== 'out/main/index.js')).toEqual(['out/main/index.js'])
    expect(missingBuildFiles(() => false)).toEqual([...REQUIRED_BUILD_FILES])
  })
})

describe('smoke - DevTools targets', () => {
  const targets = [
    { type: 'page', url: 'devtools://devtools/bundled/inspector.html', webSocketDebuggerUrl: 'ws://a' },
    { type: 'page', url: 'file:///repo/out/renderer/index.html?theme=light', webSocketDebuggerUrl: 'ws://main' },
    { type: 'iframe', url: 'aios-plugin://aios.markdown/index.html', webSocketDebuggerUrl: 'ws://md' },
    { type: 'iframe', url: 'aios-plugin://aios.text/index.html', webSocketDebuggerUrl: 'ws://text' }
  ]

  it('picks the built renderer page and a viewer frame of the requested plugin', () => {
    expect(pageTargetOf(targets)?.webSocketDebuggerUrl).toBe('ws://main')
    expect(viewerTargetOf(targets, 'aios.text')?.webSocketDebuggerUrl).toBe('ws://text')
    expect(viewerTargetOf(targets)?.webSocketDebuggerUrl).toBe('ws://md')
    expect(viewerTargetOf(targets, 'aios.pdf')).toBeNull()
    expect(pageTargetOf([])).toBeNull()
  })

  it('reads the port from DevToolsActivePort (the first line only)', () => {
    expect(devToolsPortOf('9555\n/devtools/browser/abc\n')).toBe(9555)
    expect(devToolsPortOf('')).toBeNull()
    expect(devToolsPortOf('not-a-port\n')).toBeNull()
  })
})

describe('smoke - the processes the cleanup stops', () => {
  const ps = parsePs(
    [
      '  100     1   100 /repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /repo --user-data-dir=/tmp/s/ud',
      '  101   100   100 Electron Helper (Renderer)',
      '  102   101   100 Electron Helper (GPU)',
      '  103   100   103 node /tmp/s/bin/fake --session-id x',
      '  104     1   100 orphan helper of the group',
      '  200     1   200 /Applications/Other.app/Contents/MacOS/Other',
      '  201   200   200 Other Helper',
      'garbage line'
    ].join('\n')
  )

  it('parses ps rows and skips the lines that do not parse', () => {
    expect(ps).toHaveLength(7)
    expect(ps[0]).toEqual({ pid: 100, ppid: 1, pgid: 100, command: expect.stringContaining('Electron') })
  })

  it('owns the root, its descendants (even in another group) and its group (even re-parented), never another app', () => {
    const pids = ownedProcesses(ps, 100).map((r: { pid: number }) => r.pid).sort((a: number, b: number) => a - b)
    expect(pids).toEqual([100, 101, 102, 103, 104])
  })

  it('kills only what is still the same process (a recycled pid with another command line is spared)', () => {
    const snapshot = ownedProcesses(ps, 100)
    const later = parsePs(['  101   100   100 Electron Helper (Renderer)', '  103     1   103 a different program'].join('\n'))
    expect(survivors(snapshot, later).map((r: { pid: number }) => r.pid)).toEqual([101])
  })
})

describe('smoke - waiting', () => {
  /** A fake clock: `sleep` advances it, so the loop runs without real time passing. */
  function clock() {
    let t = 0
    return { now: () => t, sleep: async (ms: number) => void (t += ms) }
  }

  it('returns the value once the probe is satisfied', async () => {
    const c = clock()
    let calls = 0
    const value = await waitFor('x', async () => (++calls >= 3 ? { ok: true, value: 'done' } : { ok: false, seen: calls }), {
      timeoutMs: 10_000,
      intervalMs: 100,
      ...c
    })
    expect(value).toBe('done')
    expect(calls).toBe(3)
  })

  it('throws a WaitTimeout carrying the last observation, and a throwing probe counts as not yet', async () => {
    const c = clock()
    let calls = 0
    const run = waitFor(
      'the reply',
      async () => {
        calls += 1
        if (calls === 1) throw new Error('reloading')
        return { ok: false, seen: { rows: calls } }
      },
      { timeoutMs: 1000, intervalMs: 250, ...c }
    )
    await expect(run).rejects.toBeInstanceOf(WaitTimeout)
    await expect(run).rejects.toThrow(/the reply/)
    expect(calls).toBeGreaterThan(2)
  })

  it('a WaitAbort from the probe ends the wait at once instead of being treated as not yet', async () => {
    const c = clock()
    let calls = 0
    const run = waitFor(
      'the port',
      async () => {
        calls += 1
        throw new WaitAbort('the app exited')
      },
      { timeoutMs: 30_000, intervalMs: 250, ...c }
    )
    await expect(run).rejects.toBeInstanceOf(WaitAbort)
    await expect(run).rejects.toThrow('the app exited')
    expect(calls).toBe(1)
  })
})

describe('smoke - side effects outside the disposable profile', () => {
  const line = (o: Record<string, unknown>) => JSON.stringify({ ts: '2026-11-22T00:00:00.000Z', level: 'info', proc: 'main', ...o })

  it('a clean run has none (the skipped Help copy is not a side effect)', () => {
    const log = [line({ event: 'db.opened', mode: 'encrypted' }), line({ event: 'help.sync', result: 'skipped-copy' }), 'DevTools listening on ws://…'].join('\n')
    expect(sideEffectsIn(log)).toEqual([])
  })

  it('catches the scratch sweep, a Help write, a notification, an input-source switch and an external open', () => {
    const log = [
      line({ event: 'thread.scratch.swept', removed: 16 }),
      line({ event: 'help.sync', result: 'restored' }),
      line({ event: 'tray.created' }),
      line({ event: 'notify.shown' }),
      line({ event: 'input.helper.sent', command: 'ascii' }),
      line({ event: 'open-external.opened', origin: 'link' }),
      '{broken json'
    ].join('\n')
    expect(sideEffectsIn(log).map((e: { event: string }) => e.event)).toEqual([
      'thread.scratch.swept',
      'help.sync',
      'tray.created',
      'notify.shown',
      'input.helper.sent',
      'open-external.opened'
    ])
  })
})

describe('smoke - small helpers', () => {
  it('the reply step expects the fake backend default answer, and the viewer step uses its link scenario', () => {
    expect(replyProbe('abc')).toEqual({ text: 'smoke-ping abc', expected: 'Short reply to: smoke-ping abc' })
    expect(linkPrompt('/tmp/s/work/n.txt')).toBe('link /tmp/s/work/n.txt')
  })

  it('names screenshots and run directories safely, and keeps only the newest runs', () => {
    expect(screenshotName('viewer')).toBe('viewer.png')
    expect(screenshotName('../x y')).toBe('___x_y.png')
    expect(runDirName(new Date('2026-11-22T08:40:20.380Z'))).toBe('2026-11-22T08-40-20-380Z')
    expect(runsToPrune(['b', 'a', 'c'], 2)).toEqual(['a'])
    expect(runsToPrune(['a'], 10)).toEqual([])
  })
})
