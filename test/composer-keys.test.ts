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
  it('a lone Enter sends', () => {
    expect(shouldSend(key())).toBe(true)
  })

  it('Shift+Enter is a newline (does not send)', () => {
    expect(shouldSend(key({ shiftKey: true }))).toBe(false)
  })

  it('Cmd+Enter / Ctrl+Enter stay as send', () => {
    expect(shouldSend(key({ metaKey: true }))).toBe(true)
    expect(shouldSend(key({ ctrlKey: true }))).toBe(true)
  })

  it('Option+Enter is a newline (does not send)', () => {
    expect(shouldSend(key({ altKey: true }))).toBe(false)
  })

  it('an Enter that confirms conversion does not send (isComposing)', () => {
    expect(shouldSend(key({ isComposing: true }))).toBe(false)
    // An Enter right after confirming, once composition has ended, does send.
    expect(shouldSend(key({ isComposing: false }))).toBe(true)
  })

  it('an Enter that confirms conversion does not send (keyCode 229; a safeguard for implementations where isComposing is not set)', () => {
    expect(shouldSend(key({ keyCode: 229 }))).toBe(false)
    expect(shouldSend(key({ isComposing: true, keyCode: 229 }))).toBe(false)
  })

  it('while composing, does not send even with a modifier key', () => {
    expect(shouldSend(key({ metaKey: true, isComposing: true }))).toBe(false)
    expect(shouldSend(key({ ctrlKey: true, keyCode: 229 }))).toBe(false)
  })

  it('does not send on keys other than Enter', () => {
    for (const k of ['a', 'Tab', 'Escape', 'NumpadEnter', ' ']) {
      expect(shouldSend(key({ key: k })), k).toBe(false)
    }
  })
})

describe('shouldInterrupt (item 94)', () => {
  it('on macOS only Cmd+Enter interrupts; Ctrl+Enter and a lone Enter are a normal send (a queued item while responding)', () => {
    expect(shouldInterrupt(key({ metaKey: true }), 'mac')).toBe(true)
    expect(shouldInterrupt(key({ ctrlKey: true }), 'mac')).toBe(false)
    expect(shouldInterrupt(key(), 'mac')).toBe(false)
    // Even a key that does not interrupt still sends (it is treated as a reservation).
    expect(shouldSend(key({ ctrlKey: true }))).toBe(true)
  })

  it('outside macOS, Ctrl+Enter interrupts', () => {
    expect(shouldInterrupt(key({ ctrlKey: true }), 'other')).toBe(true)
    expect(shouldInterrupt(key({ metaKey: true }), 'other')).toBe(false)
    expect(shouldInterrupt(key(), 'other')).toBe(false)
  })

  it('a key that is not a send is not an interrupt either (conversion confirm, Shift, Alt, non-Enter)', () => {
    expect(shouldInterrupt(key({ metaKey: true, isComposing: true }), 'mac')).toBe(false)
    expect(shouldInterrupt(key({ metaKey: true, keyCode: 229 }), 'mac')).toBe(false)
    expect(shouldInterrupt(key({ metaKey: true, shiftKey: true }), 'mac')).toBe(false)
    expect(shouldInterrupt(key({ metaKey: true, altKey: true }), 'mac')).toBe(false)
    expect(shouldInterrupt(key({ metaKey: true, key: 'a' }), 'mac')).toBe(false)
    expect(shouldInterrupt(key({ ctrlKey: true, isComposing: true }), 'other')).toBe(false)
  })

  it('decides the convention from the platform string', () => {
    expect(keyPlatformOf('MacIntel')).toBe('mac')
    expect(keyPlatformOf('Win32')).toBe('other')
    expect(keyPlatformOf('Linux x86_64')).toBe('other')
    expect(keyPlatformOf('')).toBe('other')
  })
})

describe('shouldStop (item 161: stop with Esc)', () => {
  const esc = (overrides: Partial<ComposerKey> = {}): ComposerKey =>
    key({ key: 'Escape', keyCode: 27, ...overrides })

  it('a lone Esc stops', () => {
    expect(shouldStop(esc())).toBe(true)
  })
  it('an Esc during conversion (IME) cancels the conversion so it is not picked up; isComposing', () => {
    expect(shouldStop(esc({ isComposing: true }))).toBe(false)
  })
  it('an Esc during conversion (IME) is not picked up; keyCode 229 (implementations where isComposing is not set)', () => {
    expect(shouldStop(esc({ keyCode: 229 }))).toBe(false)
  })
  it('does not take an Esc with a modifier key', () => {
    expect(shouldStop(esc({ shiftKey: true }))).toBe(false)
    expect(shouldStop(esc({ metaKey: true }))).toBe(false)
    expect(shouldStop(esc({ ctrlKey: true }))).toBe(false)
    expect(shouldStop(esc({ altKey: true }))).toBe(false)
  })
  it('does not stop on keys other than Esc (Enter is on the send / queue side)', () => {
    expect(shouldStop(key())).toBe(false)
    expect(shouldStop(key({ key: 'Backspace', keyCode: 8 }))).toBe(false)
  })
})
