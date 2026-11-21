/**
 * Temporary folder for tests (TODO 262).
 *
 * macOS's `os.tmpdir()` (`/var/folders/...`) hits the exclusion of 4.4.2, so tests that need a tree to scan have no choice but to create it under home. Previously each test created it directly under home with `mkdtemp(join(homedir(), '.aios-…-'))`, and when the cleanup was missed (the run fell or was killed midway), the leftovers stayed; the test tree even went into the running real aios's index and appeared in its file tree.
 *
 * The current form:
 * - The place is **one spot, `~/.aios-test/<run>/<name>-XXXXXX`**. `~/.aios-test` is in the exclusions of the main scan, watch, and list (`TEST_FIXTURES_DIR`, `src/common/exclusions.ts`).
 * - `<run>` is one `npm test` run (made by the globalSetup of `vitest.config.ts` = `test/setup/tmp-global.ts`, and removed whole at the end). The name is `<pid>-<time>`, and **what a previous run left behind when it was killed is removed at the start of the next run** (if that pid is no longer alive). A run of another worktree in parallel has a live pid, so it is not touched.
 * - Each test still removes its own part in `afterAll` / `afterEach` / `finally` (`removeTestDir`). The cleanup in globalSetup is the backstop.
 *
 * The tests' own scans are not affected: scanning tests pass this temporary folder as `home`, so the rules expand from there (it only excludes `<temp folder>/.aios-test`). Tests that need the real rules rooted at the real `homedir()` (such as the Broker) use `testExclusions()`.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExclusionOptions, ExclusionRules } from '../../src/common/exclusions.js'
import { createMacosExclusions, TEST_FIXTURES_REASON } from '../../src/common/exclusions.js'

/** The root of the test temporary folders (`~/.aios-test`). The same place as `TEST_FIXTURES_DIR` in the main exclusions. */
export const TEST_TMP_ROOT = join(homedir(), '.aios-test')

/** The environment variable that hands the "this run" folder made by globalSetup to the workers. */
export const RUN_DIR_ENV = 'AIOS_TEST_RUN_DIR'

/** The name of a run, `<pid>-<time>`. Its leading pid tells whether that run is still alive. */
export function runName(pid: number = process.pid, now: number = Date.now()): string {
  return `${pid}-${now.toString(36)}`
}

function pidOf(name: string): number | null {
  const match = /^(\d+)-[0-9a-z]+$/.exec(name)
  if (match === null) return null
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists but belongs to someone else. Treat it as alive (lean toward not deleting).
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Removes the run folders left behind by earlier runs (a backstop for killed runs). **Does not touch runs whose pid is alive**, since they may be an `npm test` running in parallel in another worktree. Does not touch names of a different shape (ones someone placed by hand). Returns the names it removed.
 */
export function sweepDeadRuns(root: string = TEST_TMP_ROOT): string[] {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of names) {
    const pid = pidOf(name)
    if (pid === null || pid === process.pid || alive(pid)) continue
    rmSync(join(root, name), { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

/** Creates this run's folder (from globalSetup). */
export function startRun(root: string = TEST_TMP_ROOT): string {
  sweepDeadRuns(root)
  const dir = join(root, runName())
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Removes this run's folder, and removes the root too if it becomes empty (from the cleanup of globalSetup).
 * If other runs remain in the root (running in parallel), the root is kept.
 */
export function finishRun(dir: string, root: string = TEST_TMP_ROOT): void {
  rmSync(dir, { recursive: true, force: true })
  try {
    rmdirSync(root)
  } catch {
    // ENOTEMPTY (a run in parallel exists) and ENOENT are left alone.
  }
}

let fallbackRun: string | null = null

/**
 * This run's folder. In a startup that does not go through globalSetup (such as `vitest.contract.config.ts`), one is made per process, and removed when the process exits.
 */
export function testRunDir(): string {
  const fromEnv = process.env[RUN_DIR_ENV]
  if (fromEnv !== undefined && fromEnv !== '') {
    mkdirSync(fromEnv, { recursive: true })
    return fromEnv
  }
  if (fallbackRun === null) {
    const dir = join(TEST_TMP_ROOT, runName())
    mkdirSync(dir, { recursive: true })
    fallbackRun = dir
    process.once('exit', () => finishRun(dir))
  }
  return fallbackRun
}

/**
 * Makes a test temporary folder: `~/.aios-test/<run>/<name>-XXXXXX`.
 * The caller removes it (with `removeTestDir` in `afterAll` / `afterEach` / `finally`).
 */
export function makeTestDir(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`test dir name must be kebab-case: ${name}`)
  return mkdtempSync(join(testRunDir(), `${name}-`))
}

/** Removes a folder made by `makeTestDir` (it need not exist). */
export function removeTestDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/**
 * From the exclusion rules rooted at the real `homedir()`, removes only the rule for the test temporary folder (`~/.aios-test`).
 * The main side excludes all of `~/.aios-test`, so a test that passes the real rules to the Broker and the like could not read its own temporary folder. Such tests use this.
 */
export function testExclusions(
  home: string = homedir(),
  options: ExclusionOptions = {}
): ExclusionRules {
  const rules = createMacosExclusions(home, options)
  return { ...rules, prefixes: rules.prefixes.filter((rule) => rule.reason !== TEST_FIXTURES_REASON) }
}
