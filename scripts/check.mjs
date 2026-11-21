#!/usr/bin/env node
/**
 * A stand-in for local CI (TODO 745, `npm run check`).
 *
 * There is no CI (`.github/workflows`), and at each merge typecheck / test / lint / build had been run by hand.
 * This puts them into one command: typecheck → lint → test → build.
 *
 * - **Duplicates inside build are removed**: `npm run build` also runs typecheck and `test:bundle` internally, so once typecheck has
 *   been run on its own first, only `npm run build:app` (the rest of `build`, without typecheck) is called. `test:bundle` (the vitest run
 *   of the two files that use `out/`) is excluded from the `test` stage before the build (`BUNDLE_TESTS`). If the previous build's `out/`
 *   remains, it inspects the stale artifacts and fails (this was hit at the merge right after a version bump). It runs at the end of
 *   `build:app` against the new `out/`, so excluding it here loses no check.
 * - **If test fails, only the failed files are re-run once.** If they pass, they are reported as "flaky"; if they fail again, as "failed".
 *   This is so that a time-dependent test (712), which fails now and then, does not have to be judged each time as "really broken or not".
 *   Flaky cases are appended to `out/check/flaky.jsonl`, one line per case (material for 712).
 * - When it finishes, it checks that no vitest process is left over (the pitfall of wave 34). This run waits for its own `spawnSync` to
 *   finish before going on, so it should leave nothing behind, but it also reports whether remnants of other runs exist.
 *
 * It stops at the stage that failed. (Running everything and summarizing at the end was not adopted: when typecheck fails, the time
 * would be wasted on running the heavy build too.)
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = join(ROOT, 'out', 'check')
const FLAKY_LOG = join(OUT_DIR, 'flaky.jsonl')
/**
 * TODO 1185: the mark for when everything passed (`{ commit, at }`). `npm run publish:public` checks whether HEAD has been checked.
 * It is written only when the working tree was clean at both the start and the end of the run and HEAD was the same, so a run that
 * includes uncommitted changes leaves no mark.
 */
const PASSED_STAMP = join(OUT_DIR, 'passed.json')
/** The tests that check the built artifacts in `out/` (`npm run test:bundle`). They run against the new `out/` in the build stage. */
const BUNDLE_TESTS = ['test/index-bundle.test.ts', 'test/build-stamp-bundle.test.ts']
const EXCLUDE_BUNDLE = BUNDLE_TESTS.flatMap((f) => ['--exclude', f])

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT })
  if (res.error !== undefined) throw res.error
  return res.status ?? 1
}

function relPath(absPath) {
  return relative(ROOT, absPath)
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * TODO 761 (fix of 745): from the results of the re-run, separates "flaky" from "real failures". It is a pure function with no side effects
 * (no spawn, no file reads or writes), so `test/check-script.test.ts` checks it directly.
 *
 * It looks at the exit code of the re-run. If it is non-zero (a crash of vitest itself, etc.), only the files that the JSON explicitly marks
 * as "passed" are flaky, and every other file (either not listed, or listed as failed) is a "real failure". This keeps a real failure from
 * slipping through, by mistaking a file that is merely not listed for a flaky (= passed) one.
 *
 * @param {readonly string[]} failedFiles the names of the files that failed in the first run.
 * @param {{ testResults: readonly { name: string, status: string }[] } | null} retryReport the JSON report of the re-run (null if it cannot be read).
 * @param {number | null} retryExitCode the exit code of the re-run.
 * @returns {{ ok: boolean, flaky: string[], stillFailed: string[], reportMissing: boolean }}
 */
export function classifyRetry(failedFiles, retryReport, retryExitCode) {
  if (retryReport === null) {
    return { ok: false, flaky: [], stillFailed: [...failedFiles], reportMissing: true }
  }
  const passed = new Set(retryReport.testResults.filter((t) => t.status === 'passed').map((t) => t.name))
  const flaky = failedFiles.filter((f) => passed.has(f))
  const stillFailed = failedFiles.filter((f) => !passed.has(f))
  const ok = stillFailed.length === 0 && retryExitCode === 0
  return { ok, flaky, stillFailed, reportMissing: false }
}

/** Runs the whole suite with vitest's json reporter, and re-runs only the files that failed, once. */
function runTests() {
  mkdirSync(OUT_DIR, { recursive: true })
  const jsonPath = join(OUT_DIR, 'test-result.json')
  if (existsSync(jsonPath)) rmSync(jsonPath)
  const first = spawnSync(
    'npx',
    ['vitest', 'run', '--reporter=default', '--reporter=json', `--outputFile=${jsonPath}`, ...EXCLUDE_BUNDLE],
    { stdio: 'inherit', cwd: ROOT }
  )
  if (first.status === 0) return 0

  const report = readJson(jsonPath)
  if (report === null) {
    console.error('check: test の JSON レポートが読めなかった。再実行なしで失敗とする。')
    return first.status ?? 1
  }
  const failedFiles = report.testResults
    .filter((t) => t.status === 'failed')
    .map((t) => t.name)
  if (failedFiles.length === 0) {
    // Every file passes in the JSON report, yet the exit code is non-zero (a problem in vitest itself, such as a type error).
    return first.status ?? 1
  }

  console.log(
    `\ncheck: 落ちたファイルだけ再実行 (${failedFiles.length} 件): ${failedFiles.map(relPath).join(', ')}`
  )
  const retryJsonPath = join(OUT_DIR, 'test-retry.json')
  if (existsSync(retryJsonPath)) rmSync(retryJsonPath)
  const retry = spawnSync(
    'npx',
    ['vitest', 'run', '--reporter=default', '--reporter=json', `--outputFile=${retryJsonPath}`, ...failedFiles],
    { stdio: 'inherit', cwd: ROOT }
  )
  const retryReport = readJson(retryJsonPath)
  const { ok, flaky, stillFailed, reportMissing } = classifyRetry(failedFiles, retryReport, retry.status ?? 1)
  if (reportMissing) {
    console.error('check: 再実行の JSON レポートが読めなかった。失敗とする。')
    return 1
  }
  for (const file of flaky) {
    appendFileSync(
      FLAKY_LOG,
      `${JSON.stringify({ ts: new Date().toISOString(), file: relPath(file) })}\n`
    )
    console.log(`check: 不安定 (flaky、再実行で通った) として記録: ${relPath(file)}`)
  }
  if (stillFailed.length > 0) {
    console.error(`check: 再実行しても落ちた (本当の失敗): ${stillFailed.map(relPath).join(', ')}`)
    return 1
  }
  if (!ok) {
    // Every file is passed, yet the re-run's exit code is non-zero (a problem in vitest itself). It fails on the safe side.
    console.error('check: 再実行の終了コードが非 0 だった (JSON 上は全部 passed)。失敗とする。')
    return retry.status ?? 1
  }
  return 0
}

/** Checks whether any vitest process is left over (the pitfall of wave 34). It does not fail if there are none; it only reports. */
function reportLeftoverVitest() {
  const res = spawnSync('pgrep', ['-f', 'vitest'], { encoding: 'utf8' })
  const pids = res.status === 0 ? res.stdout.trim().split('\n').filter((s) => s !== '') : []
  if (pids.length === 0) {
    console.log('check: 残った vitest のプロセスは無い')
  } else {
    console.warn(`check: 残った vitest のプロセスがある (この回とは無関係かもしれない): ${pids.join(', ')}`)
  }
}

/** The HEAD commit, and whether the working tree is clean. Returns null if git is not usable. */
function treeState() {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
  if (head.status !== 0 || status.status !== 0) return null
  return { commit: head.stdout.trim(), clean: status.stdout.trim() === '' }
}

function step(name, fn) {
  console.log(`\n=== check: ${name} ===`)
  const start = Date.now()
  const code = fn()
  const ms = Date.now() - start
  if (code !== 0) {
    console.error(`\ncheck: ${name} で失敗 (${ms}ms, exit ${code})`)
    process.exit(code)
  }
  console.log(`check: ${name} 通った (${ms}ms)`)
}

// TODO 761 (fix of 745): so that `classifyRetry` can be imported and checked from `test/check-script.test.ts`, the main body runs only
// when this file is run directly (importing it alone does not run it).
if (import.meta.url === `file://${process.argv[1]}`) {
  const before = treeState()
  rmSync(PASSED_STAMP, { force: true })
  step('typecheck', () => run('npm', ['run', 'typecheck']))
  step('lint', () => run('npm', ['run', 'lint']))
  step('test', () => runTests())
  step('build', () => run('npm', ['run', 'build:app']))

  console.log('\ncheck: typecheck / lint / test / build、全部通った')
  const after = treeState()
  if (before !== null && after !== null && before.clean && after.clean && before.commit === after.commit) {
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(PASSED_STAMP, JSON.stringify({ commit: after.commit, at: new Date().toISOString() }) + '\n')
    console.log(`check: ${after.commit.slice(0, 12)} を check 済みとして ${relPath(PASSED_STAMP)} に記録`)
  } else {
    console.log('check: 未 commit の変更があった (または HEAD が変わった) ので、check 済みの印は書かない')
  }
  reportLeftoverVitest()
}
