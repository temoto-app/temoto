/**
 * Key judgment for the prompt field (ARCHITECTURE.md 5.5, T16 / TODO 20).
 *
 * The most important point is that **Enter to confirm Japanese conversion does not send**.
 * If **either** `isComposing` or `keyCode === 229` is set, it counts as confirming.
 */
import { describe, expect, it } from 'vitest'
import {
  keyPlatformOf,
  shouldInterrupt,
  shouldSend,
  shouldStop,
  type ComposerKey
} from '@renderer/composer-keys.js'

function key(overrides: Partial<ComposerKey> = {}): ComposerKey {
  return {
    key: 'Enter',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 13,
    ...overrides
  }
}

describe('shouldSend (T16)', () => {
  it('Enter 単発で送る', () => {
    expect(shouldSend(key())).toBe(true)
  })

  it('Shift+Enter は改行 (送らない)', () => {
    expect(shouldSend(key({ shiftKey: true }))).toBe(false)
  })

  it('⌘Enter / Ctrl+Enter は送信のまま残す', () => {
    expect(shouldSend(key({ metaKey: true }))).toBe(true)
    expect(shouldSend(key({ ctrlKey: true }))).toBe(true)
  })

  it('⌥Enter は改行 (送らない)', () => {
    expect(shouldSend(key({ altKey: true }))).toBe(false)
  })

  it('変換確定の Enter は送らない (isComposing)', () => {
    expect(shouldSend(key({ isComposing: true }))).toBe(false)
    // An Enter right after confirming, once composition has ended, does send.
    expect(shouldSend(key({ isComposing: false }))).toBe(true)
  })

  it('変換確定の Enter は送らない (keyCode 229。isComposing が立たない実装の保険)', () => {
    expect(shouldSend(key({ keyCode: 229 }))).toBe(false)
    expect(shouldSend(key({ isComposing: true, keyCode: 229 }))).toBe(false)
  })

  it('確定中は修飾キーが付いていても送らない', () => {
    expect(shouldSend(key({ metaKey: true, isComposing: true }))).toBe(false)
    expect(shouldSend(key({ ctrlKey: true, keyCode: 229 }))).toBe(false)
  })

  it('Enter 以外のキーでは送らない', () => {
    for (const k of ['a', 'Tab', 'Escape', 'NumpadEnter', ' ']) {
      expect(shouldSend(key({ key: k })), k).toBe(false)
    }
  })
})

describe('shouldInterrupt (項目 94)', () => {
  it('macOS は ⌘Enter だけが割り込み。Ctrl+Enter と Enter 単発は普通の送信 (応答中なら予約)', () => {
    expect(shouldInterrupt(key({ metaKey: true }), 'mac')).toBe(true)
    expect(shouldInterrupt(key({ ctrlKey: true }), 'mac')).toBe(false)
    expect(shouldInterrupt(key(), 'mac')).toBe(false)
    // Even a key that does not interrupt still sends (it is treated as a reservation).
    expect(shouldSend(key({ ctrlKey: true }))).toBe(true)
  })

  it('macOS 以外は Ctrl+Enter が割り込み', () => {
    expect(shouldInterrupt(key({ ctrlKey: true }), 'other')).toBe(true)
    expect(shouldInterrupt(key({ metaKey: true }), 'other')).toBe(false)
    expect(shouldInterrupt(key(), 'other')).toBe(false)
  })

  it('送信にならないキーは割り込みにもしない (変換確定・Shift・Alt・Enter 以外)', () => {
    expect(shouldInterrupt(key({ metaKey: true, isComposing: true }), 'mac')).toBe(false)
    expect(shouldInterrupt(key({ metaKey: true, keyCode: 229 }), 'mac')).toBe(false)
    expect(shouldInterrupt(key({ metaKey: true, shiftKey: true }), 'mac')).toBe(false)
    expect(shouldInterrupt(key({ metaKey: true, altKey: true }), 'mac')).toBe(false)
    expect(shouldInterrupt(key({ metaKey: true, key: 'a' }), 'mac')).toBe(false)
    expect(shouldInterrupt(key({ ctrlKey: true, isComposing: true }), 'other')).toBe(false)
  })

  it('流儀は platform の文字列から決める', () => {
    expect(keyPlatformOf('MacIntel')).toBe('mac')
    expect(keyPlatformOf('Win32')).toBe('other')
    expect(keyPlatformOf('Linux x86_64')).toBe('other')
    expect(keyPlatformOf('')).toBe('other')
  })
})

describe('shouldStop (項目 161: Esc で止める)', () => {
  const esc = (overrides: Partial<ComposerKey> = {}): ComposerKey =>
    key({ key: 'Escape', keyCode: 27, ...overrides })

  it('Esc 単発で止める', () => {
    expect(shouldStop(esc())).toBe(true)
  })
  it('変換中 (IME) の Esc は変換の取り消しなので拾わない — isComposing', () => {
    expect(shouldStop(esc({ isComposing: true }))).toBe(false)
  })
  it('変換中 (IME) の Esc は拾わない — keyCode 229 (isComposing が立たない実装)', () => {
    expect(shouldStop(esc({ keyCode: 229 }))).toBe(false)
  })
  it('修飾キー付きの Esc は取らない', () => {
    expect(shouldStop(esc({ shiftKey: true }))).toBe(false)
    expect(shouldStop(esc({ metaKey: true }))).toBe(false)
    expect(shouldStop(esc({ ctrlKey: true }))).toBe(false)
    expect(shouldStop(esc({ altKey: true }))).toBe(false)
  })
  it('Esc 以外のキーでは止めない (Enter は送信 / 予約の側)', () => {
    expect(shouldStop(key())).toBe(false)
    expect(shouldStop(key({ key: 'Backspace', keyCode: 8 }))).toBe(false)
  })
})
