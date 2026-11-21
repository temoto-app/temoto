/**
 * Restoring PATH at GUI launch (`src/main/path-env.ts`).
 *
 * Launched from Finder or BetterTouchTool, PATH has only launchd's defaults, and the agent CLI cannot be found. A regression test for that recovery path.
 */
import { describe, it, expect } from 'vitest'
import { looksLikeGuiLaunch, widenPathForGuiLaunch } from '../src/main/path-env.js'

const LAUNCHD = '/usr/bin:/bin:/usr/sbin:/sbin'

describe('looksLikeGuiLaunch', () => {
  it('launchd の既定だけなら GUI 起動とみなす', () => {
    expect(looksLikeGuiLaunch(LAUNCHD)).toBe(true)
    expect(looksLikeGuiLaunch('/sbin:/bin')).toBe(true)
    expect(looksLikeGuiLaunch('')).toBe(true)
    expect(looksLikeGuiLaunch(undefined)).toBe(true)
  })

  it('1 つでも独自の項目があればターミナル起動とみなす', () => {
    expect(looksLikeGuiLaunch(`${LAUNCHD}:/opt/homebrew/bin`)).toBe(false)
    expect(looksLikeGuiLaunch('/Users/x/.local/bin')).toBe(false)
  })
})

describe('widenPathForGuiLaunch', () => {
  it('ログインシェルの PATH を前に置き、既定はその後ろに残す', async () => {
    const env: NodeJS.ProcessEnv = { PATH: LAUNCHD, SHELL: '/bin/zsh' }
    const path = await widenPathForGuiLaunch(env, async () => '/Users/x/.local/bin:/usr/bin')

    const entries = path.split(':')
    expect(entries[0]).toBe('/Users/x/.local/bin')
    expect(entries).toContain('/usr/bin')
    expect(env.PATH).toBe(path)
  })

  it('同じディレクトリを 2 度足さない', async () => {
    const env: NodeJS.ProcessEnv = { PATH: LAUNCHD }
    const path = await widenPathForGuiLaunch(env, async () => '/usr/bin:/bin:/usr/bin')

    const entries = path.split(':')
    expect(new Set(entries).size).toBe(entries.length)
  })

  it('rc が echo した行は無視し、最後の非空行だけを PATH として読む', async () => {
    const env: NodeJS.ProcessEnv = { PATH: LAUNCHD }
    const noisy = 'nvm を読み込みました\n\n/opt/homebrew/bin:/usr/bin\n'
    const path = await widenPathForGuiLaunch(env, async () => noisy)

    expect(path.split(':')[0]).toBe('/opt/homebrew/bin')
    expect(path).not.toContain('nvm')
  })

  it('シェルが何も返さなくても既定の PATH は壊さない', async () => {
    const env: NodeJS.ProcessEnv = { PATH: LAUNCHD }
    const path = await widenPathForGuiLaunch(env, async () => '')

    for (const entry of LAUNCHD.split(':')) expect(path.split(':')).toContain(entry)
  })

  it('ターミナル起動ならログインシェルを呼ばない', async () => {
    const env: NodeJS.ProcessEnv = { PATH: `${LAUNCHD}:/opt/homebrew/bin` }
    let called = false
    const path = await widenPathForGuiLaunch(env, async () => {
      called = true
      return '/should/not/be/used'
    })

    expect(called).toBe(false)
    expect(path).toBe(`${LAUNCHD}:/opt/homebrew/bin`)
  })
})
