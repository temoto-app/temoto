// @vitest-environment jsdom
/**
 * TODO 521 (wave 26 bundle B): the resume button at the end of the timeline (`ResumeBar`). When pressed, it sends the fixed sentence as an ordinary send
 * (`window.aios.threads.send`). No dialog is shown. The "!" on list rows and where ThreadPane places the bar are checked in the source.
 * TODO 628: if resetsAt is known from the usage limit (interrupt-limit), a "resume after the limit lifts" button is also shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ResumeBar } from '../src/renderer/src/components/ResumeBar.js'
import { useLocale } from '../src/renderer/src/localeStore.js'
import { useUsage } from '../src/renderer/src/usageStore.js'
import { useSchedule, resetScheduleForTest } from '../src/renderer/src/scheduleStore.js'
import { limitResetsAtSec } from '../src/renderer/src/thread/resume.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
const send = vi.fn(async () => ({ kind: 'sent' }))
const reserveResume = vi.fn(async (threadId: string, prompt: string, at: number) => ({
  id: 'res-1',
  threadId,
  prompt,
  at
}))
const remove = vi.fn(async () => ({ jobs: [], autoRun: true, resumeReservations: [], laterSends: [] }))

beforeEach(() => {
  send.mockClear()
  reserveResume.mockClear()
  remove.mockClear()
  useLocale.setState({ resolved: 'ja' })
  useUsage.setState({ snapshot: null })
  resetScheduleForTest()
  ;(window as unknown as { aios: unknown }).aios = {
    threads: { send },
    schedule: { reserveResume, remove, onChanged: () => () => undefined, list: async () => undefined }
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('ResumeBar', () => {
  it('理由を出し、押すと定型文をそのスレッドへ送る', async () => {
    act(() => root.render(createElement(ResumeBar, { threadId: 't1', reason: 'interrupt-limit' })))
    expect(host.textContent).toContain('回答が途中で止まりました (使用量の上限)')
    const button = host.querySelector<HTMLButtonElement>('button.resume-button')!
    expect(button.textContent).toBe('再開')
    await act(async () => {
      button.click()
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('t1', {
      text: '使用量の上限により途中で中断した。中断状況を確認して、再開して'
    })
  })

  it('TODO 628: 使用量の上限で resetsAt が分かれば「解除後に再開」を出し、押すと予約を main に置く', async () => {
    // resetsAt (epoch seconds) of the 5-hour window. 2026-10-10 10:00 (local).
    const resetsAt = Math.floor(new Date(2026, 9, 10, 10, 0, 0, 0).getTime() / 1000)
    useUsage.setState({ snapshot: { status: 'rejected', usingOverage: false, receivedAt: 0, fiveHour: { utilization: 1, resetsAt } } })
    act(() => root.render(createElement(ResumeBar, { threadId: 't1', reason: 'interrupt-limit' })))
    const reserveButton = host.querySelector<HTMLButtonElement>('button.resume-reserve-button')!
    expect(reserveButton).not.toBeNull()
    await act(async () => {
      reserveButton.click()
    })
    expect(reserveResume).toHaveBeenCalledTimes(1)
    const [threadId, prompt, at] = reserveResume.mock.calls[0] as [string, string, number]
    expect(threadId).toBe('t1')
    expect(prompt).toBe('使用量の上限により途中で中断した。中断状況を確認して、再開して')
    // Lift (10:00) + a fixed 5 minutes = 10:05.
    expect(at).toBe(resetsAt * 1000 + 5 * 60_000)
  })

  it('code-review (628): 7 日の窓を使い切っていれば 7 日の解除を使う (5 時間の窓の解除で早く再開しない)', async () => {
    const fiveHour = Math.floor(new Date(2026, 9, 10, 10, 0).getTime() / 1000)
    const sevenDay = Math.floor(new Date(2026, 9, 13, 9, 0).getTime() / 1000)
    useUsage.setState({
      snapshot: {
        status: 'rejected',
        usingOverage: false,
        receivedAt: 0,
        fiveHour: { utilization: 0.4, resetsAt: fiveHour },
        sevenDay: { utilization: 1, resetsAt: sevenDay }
      }
    })
    act(() => root.render(createElement(ResumeBar, { threadId: 't1', reason: 'interrupt-limit' })))
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button.resume-reserve-button')!.click()
    })
    const [, , at] = reserveResume.mock.calls[0] as [string, string, number]
    expect(at).toBe(sevenDay * 1000 + 5 * 60_000)
  })

  it('TODO 628: 理由が上限以外、または resetsAt が無ければボタンを出さない', () => {
    useUsage.setState({ snapshot: null })
    act(() => root.render(createElement(ResumeBar, { threadId: 't1', reason: 'interrupt-network' })))
    expect(host.querySelector('.resume-reserve-button')).toBeNull()
  })

  it('TODO 628: 予約が一覧 (overview) に出たら「◯時に再開します」と取り消しを出す。押すと main に消させる', async () => {
    const at = new Date(2026, 9, 10, 10, 5, 0, 0).getTime()
    useSchedule.setState({ overview: { jobs: [], autoRun: true, resumeReservations: [{ id: 'res-1', threadId: 't1', at }], laterSends: [] } })
    act(() => root.render(createElement(ResumeBar, { threadId: 't1', reason: 'interrupt-limit' })))
    expect(host.querySelector('.resume-reserve-button')).toBeNull()
    expect(host.textContent).toContain('10:05')
    const cancelButton = host.querySelector<HTMLButtonElement>('button.resume-cancel-button')!
    await act(async () => {
      cancelButton.click()
    })
    expect(remove).toHaveBeenCalledWith('res-1')
  })
})

describe('置き場 (ソース)', () => {
  const src = (path: string): string => readFileSync(join(__dirname, '..', path), 'utf8')

  it('一覧の行は未読の点と同じ場所に「!」を出す', () => {
    const list = src('src/renderer/src/components/ThreadList.tsx')
    expect(list).toContain('rowBadgeOf(summary)')
    expect(list).toContain('thread-badge interrupted')
  })

  it('ThreadPane は止まったターンの末尾 (bottomRef の直前) に ResumeBar を出す', () => {
    const pane = src('src/renderer/src/components/ThreadPane.tsx')
    const at = pane.indexOf('<ResumeBar')
    expect(at).toBeGreaterThan(0)
    expect(pane.indexOf('<div ref={bottomRef} />')).toBeGreaterThan(at)
    expect(pane).toContain('showsResume(thread.interrupted, state)')
  })
})

describe('limitResetsAtSec (code-review、TODO 628)', () => {
  const w = (utilization: number, resetsAt: number | null) => ({ utilization, resetsAt })
  it('使い切っている窓の解除。両方なら遅い方', () => {
    expect(limitResetsAtSec({ fiveHour: w(1, 100), sevenDay: w(0.5, 900) })).toBe(100)
    expect(limitResetsAtSec({ fiveHour: w(0.2, 100), sevenDay: w(1.02, 900) })).toBe(900)
    expect(limitResetsAtSec({ fiveHour: w(1, 100), sevenDay: w(1, 900) })).toBe(900)
  })
  it('どれが使い切りか分からなければ遅い方、時刻が無ければ null', () => {
    expect(limitResetsAtSec({ fiveHour: w(0.9, 100), sevenDay: w(0.9, 900) })).toBe(900)
    expect(limitResetsAtSec({ fiveHour: w(1, null), sevenDay: w(0.9, 900) })).toBe(900)
    expect(limitResetsAtSec({ fiveHour: w(0.3, 100) })).toBe(100)
    expect(limitResetsAtSec({ fiveHour: w(1, null) })).toBeNull()
    expect(limitResetsAtSec(null)).toBeNull()
  })
})
