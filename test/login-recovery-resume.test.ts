/**
 * TODO 1282 (wave 95 bundle A): the re-login flow on top of TODO 960's `LoginRecovery`.
 *
 * - Starting the login is not success: only a recheck that says logged in ends the wait.
 * - The automatic resend is made only when main's record of the stopped turn says it is safe (`hold === null`); a turn that had
 *   started tools keeps "Send again". One automatic resend per expiry: a resend that stops on the login again is not resent again.
 * - Cancel, the timeout, failed checks and closing every window end the wait with a phase the renderer can show.
 * - A rejected credential gets no login; an unattended conversation never opens one by itself.
 *
 * No real Terminal, CLI or model: openLogin / isLoggedIn / resend are fakes, and the clock and timers are advanced by hand.
 */
import { describe, expect, it } from 'vitest'
import type { LoginRecoveryState } from '../src/shared/login-recovery.js'
import {
  AUTO_RESEND_COOLDOWN_MS,
  LOGIN_CHECK_FAILURE_LIMIT,
  LOGIN_POLL_INTERVAL_MS,
  LOGIN_POLL_TIMEOUT_MS,
  LoginRecovery,
  type ExpiryInfo,
  type LoginRecoveryDeps
} from '../src/main/session/login-recovery.js'

const SAFE: ExpiryInfo = { relogin: true, hold: null, unattended: false }
const TOOLS: ExpiryInfo = { relogin: true, hold: 'tool-started', unattended: false }

function harness(overrides: Partial<LoginRecoveryDeps> = {}) {
  const clock = { now: 1_000_000 }
  const timers: Array<{ fn: () => void; at: number; id: number }> = []
  let seq = 0
  const opened: Array<string | null> = []
  const resent: string[] = []
  const states: LoginRecoveryState[] = []
  const flags = { loggedIn: false, expired: new Set<string>(), auto: false, viewer: true }
  const deps: LoginRecoveryDeps = {
    openLogin: async (threadId) => {
      opened.push(threadId)
      return { opened: true }
    },
    isLoggedIn: async () => flags.loggedIn,
    stillExpired: (id) => flags.expired.has(id),
    resend: async (id) => {
      resent.push(id)
    },
    autoOpen: () => flags.auto,
    describe: () => null,
    hasViewer: () => flags.viewer,
    onState: (state) => states.push(state),
    now: () => clock.now,
    setTimer: (fn, ms) => {
      const id = ++seq
      timers.push({ fn, at: clock.now + ms, id })
      return id
    },
    clearTimer: (handle) => {
      const at = timers.findIndex((t) => t.id === handle)
      if (at !== -1) timers.splice(at, 1)
    },
    ...overrides
  }
  const recovery = new LoginRecovery(deps)
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  }
  const advance = async (): Promise<void> => {
    clock.now += LOGIN_POLL_INTERVAL_MS
    const due = timers.filter((t) => t.at <= clock.now)
    for (const t of due) {
      timers.splice(timers.indexOf(t), 1)
      t.fn()
    }
    await settle()
  }
  return { recovery, flags, opened, resent, states, timers, clock, advance, settle }
}

describe('LoginRecovery: resend only where it is safe (TODO 1282)', () => {
  it('a turn that had started tools is not resent; the state names it with the reason', async () => {
    const h = harness()
    h.flags.expired.add('safe').add('tools')
    h.recovery.noteExpired('safe', SAFE)
    h.recovery.noteExpired('tools', TOOLS)
    await h.recovery.start('safe')
    expect(h.recovery.state()).toMatchObject({
      phase: 'waiting',
      deadline: h.clock.now + LOGIN_POLL_TIMEOUT_MS,
      waiting: [
        { threadId: 'safe', resend: true },
        { threadId: 'tools', resend: false }
      ]
    })
    h.flags.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual(['safe'])
    expect(h.recovery.state()).toMatchObject({
      phase: 'recovered',
      resent: ['safe'],
      held: [{ threadId: 'tools', why: 'tool-started' }]
    })
  })

  it('starting the login is not success: nothing is resent until a recheck says logged in', async () => {
    const h = harness()
    h.flags.expired.add('a')
    h.recovery.noteExpired('a', SAFE)
    expect(await h.recovery.start('a')).toEqual({ opened: true })
    for (let i = 0; i < 5; i += 1) await h.advance()
    expect(h.resent).toEqual([])
    expect(h.recovery.isActive()).toBe(true)
  })

  it('a thread added by the button that main knows nothing about (e.g. a mark from before a restart) is held, not resent', async () => {
    const h = harness()
    h.flags.expired.add('old')
    await h.recovery.start('old')
    h.flags.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual([])
    expect(h.recovery.state().held).toEqual([{ threadId: 'old', why: 'unavailable' }])
  })

  it('a resend that stops on the login again is not resent a second time (no loop), and says so', async () => {
    const h = harness()
    h.flags.expired.add('a')
    h.recovery.noteExpired('a', SAFE)
    await h.recovery.start('a')
    h.flags.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual(['a'])
    // The resent turn stopped on the login again.
    h.recovery.noteExpired('a', SAFE)
    expect(h.recovery.state()).toMatchObject({ phase: 'failed', failure: 'login-still-failing' })
    // Even if the user logs in once more, it is left for "Send again".
    h.flags.loggedIn = false
    await h.recovery.start('a')
    h.flags.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual(['a'])
    expect(h.recovery.state().held).toEqual([{ threadId: 'a', why: 'still-failing' }])
    // After the cooldown it is an ordinary expiry again.
    h.clock.now += AUTO_RESEND_COOLDOWN_MS
    h.flags.loggedIn = false
    h.recovery.noteExpired('a', SAFE)
    await h.recovery.start('a')
    h.flags.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual(['a', 'a'])
  })

  it('a resend that throws is reported as held, not as resent', async () => {
    const h = harness({
      resend: async () => {
        throw new Error('aios-reason:resend-unavailable')
      }
    })
    h.flags.expired.add('a')
    h.recovery.noteExpired('a', SAFE)
    await h.recovery.start('a')
    h.flags.loggedIn = true
    await h.advance()
    expect(h.recovery.state()).toMatchObject({ phase: 'recovered', resent: [], held: [{ threadId: 'a', why: 'unavailable' }] })
  })
})

describe('LoginRecovery: ending the wait (TODO 1282)', () => {
  it('cancel drops the wait: no resend even if the login comes back later, and the phase is cancelled', async () => {
    const h = harness()
    h.flags.expired.add('a')
    h.recovery.noteExpired('a', SAFE)
    await h.recovery.start('a')
    expect(h.recovery.cancel()).toBe(true)
    expect(h.recovery.state().phase).toBe('cancelled')
    expect(h.timers).toHaveLength(0)
    h.flags.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual([])
    // Not waiting: nothing to cancel.
    expect(h.recovery.cancel()).toBe(false)
  })

  it('the timeout (10 minutes) ends as failed / login-timeout, without a resend', async () => {
    const h = harness()
    h.flags.expired.add('a')
    h.recovery.noteExpired('a', SAFE)
    await h.recovery.start('a')
    for (let at = 0; at < LOGIN_POLL_TIMEOUT_MS; at += LOGIN_POLL_INTERVAL_MS) await h.advance()
    expect(h.recovery.state()).toMatchObject({ phase: 'failed', failure: 'login-timeout' })
    expect(h.recovery.isActive()).toBe(false)
    expect(h.resent).toEqual([])
  })

  it('checks that keep throwing end as failed / login-check-failed after the limit (a single throw does not)', async () => {
    let calls = 0
    const h = harness({
      isLoggedIn: async () => {
        calls += 1
        throw new Error('spawn failed')
      }
    })
    await h.recovery.start('a')
    for (let i = 0; i < LOGIN_CHECK_FAILURE_LIMIT - 1; i += 1) await h.advance()
    expect(h.recovery.isActive()).toBe(true)
    await h.advance()
    expect(calls).toBe(LOGIN_CHECK_FAILURE_LIMIT)
    expect(h.recovery.state()).toMatchObject({ phase: 'failed', failure: 'login-check-failed' })
    expect(h.timers).toHaveLength(0)
  })

  it('closing every window cancels the wait (nobody would see the resend)', async () => {
    const h = harness()
    h.flags.expired.add('a')
    h.recovery.noteExpired('a', SAFE)
    await h.recovery.start('a')
    h.flags.viewer = false
    h.flags.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual([])
    expect(h.recovery.state().phase).toBe('cancelled')
  })

  it('after stop (shutdown) nothing is pushed and no timer is left', async () => {
    const h = harness()
    h.recovery.noteExpired('a', SAFE)
    await h.recovery.start('a')
    const pushed = h.states.length
    h.recovery.stop()
    h.recovery.noteExpired('b', SAFE)
    expect(h.recovery.cancel()).toBe(false)
    expect(h.timers).toHaveLength(0)
    expect(h.states.length).toBe(pushed)
  })

  it('the state is pushed on phase changes, not on every poll', async () => {
    const h = harness()
    h.recovery.noteExpired('a', SAFE)
    await h.recovery.start('a')
    const pushed = h.states.length
    for (let i = 0; i < 5; i += 1) await h.advance()
    expect(h.states.length).toBe(pushed)
  })
})

describe('LoginRecovery: when no login is started (TODO 1282)', () => {
  it('a rejected credential is refused with login-credential-invalid, by the button and automatically', async () => {
    const h = harness()
    h.flags.auto = true
    h.recovery.noteExpired('a', { relogin: false, hold: null, unattended: false })
    await h.settle()
    expect(h.opened).toEqual([])
    expect(await h.recovery.start('a')).toEqual({ opened: false, reason: 'login-credential-invalid' })
    expect(h.opened).toEqual([])
  })

  it('a rejected credential that arrives while waiting never joins the wait, so it is not resent when the login comes back (TODO 1286)', async () => {
    const h = harness()
    h.flags.expired.add('a').add('key')
    h.recovery.noteExpired('a', SAFE)
    await h.recovery.start('a')
    h.recovery.noteExpired('key', { relogin: false, hold: null, unattended: false })
    expect(h.recovery.state().waiting.map((w) => w.threadId)).toEqual(['a'])
    expect(await h.recovery.start('key')).toEqual({ opened: false, reason: 'login-credential-invalid' })
    h.flags.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual(['a'])
  })

  it('an ordinary expiry that arrives while waiting is still resent when the login comes back (TODO 1286)', async () => {
    const h = harness()
    h.flags.expired.add('a').add('b')
    h.recovery.noteExpired('a', SAFE)
    await h.recovery.start('a')
    h.recovery.noteExpired('b', SAFE)
    h.flags.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual(['a', 'b'])
  })

  it('an unattended conversation never opens the login by itself; the button still works', async () => {
    const h = harness()
    h.flags.auto = true
    h.flags.expired.add('job')
    h.recovery.noteExpired('job', { relogin: true, hold: null, unattended: true })
    await h.settle()
    expect(h.opened).toEqual([])
    expect(await h.recovery.start('job')).toEqual({ opened: true })
    h.flags.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual(['job'])
  })
})

describe('LoginRecovery: review of TODO 1282', () => {
  /** main's record of the expired threads (what `SessionManager.authExpiredThreads` / `authExpiryInfo` give). */
  function withRecord(infos: Map<string, ExpiryInfo>) {
    const h = harness({ describe: (id) => infos.get(id) ?? null, expiredThreads: () => infos.keys() })
    for (const id of infos.keys()) h.flags.expired.add(id)
    return h
  }

  it('another Log in after a cancel puts back every thread main still records as expired (the notice button from A covers B)', async () => {
    const h = withRecord(
      new Map<string, ExpiryInfo>([
        ['a', SAFE],
        ['b', SAFE],
        ['key', { relogin: false, hold: null, unattended: false }]
      ])
    )
    h.recovery.noteExpired('a', SAFE)
    h.recovery.noteExpired('b', SAFE)
    await h.recovery.start('a')
    h.recovery.cancel()
    expect(h.recovery.state().waiting).toEqual([])
    await h.recovery.start('a')
    // A rejected credential is not put into a login wait (constraint 3).
    expect(h.recovery.state().waiting).toEqual([
      { threadId: 'a', resend: true, why: null },
      { threadId: 'b', resend: true, why: null }
    ])
    h.flags.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual(['a', 'b'])
  })

  it("a thread that is put back keeps main's reason (a turn that had started tools is still not resent)", async () => {
    const h = withRecord(
      new Map<string, ExpiryInfo>([
        ['a', SAFE],
        ['tools', TOOLS]
      ])
    )
    await h.recovery.start('a')
    h.recovery.cancel()
    await h.recovery.start('a')
    expect(h.recovery.state().waiting).toContainEqual({ threadId: 'tools', resend: false, why: 'tool-started' })
    h.flags.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual(['a'])
  })

  it('the cooldown survives a cancel: a resend that stopped on the login again is not resent by the next Log in', async () => {
    const h = withRecord(new Map<string, ExpiryInfo>([['a', SAFE]]))
    h.recovery.noteExpired('a', SAFE)
    await h.recovery.start('a')
    h.flags.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual(['a'])
    // The automatic resend stopped on the login again.
    h.flags.loggedIn = false
    h.recovery.noteExpired('a', SAFE)
    await h.recovery.start('a')
    h.recovery.cancel()
    // The wait is rebuilt from main's record (hold: null), but the cooldown still holds it.
    await h.recovery.start('a')
    expect(h.recovery.state().waiting).toEqual([{ threadId: 'a', resend: false, why: 'still-failing' }])
    h.flags.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual(['a'])
    expect(h.recovery.state()).toMatchObject({ phase: 'recovered', held: [{ threadId: 'a', why: 'still-failing' }] })
  })

  it('the cooldown survives a wait dropped by closing every window too, for a thread first added by the button', async () => {
    const h = withRecord(new Map<string, ExpiryInfo>([['a', SAFE]]))
    await h.recovery.start('a')
    h.flags.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual(['a'])
    h.flags.loggedIn = false
    h.recovery.noteExpired('a', SAFE)
    await h.recovery.start('a')
    h.flags.viewer = false
    await h.advance()
    expect(h.recovery.state().phase).toBe('cancelled')
    h.flags.viewer = true
    await h.recovery.start('a')
    h.flags.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual(['a'])
  })

  it("a later failure keeps B's reason and A's still-failing (held is per thread)", async () => {
    const h = harness()
    h.flags.expired.add('a').add('b')
    h.recovery.noteExpired('a', SAFE)
    h.recovery.noteExpired('b', TOOLS)
    await h.recovery.start('a')
    h.flags.loggedIn = true
    await h.advance()
    expect(h.recovery.state()).toMatchObject({ phase: 'recovered', resent: ['a'], held: [{ threadId: 'b', why: 'tool-started' }] })
    // A's resend stopped on the login again.
    h.recovery.noteExpired('a', SAFE)
    const state = h.recovery.state()
    expect(state).toMatchObject({ phase: 'failed', failure: 'login-still-failing' })
    expect(state.held).toEqual([
      { threadId: 'b', why: 'tool-started' },
      { threadId: 'a', why: 'still-failing' }
    ])
  })

  it('a still-failing noted while the resends run is not wiped by the recovered that follows', async () => {
    let recovery: LoginRecovery | null = null
    const sent: string[] = []
    const h = harness({
      resend: async (id) => {
        sent.push(id)
        // The resent turn's result stops on the login again before the resend resolves.
        if (id === 'a') recovery?.noteExpired('a', SAFE)
      }
    })
    recovery = h.recovery
    h.flags.expired.add('a').add('b')
    h.recovery.noteExpired('a', SAFE)
    h.recovery.noteExpired('b', SAFE)
    await h.recovery.start('a')
    h.flags.loggedIn = true
    await h.advance()
    expect(sent).toEqual(['a', 'b'])
    expect(h.states.some((s) => s.phase === 'failed' && s.failure === 'login-still-failing')).toBe(true)
    expect(h.recovery.state()).toMatchObject({ phase: 'recovered', held: [{ threadId: 'a', why: 'still-failing' }] })
  })

  it('the kept reason goes when the mark is cleared or the thread expires afresh', async () => {
    const h = harness()
    h.flags.expired.add('a').add('b')
    h.recovery.noteExpired('a', TOOLS)
    h.recovery.noteExpired('b', TOOLS)
    await h.recovery.start('a')
    h.flags.loggedIn = true
    await h.advance()
    expect(h.recovery.state().held).toHaveLength(2)
    h.recovery.noteCleared('a')
    h.flags.expired.delete('a')
    h.recovery.noteExpired('b', SAFE)
    h.flags.loggedIn = false
    await h.recovery.start('b')
    expect(h.recovery.state().held).toEqual([])
  })
})
