import { describe, expect, it, vi } from 'vitest'
import { openSystemSettings } from '../src/main/os/system-settings'

describe('openSystemSettings (TODO 967)', () => {
  it('screen recording opens only the fixed URL', async () => {
    const open = vi.fn(async () => undefined)
    expect(await openSystemSettings('screen-recording', open, 'darwin')).toBe(true)
    expect(open).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  })
  it('does not open an unknown kind or URL', async () => {
    const open = vi.fn(async () => undefined)
    for (const bad of ['https://example.com', 'toString', '__proto__', '', 1, null, undefined, {}]) {
      expect(await openSystemSettings(bad, open, 'darwin')).toBe(false)
    }
    expect(open).not.toHaveBeenCalled()
  })
  it('does not open outside macOS, and a failure on the opening side returns false', async () => {
    const open = vi.fn(async () => undefined)
    expect(await openSystemSettings('screen-recording', open, 'linux')).toBe(false)
    expect(open).not.toHaveBeenCalled()
    const failing = async (): Promise<void> => {
      throw new Error('x')
    }
    expect(await openSystemSettings('screen-recording', failing, 'darwin')).toBe(false)
  })
})
