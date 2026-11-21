import { describe, expect, it, vi } from 'vitest'
import { CHROME_SHIM_SOURCE, installChromeShim } from '../src/main/web/chrome-shim.js'

function target(fail?: string) {
  const calls: string[] = []
  return {
    calls,
    t: {
      loadURL: async (url: string) => void calls.push(`load ${url}`),
      debugger: {
        attach: (v: string) => void calls.push(`attach ${v}`),
        sendCommand: async (method: string) => {
          calls.push(method)
          if (method === fail) throw new Error('boom')
        }
      }
    }
  }
}

describe('chrome-shim (handling Google login refusal)', () => {
  it('loads about:blank and then attaches, in the order Page.enable then the script for new documents', async () => {
    const { t, calls } = target()
    await installChromeShim(t)
    expect(calls).toEqual(['load about:blank', 'attach 1.3', 'Page.enable', 'Page.addScriptToEvaluateOnNewDocument'])
  })

  it('resolves even on failure (the view stays usable)', async () => {
    const { t } = target('Page.enable')
    await expect(installChromeShim(t)).resolves.toBeUndefined()
  })

  it('the script adds loadTimes / csi / app to window.chrome and does not overwrite existing ones', () => {
    const win: { chrome?: Record<string, unknown> } = { chrome: { app: 'mine' } }
    const timing = { navigationStart: 1, responseStart: 2, domContentLoadedEventEnd: 3, loadEventEnd: 4 }
    new Function('window', 'performance', `return ${CHROME_SHIM_SOURCE}`)(win, { timing })
    expect(Object.keys(win.chrome!).sort()).toEqual(['app', 'csi', 'loadTimes'])
    expect(win.chrome!['app']).toBe('mine')
    expect(typeof (win.chrome!['loadTimes'] as () => unknown)).toBe('function')
    vi.restoreAllMocks()
  })
})
