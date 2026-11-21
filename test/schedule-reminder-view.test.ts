// @vitest-environment jsdom
/**
 * The reminder screens (TODO 1265): the list row's bell and "Test notification", the editor's Type field (AI fields disappear for a reminder),
 * the snooze buttons (the fallback when the OS hides the notification's buttons), and opening the editor from a notification click.
 * Uses neither the model nor Electron.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ScheduleOverview, ScheduledJob, ScheduledJobInput } from '../src/shared/schedule.js'
import type { ThreadCreateOptions } from '../src/shared/thread.js'
import { en } from './helpers/i18n.js'
import { resetScheduleForTest, useSchedule } from '../src/renderer/src/scheduleStore.js'
import { useThreads } from '../src/renderer/src/threadStore.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.now()

function reminder(patch: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: 'r-1',
    name: 'Medicine',
    enabled: true,
    spec: { kind: 'daily', time: '08:00' },
    action: { kind: 'reminder', body: 'after breakfast' },
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
    lastRunAt: null,
    lastThreadId: null,
    lastOutcome: null,
    lastError: null,
    lastSkipAt: null,
    nextRunAt: NOW + 3_600_000,
    running: false,
    maxRuns: null,
    runCount: 0,
    snoozedUntil: null,
    ...patch
  }
}

const options = {
  backends: [
    {
      id: 'x',
      label: 'X',
      available: true,
      message: null,
      models: [{ id: 'model-a', label: 'Model A' }],
      modelSelect: true,
      thinkingLevel: true,
      rewind: false,
      degradations: [],
      commands: null
    }
  ],
  defaultBackend: 'x',
  homeUri: 'file:///Users/me',
  cwdHistory: []
} as unknown as ThreadCreateOptions

let overview: ScheduleOverview
const create = vi.fn(async (input: ScheduledJobInput): Promise<ScheduleOverview> => {
  overview = { ...overview, jobs: [...overview.jobs, reminder({ id: 'r-2', ...input } as Partial<ScheduledJob>)] }
  return overview
})
const update = vi.fn(async (): Promise<ScheduleOverview> => overview)
const runNow = vi.fn(async (): Promise<ScheduleOverview> => overview)
const snooze = vi.fn(async (): Promise<ScheduleOverview> => overview)
const cancelSnooze = vi.fn(async (): Promise<ScheduleOverview> => overview)

function stubApi(): void {
  ;(window as unknown as { aios: unknown }).aios = {
    schedule: {
      list: async () => overview,
      create,
      update,
      remove: vi.fn(async () => overview),
      runNow,
      snooze,
      cancelSnooze,
      onChanged: () => () => {}
    },
    trigger: { list: async () => ({ autoRun: true, queued: 0, triggers: [] }), update: vi.fn(), onChanged: () => () => {} },
    threads: { createOptions: async () => options },
    approvals: { roleGrants: vi.fn(async () => []), removeRoleGrant: vi.fn(), onChanged: () => () => {} },
    fs: { pickDirectory: async () => ({ uri: null, reason: null }) }
  }
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto = Object.getPrototypeOf(element) as object
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
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

const render = async (component: () => React.JSX.Element | null): Promise<void> => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(component))
  })
}

beforeEach(() => {
  overview = { jobs: [reminder()], autoRun: true, resumeReservations: [], laterSends: [] }
  resetScheduleForTest()
  useSchedule.setState({ overview })
  for (const fn of [create, update, runNow, snooze, cancelSnooze]) fn.mockClear()
  stubApi()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ScheduleList (reminder rows)', () => {
  it('ベルの印 (⏰ ではない) とスヌーズ中の表示。「通知を試す」は main の runNow', async () => {
    useSchedule.setState({
      overview: { ...overview, jobs: [reminder({ snoozedUntil: NOW + 5 * 60_000 })] }
    })
    await render(ScheduleList)
    const row = container.querySelector('.schedule-item')!
    expect(row.querySelector('.schedule-reminder-mark')?.getAttribute('aria-label')).toBe(en['schedule.reminder.badge'])
    expect(row.textContent).not.toContain('⏰')
    expect(row.textContent).toContain(en['schedule.reminder.snoozed'].split('{when}')[0])
    const test = row.querySelector<HTMLButtonElement>('.schedule-item-run')!
    expect(test.textContent).toBe(en['schedule.reminder.test'])
    await act(async () => test.click())
    expect(runNow).toHaveBeenCalledWith('r-1')
  })
})

describe('ScheduleEditor (reminders)', () => {
  it('追加: 種類をリマインダーにすると AI 用の欄 (プロンプト・フォルダ・Model・厳格) が消え、題と本文だけで保存する', async () => {
    overview = { jobs: [], autoRun: true, resumeReservations: [], laterSends: [] }
    useSchedule.setState({ editing: { id: null }, overview })
    await render(ScheduleEditor)
    const form = container.querySelector('form.schedule-form') as HTMLFormElement
    const kind = form.querySelector<HTMLSelectElement>(`select[aria-label="${en['schedule.field.jobKind']}"]`)!
    expect(kind.disabled).toBe(false)
    expect(form.querySelector('textarea.schedule-prompt')).not.toBeNull()
    await act(async () => setValue(kind, 'reminder'))
    expect(form.querySelector('textarea.schedule-prompt')).toBeNull()
    expect(form.textContent).not.toContain(en['schedule.field.folder'])
    expect(form.textContent).not.toContain(en['schedule.field.strict'])
    expect(form.textContent).not.toContain(en['common.model'])
    expect(form.textContent).toContain(en['schedule.field.title'])
    await act(async () => setValue(form.querySelector<HTMLInputElement>('input[type="text"]')!, 'Stretch'))
    await act(async () => setValue(form.querySelector<HTMLTextAreaElement>('textarea.schedule-reminder-body')!, 'stand up'))
    const save = [...form.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === en['schedule.save'])!
    await act(async () => save.click())
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[0]).toEqual({
      name: 'Stretch',
      enabled: true,
      spec: { kind: 'daily', time: '08:00' },
      maxRuns: null,
      action: { kind: 'reminder', body: 'stand up' }
    })
  })

  it('既存のリマインダー: 種類は変えられない。スヌーズのボタン (5 分 / 10 分 / 1 時間) と取り消し', async () => {
    overview = { ...overview, jobs: [reminder({ snoozedUntil: NOW + 10 * 60_000 })] }
    useSchedule.setState({ editing: { id: 'r-1' }, overview })
    await render(ScheduleEditor)
    expect(
      container.querySelector<HTMLSelectElement>(`select[aria-label="${en['schedule.field.jobKind']}"]`)?.disabled
    ).toBe(true)
    const row = container.querySelector('.schedule-snooze')!
    const buttons = [...row.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.map((b) => b.textContent)).toEqual([
      en['schedule.reminder.snoozeMinutes'].replace('{minutes}', '5'),
      en['schedule.reminder.snoozeMinutes'].replace('{minutes}', '10'),
      en['schedule.reminder.snoozeHours'].replace('{hours}', '1'),
      en['schedule.reminder.cancelSnooze']
    ])
    await act(async () => buttons[0]!.click())
    expect(snooze).toHaveBeenCalledWith('r-1', 5)
    await act(async () => buttons[3]!.click())
    expect(cancelSnooze).toHaveBeenCalledWith('r-1')
    // "Test notification" instead of Run now.
    const actions = [...container.querySelectorAll<HTMLButtonElement>('.schedule-summary .settings-actions button')]
    expect(actions.map((b) => b.textContent)).toContain(en['schedule.reminder.test'])
    expect(actions.map((b) => b.textContent)).not.toContain(en['schedule.runNow'])
  })

  it('通知を押した (OpenRequest.scheduleJobId → threadStore) らそのジョブの編集が開く', async () => {
    await render(ScheduleEditor)
    expect(useSchedule.getState().editing).toBeNull()
    act(() => useThreads.setState({ scheduleOpenRequest: { jobId: 'r-1', seq: 1 } }))
    expect(useSchedule.getState().editing).toEqual({ id: 'r-1' })
  })
})
