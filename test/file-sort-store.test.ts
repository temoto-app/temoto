/**
 * TODO 872 (code-review fix): `initFileSort` does the initialization and the subscription only once, and each call of `relist` adds one more.
 * Even when the settings screen calls it first with `() => undefined`, the tree's entry point that comes later is not discarded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initFileSort, resetFileSortForTest, useFileSort } from '../src/renderer/src/fileSortStore.js'

let emit: ((order: string) => void) | null = null
let subscribed = 0

beforeEach(() => {
  resetFileSortForTest()
  emit = null
  subscribed = 0
  ;(globalThis as unknown as { window: unknown }).window = {
    aios: {
      fileSort: {
        get: async () => 'name',
        set: async (o: string) => o,
        onChanged: (l: (o: string) => void) => {
          subscribed++
          emit = l
        }
      }
    }
  }
})
afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('initFileSort', () => {
  it('even if Settings calls first, the later tree relist is called', async () => {
    const tree = vi.fn()
    await initFileSort(() => undefined)
    await initFileSort(tree)
    expect(subscribed).toBe(1)
    emit?.('modified')
    expect(tree).toHaveBeenCalledTimes(1)
    expect(useFileSort.getState().order).toBe('modified')
  })
})
