// @vitest-environment jsdom
/**
 * TODO 1225 (7.2.1): the "Settings" section of the extension details (`PluginSettingsSection`). It draws the fields and sends only the one field that was changed to main (fix X).
 * Saving is serial, and success does not rebuild the fields. Only a field that was refused goes back to its saved value, with the reason shown. Neither the model nor Electron is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  checkPluginSettingUpdate,
  pluginSettingsView,
  type PluginConfigurationDeclaration,
  type PluginSettingsView
} from '../src/shared/plugin-settings.js'
import { en } from '../src/renderer/src/i18n/en.js'
import { PluginSettingsSection } from '../src/renderer/src/components/PluginSettingsSection.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CONFIG: PluginConfigurationDeclaration = {
  properties: {
    allowFrom: { type: 'array', items: { type: 'string' }, default: [], description: 'Allowed senders', title: 'Senders', order: 1 },
    requireAuth: { type: 'boolean', default: true, description: 'Danger: turning this off…', title: 'Check auth', order: 2 }
  }
}

/** Stands in for main's storage (checks each single-field update and overlays it). */
let stored: Record<string, unknown>
let reject: ReadonlySet<string> = new Set()
/** When true, saving waits until it is returned by hand. */
let hold = false
const held: (() => void)[] = []
const save = vi.fn(async (pluginId: string, name: string, value: unknown): Promise<PluginSettingsView> => {
  if (hold) await new Promise<void>((resolve) => held.push(resolve))
  if (reject.has(name) || checkPluginSettingUpdate(CONFIG, name, value) === null) throw new Error('aios-reason:invalid-value')
  stored = { ...stored, [name]: value }
  return pluginSettingsView(pluginId, CONFIG, stored)
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  stored = {}
  reject = new Set()
  hold = false
  held.length = 0
  save.mockClear()
  ;(window as unknown as { aios: unknown }).aios = {
    pluginSettings: { get: async () => pluginSettingsView('aios.fake', CONFIG, stored), save }
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function typeLines(area: HTMLTextAreaElement | null, text: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(area, text)
    area?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => area?.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
}

async function releaseAll(): Promise<void> {
  while (held.length > 0) {
    await act(async () => {
      held.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

describe('the "Settings" section of extension details', () => {
  it('draws the fields, and sends only that one field: a boolean when toggled, a table when the field loses focus', async () => {
    await act(async () => root.render(createElement(PluginSettingsSection, { pluginId: 'aios.fake' })))
    expect(container.textContent).toContain(en['extensions.settings.title'])
    expect(container.textContent).toContain('Danger')
    const check = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(check?.checked).toBe(true)
    await act(async () => check?.click())
    expect(save).toHaveBeenLastCalledWith('aios.fake', 'requireAuth', false)
    await typeLines(container.querySelector('textarea'), ' a@example.com \n\nacme.com\n')
    expect(save).toHaveBeenLastCalledWith('aios.fake', 'allowFrom', ['a@example.com', 'acme.com'])
    expect(stored).toEqual({ requireAuth: false, allowFrom: ['a@example.com', 'acme.com'] })
  })

  it('fix X: changing two fields in a row keeps both (saves are serialized and an old value does not roll back the previous save)', async () => {
    await act(async () => root.render(createElement(PluginSettingsSection, { pluginId: 'aios.fake' })))
    hold = true
    await typeLines(container.querySelector('textarea'), 'acme.com')
    // Another field is changed before the first save returns.
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click())
    expect(save).toHaveBeenCalledTimes(1)
    await releaseAll()
    expect(save.mock.calls.map((call) => call.slice(1))).toEqual([
      ['allowFrom', ['acme.com']],
      ['requireAuth', false]
    ])
    expect(stored).toEqual({ allowFrom: ['acme.com'], requireAuth: false })
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('acme.com')
  })

  it('fix X: a successful save does not rebuild the field DOM (a click in progress lands and focus stays)', async () => {
    await act(async () => root.render(createElement(PluginSettingsSection, { pluginId: 'aios.fake' })))
    const area = container.querySelector<HTMLTextAreaElement>('textarea')
    const check = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    hold = true
    await typeLines(area, 'acme.com')
    await act(async () => check?.click())
    await act(async () => check?.click())
    await releaseAll()
    expect(container.querySelector('textarea')).toBe(area)
    expect(container.querySelector('input[type="checkbox"]')).toBe(check)
    // Both clicks arrived (true → false → true).
    expect(check?.checked).toBe(true)
    expect(stored).toEqual({ allowFrom: ['acme.com'], requireAuth: true })
    area?.focus()
    await act(async () => check?.click())
    expect(document.activeElement === area || document.activeElement === check).toBe(true)
  })

  it('fix X: only the refused field shows the error and returns to the saved value; the other fields are kept', async () => {
    await act(async () => root.render(createElement(PluginSettingsSection, { pluginId: 'aios.fake' })))
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click())
    reject = new Set(['allowFrom'])
    await typeLines(container.querySelector('textarea'), 'x.com')
    const allow = container.querySelector('[data-setting="allowFrom"]')
    const auth = container.querySelector('[data-setting="requireAuth"]')
    expect(allow?.querySelector('[role="alert"]')).not.toBeNull()
    expect(auth?.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('')
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
    expect(stored).toEqual({ requireAuth: false })
  })

  it('fix X: a row that does not match the item format is not sent; shows the row number and the aios explanation and keeps the input', async () => {
    const shaped: PluginConfigurationDeclaration = {
      properties: {
        allowFrom: { type: 'array', items: { type: 'string', format: 'email-or-domain' }, default: [], description: 'Senders' }
      }
    }
    ;(window as unknown as { aios: unknown }).aios = {
      pluginSettings: { get: async () => pluginSettingsView('aios.fake', shaped, {}), save }
    }
    await act(async () => root.render(createElement(PluginSettingsSection, { pluginId: 'aios.fake' })))
    await typeLines(container.querySelector('textarea'), 'acme.com\nAlice <alice@example.com>\n\na@x.com b@y.com')
    expect(save).not.toHaveBeenCalled()
    const alert = container.querySelector('[data-setting="allowFrom"] [role="alert"]')?.textContent ?? ''
    expect(alert).toContain(en['extensions.settings.invalidLines'].replace('{lines}', '2, 4'))
    expect(alert).toContain(en['extensions.settings.format.emailOrDomain'])
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('acme.com\nAlice <alice@example.com>\n\na@x.com b@y.com')
  })

  it('fix X: a field whose saved value no longer matches the current shape and is unused says so and asks to fix it', async () => {
    const shaped: PluginConfigurationDeclaration = {
      properties: {
        allowFrom: { type: 'array', items: { type: 'string', format: 'email-or-domain' }, default: [], description: 'Senders' }
      }
    }
    ;(window as unknown as { aios: unknown }).aios = {
      pluginSettings: { get: async () => pluginSettingsView('aios.fake', shaped, { allowFrom: ['Alice <a@b.com>'] }), save }
    }
    await act(async () => root.render(createElement(PluginSettingsSection, { pluginId: 'aios.fake' })))
    expect(container.querySelector('[data-setting="allowFrom"] [role="alert"]')?.textContent).toBe(en['extensions.settings.storedInvalid'])
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Alice <a@b.com>')
  })

  it('does not show the section when there is no declaration', async () => {
    ;(window as unknown as { aios: unknown }).aios = {
      pluginSettings: { get: async () => pluginSettingsView('aios.fake', undefined, {}), save }
    }
    await act(async () => root.render(createElement(PluginSettingsSection, { pluginId: 'aios.fake' })))
    expect(container.textContent).toBe('')
  })
})
