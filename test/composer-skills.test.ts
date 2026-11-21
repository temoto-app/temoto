// @vitest-environment jsdom
/**
 * TODO 564 (wave 27 bundle H): shows the CLI's skills in the Composer's `/` completion with a "skill" badge, and the last item
 * "create a new skill" puts a request template into the input field that asks the CLI to write a skill (not sent).
 *
 * The list is synthetic (that the Adapter reads `skills` from init is checked by `test/parse-event.test.ts` against the real fixture).
 * jsdom cannot read the compat table, so parseEvent is not run here. Neither the real CLI nor the model is called. `window.aios` is a minimal fake with only the entry points touched at render time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AiosEvent } from '../src/shared/agent.js'
import type { ThreadSummary } from '../src/shared/thread.js'
import { skillsFor, slashMenuStep } from '../src/renderer/src/composer-slash.js'
import { lastSkills } from '../src/renderer/src/thread-events.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const COMMANDS = ['my-skill', 'compact', 'context']
const SKILLS = ['my-skill']

function started(id: string, skills: readonly string[] | undefined): AiosEvent {
  return {
    id,
    sessionId: 's',
    threadId: 't1',
    ts: 1,
    actor: 'main',
    kind: 'session_started',
    payload: { backendSessionId: 'b', tools: [], toolServers: [], resumed: false, commands: COMMANDS, skills }
  } as unknown as AiosEvent
}

describe('skillsFor / slashMenuStep / lastSkills (TODO 564)', () => {
  it('スレッド自身の一覧が優先、無ければ最後に報告された一覧、どちらも無ければ null', () => {
    const own = ['a']
    const recent = ['b']
    expect(skillsFor(own, recent)).toBe(own)
    expect(skillsFor(undefined, recent)).toBe(recent)
    expect(skillsFor(undefined, null)).toBeNull()
  })

  it('↑↓ は末尾の行を含めて巡回する', () => {
    expect(slashMenuStep(2, 1, 3)).toBe(0)
    expect(slashMenuStep(0, -1, 3)).toBe(2)
    expect(slashMenuStep(0, 1, 0)).toBe(0)
  })

  it('最後の session_started の skills を返す。欄の無い行は飛ばす', () => {
    const init = started('e1', SKILLS)
    expect(lastSkills([init])).toEqual(SKILLS)
    const old = started('old', undefined)
    expect(lastSkills([init, old])).toEqual(SKILLS)
    expect(lastSkills([old])).toBeUndefined()
  })
})

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(window as unknown as { aios: unknown }).aios = {
    drop: { uriFor: (file: { uri?: string }) => file.uri ?? '' },
    attachments: { pick: vi.fn(async () => []) },
    threads: { setPlanMode: vi.fn() },
    fs: {}
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(draft: string): Promise<typeof import('../src/renderer/src/threadStore.js')['useThreads']> {
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  const runtime = { state: 'idle', live: false } as unknown as ThreadSummary['runtime']
  useThreads.setState({
    drafts: { t1: draft },
    attachments: {},
    sending: new Set(),
    error: null,
    threadsById: { t1: { thread: {}, runtime, preview: null } as unknown as ThreadSummary },
    threadCommands: { t1: COMMANDS },
    threadSkills: { t1: SKILLS }
  })
  const { useLocale } = await import('../src/renderer/src/localeStore.js')
  useLocale.setState({ resolved: 'en' })
  const { Composer } = await import('../src/renderer/src/components/Composer.js')
  act(() => root.render(createElement(Composer, { threadId: 't1' })))
  await act(async () => {})
  return useThreads
}

function rows(): HTMLLIElement[] {
  return [...host.querySelectorAll<HTMLLIElement>('.composer-slash-menu li')]
}

describe('Composer の `/` の補完の skill (TODO 564)', () => {
  it('skill には札が付き、組み込みのコマンドには付かない', async () => {
    await render('/')
    const skill = rows().find((li) => li.querySelector('.slash-name')?.textContent === '/my-skill')
    expect(skill?.querySelector('.slash-skill-tag')?.textContent).toBe('skill')
    await render('/comp')
    const compact = rows().find((li) => li.querySelector('.slash-name')?.textContent === '/compact')
    expect(compact).not.toBeUndefined()
    expect(compact?.querySelector('.slash-skill-tag')).toBeNull()
  })

  it('末尾に「新しい skill を作る」。押すと依頼の雛形が入力欄に入る (送らない)', async () => {
    const useThreads = await render('/')
    const last = rows().at(-1)!
    expect(last.classList.contains('slash-create-skill')).toBe(true)
    expect(last.textContent).toBe('Create a new skill…')
    const send = vi.fn(async () => undefined)
    useThreads.setState({ send })
    act(() => last.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })))
    const draft = useThreads.getState().drafts['t1'] ?? ''
    expect(draft).toContain('Create a new CLI skill')
    expect(draft.endsWith('Instructions:\n')).toBe(true)
    expect(send).not.toHaveBeenCalled()
    // The template does not start with `/`, so completion closes.
    expect(host.querySelector('.composer-slash-menu')).toBeNull()
  })

  it('↑ で末尾へ回り、Enter で雛形を入れる', async () => {
    const useThreads = await render('/')
    const textarea = host.querySelector('textarea')!
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    })
    expect(rows().at(-1)?.classList.contains('active')).toBe(true)
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(useThreads.getState().drafts['t1'] ?? '').toContain('Create a new CLI skill')
  })
})
