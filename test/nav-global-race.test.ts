// @vitest-environment jsdom
/**
 * TODO 1257 (wave 92 fix Y): `navigateGlobal` waits for `fs.stat` before it moves. A conversation picked during that
 * wait must not be overwritten by the step computed before the wait.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NavEntry } from '../src/renderer/src/nav-history.js'

const entry = (threadId: string, viewerUri: string | null): NavEntry => ({ threadId, viewerUri, at: 0, rapid: false })

describe('navigateGlobal: a pick during the stat wait', () => {
  let release: ((value: unknown) => void) | null
  let selected: string[]

  beforeEach(() => {
    selected = []
    release = null
    ;(window as unknown as { aios: unknown }).aios = {
      fs: { stat: () => new Promise((resolve) => (release = resolve)) }
    }
  })

  it('computes the step again from the history as it is after the wait', async () => {
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const { useStore } = await import('../src/renderer/src/store.js')
    const { useNav, navigateGlobal } = await import('../src/renderer/src/navHistory.js')
    useStore.setState({ selectedUri: null })
    useThreads.setState({
      activeThreadId: 'c',
      threadsById: { a: {} as never, b: {} as never, c: {} as never, d: {} as never },
      selectThread: async (id: string) => {
        selected.push(id)
        useThreads.setState({ activeThreadId: id })
      }
    })
    useNav.setState({
      history: { entries: [entry('a', null), entry('b', 'file:///b.txt'), entry('c', null)], index: 2 }
    })
    const moved = navigateGlobal('back')
    // While stat is pending, the user picks conversation d (a new step on top of c).
    await vi.waitFor(() => expect(release).not.toBeNull())
    useThreads.setState({ activeThreadId: 'd' })
    useNav.setState({
      history: {
        entries: [entry('a', null), entry('b', 'file:///b.txt'), entry('c', null), entry('d', null)],
        index: 3
      }
    })
    release?.({ uri: 'file:///b.txt' })
    expect(await moved).toBe(true)
    const history = useNav.getState().history
    // d is kept, and back from d lands on c (not on b, which was the destination before the wait).
    expect(history.entries.map((e) => e.threadId)).toEqual(['a', 'b', 'c', 'd'])
    expect(history.index).toBe(2)
    expect(selected).toEqual(['c'])
  })
})
