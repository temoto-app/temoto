/**
 * @vitest-environment jsdom
 *
 * TODO 750: `threadStore.send` round trip: an accident where text typed into the Composer and attachments added during the round trip of `threadStore.send` get cleared at the end of the round trip (`refreshStatus` / the first probe / spawn in main can take several seconds).
 *
 * - Clear the field **immediately** after pressing. Text retyped and attachments added during the round trip remain, and if main's send fails, the text as of the press is put back (if nothing was typed, it is put back as is; if something was typed, it is prepended).
 * - `!` (shell): if main's `submit` is sending, it adds to the reservations, so the renderer's `sending` is not held up until the command ends (up to 120 seconds on the main side); it does not block other sends.
 *
 * `window.aios.threads.send` is replaced with a `Promise` that waits until the test resolves it, and `setDraft` / `sending` are checked during that time. Neither a model nor Electron is used.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function stubAios(overrides: { send?: (...args: unknown[]) => Promise<unknown> } = {}): void {
  ;(globalThis as { window: typeof window }).window = globalThis.window ?? ({} as typeof window)
  Object.defineProperty(window, 'aios', {
    configurable: true,
    value: {
      threads: {
        send: overrides.send ?? vi.fn().mockResolvedValue({ kind: 'sent' }),
        sendInterrupt: vi.fn().mockResolvedValue({ kind: 'sent' })
      }
    }
  })
}

describe('threadStore.send — draft during the round trip (TODO 750)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('the field is empty right after the press, and text typed during the round trip remains (when main succeeds)', async () => {
    const pending = deferred<{ kind: 'sent' }>()
    stubAios({ send: vi.fn().mockReturnValue(pending.promise) })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    useThreads.setState({ drafts: { t1: '元の文' } })

    const sendPromise = useThreads.getState().send('t1', undefined)
    // Before the await, the field should already be emptied synchronously.
    expect(useThreads.getState().drafts['t1']).toBe('')
    expect(useThreads.getState().sending.has('t1')).toBe(true)

    // Retyped during the round trip.
    useThreads.getState().setDraft('t1', '次の文')

    pending.resolve({ kind: 'sent' })
    await sendPromise

    // Text typed during the round trip remains (it is not cleared on main's success).
    expect(useThreads.getState().drafts['t1']).toBe('次の文')
    expect(useThreads.getState().sending.has('t1')).toBe(false)
  })

  it('when main fails, puts the original text back if nothing was typed', async () => {
    const pending = deferred<unknown>()
    stubAios({ send: vi.fn().mockReturnValue(pending.promise) })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    useThreads.setState({ drafts: { t1: '元の文' } })

    const sendPromise = useThreads.getState().send('t1', undefined)
    expect(useThreads.getState().drafts['t1']).toBe('')

    pending.reject(new Error('agent-not-logged-in'))
    await sendPromise

    expect(useThreads.getState().drafts['t1']).toBe('元の文')
    expect(useThreads.getState().error).not.toBeNull()
    expect(useThreads.getState().sending.has('t1')).toBe(false)
  })

  it('when main fails and something was typed meanwhile, prepends the original text', async () => {
    const pending = deferred<unknown>()
    stubAios({ send: vi.fn().mockReturnValue(pending.promise) })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    useThreads.setState({ drafts: { t1: '元の文' } })

    const sendPromise = useThreads.getState().send('t1', undefined)
    useThreads.getState().setDraft('t1', '打ち直した文')

    pending.reject(new Error('agent-not-logged-in'))
    await sendPromise

    expect(useThreads.getState().drafts['t1']).toBe('元の文\n打ち直した文')
  })

  it('attachments are the same: put back on failure, and those added during the round trip stay in front', async () => {
    const pending = deferred<unknown>()
    stubAios({ send: vi.fn().mockReturnValue(pending.promise) })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const original = { uri: 'file:///a.txt', kind: 'reference' as const, name: 'a.txt', mediaType: null, bytes: 0 }
    const extra = { uri: 'file:///b.txt', kind: 'reference' as const, name: 'b.txt', mediaType: null, bytes: 0 }
    useThreads.setState({ drafts: { t1: '文' }, attachments: { t1: [original] } })

    const sendPromise = useThreads.getState().send('t1', undefined)
    expect(useThreads.getState().attachments['t1']).toEqual([])

    useThreads.setState((state) => ({ attachments: { ...state.attachments, t1: [extra] } }))

    pending.reject(new Error('fail'))
    await sendPromise

    expect(useThreads.getState().attachments['t1']).toEqual([original, extra])
  })

  it('`!` (shell) lowers sending immediately and does not block other sends meanwhile', async () => {
    const pending = deferred<unknown>()
    stubAios({ send: vi.fn().mockReturnValue(pending.promise) })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    useThreads.setState({ drafts: { t1: 'ls' } })

    const sendPromise = useThreads.getState().send('t1', undefined, false, null, true)
    // Lower it right away, without waiting for main's round trip (up to 120 seconds).
    expect(useThreads.getState().sending.has('t1')).toBe(false)
    // Attachments are not touched (`!` does not send attachments).
    expect(useThreads.getState().attachments['t1']).toBeUndefined()

    pending.resolve({ kind: 'sent' })
    await sendPromise
    // A command that succeeded is not put back (it stays cleared from right after pressing).
    expect(useThreads.getState().drafts['t1']).toBe('')
  })

  it('when `!` fails, puts the typed command back', async () => {
    const pending = deferred<unknown>()
    stubAios({ send: vi.fn().mockReturnValue(pending.promise) })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    useThreads.setState({ drafts: { t1: 'ls' } })

    const sendPromise = useThreads.getState().send('t1', undefined, false, null, true)
    pending.reject(new Error('shell-invalid'))
    await sendPromise

    expect(useThreads.getState().drafts['t1']).toBe('ls')
    expect(useThreads.getState().error).not.toBeNull()
  })
})

describe('threadStore.send — the mark to move to the bottom (TODO 823)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('sendScroll advances on every send, whether normal, interrupt, or !', async () => {
    stubAios()
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    expect(useThreads.getState().sendScroll).toBeNull()
    useThreads.setState({ drafts: { t1: 'a' } })
    await useThreads.getState().send('t1', undefined)
    expect(useThreads.getState().sendScroll).toEqual({ threadId: 't1', seq: 1 })
    useThreads.setState({ drafts: { t1: 'b' } })
    await useThreads.getState().send('t1', undefined, true)
    expect(useThreads.getState().sendScroll?.seq).toBe(2)
    useThreads.setState({ drafts: { t1: 'ls' } })
    await useThreads.getState().send('t1', undefined, false, null, true)
    expect(useThreads.getState().sendScroll?.seq).toBe(3)
  })

  it('does not advance on an empty send', async () => {
    stubAios()
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    await useThreads.getState().send('t1', undefined)
    expect(useThreads.getState().sendScroll).toBeNull()
  })

  // TODO 906: the other send entry points also set the same mark.
  it('an answer to a question, plan approval, and a refusal with text advance sendScroll, and an ordinary permission does not', async () => {
    const decide = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'aios', { configurable: true, value: { approvals: { decide } } })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const base = { threadId: 't1', questions: null, plan: null }
    useThreads.setState({
      approvals: [
        { ...base, id: 'q' },
        { ...base, id: 'p', plan: '# plan' },
        { ...base, id: 'x' }
      ] as never
    })
    await useThreads.getState().decide('x', { kind: 'allow' })
    await useThreads.getState().decide('x', { kind: 'deny' })
    expect(useThreads.getState().sendScroll).toBeNull()
    await useThreads.getState().decide('q', { kind: 'answer', answers: { a: ['b'] } })
    expect(useThreads.getState().sendScroll).toEqual({ threadId: 't1', seq: 1 })
    await useThreads.getState().decide('p', { kind: 'allow' })
    expect(useThreads.getState().sendScroll?.seq).toBe(2)
    await useThreads.getState().decide('x', { kind: 'deny', message: 'こうして' })
    expect(useThreads.getState().sendScroll?.seq).toBe(3)
    expect(decide).toHaveBeenCalledTimes(5)
  })

  it('/compact also advances sendScroll', async () => {
    stubAios()
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    await useThreads.getState().compact('t1')
    expect(useThreads.getState().sendScroll).toEqual({ threadId: 't1', seq: 1 })
  })
})
