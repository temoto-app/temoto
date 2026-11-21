/** TODO 1004: confirmation for ⌘Q (once, and only when a conversation is running). */
import { describe, expect, it, vi } from 'vitest'
import { QuitConfirm } from '../src/main/quit-confirm.js'
import { nativeText } from '../src/main/i18n-native.js'

function make(blocker: string | null, answer: boolean, shutdown = () => false) {
  let resolve: (v: boolean) => void = () => undefined
  const ask = vi.fn<(kind: string) => Promise<boolean>>(
    () =>
      new Promise<boolean>((r) => {
        resolve = r
      })
  )
  const proceed = vi.fn()
  const gate = new QuitConfirm({ blocker: () => blocker, ask, proceed, systemShutdown: shutdown })
  return { gate, ask, proceed, answer: () => resolve(answer) }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('QuitConfirm', () => {
  it('passes without asking when nothing is running', () => {
    const t = make(null, true)
    expect(t.gate.check()).toBe('pass')
    expect(t.ask).not.toHaveBeenCalled()
  })

  it('if something is running, stops and asks only once, and on consent it proceeds; the following before-quit passes through', async () => {
    const t = make('session', true)
    expect(t.gate.check()).toBe('hold')
    expect(t.gate.check()).toBe('hold') // ⌘Q during the confirmation is not stacked
    expect(t.ask).toHaveBeenCalledTimes(1)
    t.answer()
    await flush()
    expect(t.proceed).toHaveBeenCalledTimes(1)
    expect(t.gate.check()).toBe('pass')
    expect(t.ask).toHaveBeenCalledTimes(1)
  })

  it('on cancel it does not quit, and the next ⌘Q asks again', async () => {
    const t = make('session', false)
    expect(t.gate.check()).toBe('hold')
    t.answer()
    await flush()
    expect(t.proceed).not.toHaveBeenCalled()
    expect(t.gate.check()).toBe('hold')
    expect(t.ask).toHaveBeenCalledTimes(2)
  })

  it('does not ask for a confirmation already done by a relaunch or an update restart; reset restores', () => {
    const t = make('session', true)
    t.gate.markConfirmed()
    expect(t.gate.check()).toBe('pass')
    t.gate.reset()
    expect(t.gate.check()).toBe('hold')
  })

  it('the gate for an update restart / relaunch raises the conversation confirmation once itself, and the following before-quit does not ask', async () => {
    const t = make('session', true)
    const result = t.gate.confirmForRestart()
    // ⌘Q while asking is not stacked, and a second restart is not stacked either.
    expect(t.gate.check()).toBe('hold')
    expect(await Promise.race([t.gate.confirmForRestart(), Promise.resolve('x')])).toBe(false)
    t.answer()
    expect(await result).toBe(true)
    expect(t.ask).toHaveBeenCalledTimes(1)
    expect(t.ask).toHaveBeenCalledWith('relaunch')
    expect(t.gate.check()).toBe('pass')
    expect(t.ask).toHaveBeenCalledTimes(1)
  })

  it('the restart gate does not ask when nothing is running, and when refused it returns false and remembers nothing', async () => {
    const idle = make(null, true)
    expect(await idle.gate.confirmForRestart()).toBe(true)
    expect(idle.ask).not.toHaveBeenCalled()
    const no = make('session', false)
    const result = no.gate.confirmForRestart()
    no.answer()
    expect(await result).toBe(false)
    expect(no.gate.check()).toBe('hold')
  })

  it('does not ask during an OS logout / restart (does not block the OS shutdown)', () => {
    let shutdown = false
    const t = make('session', true, () => shutdown)
    shutdown = true
    expect(t.gate.check()).toBe('pass')
    expect(t.ask).not.toHaveBeenCalled()
  })

  it('does not quit if the dialog throws', async () => {
    const proceed = vi.fn()
    const gate = new QuitConfirm({ blocker: () => 'x', ask: () => Promise.reject(new Error('boom')), proceed })
    expect(gate.check()).toBe('hold')
    await flush()
    expect(proceed).not.toHaveBeenCalled()
  })

  it('the text exists in en / ja', () => {
    for (const locale of ['en', 'ja'] as const) {
      for (const key of ['dialog.quit.message', 'dialog.quit.detail', 'dialog.quit.confirm', 'dialog.relaunch.message', 'dialog.relaunch.detail', 'dialog.relaunch.confirm'] as const) {
        expect(nativeText(locale, key).length).toBeGreaterThan(0)
      }
    }
  })
})
