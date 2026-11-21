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
  it('走っているものが無ければ聞かずに通す', () => {
    const t = make(null, true)
    expect(t.gate.check()).toBe('pass')
    expect(t.ask).not.toHaveBeenCalled()
  })

  it('走っていれば止めて 1 回だけ聞き、承諾で proceed する。その後の before-quit は素通り', async () => {
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

  it('キャンセルなら終了せず、次の ⌘Q はまた聞く', async () => {
    const t = make('session', false)
    expect(t.gate.check()).toBe('hold')
    t.answer()
    await flush()
    expect(t.proceed).not.toHaveBeenCalled()
    expect(t.gate.check()).toBe('hold')
    expect(t.ask).toHaveBeenCalledTimes(2)
  })

  it('起動し直し・更新の再起動が済ませた確認では聞かない。reset で戻る', () => {
    const t = make('session', true)
    t.gate.markConfirmed()
    expect(t.gate.check()).toBe('pass')
    t.gate.reset()
    expect(t.gate.check()).toBe('hold')
  })

  it('更新の再起動 / 起動し直しの関門が会話の確認を自分で 1 回出し、続く before-quit では聞かない', async () => {
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

  it('再起動の関門は、動いているものが無ければ聞かず、断られたら false で何も覚えない', async () => {
    const idle = make(null, true)
    expect(await idle.gate.confirmForRestart()).toBe(true)
    expect(idle.ask).not.toHaveBeenCalled()
    const no = make('session', false)
    const result = no.gate.confirmForRestart()
    no.answer()
    expect(await result).toBe(false)
    expect(no.gate.check()).toBe('hold')
  })

  it('OS のログアウト / 再起動の最中は聞かない (OS の終了を止めない)', () => {
    let shutdown = false
    const t = make('session', true, () => shutdown)
    shutdown = true
    expect(t.gate.check()).toBe('pass')
    expect(t.ask).not.toHaveBeenCalled()
  })

  it('ダイアログが投げたら終了しない', async () => {
    const proceed = vi.fn()
    const gate = new QuitConfirm({ blocker: () => 'x', ask: () => Promise.reject(new Error('boom')), proceed })
    expect(gate.check()).toBe('hold')
    await flush()
    expect(proceed).not.toHaveBeenCalled()
  })

  it('文言が en / ja にある', () => {
    for (const locale of ['en', 'ja'] as const) {
      for (const key of ['dialog.quit.message', 'dialog.quit.detail', 'dialog.quit.confirm', 'dialog.relaunch.message', 'dialog.relaunch.detail', 'dialog.relaunch.confirm'] as const) {
        expect(nativeText(locale, key).length).toBeGreaterThan(0)
      }
    }
  })
})
