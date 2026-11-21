/**
 * The window that a search query came from (TODO 497). main's IPC attaches the webContents id, and when the window closes or is reloaded, it arranges
 * for the index process's ledger to be cleared (`SearchOrigins`). Does not use electron; imitates webContents with `EventEmitter`.
 */
import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { SearchOrigins } from '../src/main/ipc/search-origin.js'

class FakeSender extends EventEmitter {
  constructor(readonly id: number) {
    super()
  }
}

describe('SearchOrigins (TODO 497)', () => {
  it('窓の id を返し、手配は窓ごとに 1 回だけ', () => {
    const forgotten: number[] = []
    const origins = new SearchOrigins((origin) => forgotten.push(origin))
    const one = new FakeSender(1)
    const two = new FakeSender(2)
    expect(origins.of(one)).toBe(1)
    expect(origins.of(one)).toBe(1)
    expect(origins.of(two)).toBe(2)
    expect(origins.size()).toBe(2)
    expect(one.listenerCount('destroyed')).toBe(1)
    expect(one.listenerCount('did-navigate')).toBe(1)
    expect(forgotten).toEqual([])
  })

  it('窓が閉じたら帳簿を消し、手配も外す', () => {
    const forgotten: number[] = []
    const origins = new SearchOrigins((origin) => forgotten.push(origin))
    const one = new FakeSender(1)
    origins.of(one)
    one.emit('destroyed')
    expect(forgotten).toEqual([1])
    expect(origins.size()).toBe(0)
  })

  it('読み直したら (did-navigate) 帳簿を消す。窓は手配済みのまま', () => {
    const forgotten: number[] = []
    const origins = new SearchOrigins((origin) => forgotten.push(origin))
    const one = new FakeSender(1)
    origins.of(one)
    one.emit('did-navigate')
    one.emit('did-navigate')
    expect(forgotten).toEqual([1, 1])
    expect(origins.size()).toBe(1)
    // The next query does not stack another arrangement.
    origins.of(one)
    expect(one.listenerCount('did-navigate')).toBe(1)
  })
})
