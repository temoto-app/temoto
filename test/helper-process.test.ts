/**
 * TODO 998 (code-review): even if the stdout of a child killed on timeout arrives late, `StdioHelper` does not mix it into the response of a new child.
 * The child is replaced by a fake (EventEmitter). The model is not called.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface FakeChild extends EventEmitter {
  stdin: PassThrough
  stdout: PassThrough
  kill: () => void
}
const children: FakeChild[] = []
vi.mock('node:child_process', () => ({
  spawn: () => {
    const c = new EventEmitter() as FakeChild
    c.stdin = new PassThrough()
    c.stdout = new PassThrough()
    c.kill = () => undefined
    children.push(c)
    return c
  }
}))

import { StdioHelper } from '../src/index-kernel/helper-process.js'

describe('StdioHelper', () => {
  afterEach(() => {
    children.length = 0
    vi.useRealTimers()
  })

  it("even if data arrives late from a killed child, the new child's response is not broken", async () => {
    vi.useFakeTimers()
    const helper = new StdioHelper('/fake', { name: 'test', timeoutMs: 100, idleMs: 10_000 })
    const first = helper.request({ op: 'a' }, new Uint8Array(1))
    await vi.advanceTimersByTimeAsync(101)
    expect(await first).toBeNull()

    const second = helper.request({ op: 'b' }, new Uint8Array(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(2)
    // The killed child emits a partial line late.
    children[0]?.stdout.write('{"id":1,"te')
    await vi.advanceTimersByTimeAsync(0)
    children[1]?.stdout.write('{"id":2,"ok":true}\n')
    await vi.advanceTimersByTimeAsync(0)
    expect(await second).toEqual({ id: 2, ok: true })
    helper.dispose()
  })
})
