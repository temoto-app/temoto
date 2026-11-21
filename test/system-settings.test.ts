import { describe, expect, it, vi } from 'vitest'
import { openSystemSettings } from '../src/main/os/system-settings'

describe('openSystemSettings (TODO 967)', () => {
  it('画面収録は固定の URL だけを開く', async () => {
    const open = vi.fn(async () => undefined)
    expect(await openSystemSettings('screen-recording', open, 'darwin')).toBe(true)
    expect(open).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  })
  it('知らない kind や URL は開かない', async () => {
    const open = vi.fn(async () => undefined)
    for (const bad of ['https://example.com', 'toString', '__proto__', '', 1, null, undefined, {}]) {
      expect(await openSystemSettings(bad, open, 'darwin')).toBe(false)
    }
    expect(open).not.toHaveBeenCalled()
  })
  it('macOS 以外では開かず、開く側の失敗は false', async () => {
    const open = vi.fn(async () => undefined)
    expect(await openSystemSettings('screen-recording', open, 'linux')).toBe(false)
    expect(open).not.toHaveBeenCalled()
    const failing = async (): Promise<void> => {
      throw new Error('x')
    }
    expect(await openSystemSettings('screen-recording', failing, 'darwin')).toBe(false)
  })
})
