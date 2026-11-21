/**
 * The place for test temp folders (TODO 262).
 *
 * - A temp folder is created as `~/.aios-test/<run>/<name>-XXXXXX` and falls under the app's exclusion (`~/.aios-test`). `testExclusions()`, passed to the Broker and others, removes only that rule.
 * - After globalSetup's cleanup (`finishRun`), the inside of the place is empty (the root itself is removed).
 * - Leftovers from a run that was killed are removed at the start of the next run (`startRun` -> `sweepDeadRuns`). It does not touch runs whose pid is alive (another worktree running in parallel), or names of a different shape.
 *
 * Tests that check what goes in and out of the place do not touch the real `~/.aios-test`; they treat a temp folder under it as the 'root' (so that a run in parallel is not removed).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { classify, createMacosExclusions } from '../src/common/exclusions.js'
import {
  finishRun,
  makeTestDir,
  removeTestDir,
  RUN_DIR_ENV,
  runName,
  startRun,
  sweepDeadRuns,
  TEST_TMP_ROOT,
  testExclusions,
  testRunDir
} from './helpers/tmp.js'

const made: string[] = []
afterAll(() => {
  for (const dir of made.splice(0)) removeTestDir(dir)
})

describe('test temporary folder (TODO 262)', () => {
  it("is created at ~/.aios-test/<run>/<name>-XXXXXX, and this run's folder is the one globalSetup handed over", () => {
    const dir = makeTestDir('tmp-probe')
    made.push(dir)
    expect(dir.startsWith(`${TEST_TMP_ROOT}/`)).toBe(true)
    expect(dir.startsWith(`${testRunDir()}/tmp-probe-`)).toBe(true)
    // If it comes from `npm test` (the globalSetup in vitest.config.ts), the env var is set.
    expect(process.env[RUN_DIR_ENV]).toBe(testRunDir())
    expect(existsSync(dir)).toBe(true)
  })

  it('the name is kebab-case only (no path mixed in)', () => {
    expect(() => makeTestDir('../escape')).toThrow(/kebab-case/)
    expect(() => makeTestDir('.hidden')).toThrow(/kebab-case/)
  })

  it('the main exclusion rules exclude ~/.aios-test as a whole, and testExclusions restores only that', () => {
    const dir = makeTestDir('tmp-rules')
    made.push(dir)
    const real = createMacosExclusions(homedir())
    expect(classify(TEST_TMP_ROOT, '.aios-test', true, real)).toEqual({
      excluded: true,
      reason: 'test-fixtures'
    })
    expect(classify(join(dir, 'a.txt'), 'a.txt', false, real).excluded).toBe(true)
    // The test rule removes only that one; other exclusions (credentials, etc.) stay as they are.
    const forTests = testExclusions()
    expect(classify(join(dir, 'a.txt'), 'a.txt', false, forTests).excluded).toBe(false)
    expect(classify(join(homedir(), '.ssh'), '.ssh', true, forTests).reason).toBe('credentials')
    expect(forTests.prefixes).toHaveLength(real.prefixes.length - 1)
  })

  it("the scan rules with the temporary folder as home do not exclude that tree (they do not affect the test's own scan)", () => {
    const home = makeTestDir('tmp-home')
    made.push(home)
    const rules = createMacosExclusions(home)
    expect(classify(join(home, 'notes'), 'notes', true, rules).excluded).toBe(false)
    expect(classify(join(home, 'notes', 'a.md'), 'a.md', false, rules).excluded).toBe(false)
    // It is expanded from home, so the only thing excluded is `<home>/.aios-test`.
    expect(classify(join(home, '.aios-test'), '.aios-test', true, rules).reason).toBe('test-fixtures')
  })
})

describe('run entry and exit (globalSetup startRun / finishRun)', () => {
  it('after finishRun the area under the root is empty and the root is removed', () => {
    const root = join(makeTestDir('tmp-lifecycle'), 'root')
    const run = startRun(root)
    expect(readdirSync(root)).toEqual([run.slice(root.length + 1)])
    // Even if what the test created is left behind (a run whose cleanup leaked), the whole thing is removed.
    mkdirSync(join(run, 'leak-XXXX', 'deep'), { recursive: true })
    writeFileSync(join(run, 'leak-XXXX', 'deep', 'f.txt'), 'x')
    finishRun(run, root)
    expect(existsSync(root)).toBe(false)
    removeTestDir(join(root, '..'))
  })

  it('keeps the root when a concurrently running run remains (does not touch that run)', () => {
    const root = join(makeTestDir('tmp-parallel'), 'root')
    made.push(join(root, '..'))
    const other = join(root, runName(process.ppid))
    mkdirSync(other, { recursive: true })
    const run = startRun(root)
    finishRun(run, root)
    expect(readdirSync(root)).toEqual([other.slice(root.length + 1)])
  })

  it('leftovers of a killed run (dead pid) are removed at the start of the next run, while live runs and hand-placed things remain', () => {
    const root = join(makeTestDir('tmp-sweep'), 'root')
    made.push(join(root, '..'))
    // 99999999 is above the pid limit, so that process is not alive.
    const dead = runName(99_999_999)
    const live = runName(process.ppid)
    mkdirSync(join(root, dead, 'index-test-AAAA'), { recursive: true })
    mkdirSync(join(root, live), { recursive: true })
    mkdirSync(join(root, 'by-hand'), { recursive: true })
    expect(sweepDeadRuns(root)).toEqual([dead])
    expect(readdirSync(root).sort()).toEqual(['by-hand', live].sort())
  })
})
