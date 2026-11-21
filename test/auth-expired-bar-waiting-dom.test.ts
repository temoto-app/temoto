// @vitest-environment jsdom
/**
 * TODO 1282 (wave 95 bundle A): the expired-login bar while main waits for the login started in Terminal, and after it.
 *
 * - While waiting: the steps the user has to do, until when, whether this conversation will be resent, and "Cancel"
 *   (`agent.cancelLogin`, no arguments). The "Log in" button is not offered twice.
 * - After the login is back: a conversation main held says why, and "Send again" stays.
 * - A failed recovery raises the common error notice once (reason code + params only).
 * - An unattended conversation shows the guidance for unattended runs from main's words, with no input field.
 * All state is main's (`useLoginRecovery` mirrors the push); nothing here decides what is safe to resend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AgentStatus } from '../src/shared/agent.js'
import type { Thread, ThreadSummary } from '../src/shared/thread.js'
import { LOGIN_RECOVERY_IDLE, type LoginRecoveryState } from '../src/shared/login-recovery.js'
import { AuthExpiredBar, startLogin } from '../src/renderer/src/components/AuthExpiredBar.js'
import { resetUnattendedGuideForTest } from '../src/renderer/src/components/UnattendedAuthGuide.js'
import { ensureLoginRecovery, resetLoginRecoveryForTest, useLoginRecovery } from '../src/renderer/src/loginRecoveryStore.js'
import { useLocale } from '../src/renderer/src/localeStore.js'
import { useThreads } from '../src/renderer/src/threadStore.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
let push: ((state: LoginRecoveryState) => void) | null = null
const cancelLogin = vi.fn(async () => true)
const startLoginIpc = vi.fn(async () => ({ opened: true }) as const)
const unattendedLoginGuide = vi.fn(async () => ({ setupCommand: 'tool setup-token', tokenEnv: 'TOOL_TOKEN' }))

const agent = (loggedIn: boolean): AgentStatus => ({ loggedIn }) as unknown as AgentStatus
const at = (patch: Partial<LoginRecoveryState>): LoginRecoveryState => ({ ...LOGIN_RECOVERY_IDLE, changedAt: Date.now(), ...patch })

beforeEach(() => {
  cancelLogin.mockClear()
  startLoginIpc.mockClear()
  unattendedLoginGuide.mockClear()
  resetLoginRecoveryForTest()
  resetUnattendedGuideForTest()
  push = null
  useLocale.setState({ resolved: 'en' })
  useThreads.setState({ agent: agent(false), error: null, threadsById: {} })
  ;(window as unknown as { aios: unknown }).aios = {
    threads: { resendLast: vi.fn(async () => ({ kind: 'sent' })), openInTerminal: vi.fn(async () => ({ opened: true })) },
    agent: {
      recheckLogin: vi.fn(async () => agent(false)),
      startLogin: startLoginIpc,
      cancelLogin,
      unattendedLoginGuide,
      loginRecovery: vi.fn(async () => LOGIN_RECOVERY_IDLE),
      onLoginRecovery: (listener: (state: LoginRecoveryState) => void) => {
        push = listener
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
})

describe('AuthExpiredBar while waiting for the login (TODO 1282)', () => {
  it('shows the steps, says whether it will resend, and Cancel calls main without arguments', async () => {
    act(() => root.render(createElement(AuthExpiredBar, { threadId: 't1' })))
    await act(async () => {
      push?.(at({ phase: 'waiting', deadline: Date.now() + 600_000, waiting: [{ threadId: 't1', resend: true, why: null }] }))
    })
    expect(host.textContent).toContain('Waiting for you to sign in')
    expect(host.textContent).toContain('the last message is sent again')
    expect(host.querySelector('button.auth-login-button')).toBeNull()
    const cancel = host.querySelector<HTMLButtonElement>('button.auth-cancel-button')!
    await act(async () => {
      cancel.click()
    })
    expect(cancelLogin).toHaveBeenCalledWith()
  })

  it('a conversation that will not be resent says so while waiting, with the reason', async () => {
    act(() => root.render(createElement(AuthExpiredBar, { threadId: 't1' })))
    await act(async () => {
      push?.(at({ phase: 'waiting', deadline: Date.now() + 600_000, waiting: [{ threadId: 't1', resend: false, why: 'tool-started' }] }))
    })
    expect(host.textContent).toContain('press Send again')
    expect(host.textContent).toContain('tools had already started running')
    await act(async () => {
      push?.(
        at({ phase: 'waiting', deadline: Date.now() + 600_000, waiting: [{ threadId: 't1', resend: false, why: 'still-failing' }] })
      )
    })
    expect(host.textContent).toContain('not sent automatically a second time')
    expect(host.textContent).not.toContain('the last message is sent again')
  })

  it('review: a conversation main does not list in the wait is not told it will be resent', async () => {
    act(() => root.render(createElement(AuthExpiredBar, { threadId: 'other' })))
    await act(async () => {
      push?.(at({ phase: 'waiting', deadline: Date.now() + 600_000, waiting: [{ threadId: 't1', resend: true, why: null }] }))
    })
    expect(host.textContent).toContain('not part of this wait')
    expect(host.textContent).not.toContain('the last message is sent again')
  })

  it('review: the reason main kept stays on the bar after a later failure', async () => {
    act(() => root.render(createElement(AuthExpiredBar, { threadId: 't1' })))
    await act(async () => {
      push?.(at({ phase: 'failed', failure: 'login-still-failing', held: [{ threadId: 't1', why: 'tool-started' }] }))
    })
    expect(host.textContent).toContain('already started running tools')
  })

  it('after the login is back, a held conversation gives the reason and keeps Send again', async () => {
    useThreads.setState({ agent: agent(true) })
    act(() => root.render(createElement(AuthExpiredBar, { threadId: 't1' })))
    await act(async () => {
      push?.(at({ phase: 'recovered', held: [{ threadId: 't1', why: 'tool-started' }] }))
    })
    expect(host.textContent).toContain('already started running tools')
    expect(host.querySelector('button.auth-resend-button')).not.toBeNull()
  })

  it('a failed recovery raises the error notice once, as a reason code', async () => {
    ensureLoginRecovery()
    await act(async () => {
      push?.(at({ phase: 'waiting', deadline: Date.now() + 600_000 }))
    })
    const failed = at({ phase: 'failed', failure: 'login-timeout', changedAt: Date.now() + 1 })
    await act(async () => {
      push?.(failed)
    })
    expect(useThreads.getState().error).toMatch(/^aios-reason:login-timeout \{"minutes":\d+\}$/)
    useThreads.setState({ error: null })
    await act(async () => {
      push?.(failed)
    })
    expect(useThreads.getState().error).toBeNull()
    expect(useLoginRecovery.getState().state.phase).toBe('failed')
  })

  it('a refused start goes to the error notice with its reason code', async () => {
    startLoginIpc.mockResolvedValueOnce({ opened: false, reason: 'login-credential-invalid' } as never)
    await startLogin((key) => key, 't1')
    expect(useThreads.getState().error).toBe('aios-reason:login-credential-invalid')
  })

  it('an unattended conversation shows the unattended guidance from main, with no input field', async () => {
    const thread = { id: 't1', scheduledJobId: 'job-1' } as unknown as Thread
    useThreads.setState({ threadsById: { t1: { thread } as ThreadSummary } })
    await act(async () => {
      root.render(createElement(AuthExpiredBar, { threadId: 't1' }))
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(host.textContent).toContain('tool setup-token')
    expect(host.textContent).toContain('TOOL_TOKEN')
    expect(host.querySelector('input, textarea')).toBeNull()
  })
})
