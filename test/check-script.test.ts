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

describe('classifyRetry (TODO 761、745 の直し)', () => {
  it('再実行が通って (exit 0) JSON も全部 passed なら、全部 flaky で ok', () => {
    const report = { testResults: [{ name: 'a.test.ts', status: 'passed' }, { name: 'b.test.ts', status: 'passed' }] }
    const result = classifyRetry(['a.test.ts', 'b.test.ts'], report, 0)
    expect(result).toEqual({ ok: true, flaky: ['a.test.ts', 'b.test.ts'], stillFailed: [], reportMissing: false })
  })

  it('再実行 (exit 0) で一部が failed のままなら、それは本当の失敗', () => {
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

  it('TODO 761: 再実行が非 0 で終わり、JSON に一部のファイルしか載っていなければ、載っていない分は flaky にしない (本当の失敗)', () => {
    // Pretends the rerun crashed after writing only the a.test.ts result.
    const report = { testResults: [{ name: 'a.test.ts', status: 'passed' }] }
    const result = classifyRetry(['a.test.ts', 'b.test.ts', 'c.test.ts'], report, 1)
    expect(result.flaky).toEqual(['a.test.ts'])
    // b.test.ts / c.test.ts are not in the JSON (not explicitly marked passed), so they remain as real failures.
    expect(result.stillFailed).toEqual(['b.test.ts', 'c.test.ts'])
    expect(result.ok).toBe(false)
  })

  it('再実行が非 0 で終わっても、全部 passed と明示されていれば flaky (安全側に倒して呼び出し側が失敗にする)', () => {
    const report = { testResults: [{ name: 'a.test.ts', status: 'passed' }] }
    const result = classifyRetry(['a.test.ts'], report, 1)
    expect(result.flaky).toEqual(['a.test.ts'])
    expect(result.stillFailed).toEqual([])
    // Even without stillFailed, it is not ok if the exit code is non-zero. The caller (runTests) fails safe: when the JSON says all passed
    // but the exit code is non-zero, it counts as a failure.
    expect(result.ok).toBe(false)
  })

  it('JSON レポートが読めなければ reportMissing、再実行前の全ファイルを失敗扱い', () => {
    const result = classifyRetry(['a.test.ts', 'b.test.ts'], null, 1)
    expect(result.reportMissing).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.flaky).toEqual([])
    expect(result.stillFailed).toEqual(['a.test.ts', 'b.test.ts'])
  })
})
