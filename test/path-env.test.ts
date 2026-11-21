/**
 * Restoring PATH at GUI launch (`src/main/path-env.ts`).
 *
 * Launched from Finder or BetterTouchTool, PATH has only launchd's defaults, and the agent CLI cannot be found. A regression test for that recovery path.
 */
import { describe, it, expect } from 'vitest'
import { looksLikeGuiLaunch, widenPathForGuiLaunch } from '../src/main/path-env.js'

const LAUNCHD = '/usr/bin:/bin:/usr/sbin:/sbin'

describe('looksLikeGuiLaunch', () => {
  it('regards only the launchd default as a GUI launch', () => {
    expect(looksLikeGuiLaunch(LAUNCHD)).toBe(true)
    expect(looksLikeGuiLaunch('/sbin:/bin')).toBe(true)
    expect(looksLikeGuiLaunch('')).toBe(true)
    expect(looksLikeGuiLaunch(undefined)).toBe(true)
  })

  it('regards even one custom entry as a terminal launch', () => {
    expect(looksLikeGuiLaunch(`${LAUNCHD}:/opt/homebrew/bin`)).toBe(false)
    expect(looksLikeGuiLaunch('/Users/x/.local/bin')).toBe(false)
  })
})

describe('widenPathForGuiLaunch', () => {
  it("puts the login shell's PATH first and leaves the default after it", async () => {
    const env: NodeJS.ProcessEnv = { PATH: LAUNCHD, SHELL: '/bin/zsh' }
    const path = await widenPathForGuiLaunch(env, async () => '/Users/x/.local/bin:/usr/bin')

    const entries = path.split(':')
    expect(entries[0]).toBe('/Users/x/.local/bin')
    expect(entries).toContain('/usr/bin')
    expect(env.PATH).toBe(path)
  })

  it('does not add the same directory twice', async () => {
    const env: NodeJS.ProcessEnv = { PATH: LAUNCHD }
    const path = await widenPathForGuiLaunch(env, async () => '/usr/bin:/bin:/usr/bin')

    const entries = path.split(':')
    expect(new Set(entries).size).toBe(entries.length)
  })

  it('ignores lines echoed by rc and reads only the last non-empty line as PATH', async () => {
    const env: NodeJS.ProcessEnv = { PATH: LAUNCHD }
    const noisy = 'nvm を読み込みました\n\n/opt/homebrew/bin:/usr/bin\n'
    const path = await widenPathForGuiLaunch(env, async () => noisy)

    expect(path.split(':')[0]).toBe('/opt/homebrew/bin')
    expect(path).not.toContain('nvm')
  })

  it('does not break the default PATH even when the shell returns nothing', async () => {
    const env: NodeJS.ProcessEnv = { PATH: LAUNCHD }
    const path = await widenPathForGuiLaunch(env, async () => '')

    for (const entry of LAUNCHD.split(':')) expect(path.split(':')).toContain(entry)
  })

  it('does not call the login shell for a terminal launch', async () => {
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
