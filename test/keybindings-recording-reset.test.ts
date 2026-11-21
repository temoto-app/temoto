// TODO 936 (wave 49 bundle E): even if the reload or the renderer crashes while a shortcut is being recorded, do not leave the menu keys stopped.
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    on: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  }
}))

import { IpcChannel } from '../src/shared/ipc.js'
import { registerKeybindingsHandlers } from '../src/main/keybindings-ipc.js'

describe('keybindings.recording の後始末 (TODO 936)', () => {
  it('did-navigate / render-process-gone で setIgnoreMenuShortcuts(false) に戻す', () => {
    registerKeybindingsHandlers({ readTyped: () => undefined, write: () => undefined } as never, () => [])
    const recording = handlers.get(IpcChannel.keybindingsRecording)!
    const ignore = vi.fn()
    const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, setIgnoreMenuShortcuts: ignore })
    recording({ sender }, true)
    expect(ignore).toHaveBeenLastCalledWith(true)
    sender.emit('did-navigate')
    expect(ignore).toHaveBeenLastCalledWith(false)
    recording({ sender }, true)
    sender.emit('render-process-gone')
    expect(ignore).toHaveBeenLastCalledWith(false)
    // However many times recording runs, there is only one set of listeners
    expect(sender.listenerCount('did-navigate')).toBe(1)
  })
})
