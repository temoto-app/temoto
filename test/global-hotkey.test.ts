/**
 * Global hotkey (TODO 976 part 1, ARCHITECTURE 3.3). `GlobalHotkey` does not depend on electron. It checks registration, failure by conflict, changes of assignment, unregistering, and invalidation after exit, using a fake registry in place of `globalShortcut`. The model is not called.
 */
import { describe, expect, it } from 'vitest'
import { GlobalHotkey, MAX_RETRIES, applyHotkeys, retryHotkeys, type ShortcutRegistry } from '../src/main/global-hotkey.js'
import { GLOBAL_HOTKEY_IDS, conflictsOf, effectiveKeybinding, keybindingCommand, parseKeybinding } from '../src/shared/keybindings.js'

class FakeRegistry implements ShortcutRegistry {
  readonly active = new Map<string, () => void>()
  /** Keys put here are in use by other apps, so they cannot be registered. */
  readonly taken = new Set<string>()
  throws = false
  register(accelerator: string, callback: () => void): boolean {
    if (this.throws) throw new Error('boom')
    if (this.taken.has(accelerator)) return false
    this.active.set(accelerator, callback)
    return true
  }
  unregister(accelerator: string): void {
    this.active.delete(accelerator)
  }
}

describe('GlobalHotkey', () => {
  it('登録して、押されたら onPress を呼ぶ', () => {
    const registry = new FakeRegistry()
    let pressed = 0
    const hotkey = new GlobalHotkey(registry, () => (pressed += 1))
    expect(hotkey.apply('Ctrl+Alt+Space')).toEqual({ accelerator: 'Ctrl+Alt+Space', state: 'registered' })
    registry.active.get('Ctrl+Alt+Space')?.()
    expect(pressed).toBe(1)
  })

  it('他のアプリと衝突したら failed (例外にしない)。直すと登録できる', () => {
    const registry = new FakeRegistry()
    registry.taken.add('Ctrl+Alt+Space')
    const hotkey = new GlobalHotkey(registry, () => undefined)
    expect(hotkey.apply('Ctrl+Alt+Space').state).toBe('failed')
    expect(registry.active.size).toBe(0)
    expect(hotkey.apply('Ctrl+Alt+K')).toEqual({ accelerator: 'Ctrl+Alt+K', state: 'registered' })
    // Return to the key that failed: if it is free now, a retry registers it.
    registry.taken.clear()
    expect(hotkey.apply('Ctrl+Alt+Space').state).toBe('registered')
  })

  it('register が例外を投げても failed で止まる', () => {
    const registry = new FakeRegistry()
    registry.throws = true
    const hotkey = new GlobalHotkey(registry, () => undefined)
    expect(hotkey.apply('Ctrl+Alt+Space').state).toBe('failed')
  })

  it('割り当てを変えると前のキーを外す。null で無効にする', () => {
    const registry = new FakeRegistry()
    const hotkey = new GlobalHotkey(registry, () => undefined)
    hotkey.apply('Ctrl+Alt+Space')
    hotkey.apply('Ctrl+Alt+K')
    expect([...registry.active.keys()]).toEqual(['Ctrl+Alt+K'])
    expect(hotkey.apply(null)).toEqual({ accelerator: null, state: 'off' })
    expect(registry.active.size).toBe(0)
  })

  it('同じキーを登録済みなら登録し直さない', () => {
    const registry = new FakeRegistry()
    const hotkey = new GlobalHotkey(registry, () => undefined)
    hotkey.apply('Ctrl+Alt+Space')
    const first = registry.active.get('Ctrl+Alt+Space')
    hotkey.apply('Ctrl+Alt+Space')
    expect(registry.active.get('Ctrl+Alt+Space')).toBe(first)
  })

  it('dispose の後は登録しない・押されても呼ばない', () => {
    const registry = new FakeRegistry()
    let pressed = 0
    const hotkey = new GlobalHotkey(registry, () => (pressed += 1))
    hotkey.apply('Ctrl+Alt+Space')
    const callback = registry.active.get('Ctrl+Alt+Space')
    hotkey.dispose()
    expect(registry.active.size).toBe(0)
    callback?.()
    expect(pressed).toBe(0)
    expect(hotkey.apply('Ctrl+Alt+K').state).toBe('off')
    expect(registry.active.size).toBe(0)
  })
})

describe('GlobalHotkey (TODO 976 review Y-2 / Y-4)', () => {
  it('Y-2: 無効の instance (dev・検証版) は登録せず disabled を返す', () => {
    const registry = new FakeRegistry()
    const hotkey = new GlobalHotkey(registry, () => undefined, false)
    expect(hotkey.apply('Ctrl+Alt+Space')).toEqual({ accelerator: 'Ctrl+Alt+Space', state: 'disabled' })
    expect(registry.active.size).toBe(0)
    expect(hotkey.retryIfFailed()).toBe(false)
  })

  it('Y-4: failed の間は再試行し、空いたら登録して true を返す', () => {
    const registry = new FakeRegistry()
    registry.taken.add('Ctrl+Alt+Space')
    const hotkey = new GlobalHotkey(registry, () => undefined)
    hotkey.apply('Ctrl+Alt+Space')
    expect(hotkey.retryIfFailed()).toBe(false)
    registry.taken.clear()
    expect(hotkey.retryIfFailed()).toBe(true)
    expect(hotkey.status().state).toBe('registered')
    expect(hotkey.retryIfFailed()).toBe(false)
  })

  it('Y-4: 再試行には上限があり、割り当てを変えると数え直す', () => {
    const registry = new FakeRegistry()
    registry.taken.add('Ctrl+Alt+Space')
    const hotkey = new GlobalHotkey(registry, () => undefined)
    hotkey.apply('Ctrl+Alt+Space')
    for (let i = 0; i < MAX_RETRIES; i += 1) hotkey.retryIfFailed()
    registry.taken.clear()
    expect(hotkey.retryIfFailed()).toBe(false)
    expect(hotkey.status().state).toBe('failed')
    registry.taken.add('Ctrl+Alt+K')
    hotkey.apply('Ctrl+Alt+K')
    registry.taken.clear()
    expect(hotkey.retryIfFailed()).toBe(true)
  })
})

describe('app.summon (キーボードショートカットの表)', () => {
  it('scope は global、既定は Ctrl+Alt+Space で、読めるキーである', () => {
    expect(keybindingCommand('app.summon').scope).toBe('global')
    for (const platform of ['mac', 'other'] as const) {
      const key = effectiveKeybinding('app.summon', platform, {})
      expect(key).toBe('Ctrl+Alt+Space')
      expect(parseKeybinding(key)).not.toBeNull()
    }
  })

  it('割り当てを外すと null (登録しない)', () => {
    expect(effectiveKeybinding('app.summon', 'mac', { 'app.summon': null })).toBeNull()
  })
})

describe('app.summonDictate (TODO 1267)', () => {
  it('表に 1 行 (scope global)・既定は割り当てなし・付けると読めるキーになる', () => {
    expect(keybindingCommand('app.summonDictate').scope).toBe('global')
    expect(GLOBAL_HOTKEY_IDS).toContain('app.summonDictate')
    for (const platform of ['mac', 'other'] as const) {
      expect(effectiveKeybinding('app.summonDictate', platform, {})).toBeNull()
      const assigned = effectiveKeybinding('app.summonDictate', platform, { 'app.summonDictate': 'Ctrl+Alt+D' })
      expect(parseKeybinding(assigned)).not.toBeNull()
      // Assigning summon's key to dictation shows up as a conflict of the table.
      expect(conflictsOf('Ctrl+Alt+Space', 'app.summonDictate', platform, {}).commands).toEqual(['app.summon'])
    }
  })

  it('既定 (null) では登録せず、付けると登録し、外すと解除する', () => {
    const registry = new FakeRegistry()
    let pressed = 0
    const hotkey = new GlobalHotkey(registry, () => (pressed += 1))
    expect(hotkey.apply(effectiveKeybinding('app.summonDictate', 'mac', {}))).toEqual({ accelerator: null, state: 'off' })
    expect(registry.active.size).toBe(0)
    hotkey.apply('Ctrl+Alt+D')
    registry.active.get('Ctrl+Alt+D')?.()
    expect(pressed).toBe(1)
    hotkey.apply(null)
    expect(registry.active.size).toBe(0)
  })

  it('検証版 (enabled=false) では登録しない', () => {
    const registry = new FakeRegistry()
    const hotkey = new GlobalHotkey(registry, () => undefined, false)
    expect(hotkey.apply('Ctrl+Alt+D').state).toBe('disabled')
    expect(registry.active.size).toBe(0)
  })
})

/** Like electron: registering a key this app already holds returns false. */
class StrictRegistry extends FakeRegistry {
  override register(accelerator: string, callback: () => void): boolean {
    if (this.active.has(accelerator)) return false
    return super.register(accelerator, callback)
  }
}

describe('applyHotkeys (TODO 1267 review Y)', () => {
  const setup = () => {
    const registry = new StrictRegistry()
    const a = new GlobalHotkey(registry, () => undefined)
    const b = new GlobalHotkey(registry, () => undefined)
    return { registry, a, b }
  }

  it('moves a key from the first hotkey to the second, clearing the first', () => {
    const { registry, a, b } = setup()
    applyHotkeys([{ hotkey: a, accelerator: 'Ctrl+Alt+K' }, { hotkey: b, accelerator: null }])
    applyHotkeys([{ hotkey: a, accelerator: null }, { hotkey: b, accelerator: 'Ctrl+Alt+K' }])
    expect(a.status()).toEqual({ accelerator: null, state: 'off' })
    expect(b.status()).toEqual({ accelerator: 'Ctrl+Alt+K', state: 'registered' })
    expect(registry.active.size).toBe(1)
  })

  it('moves a key from the second hotkey to the first', () => {
    const { a, b } = setup()
    applyHotkeys([{ hotkey: a, accelerator: null }, { hotkey: b, accelerator: 'Ctrl+Alt+K' }])
    applyHotkeys([{ hotkey: a, accelerator: 'Ctrl+Alt+K' }, { hotkey: b, accelerator: null }])
    expect(a.status()).toEqual({ accelerator: 'Ctrl+Alt+K', state: 'registered' })
    expect(b.status().state).toBe('off')
  })

  it('swaps two keys in one call', () => {
    const { a, b } = setup()
    applyHotkeys([{ hotkey: a, accelerator: 'Ctrl+Alt+1' }, { hotkey: b, accelerator: 'Ctrl+Alt+2' }])
    applyHotkeys([{ hotkey: a, accelerator: 'Ctrl+Alt+2' }, { hotkey: b, accelerator: 'Ctrl+Alt+1' }])
    expect(a.status()).toEqual({ accelerator: 'Ctrl+Alt+2', state: 'registered' })
    expect(b.status()).toEqual({ accelerator: 'Ctrl+Alt+1', state: 'registered' })
  })

  it('on a duplicate the first wins and the second is failed', () => {
    const { registry, a, b } = setup()
    applyHotkeys([{ hotkey: a, accelerator: 'Ctrl+Alt+K' }, { hotkey: b, accelerator: 'Ctrl+Alt+K' }])
    expect(a.status().state).toBe('registered')
    expect(b.status()).toEqual({ accelerator: 'Ctrl+Alt+K', state: 'failed' })
    expect(registry.active.size).toBe(1)
  })

  it('does not unregister an unchanged key', () => {
    const { registry, a, b } = setup()
    applyHotkeys([{ hotkey: a, accelerator: 'Ctrl+Alt+K' }, { hotkey: b, accelerator: null }])
    const cb = registry.active.get('Ctrl+Alt+K')
    applyHotkeys([{ hotkey: a, accelerator: 'Ctrl+Alt+K' }, { hotkey: b, accelerator: 'Ctrl+Alt+J' }])
    expect(registry.active.get('Ctrl+Alt+K')).toBe(cb)
  })
})

describe('retryHotkeys (TODO 1267 review Y)', () => {
  it('retries both even when the first recovers', () => {
    const registry = new FakeRegistry()
    registry.taken.add('Ctrl+Alt+1')
    registry.taken.add('Ctrl+Alt+2')
    const a = new GlobalHotkey(registry, () => undefined)
    const b = new GlobalHotkey(registry, () => undefined)
    applyHotkeys([{ hotkey: a, accelerator: 'Ctrl+Alt+1' }, { hotkey: b, accelerator: 'Ctrl+Alt+2' }])
    registry.taken.clear()
    expect(retryHotkeys([a, b, null])).toBe(true)
    expect(a.status().state).toBe('registered')
    expect(b.status().state).toBe('registered')
  })
})
