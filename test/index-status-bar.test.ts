// @vitest-environment jsdom
/**
 * TODO 434 (wave 22 bundle D): the wording of the status bar (`IndexStatusBar`).
 *
 * - Slow while in operation (`building` + `message: 'slow'`) reads as "indexing (slow)…", and shows a stop button.
 * - Full speed while idle (`building` + `message: null`) is the earlier "indexing N / remaining M".
 * - "Waiting" appears only when stopped by heat (`thermal`) or Low Power Mode (`low-power`).
 *
 * Neither the model nor Electron is used.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { IndexStatus } from '../src/shared/search.js'
import { translate } from '../src/renderer/src/i18n/index.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function status(patch: Partial<IndexStatus>): IndexStatus {
  return {
    state: 'building',
    documents: 10_000,
    indexed: 3_831,
    pending: 6_169,
    skipped: 0,
    failed: 0,
    chunks: 0,
    startedAt: 1,
    finishedAt: null,
    message: null,
    ...patch
  }
}

let reactRoot: Root
let host: HTMLDivElement

async function render(value: IndexStatus, locale: 'ja' | 'en' = 'ja'): Promise<HTMLElement> {
  const { useSearch } = await import('../src/renderer/src/searchStore.js')
  const { useLocale } = await import('../src/renderer/src/localeStore.js')
  act(() => {
    useLocale.setState({ resolved: locale })
    useSearch.setState({ status: value, indexBusy: null })
  })
  const { IndexStatusBar } = await import('../src/renderer/src/components/IndexStatusBar.js')
  act(() => reactRoot.render(createElement(IndexStatusBar)))
  return host
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  reactRoot = createRoot(host)
})

afterEach(() => {
  act(() => reactRoot.unmount())
  host.remove()
})

describe('IndexStatusBar text (TODO 434)', () => {
  it('slow indexing while the user is active shows 「索引中 (ゆっくり)」 and a stop button', async () => {
    const el = await render(status({ message: 'slow' }))
    expect(el.textContent).toContain(
      '索引中 (ゆっくり): 操作が止まると速くなります (残り 6,169)'
    )
    expect(el.querySelector('button')?.textContent).toBe('停止')
  })

  it('full speed while idle uses the same text as before', async () => {
    const el = await render(status({ message: null }))
    expect(el.textContent).toContain('索引中 3,831 / 残り 6,169')
  })

  it('「待機中」 (the heat text) only when stopped by heat', async () => {
    const el = await render(status({ state: 'waiting', message: 'thermal' }))
    expect(el.textContent).toContain('待機中: 本体が熱いため索引を止めています (残り 6,169)')
    expect(el.querySelector('button')?.textContent).toBe('停止')
  })

  it('「待機中」 when stopped by Low Power Mode', async () => {
    const el = await render(status({ state: 'waiting', message: 'low-power' }))
    expect(el.textContent).toContain('待機中: 低電力モードのため索引を止めています (残り 6,169)')
  })

  it('English text', async () => {
    const el = await render(status({ message: 'slow' }), 'en')
    expect(el.textContent).toContain('Indexing slowly: speeds up when you are idle (6,169 left)')
    expect(translate('en', 'index.waitingThermal', { pending: '1' })).toBe(
      'Waiting: indexing paused while the Mac is hot (1 left)'
    )
    expect(translate('en', 'index.waitingLowPower', { pending: '1' })).toBe(
      'Waiting: indexing paused in Low Power Mode (1 left)'
    )
  })
})
