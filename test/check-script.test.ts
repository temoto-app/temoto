/**
 * TODO 745/761: checks the judgment in `scripts/check.mjs` that reruns only the failed files to separate flaky from real failures
 * (`classifyRetry`) directly, without spawn or file I/O.
 *
 * Fix of 761: it did not look at the rerun's exit code, and treated a file missing from the JSON as flaky
 * (if the rerun crashed, a real failure would pass). If the rerun's exit code is non-zero, only files marked "passed" explicitly in the JSON are
 * flaky; everything else (not listed, or failed) is treated as a failure.
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- check.mjs is .mjs and has no types (the same setup as the settings-owner test)
import { classifyRetry } from '../scripts/check.mjs'

describe('classifyRetry (TODO 761, fix for 745)', () => {
  it('when the rerun passes (exit 0) and the JSON is all passed, everything is flaky and ok', () => {
    const report = { testResults: [{ name: 'a.test.ts', status: 'passed' }, { name: 'b.test.ts', status: 'passed' }] }
    const result = classifyRetry(['a.test.ts', 'b.test.ts'], report, 0)
    expect(result).toEqual({ ok: true, flaky: ['a.test.ts', 'b.test.ts'], stillFailed: [], reportMissing: false })
  })

  it('when the rerun (exit 0) leaves some failed, that is a real failure', () => {
    const report = {
      testResults: [
        { name: 'a.test.ts', status: 'passed' },
        { name: 'b.test.ts', status: 'failed' }
      ]
    }
    const result = classifyRetry(['a.test.ts', 'b.test.ts'], report, 0)
    expect(result.ok).toBe(false)
    expect(result.flaky).toEqual(['a.test.ts'])
    expect(result.stillFailed).toEqual(['b.test.ts'])
  })

  it('TODO 761: when the rerun exits non-zero and the JSON lists only some files, the unlisted ones are not flaky (real failure)', () => {
    // Pretends the rerun crashed after writing only the a.test.ts result.
    const report = { testResults: [{ name: 'a.test.ts', status: 'passed' }] }
    const result = classifyRetry(['a.test.ts', 'b.test.ts', 'c.test.ts'], report, 1)
    expect(result.flaky).toEqual(['a.test.ts'])
    // b.test.ts / c.test.ts are not in the JSON (not explicitly marked passed), so they remain as real failures.
    expect(result.stillFailed).toEqual(['b.test.ts', 'c.test.ts'])
    expect(result.ok).toBe(false)
  })

  it('even when the rerun exits non-zero, it is flaky if all passed is explicit (fails on the safe side at the caller)', () => {
    const report = { testResults: [{ name: 'a.test.ts', status: 'passed' }] }
    const result = classifyRetry(['a.test.ts'], report, 1)
    expect(result.flaky).toEqual(['a.test.ts'])
    expect(result.stillFailed).toEqual([])
    // Even without stillFailed, it is not ok if the exit code is non-zero. The caller (runTests) fails safe: when the JSON says all passed
    // but the exit code is non-zero, it counts as a failure.
    expect(result.ok).toBe(false)
  })

  it('when the JSON report cannot be read, reportMissing and every file from before the rerun counts as failed', () => {
    const result = classifyRetry(['a.test.ts', 'b.test.ts'], null, 1)
    expect(result.reportMissing).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.flaky).toEqual([])
    expect(result.stillFailed).toEqual(['a.test.ts', 'b.test.ts'])
  })
})
