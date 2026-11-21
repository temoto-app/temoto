// @vitest-environment jsdom
/**
 * The flow of recording a key in Settings' 'Keyboard shortcuts' (`ShortcutSettings.tsx`) (TODO 549, wave 27 bundle E). In jsdom, `window.aios.keybindings` is a fake (it checks and returns values in place of main). jsdom's `navigator.platform` is empty, so the platform is `other` (Ctrl).
 *
 * - 'Change' -> press a key -> the label appears -> Enter sends the diff to main. While recording, the menu accelerators are suspended
 * - If the key is the same as another command's, a conflict is shown on the spot. Esc cancels
 * - 'Reset to default', 'Reset all to default', 'Remove'
 * - The keydown in the recording field does not reach the app's shortcuts (the window's keydown)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { sanitizeKeybindingOverrides, type KeybindingOverrides } from '../src/shared/keybindings.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const sent: KeybindingOverrides[] = []
const recording: boolean[] = []

function stubApi(): void {
  ;(window as unknown as { aios: unknown }).aios = {
    keybindings: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async (overrides: unknown) => {
        const clean = sanitizeKeybindingOverrides(overrides, 'other')
        sent.push(clean)
        return clean
      }),
      setRecording: vi.fn((value: boolean) => recording.push(value)),
      onChanged: () => () => {}
    },
    app: { onMenuCommand: () => () => {} }
  }
}

describe('ShortcutSettings (TODO 549)', () => {
  let container: HTMLDivElement
  let root: Root
  let ShortcutSettings: () => React.JSX.Element
  let keybindingStore: typeof import('../src/renderer/src/keybindingStore.js')
  let shortcuts: typeof import('../src/renderer/src/shortcuts.js')

  beforeAll(async () => {
    stubApi()
    ;({ ShortcutSettings } = await import('../src/renderer/src/components/ShortcutSettings.js'))
    keybindingStore = await import('../src/renderer/src/keybindingStore.js')
    shortcuts = await import('../src/renderer/src/shortcuts.js')
  })

  beforeEach(async () => {
    sent.length = 0
    recording.length = 0
    stubApi()
    await act(async () => keybindingStore.saveKeybindings({}))
    sent.length = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(createElement(ShortcutSettings)))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const row = (id: string): HTMLTableRowElement =>
    container.querySelector(`tr[data-command="${id}"]`) as HTMLTableRowElement
  const buttons = (id: string): HTMLButtonElement[] => [...row(id).querySelectorAll('button')]
  const recordInput = (): HTMLInputElement => container.querySelector('.shortcut-settings-record') as HTMLInputElement
  const keydown = (target: Element, init: KeyboardEventInit): void => {
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
    })
  }

  it('全コマンドの行と既定のキー。絞り込みでコマンド名・キーの表記に当てる', () => {
    expect(container.querySelectorAll('tbody tr').length).toBeGreaterThan(10)
    expect(row('search.names').querySelector('kbd')?.textContent).toBe('Ctrl+P')
    const filter = container.querySelector('.shortcut-settings-filter') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(filter, 'ctrl+shift+e')
      filter.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect([...container.querySelectorAll('tbody tr')].map((tr) => tr.getAttribute('data-command'))).toEqual(['view.files'])
  })

  it('変更 → キーを押す → Enter で保存。記録の間はメニューの accelerator を止め、アプリのキーに届かない', async () => {
    const appKeys: string[] = []
    const onWindowKey = (event: KeyboardEvent): void => {
      appKeys.push(event.key)
    }
    window.addEventListener('keydown', onWindowKey)
    act(() => buttons('search.names')[0]?.click())
    expect(recording).toEqual([true])
    const input = recordInput()
    keydown(input, { key: 't', code: 'KeyT', ctrlKey: true })
    expect(input.value).toBe('Ctrl+T')
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    window.removeEventListener('keydown', onWindowKey)
    expect(appKeys).toEqual([])
    expect(sent).toEqual([{ 'search.names': 'Ctrl+T' }])
    expect(recording).toEqual([true, false])
    expect(row('search.names').querySelector('kbd')?.textContent).toBe('Ctrl+T')
    expect(row('search.names').classList.contains('modified')).toBe(true)
    // The renderer's check also follows the new key.
    expect(
      shortcuts.searchShortcut({ key: 't', metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, isComposing: false })
    ).toBe('names')
    // Reset to default (the third button: Change / Remove / Reset to default).
    await act(async () => buttons('search.names')[2]?.click())
    expect(sent.at(-1)).toEqual({})
    expect(row('search.names').querySelector('kbd')?.textContent).toBe('Ctrl+P')
  })

  it('他のコマンドと同じキーはその場で衝突を出す。Esc で取り消し (送らない)', () => {
    act(() => buttons('search.names')[0]?.click())
    keydown(recordInput(), { key: 'k', code: 'KeyK', ctrlKey: true })
    expect(row('search.names').querySelector('.shortcut-settings-conflict')?.textContent).toContain('Search conversations')
    keydown(recordInput(), { key: 'c', code: 'KeyC', ctrlKey: true })
    expect(row('search.names').querySelector('.shortcut-settings-conflict')?.textContent).toContain('Edit menu')
    keydown(recordInput(), { key: 'Escape' })
    expect(recordInput()).toBeNull()
    expect(sent).toEqual([])
  })

  it('修飾の無いキーは記録しない (案内を出す)。外す → 割り当てなし、すべて既定に戻す', async () => {
    act(() => buttons('find')[0]?.click())
    keydown(recordInput(), { key: 'g', code: 'KeyG' })
    expect(recordInput().value).toBe('')
    expect(row('find').textContent).toContain('⌘, Ctrl or ⌥')
    keydown(recordInput(), { key: 'Escape' })
    await act(async () => buttons('find')[1]?.click())
    expect(sent.at(-1)).toEqual({ find: null })
    expect(row('find').textContent).toContain('Not assigned')
    const resetAll = [...container.querySelectorAll('.shortcut-settings-toolbar button')][0] as HTMLButtonElement
    await act(async () => resetAll.click())
    expect(sent.at(-1)).toEqual({})
  })
})
