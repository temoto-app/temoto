#!/usr/bin/env node
/**
 * `npm run smoke` (TODO 1307): start the built app once with a disposable profile and the fake backend, drive it over CDP and
 * confirm four things: the window appears, one message gets a rendered reply, a file opens in the viewer, settings open.
 *
 *   node scripts/smoke/run.mjs [--keep] [--break <step>]
 *
 *   --keep          leave the disposable directory under /tmp (for looking at it afterwards; it is printed)
 *   --break <step>  make that step expect something that never appears (to see a failure reported and its screenshot kept)
 *
 * Safety (the same rules as proxy verification, `docs/notes/parallel-work-and-verification.md`):
 * - always a fresh `mktemp -d` under /tmp as `--user-data-dir`, removed at the end; the real userData, its encrypted DB and its
 *   `SingletonLock` are never opened, and the dogfood app is never touched;
 * - `HOME` is not changed; `--use-mock-keychain` keeps safeStorage off the keychain (no dialog can appear);
 * - the model is never called: the CLI is the fake backend (`spikes/27-fake-backend/bin`), first on `PATH`;
 * - no OS-wide input: every action is CDP inside this app's own page; the window is shown inactive (`AIOS_SHOW_INACTIVE`);
 * - only links to a file under the disposable directory are clicked (nothing goes to `shell.openExternal`);
 * - whatever way the run ends, the processes it started are stopped by pid / process group, never by name.
 *
 * Not part of `npm run check` (owner decision 2026-11-22): run it after a merge and at the end of a wave.
 * Results (and on failure a screenshot and the logs) go to `out/smoke/<time>/`.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  statSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Buffer } from 'node:buffer'
import { setTimeout as delay } from 'node:timers/promises'
import { CdpSession, listTargets } from './cdp.mjs'
import {
  QUIT_GRACE_MS,
  SMOKE_STEPS,
  TOTAL_TIMEOUT_MS,
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
} from './lib.mjs'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const OUT_ROOT = join(ROOT, 'out', 'smoke')
const FAKE_BIN_SRC = join(ROOT, 'spikes', '27-fake-backend', 'bin')
const FIXTURES = join(ROOT, 'test', 'fixtures')
/** How many run directories to keep under `out/smoke/`. */
const KEEP_RUNS = 10

function parseArgs(argv) {
  const opts = { keep: false, breakStep: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--keep') opts.keep = true
    else if (arg === '--break') opts.breakStep = argv[++i] ?? null
    else {
      console.error(`smoke: 不明な引数: ${arg}`)
      process.exit(2)
    }
  }
  if (opts.breakStep !== null && !SMOKE_STEPS.some((s) => s.id === opts.breakStep)) {
    console.error(`smoke: --break の段は ${SMOKE_STEPS.map((s) => s.id).join(' / ')} のどれか`)
    process.exit(2)
  }
  return opts
}

function psRows() {
  const res = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' })
  return parsePs(res.stdout ?? '')
}


/** The pid of the frontmost app (read-only `lsappinfo`), or null. Used only to report whether the smoke window took the front. */
function frontPid() {
  const front = spawnSync('lsappinfo', ['front'], { encoding: 'utf8' }).stdout?.trim()
  if (!front) return null
  const info = spawnSync('lsappinfo', ['info', '-only', 'pid', front], { encoding: 'utf8' }).stdout ?? ''
  const m = /"pid"\s*=\s*(\d+)/.exec(info)
  return m ? Number(m[1]) : null
}

/** A free loopback port: bind port 0, read what the OS gave, release it. */
async function freePort() {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}

/** Copy the fake backend next to a `{"type":"commonjs"}` package.json (it is CJS; spikes/ is an ESM package). */
function installFakeBackend(binDir) {
  mkdirSync(binDir, { recursive: true })
  for (const name of readdirSync(FAKE_BIN_SRC)) {
    const from = join(FAKE_BIN_SRC, name)
    const to = join(binDir, name)
    copyFileSync(from, to)
    if (statSync(from).mode & 0o111) chmodSync(to, 0o755)
  }
  writeFileSync(join(binDir, 'package.json'), '{"type":"commonjs"}\n')
}

// ---- The page-side expressions (always IIFEs: Runtime.evaluate keeps top-level `const` between calls) ----

const PAGE_STATE = `(() => ({
  ready: document.readyState,
  api: typeof window.aios,
  activity: document.querySelectorAll('.activity-item').length,
  banner: document.querySelector('.instance-banner')?.textContent ?? null,
  visibility: document.visibilityState
}))()`

const PROFILE_QUIET = `(async () => {
  await window.aios.input.setAsciiForSearch(false)
  await window.aios.notifications.setEnabled(false)
  return true
})()`

const bodyHas = (text) => `(() => document.body.innerText.includes(${JSON.stringify(text)}))()`

const clickByText = (selector, text) => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)}))
  if (!el) return false
  el.click()
  return true
})()`

const focusComposer = `(() => {
  const ta = document.querySelector('textarea.composer-input')
  if (!ta || ta.disabled) return false
  ta.focus()
  return document.activeElement === ta
})()`

const composerValue = `(() => document.querySelector('textarea.composer-input')?.value ?? null)()`

/** A link in the timeline that points at `href` (only that exact file is clicked, so no external opener can run). */
const clickLinkTo = (href) => `(() => {
  const el = [...document.querySelectorAll('a')].find((a) => a.getAttribute('href') === ${JSON.stringify(href)})
  if (!el) return false
  el.click()
  return true
})()`

const viewerFrameState = `(() => [...document.querySelectorAll('iframe.viewer-frame')].map((f) => f.getAttribute('src')))()`

const settingsState = `(() => ({
  items: document.querySelectorAll('.settings-item').length,
  pressed: [...document.querySelectorAll('button.activity-item[aria-pressed="true"]')].map((b) => b.getAttribute('aria-label'))
}))()`

const clickSettings = `(() => {
  const labels = ['Settings', '設定']
  const el = [...document.querySelectorAll('button.activity-item')].find((b) => labels.includes(b.getAttribute('aria-label')))
  if (!el) return false
  el.click()
  return true
})()`

// ---- The run ----

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (process.platform !== 'darwin') {
    console.error('smoke: macOS だけで動く (--use-mock-keychain と lsappinfo を前提にしている)')
    process.exit(2)
  }
  const missing = missingBuildFiles((rel) => existsSync(join(ROOT, rel)))
  if (missing.length > 0) {
    console.error(`smoke: ビルド成果物が無い (${missing.join(', ')})。先に npm run build を走らせる。`)
    process.exit(2)
  }
  const require = createRequire(import.meta.url)
  const electronBin = require('electron')
  if (typeof electronBin !== 'string' || !existsSync(electronBin)) {
    console.error('smoke: Electron の本体が無い (node node_modules/electron/install.js で取れる)')
    process.exit(2)
  }

  const startedAt = new Date()
  const runDir = join(OUT_ROOT, runDirName(startedAt))
  mkdirSync(runDir, { recursive: true })
  if (existsSync(OUT_ROOT)) {
    for (const old of runsToPrune(readdirSync(OUT_ROOT), KEEP_RUNS)) rmSync(join(OUT_ROOT, old), { recursive: true, force: true })
  }

  // A short path directly under /tmp (os.tmpdir() is under /var/folders and too long for the gateway socket).
  const tmp = mkdtempSync('/tmp/aios-smoke-')
  // Until the step loop owns the cleanup, an exception on the way removes the directory (see the catch at the bottom).
  setupTmp = opts.keep ? null : tmp
  const userData = join(tmp, 'ud')
  const work = join(tmp, 'work')
  const fakeBin = join(tmp, 'bin')
  const fakeLog = join(tmp, 'fake.log')
  mkdirSync(userData)
  mkdirSync(work)
  installFakeBackend(fakeBin)
  if (!socketPathFits(userData)) throw new Error(`userData のパスが長すぎる: ${userData}`)
  const nonce = Math.random().toString(36).slice(2, 10)
  const noteMarker = `smoke-note-${nonce}`
  const notePath = join(work, `smoke-note-${nonce}.txt`)
  writeFileSync(notePath, `${noteMarker}\nThe smoke test opened this file in the viewer.\n`)

  const port = await freePort()
  const stdoutPath = join(tmp, 'electron.stdout.log')
  const stderrPath = join(tmp, 'electron.stderr.log')
  const { openSync, closeSync } = await import('node:fs')
  const outFd = openSync(stdoutPath, 'a')
  const errFd = openSync(stderrPath, 'a')
  const frontBefore = frontPid()

  const results = []
  const notes = []
  let child = null
  let page = null
  let cleaned = false
  let failed = false
  let lastSnapshot = []
  let quit = null

  const snapshot = () => {
    if (child?.pid === undefined) return
    const owned = ownedProcesses(psRows(), child.pid)
    if (owned.length > 0) lastSnapshot = owned
  }

  async function cleanup() {
    if (cleaned) return
    cleaned = true
    page?.close()
    if (child?.pid !== undefined) {
      snapshot()
      const known = lastSnapshot
      // `exitCode` / `signalCode` come from the 'exit' event (a reaped child); `kill(pid, 0)` would also succeed on a zombie.
      const exited = () => child.exitCode !== null || child.signalCode !== null
      if (!exited()) {
        const t0 = Date.now()
        try {
          process.kill(child.pid, 'SIGTERM')
        } catch {
          // Already gone.
        }
        const deadline = t0 + QUIT_GRACE_MS
        while (!exited() && Date.now() < deadline) await delay(100)
        quit = { ms: Date.now() - t0, forced: !exited() }
        if (quit.forced) notes.push(`SIGTERM から ${QUIT_GRACE_MS / 1000} 秒で終わらなかったので SIGKILL した`)
      }
      // Whatever is left of this run (the group, then anything seen earlier that is still the same process) is killed.
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // The group is already empty.
      }
      for (const row of survivors(known, psRows())) {
        try {
          process.kill(row.pid, 'SIGKILL')
        } catch {
          // Gone in between.
        }
      }
      await delay(300)
      const left = survivors(known, psRows())
      if (left.length > 0) notes.push(`後始末の後も残ったプロセス: ${left.map((r) => r.pid).join(', ')}`)
    }
    closeSync(outFd)
    closeSync(errFd)
    // Keep the logs of this run next to the results (the app writes its own log under <userData>/logs/).
    for (const [from, name] of [
      [stdoutPath, 'electron.stdout.log'],
      [stderrPath, 'electron.stderr.log'],
      [fakeLog, 'fake-backend.log']
    ]) {
      if (existsSync(from)) copyFileSync(from, join(runDir, name))
    }
    const logs = join(userData, 'logs')
    if (existsSync(logs)) cpSync(logs, join(runDir, 'app-logs'), { recursive: true })
    const stray = psRows().filter((row) => row.command.includes(tmp))
    if (stray.length > 0) notes.push(`一時ディレクトリを参照するプロセスが残っている: ${stray.map((r) => r.pid).join(', ')}`)
    if (opts.keep) notes.push(`--keep: ${tmp} を残した`)
    else rmSync(tmp, { recursive: true, force: true })
  }

  const hardStop = globalThis.setTimeout(() => {
    console.error(`smoke: 全体の上限 ${TOTAL_TIMEOUT_MS / 1000} 秒を超えた。止める。`)
    failed = true
    void cleanup().finally(() => process.exit(1))
  }, TOTAL_TIMEOUT_MS)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      console.error(`smoke: ${signal} を受けた。止める。`)
      void cleanup().finally(() => process.exit(130))
    })
  }

  async function screenshot(stepId) {
    if (page === null) return null
    try {
      const data = await page.screenshot()
      const file = join(runDir, screenshotName(stepId))
      writeFileSync(file, Buffer.from(data, 'base64'))
      return file
    } catch (err) {
      notes.push(`スクリーンショットに失敗: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  const evaluate = (expr) => page.evaluate(expr)
  const until = (what, expr, check, timeoutMs) =>
    waitFor(
      what,
      async () => {
        const value = await evaluate(expr)
        return check(value) ? { ok: true, value } : { ok: false, seen: value }
      },
      { timeoutMs }
    )
  /** With `--break <step>` the step waits for something that never exists (a quick, deliberate failure). */
  const breakIf = async (stepId) => {
    if (opts.breakStep === stepId) await until(`--break ${stepId}`, bodyHas(`never-${nonce}-never`), (v) => v === true, 3000)
  }

  async function typeAndSend(text) {
    await until('Composer に focus が入る', focusComposer, (v) => v === true, 10_000)
    await page.send('Input.insertText', { text })
    await until('Composer に文が入る', composerValue, (v) => v === text, 5000)
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
    await page.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...key })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  }

  const steps = {
    async window() {
      child = spawn(electronBin, electronArgs({ appDir: ROOT, userDataDir: userData, port }), {
        cwd: ROOT,
        env: smokeEnv(process.env, { fakeBinDir: fakeBin, fixturesDir: FIXTURES, fakeLog }),
        stdio: ['ignore', outFd, errFd],
        // A process group of its own, so the cleanup can stop exactly this app and its helpers.
        detached: true
      })
      child.on('exit', (code, signal) => {
        if (!cleaned) notes.push(`アプリが途中で終わった (code=${code}, signal=${signal})`)
      })
      // The DevTools port must be this run's: Chromium writes it into this userData.
      await waitFor(
        'DevToolsActivePort',
        async () => {
          if (child.exitCode !== null || child.signalCode !== null) throw new WaitAbort('アプリが起動直後に終わった (electron.stderr.log を見る)')
          const file = join(userData, 'DevToolsActivePort')
          if (!existsSync(file)) return { ok: false, seen: 'まだ無い' }
          const got = devToolsPortOf(readFileSync(file, 'utf8'))
          if (got !== port) throw new WaitAbort(`DevTools のポートが違う: ${got} (期待 ${port})`)
          return { ok: true, value: got }
        },
        { timeoutMs: 30_000 }
      )
      const target = await waitFor(
        '主窓の page target',
        async () => {
          const found = pageTargetOf(await listTargets(port))
          return found ? { ok: true, value: found } : { ok: false, seen: 'page なし' }
        },
        { timeoutMs: 30_000 }
      )
      snapshot()
      page = await CdpSession.connect(target.webSocketDebuggerUrl)
      const state = await until(
        '画面が描かれる (window.aios と Activity Bar と帯)',
        PAGE_STATE,
        // The band arrives one async step after the Activity Bar, so it is part of the wait (a missing band times out here).
        (v) => v?.ready === 'complete' && v.api === 'object' && v.activity > 0 && v.banner !== null,
        30_000
      )
      // Before anything gets focus: no OS-wide side effects from this profile. The ASCII-for-search helper switches the
      // Mac's input source (the owner may be typing Japanese elsewhere), and a reply in an unfocused window posts a desktop
      // notification. Both are settings of the disposable DB.
      await evaluate(PROFILE_QUIET)
      // The window has no OS focus (shown inactive); without this, focus / blur inside the page do not take effect.
      await page.send('Emulation.setFocusEmulationEnabled', { enabled: true })
      // The band of a non-default profile (item 192) proves this is the disposable profile, not the real one.
      if (state.banner === null || !state.banner.includes(userData)) {
        throw new Error(`既定以外のプロファイルの帯が無い、または別のパス: ${JSON.stringify(state.banner)}`)
      }
      if (state.visibility !== 'visible') throw new Error(`窓が見えていない (visibilityState=${state.visibility})`)
      const front = frontPid()
      if (front !== null && front !== frontBefore && lastSnapshot.some((row) => row.pid === front)) {
        notes.push('smoke の窓が前面を取った (AIOS_SHOW_INACTIVE が効いていない)')
      }
      await breakIf('window')
      return `帯 ${JSON.stringify(state.banner)}`
    },

    async reply() {
      const title = `smoke-${nonce}`
      const thread = await evaluate(`(async () => {
        const t = await window.aios.threads.create({ cwdUri: ${JSON.stringify(pathToFileURL(work).href)}, title: ${JSON.stringify(title)} })
        return { id: t.id, backend: t.backend ?? null }
      })()`)
      await waitFor(
        '会話の行が一覧に出て選べる',
        async () => {
          const clicked = await evaluate(clickByText('.thread-row', title))
          if (!clicked) return { ok: false, seen: '行なし' }
          const ready = await evaluate(focusComposer)
          return ready ? { ok: true, value: true } : { ok: false, seen: 'Composer なし' }
        },
        { timeoutMs: 15_000 }
      )
      const probe = replyProbe(nonce)
      await typeAndSend(probe.text)
      await until(`返事「${probe.expected}」が描かれる`, bodyHas(probe.expected), (v) => v === true, 25_000)
      snapshot()
      await breakIf('reply')
      return `thread ${thread.id}`
    },

    async viewer() {
      await typeAndSend(linkPrompt(notePath))
      await waitFor(
        '返事のリンクを押す',
        async () => ((await evaluate(clickLinkTo(notePath))) ? { ok: true, value: true } : { ok: false, seen: 'リンクなし' }),
        { timeoutMs: 15_000 }
      )
      const frames = await until(
        'ViewerPane に aios.text の iframe が出る',
        viewerFrameState,
        (v) => Array.isArray(v) && v.some((src) => typeof src === 'string' && src.startsWith('aios-plugin://aios.text/')),
        15_000
      )
      // The file's contents must be drawn inside the plugin's own frame (a separate target, reached over its own session).
      await waitFor(
        `viewer の中に「${noteMarker}」が描かれる`,
        async () => {
          const target = viewerTargetOf(await listTargets(port), 'aios.text')
          if (target === null) return { ok: false, seen: 'viewer の target なし' }
          const frame = await CdpSession.connect(target.webSocketDebuggerUrl)
          try {
            const has = await frame.evaluate(bodyHas(noteMarker))
            return has ? { ok: true, value: true } : { ok: false, seen: '本文なし' }
          } finally {
            frame.close()
          }
        },
        { timeoutMs: 15_000 }
      )
      snapshot()
      await breakIf('viewer')
      return `iframe ${frames.length} 枚`
    },

    async settings() {
      const clicked = await evaluate(clickSettings)
      if (!clicked) throw new Error('Activity Bar に設定の歯車が無い')
      const state = await until('設定の項目が並ぶ', settingsState, (v) => v?.items > 0, 10_000)
      await breakIf('settings')
      return `項目 ${state.items} 件`
    }
  }

  console.log(`smoke: 一時プロファイル ${userData} / CDP 127.0.0.1:${port}`)
  setupTmp = null
  try {
    for (const step of SMOKE_STEPS) {
      const t0 = Date.now()
      try {
        const detail = await waitForStep(step, () => steps[step.id]())
        const ms = Date.now() - t0
        results.push({ id: step.id, title: step.title, ok: true, ms, detail })
        console.log(`  ok   ${step.id.padEnd(8)} ${step.title} (${ms} ms) ${detail ?? ''}`)
      } catch (err) {
        const ms = Date.now() - t0
        const message = err instanceof Error ? err.message : String(err)
        const shot = await screenshot(step.id)
        results.push({ id: step.id, title: step.title, ok: false, ms, error: message, screenshot: shot })
        console.log(`  FAIL ${step.id.padEnd(8)} ${step.title} (${ms} ms)\n       ${message}`)
        if (shot !== null) console.log(`       スクリーンショット: ${shot}`)
        failed = true
        break
      }
    }
  } finally {
    globalThis.clearTimeout(hardStop)
    await cleanup()
  }

  // The run must not have reached outside its profile (the app's own log says what it did).
  const appLogs = join(runDir, 'app-logs')
  const effects = existsSync(appLogs)
    ? readdirSync(appLogs).flatMap((name) => sideEffectsIn(readFileSync(join(appLogs, name), 'utf8')))
    : []
  if (effects.length > 0) {
    failed = true
    results.push({ id: 'isolation', title: '使い捨てのプロファイルの外に触れていない', ok: false, error: effects })
    console.log('  FAIL isolation 使い捨てのプロファイルの外に触れた:')
    for (const e of effects) console.log(`       ${e.event} — ${e.why} (${e.ts})`)
  } else if (!existsSync(appLogs)) {
    notes.push('アプリのログが無かったので、外に触れていないかは見ていない')
  }

  const total = Date.now() - startedAt.getTime()
  const summary = { startedAt: startedAt.toISOString(), totalMs: total, ok: !failed, quit, results, notes }
  writeFileSync(join(runDir, 'result.json'), JSON.stringify(summary, null, 2) + '\n')
  for (const note of notes) console.log(`  note ${note}`)
  console.log(`smoke: ${failed ? '失敗' : '4 つとも通った'} (${(total / 1000).toFixed(1)} 秒) — ${runDir}`)
  process.exit(failed ? 1 : 0)
}

/** Bound one step by its own timeout (on top of the waits inside it). */
async function waitForStep(step, run) {
  let timer
  const limit = new Promise((_, reject) => {
    timer = globalThis.setTimeout(() => reject(new WaitTimeout(`段 ${step.id} の上限 ${step.timeoutMs} ms`)), step.timeoutMs)
  })
  try {
    return await Promise.race([run(), limit])
  } finally {
    globalThis.clearTimeout(timer)
  }
}

/** The disposable directory while the run is still being set up (nothing is spawned yet), so an exception can remove it. */
let setupTmp = null

main().catch((err) => {
  console.error(`smoke: 例外で止まった: ${err instanceof Error ? err.stack : String(err)}`)
  if (setupTmp !== null) rmSync(setupTmp, { recursive: true, force: true })
  process.exit(1)
})
