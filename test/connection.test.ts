// @vitest-environment jsdom
/**
 * TODO 525 (wave 26 bundle B): turns the BottomBar red with white text when the network is down or the model cannot be connected.
 *
 * - Judgment (`shared/connection.ts`): the OS is offline, or a connection failure within the last minute (`api_retry`). Returns to normal on a successful `result`.
 * - main's aggregation (`ConnectionTracker`): one for the whole app; delivered only when it changes. Not saved.
 * - renderer (`connectionStore.ts`): subscribes to main's value (TODO 1171: does not watch the OS's `online` / `offline` events). After a minute, redraws and returns.
 * - Colors are CSS variables (`--error-bg` / `--error-fg`, both themes; the contrast is in STATE_PAIRS of theme-tokens.test.ts).
 * Neither the model is called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AiosEvent, ResultPayload } from '../src/shared/agent.js'
import {
  CONNECTION_FAILURE_WINDOW_MS,
  connectionAlert,
  nextConnectionFailure,
  parseConnectionStatus,
  type ConnectionStatus
} from '../src/shared/connection.js'
import { ConnectionTracker } from '../src/main/connection.js'
import {
  ensureConnection,
  resetConnectionForTest,
  useConnectionAlert
} from '../src/renderer/src/connectionStore.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RESULT: ResultPayload = {
  ok: true,
  subtype: 'success',
  turns: 1,
  durationMs: 1,
  costUsd: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  stopReason: null,
  denials: [],
  text: null
}

function ev(partial: Record<string, unknown>): AiosEvent {
  return { id: 'e', sessionId: 's', threadId: 't', ts: 1, actor: 'main', ...partial } as unknown as AiosEvent
}
const retry = (ts: number): AiosEvent =>
  ev({ kind: 'api_retry', ts, payload: { attempt: 1, maxRetries: 10, retryDelayMs: 1000, errorStatus: null } })
const result = (ok: boolean): AiosEvent => ev({ kind: 'result', payload: { ...RESULT, ok } })

describe('判定 (shared/connection.ts)', () => {
  it('再試行で失敗の時刻を進め、成功の result で戻す。失敗の result と他の種別では動かさない', () => {
    expect(nextConnectionFailure(null, [retry(100)])).toBe(100)
    expect(nextConnectionFailure(100, [retry(200)])).toBe(200)
    expect(nextConnectionFailure(100, [result(false)])).toBe(100)
    expect(nextConnectionFailure(100, [result(true)])).toBeNull()
    // Read in the order of the bundle (if a retry comes after a success, it stays a failure).
    expect(nextConnectionFailure(100, [result(true), retry(300)])).toBe(300)
    expect(nextConnectionFailure(null, [ev({ kind: 'assistant_text', payload: { text: 'x' } })])).toBeNull()
  })

  it('TODO 546-1: 429 (使用量の上限) の再試行では赤にしない — 上限は使用量の札が受け持つ。他の状態コードは赤', () => {
    const retryStatus = (ts: number, errorStatus: number | null): AiosEvent =>
      ev({ kind: 'api_retry', ts, payload: { attempt: 1, maxRetries: 10, retryDelayMs: 1000, errorStatus } })
    expect(nextConnectionFailure(null, [retryStatus(100, 429)])).toBeNull()
    expect(nextConnectionFailure(50, [retryStatus(100, 429)])).toBe(50)
    expect(nextConnectionFailure(null, [retryStatus(100, 529)])).toBe(100)
    expect(nextConnectionFailure(null, [retryStatus(100, null)])).toBe(100)
  })

  it('TODO 1171: 赤の理由は直近 1 分の失敗だけ', () => {
    expect(connectionAlert(1000, 1000 + CONNECTION_FAILURE_WINDOW_MS - 1)).toBe('unreachable')
    expect(connectionAlert(1000, 1000 + CONNECTION_FAILURE_WINDOW_MS)).toBeNull()
    expect(connectionAlert(null, 0)).toBeNull()
  })

  it('IPC の値を読む', () => {
    expect(parseConnectionStatus({ failedAt: 5 })).toEqual({ failedAt: 5 })
    expect(parseConnectionStatus({ failedAt: null })).toEqual({ failedAt: null })
    expect(parseConnectionStatus({ failedAt: 'x' })).toBeNull()
    expect(parseConnectionStatus(null)).toBeNull()
  })
})

describe('ConnectionTracker (main)', () => {
  it('変わったときだけ配る', () => {
    const pushed: ConnectionStatus[] = []
    const tracker = new ConnectionTracker((status) => pushed.push(status))
    tracker.observe({ events: [ev({ kind: 'assistant_text', payload: { text: 'x' } })], at: 0 })
    expect(pushed).toEqual([])
    tracker.observe({ events: [retry(10)], at: 10 })
    tracker.observe({ events: [result(false)], at: 11 })
    tracker.observe({ events: [result(true)], at: 12 })
    expect(pushed).toEqual([{ failedAt: 10 }, { failedAt: null }])
    expect(tracker.get()).toEqual({ failedAt: null })
  })
})

describe('renderer (connectionStore + useConnectionAlert)', () => {
  let root: Root
  let host: HTMLDivElement
  let listener: ((status: ConnectionStatus) => void) | null
  const seen: (string | null)[] = []

  function Probe(): null {
    seen.push(useConnectionAlert())
    return null
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    resetConnectionForTest()
    seen.length = 0
    listener = null
    ;(window as unknown as { aios: unknown }).aios = {
      connection: {
        get: async () => ({ failedAt: null }),
        onChanged: (fn: (status: ConnectionStatus) => void) => {
          listener = fn
          return () => undefined
        }
      }
    }
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  it('main の失敗の知らせで赤くなり、1 分経つと戻る', async () => {
    ensureConnection()
    act(() => root.render(createElement(Probe)))
    expect(seen.at(-1)).toBeNull()
    act(() => listener!({ failedAt: Date.now() }))
    expect(seen.at(-1)).toBe('unreachable')
    act(() => {
      vi.advanceTimersByTime(CONNECTION_FAILURE_WINDOW_MS + 100)
    })
    expect(seen.at(-1)).toBeNull()
  })

  it('成功の知らせ (failedAt = null) で直ぐ戻る', () => {
    ensureConnection()
    act(() => root.render(createElement(Probe)))
    act(() => listener!({ failedAt: Date.now() }))
    expect(seen.at(-1)).toBe('unreachable')
    act(() => listener!({ failedAt: null }))
    expect(seen.at(-1)).toBeNull()
  })

  it('TODO 1171: navigator.onLine が false でも、window の offline の事象が来ても赤くしない', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    ensureConnection()
    act(() => root.render(createElement(Probe)))
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })
    expect(seen.at(-1)).toBeNull()
    onLine.mockRestore()
  })
})

describe('見た目 (ソース)', () => {
  const src = (path: string): string => readFileSync(join(__dirname, '..', path), 'utf8')

  it('BottomBar は赤のとき .offline と左端の札を出す', () => {
    const bar = src('src/renderer/src/components/BottomBar.tsx')
    expect(bar).toContain("'bottom-bar offline'")
    expect(bar).toContain('bottom-bar-alert')
    expect(bar).not.toContain('bottomBar.offline')
  })

  it('--error-bg / --error-fg は両テーマにあり、中の札・棒も白にする', () => {
    const css = src('src/renderer/src/styles.css')
    expect(css.match(/--error-bg:/g)?.length).toBe(2)
    expect(css.match(/--error-fg:/g)?.length).toBe(2)
    expect(css).toContain('.bottom-bar.offline { background: var(--error-bg)')
    expect(css).toContain('.bottom-bar.offline .usage-badge-bar-fill')
    expect(css).toContain('.bottom-bar.offline .git-status')
  })

  it('TODO 546-2: 赤の帯の中のボタン (索引の「停止」/「再開」) は地を透かし白の縁にする — 白文字が明るい地に乗らない', () => {
    const css = src('src/renderer/src/styles.css')
    // If only the text is made white with `.status-bar *`, white text lands on the button's default light background (--button-bg family) and cannot be read (measured at 1.1:1 on the 31st run).
    const rule = css.match(/\.bottom-bar\.offline \.status-bar button\s*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    expect(rule?.[1]).toMatch(/background:\s*transparent/)
    expect(rule?.[1]).toMatch(/border-color:\s*var\(--error-fg\)/)
  })
})
