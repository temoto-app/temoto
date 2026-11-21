// @vitest-environment jsdom
/**
 * TODO 1100: rendering of the skill badges at the head of a response turn (`SkillBadges`). A badge that can be looked up can be pressed, and opens its body in ViewerPane (`select(uri)`); if it cannot be looked up, only the badge is shown. Interpretation, saving, and folding are in `test/skill-badges.test.ts`.
 *
 * Neither the real CLI nor a model is called. `window.aios` is a minimal fake with only `skills.list`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SkillEntry } from '../src/shared/skills.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const entry = (patch: Partial<SkillEntry>): SkillEntry => ({
  name: 'x',
  dirName: 'x',
  description: '',
  scope: 'user',
  pluginName: null,
  uri: 'file:///x/SKILL.md',
  linked: false,
  readOnly: false,
  ...patch
})

describe('SkillBadges の描画 (TODO 1100)', () => {
  let root: Root
  let host: HTMLDivElement
  const list = vi.fn(async (cwdUri: string | null) => ({
    skills: [
      entry({ name: 'greet-check', dirName: 'greet-check', scope: 'project', uri: `${cwdUri ?? ''}/skills/greet-check/SKILL.md` })
    ],
    projectChecked: true
  }))

  beforeEach(async () => {
    ;(window as unknown as { aios: unknown }).aios = { skills: { list } }
    const { resetSkillListingCache } = await import('../src/renderer/src/components/SkillBadges.js')
    resetSkillListingCache()
    list.mockClear()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const { useLocale } = await import('../src/renderer/src/localeStore.js')
    useLocale.setState({ resolved: 'en' })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('引けた札は押せて本体を開く。引けない札は押せない。一覧は作業フォルダごとに 1 回', async () => {
    const { useStore } = await import('../src/renderer/src/store.js')
    const select = vi.fn()
    useStore.setState({ select } as never)
    const { SkillBadges } = await import('../src/renderer/src/components/SkillBadges.js')
    await act(async () => {
      root.render(
        createElement('div', null, [
          createElement(SkillBadges, { key: 'a', badges: [{ name: 'greet-check' }, { name: 'bundled-only' }], cwdUri: 'file:///Users/me/project' }),
          createElement(SkillBadges, { key: 'b', badges: [{ name: 'greet-check' }], cwdUri: 'file:///Users/me/project' })
        ])
      )
    })
    await act(async () => {})
    expect(list).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledWith('file:///Users/me/project')
    const rows = host.querySelectorAll('.skill-badges')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.querySelector('.skill-badges-label')?.textContent).toBe('Skill')
    const buttons = rows[0]!.querySelectorAll('button.skill-badge')
    expect([...buttons].map((b) => b.textContent)).toEqual(['greet-check'])
    const plain = rows[0]!.querySelector('span.skill-badge')
    expect(plain?.textContent).toBe('bundled-only')
    expect(plain?.getAttribute('title')).toContain('not found')
    act(() => (buttons[0] as HTMLButtonElement).click())
    expect(select).toHaveBeenCalledWith('file:///Users/me/project/skills/greet-check/SKILL.md')
  })

  it('一覧の取得に失敗したら使い回さず、次の描画で引き直して押せる札にする (review)', async () => {
    list.mockRejectedValueOnce(new Error('boom'))
    const { SkillBadges } = await import('../src/renderer/src/components/SkillBadges.js')
    const cwdUri = 'file:///Users/me/flaky'
    await act(async () => {
      root.render(createElement(SkillBadges, { key: 'first', badges: [{ name: 'greet-check' }], cwdUri }))
    })
    await act(async () => {})
    expect(list).toHaveBeenCalledTimes(1)
    expect(host.querySelectorAll('button.skill-badge')).toHaveLength(0)
    // Even within the TTL (15 seconds), a list that failed is not kept, so it is fetched again.
    await act(async () => {
      root.render(createElement(SkillBadges, { key: 'second', badges: [{ name: 'greet-check' }], cwdUri }))
    })
    await act(async () => {})
    expect(list).toHaveBeenCalledTimes(2)
    expect([...host.querySelectorAll('button.skill-badge')].map((b) => b.textContent)).toEqual(['greet-check'])
  })
})
