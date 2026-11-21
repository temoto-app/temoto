// @vitest-environment jsdom
/**
 * Trigger view (TODO 1216, ARCHITECTURE 6.2.6): the 'Triggers' section of the scheduled-run view (below `ScheduleList`), and editing of the host-side rules (`TriggerEditor`, in the same place as `ScheduleEditor`). Uses neither the model nor Electron.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ThreadCreateOptions } from '../src/shared/thread.js'
import { DEFAULT_TRIGGER_RULE, type TriggerOverview, type TriggerRow } from '../src/shared/trigger.js'
import { en } from '../src/renderer/src/i18n/en.js'
import { resetScheduleForTest, useSchedule } from '../src/renderer/src/scheduleStore.js'
import { resetTriggersForTest, useTriggers } from '../src/renderer/src/triggerStore.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function row(overrides: Partial<TriggerRow> = {}): TriggerRow {
  return {
    pluginId: 'aios.fakemail',
    triggerId: 'new-mail',
    pluginName: 'Fake mail',
    name: 'New mail to me',
    description: 'Filtered new mail',
    defaultPrompt: 'Summarize and draft a reply',
    pluginEnabled: true,
    bundled: false,
    toolChoices: [],
    rule: { ...DEFAULT_TRIGGER_RULE },
    today: { accepted: 3, capped: 1 },
    lastAcceptedAt: null,
    lastThreadId: null,
    failedRecent: 0,
    autoDisabled: null,
    ...overrides
  }
}

let overview: TriggerOverview
const update = vi.fn(
  async (_pluginId: string, _triggerId: string, rule: TriggerRow['rule']): Promise<TriggerOverview> => ({
    ...overview,
    triggers: [row({ rule })]
  })
)
const options = {
  backends: [],
  defaultBackend: 'fake',
  cwdHistory: []
} as unknown as ThreadCreateOptions

function stubApi(): void {
  ;(window as unknown as { aios: unknown }).aios = {
    schedule: {
      list: async () => ({ jobs: [], autoRun: true, resumeReservations: [], laterSends: [] }),
      onChanged: () => () => {}
    },
    trigger: { list: async () => overview, update, onChanged: () => () => {} },
    threads: { createOptions: async () => options },
    fs: { pickDirectory: async () => ({ uri: null, reason: null }) }
  }
}

let container: HTMLDivElement
let root: Root
let ScheduleList: () => React.JSX.Element
let ScheduleEditor: () => React.JSX.Element | null

beforeAll(async () => {
  stubApi()
  ;({ ScheduleList } = await import('../src/renderer/src/components/ScheduleList.js'))
  ;({ ScheduleEditor } = await import('../src/renderer/src/components/ScheduleEditor.js'))
})

beforeEach(() => {
  overview = { autoRun: true, queued: 2, triggers: [row()] }
  resetScheduleForTest()
  resetTriggersForTest()
  useSchedule.setState({ overview: { jobs: [], autoRun: true, resumeReservations: [], laterSends: [] } })
  useTriggers.setState({ overview })
  update.mockClear()
  stubApi()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the 「トリガー」 section (ScheduleList)', () => {
  it("declaration row: name, extension, today's count, the count skipped by the limit, and the waiting count, and does not show cost", async () => {
    await act(async () => root.render(createElement(ScheduleList)))
    const section = container.querySelector('.trigger-section')
    expect(section?.textContent).toContain(en['trigger.section'])
    expect(section?.textContent).toContain('2 waiting')
    const item = section?.querySelector('.schedule-item')
    expect(item?.textContent).toContain('New mail to me')
    expect(item?.textContent).toContain('Fake mail')
    expect(item?.textContent).toContain('Today 3 / 20')
    expect(item?.textContent).toContain('1 skipped by the daily limit')
    expect(item?.textContent).not.toMatch(/\$|USD|cost/i)
  })

  it('does not show the whole section when there is no declaration', async () => {
    useTriggers.setState({ overview: { autoRun: true, queued: 0, triggers: [] } })
    await act(async () => root.render(createElement(ScheduleList)))
    expect(container.querySelector('.trigger-section')).toBeNull()
  })

  it('toggling enabled calls main (the rest of the rule stays as is), and pressing a row opens rule editing on the main side', async () => {
    await act(async () => root.render(createElement(ScheduleList)))
    const toggle = container.querySelector<HTMLInputElement>('.trigger-section .schedule-item-enabled')
    expect(toggle?.checked).toBe(false)
    await act(async () => toggle?.click())
    expect(update).toHaveBeenCalledWith('aios.fakemail', 'new-mail', { ...DEFAULT_TRIGGER_RULE, enabled: true }, null)
    await act(async () => container.querySelector<HTMLButtonElement>('.trigger-section .schedule-item-main')?.click())
    expect(useSchedule.getState().editing).toEqual({ id: null, trigger: { pluginId: 'aios.fakemail', triggerId: 'new-mail' } })
  })

  it('fix X: a rule disabled because the extension changed shows the reason in the list, and the enabling action opens the edit screen (does not call main)', async () => {
    useTriggers.setState({ overview: { ...overview, triggers: [row({ autoDisabled: 'plugin-changed' })] } })
    await act(async () => root.render(createElement(ScheduleList)))
    expect(container.textContent).toContain(en['trigger.autoDisabled.short'])
    await act(async () => container.querySelector<HTMLInputElement>('.trigger-section .schedule-item-enabled')?.click())
    expect(update).not.toHaveBeenCalled()
    expect(useSchedule.getState().editing).toEqual({ id: null, trigger: { pluginId: 'aios.fakemail', triggerId: 'new-mail' } })
  })
})

describe('rule editing (TriggerEditor)', () => {
  it("the instruction placeholder is the declaration's default, and changing the daily limit and saving calls main and closes", async () => {
    useSchedule.getState().openTrigger('aios.fakemail', 'new-mail')
    await act(async () => root.render(createElement(ScheduleEditor)))
    expect(container.querySelector('.trigger-editor .schedule-editor-title')?.textContent).toBe('New mail to me')
    const textarea = container.querySelector<HTMLTextAreaElement>('.trigger-editor textarea')
    expect(textarea?.placeholder).toBe('Summarize and draft a reply')
    expect(container.textContent).toContain(en['trigger.readOnlyNote'])
    const cap = container.querySelector<HTMLInputElement>('.trigger-editor input[type="number"]')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(cap, '5')
      cap?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const enabled = container.querySelector<HTMLInputElement>('.trigger-editor input[type="checkbox"]')
    await act(async () => enabled?.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.trigger-editor button[type="submit"]')?.click())
    expect(update).toHaveBeenCalledWith(
      'aios.fakemail',
      'new-mail',
      expect.objectContaining({ enabled: true, dailyCap: 5, instructions: null }),
      null
    )
    expect(useSchedule.getState().editing).toBeNull()
  })

  it('TODO 1227: a non-bundled extension can choose candidate tools (default empty) and sends only the chosen names, and for a bundled one the field is not shown', async () => {
    const choices = [
      { name: 'readThing', title: 'Read a thing', description: 'Reads.' },
      { name: 'listThings', title: 'List things', description: 'Lists.' }
    ]
    useTriggers.setState({ overview: { ...overview, triggers: [row({ toolChoices: choices })] } })
    useSchedule.getState().openTrigger('aios.fakemail', 'new-mail')
    await act(async () => root.render(createElement(ScheduleEditor)))
    expect(container.textContent).toContain(en['trigger.field.tools'])
    const boxes = [...container.querySelectorAll<HTMLInputElement>('.trigger-editor input[type="checkbox"]')]
    const read = boxes.find((box) => box.parentElement?.textContent === 'Read a thing')
    expect(read?.checked).toBe(false)
    await act(async () => read?.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.trigger-editor button[type="submit"]')?.click())
    expect(update).toHaveBeenCalledWith('aios.fakemail', 'new-mail', expect.objectContaining({ allowedTools: ['readThing'] }), null)

    act(() => root.unmount())
    root = createRoot(container)
    useTriggers.setState({ overview: { ...overview, triggers: [row({ bundled: true })] } })
    useSchedule.getState().openTrigger('aios.fakemail', 'new-mail')
    await act(async () => root.render(createElement(ScheduleEditor)))
    expect(container.textContent).not.toContain(en['trigger.field.tools'])
    expect(container.textContent).toContain(en['trigger.field.toolsBundled'])
  })

  it('fix X: a rule aios disabled shows the reason in the edit screen, and saving passes the seen reason to main', async () => {
    useTriggers.setState({ overview: { ...overview, triggers: [row({ autoDisabled: 'plugin-missing' })] } })
    useSchedule.getState().openTrigger('aios.fakemail', 'new-mail')
    await act(async () => root.render(createElement(ScheduleEditor)))
    expect(container.querySelector('[data-auto-disabled="plugin-missing"]')?.textContent).toBe(en['trigger.autoDisabled.missing'])
    const enabled = container.querySelector<HTMLInputElement>('.trigger-editor input[type="checkbox"]')
    await act(async () => enabled?.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.trigger-editor button[type="submit"]')?.click())
    expect(update).toHaveBeenCalledWith('aios.fakemail', 'new-mail', expect.objectContaining({ enabled: true }), 'plugin-missing')
  })

  it('closes when the extension is removed (the row disappears from the list)', async () => {
    useSchedule.getState().openTrigger('aios.fakemail', 'new-mail')
    await act(async () => root.render(createElement(ScheduleEditor)))
    await act(async () => useTriggers.getState().setOverview({ autoRun: true, queued: 0, triggers: [] }))
    expect(useSchedule.getState().editing).toBeNull()
  })
})
