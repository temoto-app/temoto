// @vitest-environment jsdom
/**
 * The scheduled-run screen (TODO 323 stage 1 / wave 18 bundle A; its place changed in TODO 372 / wave 20 bundle B).
 *
 * The first half is the pure display functions (`schedule-format.ts`). The second half, in jsdom, checks the list in the sidebar (`ScheduleList`: each row's next run, last result, push while running, run now, the enabled switch, and clicking a row opens editing), the dot on the activity bar (`scheduleDot`), and editing in the main area (`ScheduleEditor`: summary, draft, the simple form for adding → cron expression, the lower limit of the interval, deletion, exclusion with settings). That scheduled runs are absent from settings is in `settings-editor.test.ts`.
 * Uses neither the model nor Electron.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ScheduleOverview, ScheduledJob, ScheduledJobInput } from '../src/shared/schedule.js'
import type { ThreadCreateOptions, ThreadSummary } from '../src/shared/thread.js'
import { translate } from '../src/renderer/src/i18n/index.js'
import {
  describeDays,
  describeNext,
  describePerDay,
  describeSpec,
  emptyJobDraft,
  formatScheduleWhen,
  switchSpecKind,
  toggleWeekday
} from '../src/renderer/src/schedule-format.js'
import { en } from './helpers/i18n.js'
import { resetScheduleForTest, scheduleDot, useSchedule } from '../src/renderer/src/scheduleStore.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const t = (key: string, params?: Readonly<Record<string, string | number>>): string => translate('en', key, params)

describe('schedule-format (純関数)', () => {
  it('書き方の要約', () => {
    expect(describeSpec(t, { kind: 'daily', time: '8:00' })).toBe('Every day at 08:00')
    expect(describeSpec(t, { kind: 'weekdays', time: '18:30' })).toBe('Weekdays at 18:30')
    expect(describeSpec(t, { kind: 'interval', minutes: 30 })).toBe('Every 30 min')
    expect(describeSpec(t, { kind: 'cron', expression: '0 8 * * 1-5' })).toBe('cron: 0 8 * * 1-5')
    expect(translate('ja', 'schedule.summary.daily', { time: '08:00' })).toBe('毎日 08:00')
  })

  it('TODO 527: 曜日の要約 (月曜始まり、全部なら毎日・月〜金なら平日) とチェックの切り替え', () => {
    expect(describeSpec(t, { kind: 'days', days: [5, 1, 3], time: '9:00' })).toBe('Mon, Wed, Fri at 09:00')
    expect(describeSpec(t, { kind: 'days', days: [0, 6], time: '10:00' })).toBe('Sat, Sun at 10:00')
    expect(describeSpec(t, { kind: 'days', days: [1, 2, 3, 4, 5], time: '8:00' })).toBe('Weekdays at 08:00')
    expect(describeSpec(t, { kind: 'days', days: [0, 1, 2, 3, 4, 5, 6], time: '8:00' })).toBe('Every day at 08:00')
    const ja = (key: string, params?: Readonly<Record<string, string | number>>): string => translate('ja', key, params)
    expect(describeSpec(ja, { kind: 'days', days: [1, 3, 5], time: '9:00' })).toBe('月・水・金 09:00')
    expect(describeDays(ja, [0, 1])).toBe('月・日')
    expect(toggleWeekday([1, 2], 0, true)).toEqual([1, 2, 0])
    expect(toggleWeekday([1, 2, 0], 2, false)).toEqual([1, 0])
    expect(toggleWeekday([1], 1, true)).toEqual([1])
  })

  it('予定の時刻: 今日 / 明日 / 日付', () => {
    const now = new Date(2026, 9, 5, 12, 0).getTime()
    expect(formatScheduleWhen(t, new Date(2026, 9, 5, 18, 5).getTime(), now)).toBe('today 18:05')
    expect(formatScheduleWhen(t, new Date(2026, 9, 6, 8, 0).getTime(), now)).toBe('tomorrow 08:00')
    expect(formatScheduleWhen(t, new Date(2026, 9, 9, 8, 0).getTime(), now)).toBe('10/9 08:00')
  })

  it('種類の切り替えは時刻を引き継ぐ', () => {
    // TODO 527: the old `weekdays` is absorbed into Mon–Fri of `days`.
    expect(switchSpecKind({ kind: 'daily', time: '07:30' }, 'weekdays')).toEqual({ kind: 'days', days: [1, 2, 3, 4, 5], time: '07:30' })
    expect(switchSpecKind({ kind: 'daily', time: '07:30' }, 'days')).toEqual({ kind: 'days', days: [1, 2, 3, 4, 5], time: '07:30' })
    expect(switchSpecKind({ kind: 'weekdays', time: '07:30' }, 'cron')).toEqual({ kind: 'cron', expression: '30 7 * * 1,2,3,4,5' })
    expect(switchSpecKind({ kind: 'days', days: [1, 3, 0], time: '07:30' }, 'cron')).toEqual({ kind: 'cron', expression: '30 7 * * 0,1,3' })
    expect(switchSpecKind({ kind: 'days', days: [6], time: '07:30' }, 'daily')).toEqual({ kind: 'daily', time: '07:30' })
    expect(switchSpecKind({ kind: 'daily', time: '07:30' }, 'cron')).toEqual({ kind: 'cron', expression: '30 7 * * *' })
    expect(switchSpecKind({ kind: 'cron', expression: 'x' }, 'daily')).toEqual({ kind: 'daily', time: '08:00' })
    expect(switchSpecKind({ kind: 'daily', time: '07:30' }, 'interval')).toEqual({ kind: 'interval', minutes: 60 })
  })

  it('追加の下書きは厳格モードなし (TODO 1015、959 の既定 ON を戻した)・有効・所属なし・回数は無制限', () => {
    const draft = emptyJobDraft({ modelId: 'm', thinking: 'high' })
    expect(draft.enabled).toBe(true)
    expect(draft.maxRuns).toBeNull()
    expect(draft.action).toMatchObject({ cwdUri: null, modelId: 'm', thinking: 'high', approvalStrict: false })
  })

  it('TODO 725: 使い切って無効になった行は「完了 (N/N)」、手で止めた行は「止めています」', () => {
    const now = Date.now()
    const completed = { enabled: false, nextRunAt: null, maxRuns: 3, runCount: 3 }
    const pausedByHand = { enabled: false, nextRunAt: null, maxRuns: 3, runCount: 1 }
    const unlimited = { enabled: false, nextRunAt: null, maxRuns: null, runCount: 10 }
    expect(describeNext(t, completed, true, now)).toBe(t('schedule.completed', { count: 3, max: 3 }))
    expect(describeNext(t, pausedByHand, true, now)).toBe(t('schedule.disabled'))
    expect(describeNext(t, unlimited, true, now)).toBe(t('schedule.disabled'))
  })

  it('TODO 827: 回数の上限があって動いている行は、次回の後ろに残りの回数を添える', () => {
    const now = Date.now()
    const running = { enabled: true, nextRunAt: now + 60_000, maxRuns: 5, runCount: 2 }
    expect(describeNext(t, running, true, now)).toContain(t('schedule.remaining', { count: 3 }))
    expect(describeNext(t, { ...running, maxRuns: null }, true, now)).not.toContain(
      t('schedule.remaining', { count: 3 })
    )
  })

  it('TODO 725: 1 日に 1 回未満の間隔 (間隔の上限を 7 日に広げたため) は「1 日に 1 回未満」', () => {
    expect(describePerDay(t, 0)).toBe(t('schedule.perDayLessThanOne'))
    expect(describePerDay(t, 1)).toBe(t('schedule.perDay', { count: 1 }))
  })
})

// ---------------------------------------------------------------------------
// Drawing (jsdom)
// ---------------------------------------------------------------------------

const NOW = Date.now()

function job(patch: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: 'job-1',
    name: 'Morning inbox',
    enabled: true,
    spec: { kind: 'daily', time: '08:00' },
    action: { kind: 'prompt', prompt: 'look', cwdUri: null, modelId: 'model-a', thinking: null, approvalStrict: true },
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
    lastRunAt: NOW - 3_600_000,
    lastThreadId: 'thread-9',
    lastOutcome: 'failed',
    lastError: 'aios-reason:agent-not-logged-in',
    // TODO 351: "last run" (lastRunAt) and "skipped run" (lastSkipAt) are separate values. The default is none.
    lastSkipAt: null,
    nextRunAt: NOW + 3_600_000,
    running: false,
    // TODO 725: the default is unlimited and not yet run.
    maxRuns: null,
    runCount: 0,
    // TODO 1265: not snoozed (always null for a prompt job).
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
  cwdHistory: [
    { uri: 'file:///Users/me/work', name: 'work', parentName: 'me', lastUsedAt: 0, useCount: 1, usable: true, reason: null }
  ]
} as unknown as ThreadCreateOptions

let overview: ScheduleOverview
const create = vi.fn(async (input: ScheduledJobInput): Promise<ScheduleOverview> => {
  overview = { ...overview, jobs: [...overview.jobs, job({ id: 'job-2', ...input, lastRunAt: null, lastOutcome: null })] }
  return overview
})
const update = vi.fn(async (): Promise<ScheduleOverview> => overview)
const runNow = vi.fn(async (): Promise<ScheduleOverview> => overview)
const remove = vi.fn(async (): Promise<ScheduleOverview> => ({ ...overview, jobs: [] }))
// TODO 983 stage 2: the table of "what was allowed for this job".
let roleGrants: unknown[] = []
const roleGrantsCall = vi.fn(async (roleKey: string) => (roleKey === '' ? [] : roleGrants))
const removeRoleGrant = vi.fn(async (roleKey: string, id: string) => {
  roleGrants = []
  return roleKey !== '' && id !== ''
})

function stubApi(): void {
  ;(window as unknown as { aios: unknown }).aios = {
    schedule: {
      list: async () => overview,
      create,
      update,
      remove,
      runNow,
      onChanged: () => () => {}
    },
    // TODO 1216: the list of triggers (the section does not appear if there is no declaration).
    trigger: { list: async () => ({ autoRun: true, queued: 0, triggers: [] }), update: vi.fn(), onChanged: () => () => {} },
    threads: { createOptions: async () => options },
    approvals: { roleGrants: roleGrantsCall, removeRoleGrant, onChanged: () => () => {} },
    fs: { pickDirectory: async () => ({ uri: null, reason: null }) }
  }
}

/** Puts a value into React's controlled input (the native setter + input event). */
function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto = Object.getPrototypeOf(element) as object
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

describe('ScheduleList (サイドバーの一覧、TODO 372)', () => {
  let container: HTMLDivElement
  let root: Root
  let ScheduleList: () => React.JSX.Element

  beforeAll(async () => {
    stubApi()
    ;({ ScheduleList } = await import('../src/renderer/src/components/ScheduleList.js'))
  })

  const render = async (): Promise<void> => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(createElement(ScheduleList))
    })
  }

  beforeEach(() => {
    overview = { jobs: [job()], autoRun: true, resumeReservations: [], laterSends: [] }
    resetScheduleForTest()
    useSchedule.setState({ overview })
    create.mockClear()
    update.mockClear()
    runNow.mockClear()
    remove.mockClear()
    stubApi()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('1 行: 名前・次回・前回の失敗の理由。費用は出さない', async () => {
    await render()
    const row = container.querySelector('.schedule-item')
    expect(row?.textContent).toContain('⏰ Morning inbox')
    expect(row?.textContent).toMatch(/Next: (today|tomorrow) /)
    expect(row?.textContent).toContain('failed: ' + en['reason.agent-not-logged-in'])
    expect(row?.textContent).not.toMatch(/\$|USD|cost/i)
    expect(container.querySelector('.schedule-banner')).toBeNull()
  })

  it('TODO 527: 行に時刻の書き方の要約 (曜日は月曜始まりで「Mon, Wed, Fri」)', async () => {
    useSchedule.setState({ overview: { jobs: [job({ spec: { kind: 'days', days: [5, 1, 3], time: '9:00' } })], autoRun: true, resumeReservations: [], laterSends: [] } })
    await render()
    expect(container.querySelector('.schedule-item .schedule-item-spec')?.textContent).toBe('Mon, Wed, Fri at 09:00')
  })

  it('TODO 351: 飛ばした回 (lastSkipAt) は「前回」とは別の、その回の時刻で出す', async () => {
    useSchedule.setState({
      overview: {
        jobs: [
          job({ lastRunAt: NOW - 15 * 60_000, lastOutcome: 'skipped', lastError: null, lastSkipAt: NOW + 15 * 60_000 })
        ],
        autoRun: true,
        resumeReservations: [], laterSends: []
      }
    })
    await render()
    const text = container.querySelector('.schedule-item')?.textContent ?? ''
    expect(text).toContain(
      en['schedule.outcome.skippedAt'].replace('{when}', formatScheduleWhen(t, NOW + 15 * 60_000, NOW))
    )
  })

  it('複製のインスタンスは帯を出し、次回は「止めています」', async () => {
    useSchedule.setState({ overview: { jobs: [job()], autoRun: false, resumeReservations: [], laterSends: [] } })
    await render()
    expect(container.querySelector('.schedule-banner')?.textContent).toBe(en['schedule.autoRunOff'])
    expect(container.querySelector('.schedule-item')?.textContent).toContain(en['schedule.disabled'])
  })

  it('今すぐ実行と有効の切り替えは main を呼ぶ', async () => {
    await render()
    const run = container.querySelector<HTMLButtonElement>('.schedule-item-run')
    expect(run?.textContent).toBe(en['schedule.runNow'])
    await act(async () => run?.click())
    expect(runNow).toHaveBeenCalledWith('job-1')
    const toggle = container.querySelector<HTMLInputElement>('.schedule-item-enabled')
    expect(toggle?.checked).toBe(true)
    await act(async () => toggle?.click())
    expect(update).toHaveBeenCalledWith('job-1', expect.objectContaining({ enabled: false, name: 'Morning inbox' }))
  })

  it('TODO 739: 回数の上限を使い切ったジョブの今すぐ実行は無効の見た目 + 吹き出しで理由に', async () => {
    overview = {
      jobs: [job({ enabled: false, maxRuns: 2, runCount: 2 })],
      autoRun: true,
      resumeReservations: [], laterSends: []
    }
    useSchedule.setState({ overview })
    await render()
    const run = container.querySelector<HTMLButtonElement>('.schedule-item-run')
    expect(run?.disabled).toBe(true)
    await act(async () => run?.click())
    expect(runNow).not.toHaveBeenCalled()
    // The target of the tooltip is a span wrapping a disabled button (a Chromium mouseenter pitfall; same approach as Composer).
    expect(run?.closest('.composer-icon-tip')).not.toBeNull()
  })

  it('TODO 739: 使い切った「1 回だけ」も同じく無効の見た目に (629 と揃える)', async () => {
    overview = {
      jobs: [job({ enabled: false, spec: { kind: 'once', at: new Date(NOW + 1000).toISOString() } })],
      autoRun: true,
      resumeReservations: [], laterSends: []
    }
    useSchedule.setState({ overview })
    await render()
    const run = container.querySelector<HTMLButtonElement>('.schedule-item-run')
    expect(run?.disabled).toBe(true)
  })

  it('TODO 739: 回数が残っていれば今すぐ実行は押せる (無効なだけでは使い切りと見なさない)', async () => {
    overview = {
      jobs: [job({ enabled: false, maxRuns: 5, runCount: 2 })],
      autoRun: true,
      resumeReservations: [], laterSends: []
    }
    useSchedule.setState({ overview })
    await render()
    const run = container.querySelector<HTMLButtonElement>('.schedule-item-run')
    expect(run?.disabled).toBe(false)
  })

  it('351-2: main の push で「実行中」が付き / 外れる (開き直さなくてよい)', async () => {
    await render()
    expect(container.querySelector('.schedule-running')).toBeNull()
    await act(async () => useSchedule.getState().setOverview({ jobs: [job({ running: true })], autoRun: true, resumeReservations: [], laterSends: [] }))
    expect(container.querySelector('.schedule-item .schedule-running')?.textContent).toBe(en['schedule.running'])
    // Run-now is not shown while running.
    expect(container.querySelector('.schedule-item-run')).toBeNull()
    await act(async () => useSchedule.getState().setOverview({ jobs: [job({ running: false })], autoRun: true, resumeReservations: [], laterSends: [] }))
    expect(container.querySelector('.schedule-running')).toBeNull()
    expect(container.querySelector('.schedule-item-run')).not.toBeNull()
  })

  it('行を押すと本体側の編集が開き、行が選択中になる。+ は追加の編集', async () => {
    await render()
    await act(async () => container.querySelector<HTMLButtonElement>('.schedule-item-main')?.click())
    expect(useSchedule.getState().editing).toEqual({ id: 'job-1' })
    expect(container.querySelector('.schedule-item')?.classList.contains('selected')).toBe(true)
    await act(async () => container.querySelector<HTMLButtonElement>('.schedule-add')?.click())
    expect(useSchedule.getState().editing).toEqual({ id: null })
  })

  it('TODO 725: 回数を使い切って無効になった行は「完了 (N/N)」と出る', async () => {
    useSchedule.setState({
      overview: { jobs: [job({ enabled: false, nextRunAt: null, maxRuns: 2, runCount: 2 })], autoRun: true, resumeReservations: [], laterSends: [] }
    })
    await render()
    expect(container.querySelector('.schedule-item')?.textContent).toContain(en['schedule.completed'].replace('{count}', '2').replace('{max}', '2'))
  })

  it('空の一覧は「まだありません」と説明', async () => {
    useSchedule.setState({ overview: { jobs: [], autoRun: true, resumeReservations: [], laterSends: [] } })
    await render()
    expect(container.textContent).toContain(en['schedule.empty'])
    expect(container.textContent).toContain(en['schedule.description'])
  })

  it('一覧が見えている間に届いた結果は「見た」ことになる (点が消える)', async () => {
    useSchedule.setState({ seenAt: 0 })
    expect(scheduleDot(useSchedule.getState().overview, 0)).toBe('attention')
    await render()
    const { overview: shown, seenAt } = useSchedule.getState()
    expect(seenAt).toBeGreaterThan(0)
    expect(scheduleDot(shown, seenAt)).toBeNull()
  })
})

describe('アクティビティバーの点 (scheduleDot、TODO 372)', () => {
  it('最後に見た後の失敗は警告色、飛ばした回だけならアクセント色、見た後なら無し', () => {
    const failed = job({ lastRunAt: 2_000, lastOutcome: 'failed' })
    const skipped = job({ id: 'b', lastRunAt: 1_000, lastOutcome: 'skipped', lastError: null, lastSkipAt: 3_000 })
    const started = job({ id: 'c', lastOutcome: 'started', lastError: null })
    expect(scheduleDot(undefined, 0)).toBeNull()
    expect(scheduleDot({ jobs: [started], autoRun: true, resumeReservations: [], laterSends: [] }, 0)).toBeNull()
    expect(scheduleDot({ jobs: [skipped, failed], autoRun: true, resumeReservations: [], laterSends: [] }, 0)).toBe('attention')
    expect(scheduleDot({ jobs: [skipped, failed], autoRun: true, resumeReservations: [], laterSends: [] }, 2_500)).toBe('unread')
    expect(scheduleDot({ jobs: [skipped, failed], autoRun: true, resumeReservations: [], laterSends: [] }, 3_000)).toBeNull()
  })
})

describe('ScheduleEditor (本体側の編集、TODO 372)', () => {
  let container: HTMLDivElement
  let root: Root
  let ScheduleEditor: () => React.JSX.Element | null

  beforeAll(async () => {
    stubApi()
    ;({ ScheduleEditor } = await import('../src/renderer/src/components/ScheduleEditor.js'))
  })

  const render = async (): Promise<void> => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(createElement(ScheduleEditor))
    })
  }

  beforeEach(() => {
    overview = { jobs: [job()], autoRun: true, resumeReservations: [], laterSends: [] }
    resetScheduleForTest()
    useSchedule.setState({ overview })
    create.mockClear()
    update.mockClear()
    runNow.mockClear()
    remove.mockClear()
    stubApi()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('閉じていれば何も描かない', async () => {
    await render()
    expect(container.innerHTML).toBe('')
  })

  it('TODO 739: 回数の上限を使い切ったジョブは、本体側の編集でも今すぐ実行が無効の見た目に', async () => {
    overview = {
      jobs: [job({ enabled: false, maxRuns: 2, runCount: 2 })],
      autoRun: true,
      resumeReservations: [], laterSends: []
    }
    useSchedule.setState({ overview, editing: { id: 'job-1' } })
    await render()
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.settings-actions button')]
    const run = buttons.find((b) => b.textContent === en['schedule.runNow'])
    expect(run?.disabled).toBe(true)
    await act(async () => run?.click())
    expect(runNow).not.toHaveBeenCalled()
  })

  it('既存のジョブ: 要約 (1 日あたりの回数・厳格モード) と下書きのフォーム。保存で main を呼んで閉じる', async () => {
    useSchedule.setState({ editing: { id: 'job-1' } })
    await render()
    const region = container.querySelector('.schedule-editor')
    // The same place as the settings editor (the `.settings-editor ~ .thread-pane` rule that hides the neighboring ThreadPane takes effect).
    expect(region?.classList.contains('settings-editor')).toBe(true)
    expect(region?.classList.contains('thread-pane')).toBe(true)
    expect(container.querySelector('.schedule-editor-title')?.textContent).toBe('⏰ Morning inbox')
    const summary = container.querySelector('.schedule-summary')
    expect(summary?.textContent).toContain('Every day at 08:00')
    expect(summary?.textContent).toContain('1× a day')
    expect(summary?.textContent).toContain(en['schedule.strictBadge'])
    const form = container.querySelector('form.schedule-form') as HTMLFormElement
    expect(form.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Morning inbox')
    await act(async () => setValue(form.querySelector<HTMLInputElement>('input[type="text"]')!, 'Renamed'))
    const save = [...form.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === en['schedule.save'])!
    await act(async () => save.click())
    expect(update).toHaveBeenCalledWith('job-1', expect.objectContaining({ name: 'Renamed' }))
    expect(useSchedule.getState().editing).toBeNull()
  })

  it('push (走らせた等) で要約は描き直すが、下書きは消さない', async () => {
    useSchedule.setState({ editing: { id: 'job-1' } })
    await render()
    const form = container.querySelector('form.schedule-form') as HTMLFormElement
    await act(async () => setValue(form.querySelector<HTMLInputElement>('input[type="text"]')!, 'Draft name'))
    await act(async () => useSchedule.getState().setOverview({ jobs: [job({ running: true })], autoRun: true, resumeReservations: [], laterSends: [] }))
    expect(container.querySelector('.schedule-summary .schedule-running')?.textContent).toBe(en['schedule.running'])
    expect(container.querySelector<HTMLInputElement>('form.schedule-form input[type="text"]')?.value).toBe('Draft name')
    // Run-now cannot be pressed while running.
    const runButton = [...container.querySelectorAll<HTMLButtonElement>('.schedule-summary button')].find(
      (b) => b.textContent === en['schedule.runNow']
    )
    expect(runButton?.disabled).toBe(true)
  })

  it('削除は main を呼んで閉じる。別の窓で消えたジョブなら閉じる', async () => {
    useSchedule.setState({ editing: { id: 'job-1' } })
    await render()
    const removeButton = [...container.querySelectorAll<HTMLButtonElement>('.schedule-summary button')].find(
      (b) => b.textContent === en['schedule.remove']
    )
    await act(async () => removeButton?.click())
    expect(remove).toHaveBeenCalledWith('job-1')
    expect(useSchedule.getState().editing).toBeNull()
    act(() => root.unmount())
    container.remove()
    useSchedule.setState({ editing: { id: 'job-x' }, overview: { jobs: [job()], autoRun: true, resumeReservations: [], laterSends: [] } })
    await render()
    expect(useSchedule.getState().editing).toBeNull()
  })

  it('TODO 983 段 2: 「このジョブに許したこと」が並び、✕ は確認なしで 1 行ずつ消す (鍵は job:<id>)', async () => {
    roleGrants = [
      {
        id: 'g1',
        toolName: 'Bash',
        kind: 'command-prefix',
        value: 'docker build',
        scope: 'thread',
        expiresAt: null,
        threadTitle: 'Morning run',
        createdAt: Date.now(),
        lastUsedAt: null,
        useCount: 0
      },
      {
        id: 'g2',
        toolName: 'Write',
        kind: 'path-prefix',
        value: '/w/a/proj',
        access: 'write',
        scope: 'today',
        expiresAt: Date.now() + 1000,
        threadTitle: null,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        useCount: 3
      }
    ]
    useSchedule.setState({ editing: { id: 'job-1' } })
    await render()
    expect(roleGrantsCall).toHaveBeenCalledWith('job:job-1')
    const rows = [...container.querySelectorAll('.role-grants li')]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('commands starting with docker build')
    expect(rows[0]?.textContent).toContain('this conversation only: Morning run')
    expect(rows[1]?.textContent).toContain('until 23:59 today')
    expect(rows[1]?.textContent).toContain('(3x)')
    await act(async () => rows[0]?.querySelector<HTMLButtonElement>('button.link')?.click())
    expect(removeRoleGrant).toHaveBeenCalledWith('job:job-1', 'g1')
    expect(container.querySelectorAll('.role-grants li')).toHaveLength(0)
    roleGrants = []
  })

  it('追加: 簡易形の時刻 → 入力中に次回を出し、間隔の下限を割れば保存できない。保存は main を呼ぶ', async () => {
    overview = { jobs: [], autoRun: true, resumeReservations: [], laterSends: [] }
    useSchedule.setState({ editing: { id: null }, overview })
    await render()
    expect(container.querySelector('.schedule-editor-title')?.textContent).toBe(en['schedule.editor.newTitle'])
    const form = container.querySelector('form.schedule-form') as HTMLFormElement
    expect(form).not.toBeNull()
    // The default is every day at 08:00; the next run and the once-a-day count appear right there.
    expect(form.textContent).toMatch(/Next: (today|tomorrow) 08:00 · 1× a day/)
    // An interval of 3 minutes is below the lower limit (5).
    const kind = form.querySelector<HTMLSelectElement>('select[aria-label="When"]')!
    await act(async () => setValue(kind, 'interval'))
    const minutes = form.querySelector<HTMLInputElement>('input[type="number"]')!
    await act(async () => setValue(minutes, '3'))
    expect(form.textContent).toContain('Runs must be at least 5 minutes apart')
    const save = [...form.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === en['schedule.save'])!
    expect(save.disabled).toBe(true)
    // Switch to details (cron expression) and write it there.
    await act(async () => setValue(kind, 'cron'))
    const cron = form.querySelector<HTMLInputElement>('input.schedule-cron')!
    await act(async () => setValue(cron, '30 9,18 * * *'))
    expect(form.textContent).toContain('2× a day')
    await act(async () => setValue(form.querySelector<HTMLInputElement>('input[type="text"]')!, 'Twice'))
    await act(async () => setValue(form.querySelector<HTMLTextAreaElement>('textarea')!, 'check mail'))
    const folder = [...form.querySelectorAll<HTMLSelectElement>('select')].find((s) =>
      [...s.options].some((o) => o.value === 'file:///Users/me/work')
    )!
    await act(async () => setValue(folder, 'file:///Users/me/work'))
    expect(save.disabled).toBe(false)
    await act(async () => save.click())
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      name: 'Twice',
      enabled: true,
      spec: { kind: 'cron', expression: '30 9,18 * * *' },
      // TODO 1015: a new job's default has no strict mode (reverts the default ON from 959).
      action: { kind: 'prompt', prompt: 'check mail', cwdUri: 'file:///Users/me/work', approvalStrict: false }
    })
    // If it is saved, it closes and appears in the list (store).
    expect(useSchedule.getState().editing).toBeNull()
    expect(useSchedule.getState().overview?.jobs.map((j) => j.name)).toContain('Twice')
  })

  it('TODO 724: 各欄は Settings と同じ settings-item の形 (見出し + 操作)', async () => {
    useSchedule.setState({ editing: { id: 'job-1' } })
    await render()
    const form = container.querySelector('form.schedule-form') as HTMLFormElement
    const items = [...form.querySelectorAll('.settings-item')]
    expect(items.length).toBeGreaterThan(0)
    // The "when" field: the heading is settings-item-title, and the actual select/input is inside settings-item-control.
    const whenTitle = items.find((el) => el.querySelector('.settings-item-title')?.textContent === en['schedule.field.when'])!
    expect(whenTitle).toBeDefined()
    expect(whenTitle.querySelector('.settings-item-control select[aria-label="When"]')).not.toBeNull()
  })

  it('TODO 725: 「一定の間隔」の単位 (分 / 時間) を切り替えても保存は分のまま', async () => {
    overview = { jobs: [], autoRun: true, resumeReservations: [], laterSends: [] }
    useSchedule.setState({ editing: { id: null }, overview })
    await render()
    const form = container.querySelector('form.schedule-form') as HTMLFormElement
    const kind = form.querySelector<HTMLSelectElement>('select[aria-label="When"]')!
    await act(async () => setValue(kind, 'interval'))
    const minutes = form.querySelector<HTMLInputElement>('input[type="number"]')!
    // The default is minutes (60).
    expect(minutes.value).toBe('60')
    const unit = form.querySelector<HTMLSelectElement>('select[aria-label="Interval unit"]')!
    await act(async () => setValue(unit, 'hours'))
    // 60 minutes → shown as 1 hour.
    expect(minutes.value).toBe('1')
    await act(async () => setValue(minutes, '3'))
    await act(async () => setValue(form.querySelector<HTMLInputElement>('input[type="text"]')!, 'Hourly'))
    await act(async () => setValue(form.querySelector<HTMLTextAreaElement>('textarea')!, 'check'))
    const save = [...form.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === en['schedule.save'])!
    await act(async () => save.click())
    // Saved as 3 hours = 180 minutes.
    expect(create.mock.calls[0]?.[0]).toMatchObject({ spec: { kind: 'interval', minutes: 180 } })
  })

  it('code-review (725): 単位を時間に切り替えると、見えている値 (切り上げ・下限 1) を分に書き戻す', async () => {
    overview = { jobs: [], autoRun: true, resumeReservations: [], laterSends: [] }
    useSchedule.setState({ editing: { id: null }, overview })
    await render()
    const form = container.querySelector('form.schedule-form') as HTMLFormElement
    const kind = form.querySelector<HTMLSelectElement>('select[aria-label="When"]')!
    await act(async () => setValue(kind, 'interval'))
    const minutes = form.querySelector<HTMLInputElement>('input[type="number"]')!
    const unit = form.querySelector<HTMLSelectElement>('select[aria-label="Interval unit"]')!
    // Switching 90 minutes to hours saves the rounded result (120 minutes), not the "2 hours" that was shown rounded.
    await act(async () => setValue(minutes, '90'))
    await act(async () => setValue(unit, 'hours'))
    expect(minutes.value).toBe('2')
    await act(async () => setValue(form.querySelector<HTMLInputElement>('input[type="text"]')!, 'Ninety'))
    await act(async () => setValue(form.querySelector<HTMLTextAreaElement>('textarea')!, 'check'))
    const save = [...form.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === en['schedule.save'])!
    await act(async () => save.click())
    expect(create.mock.calls[0]?.[0]).toMatchObject({ spec: { kind: 'interval', minutes: 120 } })
  })

  it('TODO 1220: 5 / 15 / 30 / 60 分の既定値のボタンを押すとその分数が入る', async () => {
    overview = { jobs: [], autoRun: true, resumeReservations: [], laterSends: [] }
    useSchedule.setState({ editing: { id: null }, overview })
    await render()
    const form = container.querySelector('form.schedule-form') as HTMLFormElement
    const kind = form.querySelector<HTMLSelectElement>('select[aria-label="When"]')!
    await act(async () => setValue(kind, 'interval'))
    const group = form.querySelector('[role="group"][aria-label="Interval presets"]')!
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['5 min', '15 min', '30 min', '60 min'])
    await act(async () => buttons[0]!.click())
    const minutes = form.querySelector<HTMLInputElement>('input[type="number"]')!
    expect(minutes.value).toBe('5')
    expect(form.textContent).not.toContain('Runs must be at least')
    await act(async () => buttons[2]!.click())
    expect(minutes.value).toBe('30')
  })

  it('code-review (725): 15 分 (1 時間未満) で単位を時間に切り替えると「0 時間」ではなく下限 1 時間になる', async () => {
    overview = { jobs: [], autoRun: true, resumeReservations: [], laterSends: [] }
    useSchedule.setState({ editing: { id: null }, overview })
    await render()
    const form = container.querySelector('form.schedule-form') as HTMLFormElement
    const kind = form.querySelector<HTMLSelectElement>('select[aria-label="When"]')!
    await act(async () => setValue(kind, 'interval'))
    const minutes = form.querySelector<HTMLInputElement>('input[type="number"]')!
    const unit = form.querySelector<HTMLSelectElement>('select[aria-label="Interval unit"]')!
    await act(async () => setValue(minutes, '15'))
    await act(async () => setValue(unit, 'hours'))
    expect(minutes.value).toBe('1')
    await act(async () => setValue(form.querySelector<HTMLInputElement>('input[type="text"]')!, 'Quarter'))
    await act(async () => setValue(form.querySelector<HTMLTextAreaElement>('textarea')!, 'check'))
    const save = [...form.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === en['schedule.save'])!
    await act(async () => save.click())
    expect(create.mock.calls[0]?.[0]).toMatchObject({ spec: { kind: 'interval', minutes: 60 } })
  })

  it('TODO 725: 回数の上限 (既定は無制限 → 「N 回で止める」を選んで数を入れる)', async () => {
    overview = { jobs: [], autoRun: true, resumeReservations: [], laterSends: [] }
    useSchedule.setState({ editing: { id: null }, overview })
    await render()
    const form = container.querySelector('form.schedule-form') as HTMLFormElement
    const maxRunsSelect = form.querySelector<HTMLSelectElement>('select[aria-label="Run limit"]')!
    expect(maxRunsSelect.value).toBe('unlimited')
    expect(form.querySelector('input[aria-label="Number of runs"]')).toBeNull()
    await act(async () => setValue(maxRunsSelect, 'limited'))
    const count = form.querySelector<HTMLInputElement>('input[aria-label="Number of runs"]')!
    expect(count.value).toBe('1')
    await act(async () => setValue(count, '5'))
    await act(async () => setValue(form.querySelector<HTMLInputElement>('input[type="text"]')!, 'Capped'))
    await act(async () => setValue(form.querySelector<HTMLTextAreaElement>('textarea')!, 'check'))
    const save = [...form.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === en['schedule.save'])!
    await act(async () => save.click())
    expect(create.mock.calls[0]?.[0]).toMatchObject({ maxRuns: 5 })
  })

  it('TODO 725: 「1 回だけ」には回数の上限の欄を出さない', async () => {
    overview = { jobs: [], autoRun: true, resumeReservations: [], laterSends: [] }
    useSchedule.setState({ editing: { id: null }, overview })
    await render()
    const form = container.querySelector('form.schedule-form') as HTMLFormElement
    expect(form.querySelector('select[aria-label="Run limit"]')).not.toBeNull()
    const kind = form.querySelector<HTMLSelectElement>('select[aria-label="When"]')!
    await act(async () => setValue(kind, 'once'))
    expect(form.querySelector('select[aria-label="Run limit"]')).toBeNull()
  })

  it('TODO 527: 曜日を指定 → 月〜日のチェックボックス (最初は月〜金)。空なら保存できず、選んだ曜日で main を呼ぶ', async () => {
    overview = { jobs: [], autoRun: true, resumeReservations: [], laterSends: [] }
    useSchedule.setState({ editing: { id: null }, overview })
    await render()
    const form = container.querySelector('form.schedule-form') as HTMLFormElement
    const kind = form.querySelector<HTMLSelectElement>('select[aria-label="When"]')!
    // The options have no old "weekdays"; there is "days of the week" instead.
    expect([...kind.options].map((o) => o.value)).toEqual(['daily', 'days', 'interval', 'cron', 'once'])
    expect(form.querySelector('.schedule-days')).toBeNull()
    await act(async () => setValue(kind, 'days'))
    const group = form.querySelector('.schedule-days')!
    expect(group.getAttribute('role')).toBe('group')
    expect(group.getAttribute('aria-label')).toBe(en['schedule.field.days'])
    const labels = [...group.querySelectorAll('label.schedule-day')]
    // The week starts on Monday.
    expect(labels.map((l) => l.textContent)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    const boxes = labels.map((l) => l.querySelector<HTMLInputElement>('input[type="checkbox"]')!)
    expect(boxes.map((b) => b.checked)).toEqual([true, true, true, true, true, false, false])
    // The time field remains.
    expect(form.querySelector<HTMLInputElement>('input[type="time"]')?.value).toBe('08:00')
    const save = [...form.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === en['schedule.save'])!
    // If all are unchecked, it cannot be saved.
    for (const box of boxes.slice(0, 5)) await act(async () => box.click())
    expect(form.textContent).toContain(en['reason.schedule-days-empty'])
    expect(save.disabled).toBe(true)
    // Choose Wednesday and Sunday.
    await act(async () => boxes[6]!.click())
    await act(async () => boxes[2]!.click())
    expect(form.textContent).not.toContain(en['reason.schedule-days-empty'])
    expect(form.textContent).toMatch(/Next: .* · 1× a day/)
    await act(async () => setValue(form.querySelector<HTMLInputElement>('input[type="time"]')!, '09:15'))
    await act(async () => setValue(form.querySelector<HTMLInputElement>('input[type="text"]')!, 'Midweek'))
    await act(async () => setValue(form.querySelector<HTMLTextAreaElement>('textarea')!, 'check'))
    expect(save.disabled).toBe(false)
    await act(async () => save.click())
    expect(create.mock.calls[0]?.[0]).toMatchObject({ spec: { kind: 'days', days: [3, 0], time: '09:15' } })
  })

  it('TODO 527: 旧 weekdays のジョブは「曜日を指定」の月〜金として開く', async () => {
    overview = { jobs: [job({ spec: { kind: 'weekdays', time: '07:00' } })], autoRun: true, resumeReservations: [], laterSends: [] }
    useSchedule.setState({ editing: { id: 'job-1' }, overview })
    await render()
    const form = container.querySelector('form.schedule-form') as HTMLFormElement
    expect(form.querySelector<HTMLSelectElement>('select[aria-label="When"]')?.value).toBe('days')
    const boxes = [...form.querySelectorAll<HTMLInputElement>('.schedule-days input[type="checkbox"]')]
    expect(boxes.map((b) => b.checked)).toEqual([true, true, true, true, true, false, false])
    expect(container.querySelector('.schedule-summary')?.textContent).toContain('Weekdays at 07:00')
  })

  it('設定エディタを開くと閉じ、スレッドを選んでも閉じる (同じ置き場)', async () => {
    const { useSettingsEditor } = await import('../src/renderer/src/settingsEditorStore.js')
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    useSchedule.getState().openEditor('job-1')
    act(() => useSettingsEditor.getState().openEditor())
    expect(useSchedule.getState().editing).toBeNull()
    useSchedule.getState().openEditor('job-1')
    // Opening it closes the settings editor.
    expect(useSettingsEditor.getState().open).toBe(false)
    act(() => useThreads.setState((s) => ({ activeThreadId: 't1', selectionSeq: s.selectionSeq + 1 })))
    expect(useSchedule.getState().editing).toBeNull()
  })
})

describe('ThreadRow: 定期実行のスレッドの ⏰ (TODO 323)', () => {
  let host: HTMLDivElement
  let rowRoot: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    rowRoot = createRoot(host)
  })

  afterEach(() => {
    act(() => rowRoot.unmount())
    host.remove()
  })

  const summaryOf = (scheduledJobId?: string): ThreadSummary =>
    ({
      thread: {
        id: 't1',
        title: 'Morning inbox',
        cwdName: '',
        forkedFrom: null,
        rainbow: null,
        unread: false,
        ...(scheduledJobId === undefined ? {} : { scheduledJobId })
      },
      runtime: { state: 'idle', pendingApprovals: 0, subtasks: [] },
      preview: null
    }) as unknown as ThreadSummary

  const renderRow = async (summary: ThreadSummary): Promise<void> => {
    const { ThreadRow } = await import('../src/renderer/src/components/ThreadList.js')
    act(() => rowRoot.render(createElement(ThreadRow, { summary, active: false, sortKey: 'recent' })))
  }

  it('定期実行のスレッドだけに ⏰ が付く', async () => {
    await renderRow(summaryOf('job-1'))
    const mark = host.querySelector('.thread-scheduled-mark')
    expect(mark?.textContent).toBe('⏰')
    expect(mark?.getAttribute('aria-label')).toBe(en['threadList.scheduled'])
    await renderRow(summaryOf())
    expect(host.querySelector('.thread-scheduled-mark')).toBeNull()
  })
})

describe('plugin の定期タスクの描き分け (kind: plugin、TODO 372)', () => {
  let container: HTMLDivElement
  let root: Root
  const pluginJob = job({
    id: 'job-p',
    name: 'Fetch mail',
    enabled: false,
    spec: { kind: 'interval', minutes: 30 },
    action: { kind: 'plugin', pluginId: 'aios.mail', taskId: 'fetch' },
    lastRunAt: null,
    lastThreadId: null,
    lastOutcome: 'unsupported',
    lastError: null,
    lastSkipAt: NOW - 60_000,
    nextRunAt: null
  })

  beforeEach(() => {
    overview = { jobs: [pluginJob], autoRun: true, resumeReservations: [], laterSends: [] }
    resetScheduleForTest()
    useSchedule.setState({ overview })
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

  it('一覧: ⏰ ではなく plugin の札、既定は無効、「未対応」の回', async () => {
    const { ScheduleList } = await import('../src/renderer/src/components/ScheduleList.js')
    await act(async () => root.render(createElement(ScheduleList)))
    const row = container.querySelector('.schedule-item')
    expect(row?.classList.contains('disabled')).toBe(true)
    expect(row?.querySelector('.schedule-item-name')?.textContent).toBe('Fetch mail' + en['schedule.plugin.badge'])
    expect(row?.textContent).not.toContain('⏰')
    expect(container.querySelector<HTMLInputElement>('.schedule-item-enabled')?.checked).toBe(false)
    expect(row?.textContent).toContain(
      en['schedule.outcome.unsupportedAt'].replace('{when}', formatScheduleWhen(t, NOW - 60_000, NOW))
    )
    // A "not supported" run also becomes a dot (same accent color as a skipped run).
    expect(scheduleDot(overview, 0)).toBe('unread')
  })

  it('編集: 名前は読み取りだけ、プロンプト・作業フォルダ・Model の欄は無く、plugin / タスクの id と注記。保存は時刻と有効', async () => {
    const { ScheduleEditor } = await import('../src/renderer/src/components/ScheduleEditor.js')
    useSchedule.setState({ editing: { id: 'job-p' } })
    await act(async () => root.render(createElement(ScheduleEditor)))
    expect(container.querySelector('.schedule-editor-title')?.textContent).toBe('Fetch mail')
    const form = container.querySelector('form.schedule-form') as HTMLFormElement
    expect(form.querySelector<HTMLInputElement>('input[type="text"]')?.readOnly).toBe(true)
    expect(form.querySelector('textarea')).toBeNull()
    expect(form.textContent).not.toContain(en['schedule.field.folder'])
    expect(form.textContent).not.toContain(en['schedule.field.strict'])
    expect(form.querySelector('.schedule-plugin-id')?.textContent).toBe('aios.mail / fetch')
    expect(form.textContent).toContain(en['schedule.plugin.note'])
    const enabled = [...form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(enabled).toHaveLength(1)
    await act(async () => enabled[0]!.click())
    const save = [...form.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === en['schedule.save'])!
    await act(async () => save.click())
    expect(update).toHaveBeenCalledWith('job-p', {
      name: 'Fetch mail',
      enabled: true,
      spec: { kind: 'interval', minutes: 30 },
      // TODO 725: the draft keeps job.maxRuns (unlimited) as it is. main ignores it for plugin rows anyway.
      maxRuns: null,
      action: { kind: 'plugin', pluginId: 'aios.mail', taskId: 'fetch' }
    })
  })
})

describe('アクティビティバーの「定期実行」(Sidebar、TODO 372)', () => {
  let host: HTMLDivElement
  let sidebarRoot: Root

  beforeEach(() => {
    overview = { jobs: [job()], autoRun: true, resumeReservations: [], laterSends: [] }
    stubApi()
    const api = (window as unknown as { aios: Record<string, unknown> }).aios
    api['app'] = { onMenuCommand: () => () => undefined }
    api['search'] = { getStatus: async () => null, onStatus: () => () => undefined }
    // TODO 523: Sidebar now reads the plugin's contribution to the Activity Bar (`usePluginList`).
    api['plugins'] = {
      list: async () => [],
      onChanged: () => () => undefined,
      surfaces: async () => ({ sidebar: [], status: [] }),
      onSurfacesChanged: () => () => undefined
    }
    resetScheduleForTest()
    host = document.createElement('div')
    document.body.append(host)
    sidebarRoot = createRoot(host)
  })

  afterEach(() => {
    act(() => sidebarRoot.unmount())
    host.remove()
  })

  const renderSidebar = async (): Promise<void> => {
    const { Sidebar } = await import('../src/renderer/src/components/Sidebar.js')
    await act(async () => {
      sidebarRoot.render(createElement(Sidebar))
    })
  }

  it('並びはスレッド・ファイル・検索・定期実行、下端に設定。吹き出しは Tooltip (title を書かない)', async () => {
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    useThreads.setState({ mode: 'threads', sidebarCollapsed: true })
    await renderSidebar()
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.activity-bar .activity-item')]
    expect(buttons.map((b) => b.getAttribute('aria-label')?.replace(/ \(.*\)$/, ''))).toEqual([
      // TODO 408 (wave 21 bundle D): "new thread" is at the top, outside the mode column (an operation that holds no selection state).
      en['threads.new'],
      en['sidebar.mode.threads'],
      en['sidebar.mode.files'],
      en['sidebar.mode.search'],
      en['sidebar.mode.schedule'],
      // "Extensions" from wave 20 bundle A (TODO 367) sits under scheduled runs (aligned at merge).
      en['sidebar.mode.extensions'],
      // "Web" from wave 26 bundle A (TODO 522) sits under Extensions.
      en['sidebar.mode.web'],
      // Help (?) from wave 75 bundle D (TODO 1174) sits above the settings gear at the bottom.
      en['help.title'],
      en['settings.title']
    ])
    const schedule = buttons[4]!
    expect(schedule.hasAttribute('title')).toBe(false)
    expect(schedule.querySelector('svg')).not.toBeNull()
    // A failure from the previous run while the list was not visible (after seenAt 0) is a warning-colored dot.
    expect(schedule.querySelector('.activity-dot.attention')).not.toBeNull()
    expect(schedule.getAttribute('aria-label')).toBe(
      en['sidebar.mode.scheduleFailed'].replace('{label}', en['sidebar.mode.schedule'])
    )
  })

  it('押すとサイドバーに一覧が出て、点が消える', async () => {
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    // Opens from the collapsed "scheduled runs" (so the contents of other modes need not be drawn).
    useThreads.setState({ mode: 'schedule', sidebarCollapsed: true })
    await renderSidebar()
    const schedule = [...host.querySelectorAll<HTMLButtonElement>('.activity-item')][4]!
    expect(schedule.querySelector('.activity-dot')).not.toBeNull()
    await act(async () => schedule.click())
    expect(useThreads.getState().mode).toBe('schedule')
    expect(host.querySelector('.sidebar-panel .schedule-panel')).not.toBeNull()
    expect(host.querySelector('.schedule-item')?.textContent).toContain('Morning inbox')
    expect(schedule.querySelector('.activity-dot')).toBeNull()
  })
})
