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
  it('PathDenied は path-* の理由コードになる (threadAllowDir / searchBuildScope の取りこぼし)', async () => {
    const handler = guarded('aios:test', () => {
      throw new PathDenied('excluded')
    })
    expect(await reasonOf(handler())).toEqual({ code: 'path-excluded', params: {} })
  })

  it('既に理由コードの例外はそのまま (params も残る)', async () => {
    const handler = guarded('aios:test', async () => {
      throw reasonError('invalid-value', { field: 'uris' })
    })
    expect(await reasonOf(handler())).toEqual({ code: 'invalid-value', params: { field: 'uris' } })
    const bare = guarded('aios:test', () => {
      throw new Error('index-busy')
    })
    expect((await reasonOf(bare()))?.code).toBe('index-busy')
  })

  it('それ以外の Error は internal-error (生の文は渡さない)', async () => {
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

  it('成功はそのまま返す (同期・非同期)', async () => {
    await expect(guarded('aios:test', (n: number) => n + 1)(1)).resolves.toBe(2)
    await expect(guarded('aios:test', async () => 'ok')()).resolves.toBe('ok')
  })

  it('toIpcError は Error でない値も internal-error にする', () => {
    expect(parseReason(toIpcError('aios:test', 'boom').message)?.code).toBe('internal-error')
  })
})
