/**
 * TODO 572: one wrapper that makes IPC handler exceptions use the same reason codes (`guarded` / `toIpcError`).
 */
import { describe, expect, it } from 'vitest'
import { guarded, toIpcError } from '../src/main/ipc/handlers.js'
import { PathDenied } from '../src/common/fs-policy.js'
import { parseReason, reasonError } from '../src/shared/reason.js'

async function reasonOf(promise: Promise<unknown>): Promise<ReturnType<typeof parseReason>> {
  try {
    await promise
  } catch (err) {
    return parseReason(err instanceof Error ? err.message : String(err))
  }
  throw new Error('did not throw')
}

describe('guarded (TODO 572)', () => {
  it('PathDenied becomes a path-* reason code (what threadAllowDir / searchBuildScope missed)', async () => {
    const handler = guarded('aios:test', () => {
      throw new PathDenied('excluded')
    })
    expect(await reasonOf(handler())).toEqual({ code: 'path-excluded', params: {} })
  })

  it('an exception that is already a reason code is left as is (params also remain)', async () => {
    const handler = guarded('aios:test', async () => {
      throw reasonError('invalid-value', { field: 'uris' })
    })
    expect(await reasonOf(handler())).toEqual({ code: 'invalid-value', params: { field: 'uris' } })
    const bare = guarded('aios:test', () => {
      throw new Error('index-busy')
    })
    expect((await reasonOf(bare()))?.code).toBe('index-busy')
  })

  it('any other Error is internal-error (the raw text is not passed)', async () => {
    const handler = guarded('aios:test', () => {
      throw new Error('ENOENT: /secret/path')
    })
    let message = ''
    try {
      await handler()
    } catch (err) {
      message = (err as Error).message
    }
    expect(parseReason(message)?.code).toBe('internal-error')
    expect(message).not.toContain('/secret/path')
  })

  it('success is returned as is (sync and async)', async () => {
    await expect(guarded('aios:test', (n: number) => n + 1)(1)).resolves.toBe(2)
    await expect(guarded('aios:test', async () => 'ok')()).resolves.toBe('ok')
  })

  it('toIpcError also turns a non-Error value into internal-error', () => {
    expect(parseReason(toIpcError('aios:test', 'boom').message)?.code).toBe('internal-error')
  })
})
