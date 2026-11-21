/**
 * TODO 960: automatic recovery from an expired login. Does not call the real Terminal, CLI, or model (openLogin / isLoggedIn / resend are fakes;
 * the clock and timers are advanced by hand).
 */
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUTH_AUTO_LOGIN } from '../src/common/settings-keys.js'
import { isApiKeyAuthMethod } from '../src/main/session/adapter/index.js'
import { openTerminalWithCli, terminalScript } from '../src/main/editor/terminal.js'
import {
  AUTO_RESEND_COOLDOWN_MS,
  LOGIN_POLL_INTERVAL_MS,
  LOGIN_POLL_TIMEOUT_MS,
  LoginRecovery,
  type LoginRecoveryDeps
} from '../src/main/session/login-recovery.js'

function harness(overrides: Partial<LoginRecoveryDeps> = {}) {
  let clock = 0
  const timers: Array<{ fn: () => void; at: number; id: number }> = []
  let seq = 0
  const opened: Array<string | null> = []
  const resent: string[] = []
  const state = { loggedIn: false, expired: new Set<string>(), auto: false }
  const deps: LoginRecoveryDeps = {
    openLogin: async (threadId) => {
      opened.push(threadId)
      return { opened: true }
    },
    isLoggedIn: async () => state.loggedIn,
    stillExpired: (id) => state.expired.has(id),
    resend: async (id) => {
      resent.push(id)
    },
    autoOpen: () => state.auto,
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = ++seq
      timers.push({ fn, at: clock + ms, id })
      return id
    },
    clearTimer: (handle) => {
      const at = timers.findIndex((t) => t.id === handle)
      if (at !== -1) timers.splice(at, 1)
    },
    ...overrides
  }
  const recovery = new LoginRecovery(deps)
  /** Advance 3 seconds, then wait until the body of the timer that fired has finished. */
  const advance = async (): Promise<void> => {
    clock += LOGIN_POLL_INTERVAL_MS
    const due = timers.filter((t) => t.at <= clock)
    for (const t of due) {
      timers.splice(timers.indexOf(t), 1)
      t.fn()
    }
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  }
  return { recovery, state, opened, resent, timers, advance }
}

describe('LoginRecovery (TODO 960)', () => {
  it('ログインできたら、止まっていたスレッドごとに 1 回だけ再送する', async () => {
    const h = harness()
    h.state.expired.add('a').add('b')
    h.recovery.noteExpired('a')
    h.recovery.noteExpired('b')
    expect(await h.recovery.start('a')).toEqual({ opened: true })
    await h.advance()
    expect(h.resent).toEqual([])
    h.state.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual(['a', 'b'])
    // Nothing runs after this (no second resend)
    await h.advance()
    expect(h.resent).toEqual(['a', 'b'])
    expect(h.recovery.isActive()).toBe(false)
  })

  it('同時に何度押しても Terminal は 1 つ (待っている間は開き直さず、再送の対象に足すだけ)', async () => {
    const h = harness()
    h.state.expired.add('a').add('b')
    await Promise.all([h.recovery.start('a'), h.recovery.start('b')])
    await h.recovery.start('b')
    expect(h.opened).toHaveLength(1)
    h.state.loggedIn = true
    await h.advance()
    expect(h.resent.sort()).toEqual(['a', 'b'])
  })

  it('時間切れ (5 分) は案内に戻る — 再送しない', async () => {
    const h = harness()
    h.state.expired.add('a')
    await h.recovery.start('a')
    for (let at = 0; at < LOGIN_POLL_TIMEOUT_MS; at += LOGIN_POLL_INTERVAL_MS) await h.advance()
    expect(h.recovery.isActive()).toBe(false)
    expect(h.timers).toHaveLength(0)
    // Even if it succeeds late, nothing is resent, since the wait was already dropped
    h.state.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual([])
  })

  it('手で送り直した (印が消えた) スレッドには再送しない', async () => {
    const h = harness()
    h.state.expired.add('a').add('b')
    await h.recovery.start('a')
    h.recovery.noteExpired('b')
    h.state.expired.delete('a') // Resent by hand
    h.recovery.noteCleared('a')
    h.state.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual(['b'])
  })

  it('開けなかったら polling しない (API キー利用者の login-api-key など)', async () => {
    const h = harness({ openLogin: async () => ({ opened: false, reason: 'login-api-key' }) })
    h.state.expired.add('a')
    expect(await h.recovery.start('a')).toEqual({ opened: false, reason: 'login-api-key' })
    expect(h.recovery.isActive()).toBe(false)
    expect(h.timers).toHaveLength(0)
  })

  it('設定がオフなら noteExpired では開かない / オンならボタン無しで開く', async () => {
    const off = harness()
    off.recovery.noteExpired('a')
    await Promise.resolve()
    expect(off.opened).toEqual([])
    const on = harness()
    on.state.auto = true
    on.state.expired.add('a')
    on.recovery.noteExpired('a')
    on.recovery.noteExpired('b') // Even if they expire at the same time, there is only one Terminal
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(on.opened).toEqual(['a'])
    on.state.loggedIn = true
    on.state.expired.add('b')
    await on.advance()
    expect(on.resent.sort()).toEqual(['a', 'b'])
  })

  it('review: 自動はログイン済みのままの認証切れでは開かない (開いても完了を見分けられない)', async () => {
    const h = harness()
    h.state.auto = true
    h.state.loggedIn = true
    h.state.expired.add('a')
    h.recovery.noteExpired('a')
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    expect(h.opened).toEqual([])
    expect(h.recovery.isActive()).toBe(false)
    // The user's "log in" works
    expect(await h.recovery.start('a')).toEqual({ opened: true })
  })

  it('review: 自動の再送がまた認証切れになったら、一定時間は自動で開き直さない (ループしない)', async () => {
    let clock = 0
    const h = harness({ now: () => clock })
    h.state.auto = true
    h.state.expired.add('a')
    h.recovery.noteExpired('a')
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    expect(h.opened).toEqual(['a'])
    h.state.loggedIn = true
    await h.advance()
    expect(h.resent).toEqual(['a'])
    // A resend that is again an authentication error (even if auth status went back to logged-out) does not open automatically
    h.state.loggedIn = false
    h.recovery.noteExpired('a')
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    expect(h.opened).toEqual(['a'])
    // Another thread still opens automatically, as before
    h.state.expired.add('b')
    h.recovery.noteExpired('b')
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    expect(h.opened).toEqual(['a', 'b'])
    h.recovery.stop()
    // Once the limit time has passed, it can open automatically again
    const later = harness({ now: () => clock })
    later.state.auto = true
    later.state.expired.add('a')
    later.recovery.noteExpired('a')
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    later.state.loggedIn = true
    await later.advance()
    expect(later.resent).toEqual(['a'])
    clock += AUTO_RESEND_COOLDOWN_MS
    later.state.loggedIn = false
    later.recovery.noteExpired('a')
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    expect(later.opened).toEqual(['a', 'a'])
  })

  it('確認が投げても polling は続く / stop で止まる', async () => {
    let calls = 0
    const h = harness({
      isLoggedIn: async () => {
        calls += 1
        throw new Error('boom')
      }
    })
    await h.recovery.start('a')
    await h.advance()
    await h.advance()
    expect(calls).toBe(2)
    h.recovery.stop()
    expect(h.timers).toHaveLength(0)
    expect(await h.recovery.start('a')).toMatchObject({ opened: false })
  })
})

describe('認証方式と端末のスクリプト (TODO 960)', () => {
  it('API キー系の認証方式を見分ける (購読のログインは対象)', () => {
    expect(isApiKeyAuthMethod('api_key')).toBe(true)
    expect(isApiKeyAuthMethod('ANTHROPIC_API_KEY')).toBe(true)
    expect(isApiKeyAuthMethod('claude.ai')).toBe(false)
    expect(isApiKeyAuthMethod(null)).toBe(false)
    // review: true only when sure. A value containing a token (an OAuth token of a subscription is possible too), none, or an unknown value counts as subscription.
    expect(isApiKeyAuthMethod('apiKeyHelper')).toBe(true)
    expect(isApiKeyAuthMethod('bedrock')).toBe(true)
    expect(isApiKeyAuthMethod('oauth_token')).toBe(false)
    expect(isApiKeyAuthMethod('none')).toBe(false)
    expect(isApiKeyAuthMethod('api')).toBe(false)
  })

  it('引数付きのスクリプトは exec せず、終わったらシェルを抜ける。引数は引用符で閉じる', () => {
    const script = terminalScript('/work/it', 'tool', ['auth', "log'in"])
    expect(script).toContain(`'tool' 'auth' 'log'\\''in'`)
    expect(script).toContain('exit $?')
    expect(script).not.toContain('exec ')
    expect(script).not.toContain('osascript')
    expect(terminalScript('/work/it', 'tool')).toContain("exec 'tool'")
  })

  it('openTerminalWithCli は引数付きの対象で .command を書き、偽の open に渡す', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aios-login-test-'))
    let seen = ''
    const result = await openTerminalWithCli(
      {
        assertAllowed: (uri) => decodeURIComponent(new URL(uri).pathname),
        platform: 'darwin',
        tmpRoot: root,
        openInTerminal: async (path) => {
          seen = await readFile(path, 'utf8')
        }
      },
      { cwd: root, command: 'tool', args: ['auth', 'login'] }
    )
    expect(result).toEqual({ opened: true })
    expect(seen).toContain("'tool' 'auth' 'login'")
    expect((await readdir(root)).length).toBe(1)
    const bad = await openTerminalWithCli(
      { assertAllowed: () => root, platform: 'darwin', tmpRoot: root, openInTerminal: async () => undefined },
      { cwd: root, command: 'tool', args: ['a\nb'] }
    )
    expect(bad).toEqual({ opened: false, reason: 'terminal-no-command' })
  })
})

describe('auth.autoLogin の既定 (TODO 1178)', () => {
  it('未保存は真、保存済みの false は偽、true は真', () => {
    expect(AUTH_AUTO_LOGIN.parse(null)).toBe(true)
    expect(AUTH_AUTO_LOGIN.parse('false')).toBe(false)
    expect(AUTH_AUTO_LOGIN.parse('true')).toBe(true)
  })
})
