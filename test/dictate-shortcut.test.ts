/**
 * TODO 1268: the dictation shortcut (`composer.dictate`, default Cmd+D). It is a row of the shortcut table, matches the modifiers exactly as
 * pressed (mac Ctrl+D stays emacs-style delete forward), follows rebinding, and does nothing once unassigned.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { KEYBINDING_COMMANDS, effectiveKeybinding } from '../src/shared/keybindings.js'
import { isDictateShortcut, setKeybindings } from '../src/renderer/src/shortcuts.js'

function press(
  over: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; isComposing: boolean }>
) {
  return { key: 'd', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, ...over }
}

afterEach(() => setKeybindings({}, 'mac'))

describe('composer.dictate (TODO 1268)', () => {
  it('表に 1 行あり、既定は CmdOrCtrl+D、どの既定とも重ならない', () => {
    const row = KEYBINDING_COMMANDS.find((c) => c.id === 'composer.dictate')
    expect(row?.scope).toBe('renderer')
    for (const platform of ['mac', 'other'] as const) {
      const key = effectiveKeybinding('composer.dictate', platform, {})
      expect(key).toBe('CmdOrCtrl+D')
      const same = KEYBINDING_COMMANDS.filter((c) => c.id !== 'composer.dictate' && c.defaults[platform] === key)
      expect(same).toEqual([])
    }
  })

  it('mac では ⌘D だけが効き、Ctrl+D (emacs の前方削除) は効かない', () => {
    setKeybindings({}, 'mac')
    expect(isDictateShortcut(press({ metaKey: true }))).toBe(true)
    expect(isDictateShortcut(press({ ctrlKey: true }))).toBe(false)
    expect(isDictateShortcut(press({ metaKey: true, shiftKey: true }))).toBe(false)
    expect(isDictateShortcut(press({}))).toBe(false)
  })

  it('変換中は効かない・割り当てを外すと効かない・付け替えに従う', () => {
    setKeybindings({}, 'mac')
    expect(isDictateShortcut(press({ metaKey: true, isComposing: true }))).toBe(false)
    setKeybindings({ 'composer.dictate': null }, 'mac')
    expect(isDictateShortcut(press({ metaKey: true }))).toBe(false)
    setKeybindings({ 'composer.dictate': 'Cmd+Shift+M' }, 'mac')
    expect(isDictateShortcut(press({ key: 'm', metaKey: true, shiftKey: true }))).toBe(true)
    expect(isDictateShortcut(press({ metaKey: true }))).toBe(false)
  })
})
