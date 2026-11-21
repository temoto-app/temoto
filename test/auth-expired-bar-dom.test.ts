// @vitest-environment jsdom
/**
 * TODO 893 (wave 47 bundle D): the expired-auth notice (`AuthExpiredBar`). While login has expired it shows a guide to `/login`, and when a logged-in state
 * arrives it removes the guide. When the window comes back to the front it rechecks the login state. "Send again" only calls
 * main's `threads.resendLast` (the input contents are not in the renderer). Where ThreadPane places it is checked in the source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentStatus } from '../src/shared/agent.js'
import type { OpenInTerminalResult } from '../src/shared/ipc.js'
import { AuthExpiredBar } from '../src/renderer/src/components/AuthExpiredBar.js'
import { useLocale } from '../src/renderer/src/localeStore.js'
import { useThreads } from '../src/renderer/src/threadStore.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
const resendLast = vi.fn(async () => ({ kind: 'sent' }))
const recheckLogin = vi.fn(async () => ({}) as AgentStatus)
const openInTerminal = vi.fn<(threadId: string) => Promise<OpenInTerminalResult>>(async () => ({ opened: true }))

const agent = (loggedIn: boolean): AgentStatus => ({ loggedIn }) as unknown as AgentStatus

beforeEach(() => {
  resendLast.mockClear()
  recheckLogin.mockClear()
  openInTerminal.mockClear()
  useLocale.setState({ resolved: 'ja' })
  useThreads.setState({ agent: agent(false), error: null })
  ;(window as unknown as { aios: unknown }).aios = {
    threads: { resendLast, openInTerminal },
    agent: { recheckLogin }
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('AuthExpiredBar', () => {
  it('ログインが切れている間は /login の案内、ログイン済みが届くと案内を消す (再送のボタンは残る)', () => {
    act(() => root.render(createElement(AuthExpiredBar, { threadId: 't1' })))
    expect(host.textContent).toContain('ログインが切れました。ターミナルで CLI の /login を実行してから')
    expect(host.querySelector('.auth-expired.logged-in')).toBeNull()

    act(() => useThreads.setState({ agent: agent(true) }))
    expect(host.textContent).not.toContain('/login')
    expect(host.textContent).toContain('いまはログイン済みです')
    expect(host.querySelector('.auth-expired.logged-in')).not.toBeNull()
    expect(host.querySelector('button.auth-resend-button')?.textContent).toBe('もう一度送る')
  })

  it('窓が前面に戻るとログイン状態を確かめ直す。外したら聞かない', () => {
    act(() => root.render(createElement(AuthExpiredBar, { threadId: 't1' })))
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(recheckLogin).toHaveBeenCalledTimes(1)
    act(() => root.render(createElement('div')))
    window.dispatchEvent(new Event('focus'))
    expect(recheckLogin).toHaveBeenCalledTimes(1)
  })

  it('「もう一度送る」は main の resendLast を呼ぶ。断られたら理由をエラーの欄に出す', async () => {
    act(() => root.render(createElement(AuthExpiredBar, { threadId: 't1' })))
    const button = host.querySelector<HTMLButtonElement>('button.auth-resend-button')!
    await act(async () => {
      button.click()
    })
    expect(resendLast).toHaveBeenCalledWith('t1')

    resendLast.mockRejectedValueOnce(new Error('aios-reason:resend-unavailable {}'))
    await act(async () => {
      button.click()
    })
    expect(useThreads.getState().error).toContain('resend-unavailable')
  })

  it('「もう一度送る」はほかの送信の口と同じく送った入力まで巻く (markSendScroll、TODO 906)', async () => {
    useThreads.setState({ sendScroll: null })
    act(() => root.render(createElement(AuthExpiredBar, { threadId: 't1' })))
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button.auth-resend-button')!.click()
    })
    expect(useThreads.getState().sendScroll?.threadId).toBe('t1')
  })

  it('「ターミナルで開く」は会話の id だけを main へ渡す。開けなければ理由を出す (TODO 908)', async () => {
    useThreads.setState({ error: null })
    act(() => root.render(createElement(AuthExpiredBar, { threadId: 't1' })))
    const button = host.querySelector<HTMLButtonElement>('button.auth-terminal-button')!
    expect(button.textContent).toBe('ターミナルで開く')
    await act(async () => {
      button.click()
    })
    expect(openInTerminal).toHaveBeenCalledWith('t1')
    expect(useThreads.getState().error).toBeNull()
    // A sentence appears for each reason (not one uniform "macOS only").
    for (const [reason, text] of [
      ['terminal-cwd-denied', '作業フォルダを Terminal で開けません'],
      ['terminal-no-cwd', '作業フォルダがありません'],
      ['terminal-no-command', 'コマンドがありません'],
      ['terminal-open-failed', 'Terminal を起動できませんでした'],
      ['terminal-unsupported', 'macOS だけ']
    ] as const) {
      openInTerminal.mockResolvedValueOnce({ opened: false, reason })
      useThreads.setState({ error: null })
      await act(async () => {
        button.click()
      })
      expect(useThreads.getState().error).toContain(text)
    }
  })

  it('ThreadPane は interrupt-auth のときだけ ResumeBar の代わりにこれを置く', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'ThreadPane.tsx'), 'utf8')
    expect(source).toMatch(/thread\.interrupted === 'interrupt-auth' \? \(\s*<AuthExpiredBar threadId=\{threadId\} \/>/)
  })
})
