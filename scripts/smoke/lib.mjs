/**
 * The pure parts of the smoke test (TODO 1307, `npm run smoke`): the step table, the launch arguments and environment, the
 * wait loop, the CDP target choice and the process-tree arithmetic used by the cleanup. Nothing here spawns, reads files or
 * opens sockets, so `test/smoke-lib.test.ts` checks it without starting Electron.
 *
 * The runner is `scripts/smoke/run.mjs`; the CDP client is `scripts/smoke/cdp.mjs`.
 */
import { Buffer } from 'node:buffer'
import { join } from 'node:path'

/**
 * The four things the smoke test confirms, in order (owner decision 2026-11-22: start with these four, add more only where a
 * regression shows up). `timeoutMs` bounds each step on its own; the whole run has `TOTAL_TIMEOUT_MS` on top.
 */
export const SMOKE_STEPS = Object.freeze([
  Object.freeze({ id: 'window', title: '起動して窓が出る', timeoutMs: 60_000 }),
  Object.freeze({ id: 'reply', title: '1 通送って返事が描かれる', timeoutMs: 30_000 }),
  Object.freeze({ id: 'viewer', title: 'ファイルをビューアで開く', timeoutMs: 30_000 }),
  Object.freeze({ id: 'settings', title: '設定を開く', timeoutMs: 15_000 })
])

/** The hard limit for one whole run (launch, the four steps and the cleanup). Past it the runner stops everything it started. */
export const TOTAL_TIMEOUT_MS = 240_000

/** How long a SIGTERM to the app gets before the process group is killed (a normal quit takes about 5 seconds). */
export const QUIT_GRACE_MS = 15_000

/** macOS's limit on a Unix socket path (`sun_path`, 104 bytes including the NUL). The gateway socket is `<userData>/run/gw.sock`. */
export const SOCKET_PATH_LIMIT = 104

/** The files under `out/` a run needs. If any is missing the build has not been run in this tree. */
export const REQUIRED_BUILD_FILES = Object.freeze([
  'out/main/index.js',
  'out/preload/index.cjs',
  'out/renderer/index.html',
  'out/plugins/aios.text/manifest.json'
])

/** The build files that are missing, from an `exists(relativePath)` probe. */
export function missingBuildFiles(exists) {
  return REQUIRED_BUILD_FILES.filter((rel) => !exists(rel))
}

/**
 * Why the app directory cannot be started, or null. Electron does not exit at once for a path that is not an app (it waits for a DevTools
 * port that never comes, 30 s), so the run checks the directory and its `package.json` first. `exists(absolutePath)` is a probe.
 */
export function appDirProblem(appDir, exists) {
  if (!exists(appDir)) return `アプリのフォルダが無い (${appDir})`
  if (!exists(join(appDir, 'package.json'))) return `アプリのフォルダに package.json が無い (${appDir})`
  return null
}

/** Whether the gateway socket under this userData fits the macOS limit (a long path fails with `listen EINVAL`). */
export function socketPathFits(userDataDir) {
  return Buffer.byteLength(join(userDataDir, 'run', 'gw.sock'), 'utf8') < SOCKET_PATH_LIMIT
}

/**
 * The environment for the app under test. Starts from the caller's environment and:
 * - drops `ELECTRON_RUN_AS_NODE` (inherited from an Electron-based terminal; Electron would run as plain Node);
 * - puts the fake backend's directory first on `PATH` (the app finds the CLI by `PATH` only), with its fixtures and log;
 * - asks the windows to appear without taking focus (`AIOS_SHOW_INACTIVE`, honoured only off the default userData).
 * `HOME` is never changed (a changed `HOME` makes the keychain ask on the owner's screen; `docs/notes/parallel-work-and-verification.md`).
 */
export function smokeEnv(base, { fakeBinDir, fixturesDir, fakeLog }) {
  const env = { ...base }
  delete env.ELECTRON_RUN_AS_NODE
  env.PATH = base.PATH ? `${fakeBinDir}:${base.PATH}` : fakeBinDir
  env.AIOS_FIXTURES = fixturesDir
  env.AIOS_FAKE_LOG = fakeLog
  env.AIOS_SHOW_INACTIVE = '1'
  return env
}

/**
 * The command line for the app under test. Always a disposable `--user-data-dir` (never the real profile), the mock keychain
 * (safeStorage gets a fixed key, so the keychain is not touched and no dialog can appear), a DevTools port on the loopback, and
 * no throttling of a window that is behind other windows (it is shown inactive, so it may be fully covered).
 */
export function electronArgs({ appDir, userDataDir, port }) {
  return [
    appDir,
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--use-mock-keychain',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
  ]
}

/** The port in Chromium's `DevToolsActivePort` file (first line), or null. Proves the DevTools endpoint is this run's process. */
export function devToolsPortOf(fileText) {
  const first = String(fileText).split('\n')[0]?.trim() ?? ''
  return /^\d+$/.test(first) ? Number(first) : null
}

/** The main window's page among the DevTools targets (`/json/list`): the built renderer loaded from `out/renderer/`. */
export function pageTargetOf(targets) {
  return (
    targets.find(
      (t) => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith('file://') && t.url.includes('/out/renderer/index.html')
    ) ?? null
  )
}

/** A viewer frame (an out-of-process iframe of a plugin, `aios-plugin://<id>/…`) among the targets, optionally of one plugin. */
export function viewerTargetOf(targets, pluginId = null) {
  const prefix = pluginId === null ? 'aios-plugin://' : `aios-plugin://${pluginId}/`
  return targets.find((t) => t.type === 'iframe' && typeof t.url === 'string' && t.url.startsWith(prefix)) ?? null
}

/** Rows of `ps -A -o pid=,ppid=,pgid=,command=` (pid, parent, group, command line). Lines that do not parse are skipped. */
export function parsePs(text) {
  const rows = []
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] })
  }
  return rows
}

/**
 * The processes this run owns: the root, everything below it, and everything in its process group (the app is spawned as a
 * group leader, so a child that was re-parented to launchd after its parent died is still found by the group).
 */
export function ownedProcesses(rows, rootPid) {
  const owned = new Map()
  for (const row of rows) if (row.pid === rootPid || row.pgid === rootPid) owned.set(row.pid, row)
  let grew = true
  while (grew) {
    grew = false
    for (const row of rows) {
      if (!owned.has(row.pid) && owned.has(row.ppid)) {
        owned.set(row.pid, row)
        grew = true
      }
    }
  }
  return [...owned.values()]
}

/**
 * Of an earlier snapshot of owned processes, those still alive in a later `ps` and still the same process (same pid and command
 * line, so a recycled pid is never killed).
 */
export function survivors(snapshot, laterRows) {
  const later = new Map(laterRows.map((row) => [row.pid, row]))
  return snapshot.filter((row) => later.get(row.pid)?.command === row.command)
}

/** A timeout error that carries what the probe saw last (shown in the report). */
export class WaitTimeout extends Error {
  constructor(what, last) {
    super(`時間切れ: ${what}${last === undefined ? '' : ` (最後に見えたもの: ${JSON.stringify(last)})`}`)
    this.name = 'WaitTimeout'
    this.last = last
  }
}

/** Thrown by a probe to stop `waitFor` at once (the thing waited for can no longer happen: the app died, the port is wrong). `waitFor` rethrows it as is. */
export class WaitAbort extends Error {
  constructor(message) {
    super(message)
    this.name = 'WaitAbort'
  }
}

/**
 * Call `probe` until it returns `{ ok: true, value }`, or throw `WaitTimeout` after `timeoutMs`. A probe that throws counts as
 * "not yet" (the page may be reloading), unless it is a `WaitAbort`, which ends the wait immediately and its message becomes the last observation. `sleep` / `now` are injectable for tests.
 */
export async function waitFor(what, probe, { timeoutMs, intervalMs = 250, sleep, now = Date.now }) {
  const pause = sleep ?? ((ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)))
  const deadline = now() + timeoutMs
  let last
  for (;;) {
    try {
      const result = await probe()
      if (result.ok) return result.value
      last = result.seen
    } catch (err) {
      if (err instanceof WaitAbort) throw err
      last = String(err instanceof Error ? err.message : err)
    }
    if (now() >= deadline) throw new WaitTimeout(what, last)
    await pause(intervalMs)
  }
}

/**
 * Log events that mean the run reached outside its disposable profile (TODO 1307). Any of them in the app's log fails the run,
 * so a later change that makes a verification launch touch the owner's Mac is caught here.
 * - `thread.scratch.swept`: removed scratch directories. A non-default profile has its own root (`<userData>/scratch`, TODO 1314), so a fresh
 *   profile has nothing to sweep; any sweep here means the real `~/<data name>/scratch/` was reached.
 * - `help.sync` other than `skipped-copy`: wrote the Help copy under the real home folder.
 * - `notify.shown`: posted a desktop notification on the owner's screen.
 * - `input.helper.sent`: switched the Mac's input source (ASCII for search).
 * - `open-external.opened`: handed something to the OS opener (a browser or another app).
 */
export const SIDE_EFFECT_EVENTS = Object.freeze([
  Object.freeze({ event: 'thread.scratch.swept', why: '実物のホームの scratch を掃除した' }),
  Object.freeze({ event: 'help.sync', why: '実物のホームの Help の写しを書いた', unless: (row) => row.result === 'skipped-copy' }),
  Object.freeze({ event: 'tray.created', why: 'メニューバーにアイコンを出した (既定以外の userData では出さない)' }),
  Object.freeze({ event: 'notify.shown', why: 'デスクトップ通知を出した' }),
  Object.freeze({ event: 'input.helper.sent', why: 'Mac の入力ソースを切り替えた' }),
  Object.freeze({ event: 'open-external.opened', why: 'OS の既定のアプリに渡した' }),
  // TODO 1306: automatic backup never runs in a non-default userData (unless AIOS_BACKUP_IN_INSTANCE=1, which smoke never sets).
  Object.freeze({ event: 'backup.saved', why: 'バックアップを書いた (既定以外の userData では書かない)' }),
  Object.freeze({ event: 'backup.passphrase.saved', why: 'バックアップのパスフレーズをキーチェーンで封じて書いた' }),
  Object.freeze({ event: 'backup.dir.changed', why: 'バックアップの置き場を変えた' }),
  Object.freeze({ event: 'backup.restore.scheduled', why: 'バックアップから戻す予約をした' }),
  Object.freeze({ event: 'backup.restore.applied', why: 'DB を別名へ退けた (バックアップから戻す)' }),
  Object.freeze({ event: 'backup.restore.abandoned', why: '戻しの印を消した (戻さずに今のまま使う)' }),
  Object.freeze({ event: 'backup.id.created', why: 'バックアップの持ち主の id を userData に書いた (既定以外の userData では書かない)' })
])

/** The side effects found in the app's log (one JSON object per line; other lines are ignored). */
export function sideEffectsIn(logText) {
  const found = []
  for (const line of String(logText).split('\n')) {
    if (!line.startsWith('{')) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const rule = SIDE_EFFECT_EVENTS.find((r) => r.event === row.event)
    if (rule !== undefined && !(rule.unless?.(row) ?? false)) found.push({ event: row.event, why: rule.why, ts: row.ts ?? null })
  }
  return found
}

/** The text sent in the `reply` step and the line the fake backend answers with (`Short reply to: <text>`). */
export function replyProbe(nonce) {
  const text = `smoke-ping ${nonce}`
  return { text, expected: `Short reply to: ${text}` }
}

/** The text sent in the `viewer` step: the fake backend's `link` scenario answers `[link1](<path>)`. */
export function linkPrompt(filePath) {
  return `link ${filePath}`
}

/** A file name for a failure screenshot (`<step>.png`, anything odd in the id replaced). */
export function screenshotName(stepId) {
  return `${String(stepId).replace(/[^a-z0-9-]/gi, '_')}.png`
}

/** A run directory name under `out/smoke/` from a date (sortable, no colons). */
export function runDirName(date) {
  return date.toISOString().replace(/[:.]/g, '-')
}

/** Which old run directories to delete so that at most `keep` remain (names sort by time). */
export function runsToPrune(names, keep) {
  const sorted = [...names].sort()
  return sorted.slice(0, Math.max(0, sorted.length - keep))
}
