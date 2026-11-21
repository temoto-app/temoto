// TODO 932 (wave 49 bundle E): the connection of the search field's ASCII input to electron (register.ts).
// Not disposed when quit is cancelled (disposed in will-quit) / a main-frame navigation drops the record of focus.
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const appEvents = new EventEmitter()
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
const sent: string[] = []

vi.mock('electron', () => ({
  app: { on: (name: string, fn: () => void) => appEvents.on(name, fn) },
  ipcMain: {
    on: (channel: string, fn: (...args: unknown[]) => unknown) => ipcHandlers.set(channel, fn),
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => ipcHandlers.set(channel, fn)
  }
}))
vi.mock('../src/main/input/helper.js', () => ({
  InputSourceHelper: class {
    logResolvedPath(): void {}
    warm(): void {}
    send(command: string): void {
      sent.push(command)
    }
    dispose(): void {
      sent.push('helper.dispose')
    }
  }
}))
vi.mock('../src/main/input/preference.js', () => ({
  AsciiInputPreference: class {
    get(): boolean {
      return true
    }
    set(v: boolean): boolean {
      return v
    }
  }
}))

import { IpcChannel } from '../src/shared/ipc.js'
import { registerAsciiInput } from '../src/main/input/register.js'

describe('registerAsciiInput (TODO 932)', () => {
  it('does not dispose on before-quit and restores on will-quit; on reload (did-navigate) drops the focus record and restores', async () => {
    registerAsciiInput({} as never, '/x/helper')
    const report = ipcHandlers.get(IpcChannel.inputAsciiForSearch)!
    const sender = Object.assign(new EventEmitter(), { id: 7 })
    vi.useFakeTimers()
    report({ sender }, true)
    expect(sent).toEqual(['ascii'])

    // Does not stop even when quit is cancelled (only before-quit arrives, will-quit does not).
    appEvents.emit('before-quit')
    expect(sent).toEqual(['ascii'])

    // Reread: restore after the grace period.
    sender.emit('did-navigate')
    await vi.advanceTimersByTimeAsync(200)
    expect(sent).toEqual(['ascii', 'restore'])

    // It can still be switched afterwards (it is not disposed).
    report({ sender }, true)
    expect(sent).toEqual(['ascii', 'restore', 'ascii'])

    appEvents.emit('will-quit')
    vi.useRealTimers()
    expect(sent).toEqual(['ascii', 'restore', 'ascii', 'restore', 'helper.dispose'])
  })
})
