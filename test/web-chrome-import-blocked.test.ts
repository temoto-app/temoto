/**
 * TODO 687 code-review: when main refuses the Chrome import in a verification build (a launch whose userData is not the default)
 * (`reasonError('chrome-import-blocked')`), the renderer (`runChromeImport`, `src/renderer/src/webStore.ts`) shows a message different from the general 'not found'.
 * Neither the model nor Electron is used (`window.aios` is a fake).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatReason } from '../src/shared/reason.js'
import { translate } from '../src/renderer/src/i18n/index.js'

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]): string =>
  translate('ja', key, params)

describe('runChromeImport (TODO 687 code-review)', () => {
  let chromeProfiles: ReturnType<typeof vi.fn>
  let importChrome: ReturnType<typeof vi.fn>
  let runChromeImport: typeof import('../src/renderer/src/webStore.js').runChromeImport
  let setChromeImportMessage: typeof import('../src/renderer/src/webStore.js').setChromeImportMessage
  let useWeb: typeof import('../src/renderer/src/webStore.js').useWeb

  beforeEach(async () => {
    chromeProfiles = vi.fn()
    importChrome = vi.fn()
    ;(globalThis as { window: Window }).window = globalThis as unknown as Window
    ;(window as unknown as { aios: unknown }).aios = {
      web: { chromeProfiles, importChrome },
      app: { openExternal: vi.fn() },
      fs: {}
    }
    vi.resetModules()
    const mod = await import('../src/renderer/src/webStore.js')
    runChromeImport = mod.runChromeImport
    setChromeImportMessage = mod.setChromeImportMessage
    useWeb = mod.useWeb
  })

  afterEach(() => {
    setChromeImportMessage(null)
  })

  const openMenu = (): void => {
    throw new Error('openMenu should not be called for a single profile')
  }
  const point = { clientX: 0, clientY: 0 }

  it('when main throws chrome-import-blocked, shows a different message from the default not-found one', async () => {
    chromeProfiles.mockRejectedValue(new Error(formatReason('chrome-import-blocked')))
    await runChromeImport(t, openMenu, point)
    expect(useWeb.getState().chromeImportMessage).toBe(t('reason.chrome-import-blocked'))
  })

  it('other failures (Chrome not found) are unavailable as before', async () => {
    chromeProfiles.mockRejectedValue(new Error('boom'))
    await runChromeImport(t, openMenu, point)
    expect(useWeb.getState().chromeImportMessage).toBe(t('web.favorites.chromeImport.unavailable'))
  })

  it('when a profile is found, also tells apart blocked from the import (importChrome) side', async () => {
    chromeProfiles.mockResolvedValue([{ dir: 'Default', name: 'Default', count: 3 }])
    importChrome.mockRejectedValue(new Error(formatReason('chrome-import-blocked')))
    await runChromeImport(t, openMenu, point)
    expect(useWeb.getState().chromeImportMessage).toBe(t('reason.chrome-import-blocked'))
  })
})
