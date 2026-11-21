// @vitest-environment jsdom
/**
 * TODO 989: the Composer's "send later" (`LaterMenu` / `LaterList`) and the time calculation (`thread/later.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LaterList, LaterMenu, toLaterAttachments } from '../src/renderer/src/components/LaterMenu.js'
import { useLocale } from '../src/renderer/src/localeStore.js'
import { useThreads } from '../src/renderer/src/threadStore.js'
import { useUsage } from '../src/renderer/src/usageStore.js'
import { useSchedule, resetScheduleForTest } from '../src/renderer/src/scheduleStore.js'
import {
  LATER_LIMIT_DELAY_MS,
  laterAfterHours,
  laterAfterLimit,
  laterAtTimeOfDay,
  laterTimeLabel
} from '../src/renderer/src/thread/later.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
const reserveLater = vi.fn(async (threadId: string, input: { at: number; text: string }) => ({
  id: 'l1',
  threadId,
  at: input.at,
  preview: input.text,
  attachments: 0,
  failed: false,
  error: null
}))
const remove = vi.fn(async () => ({ jobs: [], autoRun: true, resumeReservations: [], laterSends: [] }))

beforeEach(() => {
  reserveLater.mockClear()
  remove.mockClear()
  useLocale.setState({ resolved: 'ja' })
  useUsage.setState({ snapshot: null })
  useThreads.setState({ drafts: {}, attachments: {} })
  resetScheduleForTest()
  ;(window as unknown as { aios: unknown }).aios = {
    schedule: { reserveLater, remove, onChanged: () => () => undefined, list: async () => undefined }
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const openMenu = (): void => {
  act(() => host.querySelector<HTMLButtonElement>('button.composer-later')!.click())
}

describe('LaterMenu', () => {
  it('開く位置は閉じると戻る・スクロールで閉じる (TODO 1041 の直し)', () => {
    useThreads.setState({ drafts: { t1: '本文' }, attachments: {} })
    act(() => root.render(createElement(LaterMenu, { threadId: 't1' })))
    openMenu()
    const first = document.querySelector<HTMLElement>('.menu-popover.above')!
    expect(first).not.toBeNull()
    // Close (Esc) → the first paint right after reopening starts from visibility: hidden, not from the previous coordinates.
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('.menu-popover')).toBeNull()
    openMenu()
    expect(document.querySelector('.menu-popover.above')).not.toBeNull()
    // Close it if the inside of the composer scrolls while it is open.
    act(() => {
      host.dispatchEvent(new Event('scroll'))
      window.dispatchEvent(new Event('resize'))
    })
    expect(document.querySelector('.menu-popover')).toBeNull()
    openMenu()
    act(() => {
      const el = document.createElement('div')
      document.body.append(el)
      el.dispatchEvent(new Event('scroll'))
      el.remove()
    })
    expect(document.querySelector('.menu-popover')).toBeNull()
  })

  it('空のときは押せない', () => {
    act(() => root.render(createElement(LaterMenu, { threadId: 't1' })))
    expect(host.querySelector<HTMLButtonElement>('button.composer-later')!.disabled).toBe(true)
  })

  it('N 時間後を選ぶと本文と添付を予約に積み、入力欄を空にする', async () => {
    useThreads.setState({
      drafts: { t1: '続きをお願い' },
      attachments: {
        t1: [{ uri: 'file:///tmp/a.txt', name: 'a.txt', kind: 'reference', mediaType: null, bytes: 3 }]
      }
    })
    act(() => root.render(createElement(LaterMenu, { threadId: 't1' })))
    openMenu()
    const before = Date.now()
    const item = [...document.querySelectorAll<HTMLButtonElement>('button.later-item')].find((b) => b.textContent === '2 時間後')!
    await act(async () => item.click())
    expect(reserveLater).toHaveBeenCalledTimes(1)
    const [threadId, input] = reserveLater.mock.calls[0] as unknown as [string, { text: string; at: number; attachments: unknown[] }]
    expect(threadId).toBe('t1')
    expect(input.text).toBe('続きをお願い')
    expect(input.attachments).toHaveLength(1)
    expect(input.at).toBeGreaterThanOrEqual(before + 2 * 3_600_000)
    expect(useThreads.getState().drafts['t1']).toBe('')
    expect(useThreads.getState().attachments['t1']).toEqual([])
  })

  it('解除の時刻が分からなければ「上限の解除後」は選べず、分かれば解除 + 5 分で予約する', async () => {
    useThreads.setState({ drafts: { t1: 'x' } })
    act(() => root.render(createElement(LaterMenu, { threadId: 't1' })))
    openMenu()
    expect(document.querySelector<HTMLButtonElement>('button.later-limit')!.disabled).toBe(true)
    const resetsAt = Math.floor(Date.now() / 1000) + 3600
    act(() => useUsage.setState({ snapshot: { status: 'rejected', usingOverage: false, receivedAt: 0, fiveHour: { utilization: 1, resetsAt } } }))
    const button = document.querySelector<HTMLButtonElement>('button.later-limit')!
    expect(button.disabled).toBe(false)
    await act(async () => button.click())
    const input = reserveLater.mock.calls[0]![1] as unknown as { at: number }
    expect(input.at).toBe(resetsAt * 1000 + LATER_LIMIT_DELAY_MS)
  })
})

describe('LaterList', () => {
  it('そのスレッドの予約を時刻つきで出し、× で取り消す', async () => {
    const at = new Date().setHours(23, 30, 0, 0)
    act(() =>
      useSchedule.setState({
        overview: {
          jobs: [],
          autoRun: true,
          resumeReservations: [],
          laterSends: [
            { id: 'l1', threadId: 't1', at, preview: 'あとで', attachments: 2, failed: false, error: null },
            { id: 'l2', threadId: 't2', at, preview: '別', attachments: 0, failed: false, error: null }
          ]
        }
      })
    )
    act(() => root.render(createElement(LaterList, { threadId: 't1' })))
    expect(host.textContent).toContain('あとで')
    expect(host.textContent).not.toContain('別')
    expect(host.textContent).toContain('23:30')
    await act(async () => host.querySelector<HTMLButtonElement>('button.reservation-action')!.click())
    expect(remove).toHaveBeenCalledWith('l1')
  })

  it('TODO 989 (review): 送れなかった予約は「失敗」で残り、もう一度送る / 入力欄へ戻すができる', async () => {
    const retryLater = vi.fn(async () => undefined)
    const takeLater = vi.fn(async () => ({ text: '戻す本文', attachments: [] }))
    ;(window as unknown as { aios: { schedule: object } }).aios.schedule = {
      ...(window as unknown as { aios: { schedule: object } }).aios.schedule,
      retryLater,
      takeLater
    }
    act(() =>
      useSchedule.setState({
        overview: {
          jobs: [],
          autoRun: true,
          resumeReservations: [],
          laterSends: [{ id: 'f1', threadId: 't1', at: Date.now(), preview: 'こけた', attachments: 0, failed: true, error: 'x' }]
        }
      })
    )
    act(() => root.render(createElement(LaterList, { threadId: 't1' })))
    expect(host.textContent).toContain('送れませんでした')
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button.reservation-action')]
    await act(async () => buttons.find((b) => b.textContent === 'もう一度送る')!.click())
    expect(retryLater).toHaveBeenCalledWith('f1')
    useThreads.setState({ drafts: { t1: '今の下書き' } })
    await act(async () => buttons.find((b) => b.textContent === '入力欄へ戻す')!.click())
    expect(takeLater).toHaveBeenCalledWith('f1')
    expect(useThreads.getState().drafts['t1']).toBe('戻す本文\n今の下書き')
  })
})

describe('thread/later.ts', () => {
  it('N 時間後・時刻・解除後・表示', () => {
    const now = new Date(2026, 9, 25, 10, 0, 0, 0).getTime()
    expect(laterAfterHours(now, 2)).toBe(now + 7_200_000)
    expect(laterAfterHours(now, 0)).toBeNull()
    expect(laterAfterHours(now, Number.NaN)).toBeNull()
    expect(laterAfterHours(now, 1000)).toBeNull()
    expect(laterAtTimeOfDay(now, '11:30')).toBe(new Date(2026, 9, 25, 11, 30).getTime())
    // A time already past means tomorrow.
    expect(laterAtTimeOfDay(now, '09:00')).toBe(new Date(2026, 9, 26, 9, 0).getTime())
    expect(laterAtTimeOfDay(now, '25:00')).toBeNull()
    expect(laterAfterLimit(null)).toBeNull()
    expect(laterTimeLabel(new Date(2026, 9, 25, 9, 5).getTime(), now)).toBe('09:05')
    expect(laterTimeLabel(new Date(2026, 9, 26, 9, 5).getTime(), now)).toBe('10/26 09:05')
  })

  it('添付は縮小版を捨て、貼り付けの画像だけ base64 を残す', () => {
    const result = toLaterAttachments([
      { uri: 'file:///a.png', name: 'a.png', kind: 'image', mediaType: 'image/png', bytes: 1, base64: 'AA', thumbnail: 'data:x' },
      { uri: 'aios-clipboard:1', name: 'p.png', kind: 'image', mediaType: 'image/png', bytes: 1, base64: 'BB' }
    ])
    expect(result.map((a) => a.base64)).toEqual([undefined, 'BB'])
    expect(result.map((a) => a.thumbnail)).toEqual(['data:x', undefined])
  })
})
