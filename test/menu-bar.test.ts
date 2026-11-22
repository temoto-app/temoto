/**
 * TODO 1269 (wave 94 bundle B): the macOS menu bar icon.
 *
 * - `trayMenuModel`: four things in a fixed order (show, new thread, pending approvals, quit); with no approvals the row is greyed and has no action;
 *   with some, the count is in the label and pressing it shows the window; EN / JA labels.
 * - `MenuBarPreference`: default off, remembers the value and calls `onChange`; where there is no menu bar (not macOS) `set` does nothing and `get` is false.
 * - The key is `display` for the AI's settings tool (a visual preference) and its default is off.
 *
 * Neither electron nor the OS is touched (electron is mocked; the tray itself, `os/tray.ts`, is not exercised).
 */
import { describe, expect, it, vi } from 'vitest'
import { APP_MENU_BAR, agentSettingAccess, type SettingKey } from '../src/common/settings-keys.js'
import { recentThreadRows, trayThreadLists, type BadgeThread } from '../src/main/session/badge.js'
import type { ApprovalItem } from '../src/shared/thread.js'
import { settingDefaults } from '../src/main/settings-snapshot.js'
import { clipTitle, menuLabelText, emptyTrayMenu, folderLabels, formatRunTime, selectUpcomingJobs, trayIconState, trayMenuModel, trayMenuSignature, type TrayMenuInput } from '../src/main/os/tray-model.js'

vi.mock('electron', () => ({ app: {}, powerMonitor: {}, powerSaveBlocker: {} }))

const { MenuBarPreference } = await import('../src/main/os-settings.js')

class MemorySettings {
  readonly values = new Map<string, string>()
  readTyped<T>(def: SettingKey<T>): T {
    return def.parse(this.values.get(def.key) ?? null)
  }
  writeTyped<T>(def: SettingKey<T>, value: T): void {
    this.values.set(def.key, def.serialize(value))
  }
}

const row = (threadId: string, title = threadId) => ({ threadId, title })
const rows = (n: number, prefix = 't') => Array.from({ length: n }, (_, i) => row(`${prefix}${i}`, `${prefix} title ${i}`))
const input = (locale: 'en' | 'ja', pending = 0): TrayMenuInput => ({ ...emptyTrayMenu(locale), pending })

describe('trayMenuModel (TODO 1269)', () => {
  it('shows a gray 「待ちの承認なし」 when there are 0 pending approvals, and clicking does nothing', () => {
    const items = trayMenuModel(input('ja'))
    expect(items.map((entry) => (entry.kind === 'separator' ? '---' : entry.id))).toEqual(['pickFolder', '---', 'show', 'newThread', '---', 'pending', '---', 'quit'])
    const pending = items.find((entry) => entry.kind === 'item' && entry.id === 'pending')
    expect(pending).toMatchObject({ label: '待ちの承認なし', enabled: false, action: null })
  })

  it('shows the count when approvals are pending, and clicking shows the window', () => {
    const pending = trayMenuModel(input('ja', 3)).find((entry) => entry.kind === 'item' && entry.id === 'pending')
    expect(pending).toMatchObject({ label: '待ちの承認: 3 件', enabled: true, action: 'show' })
    const english = trayMenuModel(input('en', 1)).find((entry) => entry.kind === 'item' && entry.id === 'pending')
    expect(english).toMatchObject({ label: 'Pending approvals: 1', enabled: true, action: 'show' })
  })

  it('has show window, new thread and quit actions, and EN / JA labels', () => {
    const byId = (locale: 'en' | 'ja') =>
      Object.fromEntries(trayMenuModel(input(locale)).flatMap((entry) => (entry.kind === 'item' ? [[entry.id, entry]] : [])))
    expect(byId('en')['show']).toMatchObject({ action: 'show', enabled: true })
    expect(byId('en')['newThread']).toMatchObject({ action: 'newThread', enabled: true, label: 'New Thread' })
    expect(byId('en')['quit']).toMatchObject({ action: 'quit', enabled: true })
    expect(byId('ja')['newThread']).toMatchObject({ label: '新しい会話' })
    expect(byId('ja')['show']?.label).not.toContain('{app}')
  })

  it('treats an invalid count (negative, fractional, NaN) as 0', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(trayMenuModel(input('en', bad))).toEqual(trayMenuModel(input('en')))
    }
  })

  it('changes the signature only when the language or the count changes (decides whether to rebuild)', () => {
    expect(trayMenuSignature(input('en', 2))).toBe(trayMenuSignature(input('en', 2)))
    expect(trayMenuSignature(input('en', 2))).not.toBe(trayMenuSignature(input('en', 3)))
    expect(trayMenuSignature(input('en', 2))).not.toBe(trayMenuSignature(input('ja', 2)))
    expect(trayMenuSignature(input('en'))).toBe(trayMenuSignature(input('en', -5)))
  })
})

describe('menu bar icon state and summary row (TODO 1302)', () => {
  it('shows a dot only while something runs, and the badge is the number handed in (the Dock badge formula)', () => {
    expect(trayIconState({ badge: 0, running: [] })).toEqual({ running: false, badge: 0 })
    expect(trayIconState({ badge: 0, running: rows(2) })).toEqual({ running: true, badge: 0 })
    expect(trayIconState({ badge: 5, running: rows(1) })).toEqual({ running: true, badge: 5 })
    expect(trayIconState({ badge: Number.NaN, running: [] })).toEqual({ running: false, badge: 0 })
  })

  it('adds a "Running N / Unread N" row only when something runs or is unread', () => {
    const find = (model: TrayMenuInput) => trayMenuModel(model).find((entry) => entry.kind === 'item' && entry.id === 'summary')
    expect(find(input('en'))).toBeUndefined()
    expect(find({ ...input('en'), running: rows(2), unread: rows(1, 'u') })).toMatchObject({ label: 'Running 2 / Unread 1', enabled: true, action: 'show' })
    expect(find({ ...input('ja'), unread: rows(3, 'u') })).toMatchObject({ label: '実行中 0 / 未読 3' })
  })

  it('rebuilds the menu when the running list changes', () => {
    expect(trayMenuSignature({ ...input('en'), running: rows(1) })).not.toBe(trayMenuSignature({ ...input('en'), running: rows(2) }))
  })
})

describe('conversations named in the menu (TODO 1303)', () => {
  const ids = (model: TrayMenuInput) => trayMenuModel(model).map((entry) => (entry.kind === 'separator' ? '---' : entry.id))

  it('lists approvals first, then running, then unread, each choosing that conversation', () => {
    const model = { ...input('en', 1), approvals: [row('a', 'Waiting')], running: [row('r', 'Busy')], unread: [row('u', 'Done')] }
    expect(ids(model)).toEqual([
      'pickFolder', '---', 'show', 'newThread', '---', 'pending',
      'tray.rowApproval:a', 'summary', 'tray.rowRunning:r', 'tray.rowUnread:u', '---', 'quit'
    ])
    const items = trayMenuModel(model).flatMap((entry) => (entry.kind === 'item' ? [entry] : []))
    expect(items.find((e) => e.id === 'tray.rowApproval:a')).toMatchObject({ label: 'Awaiting approval: Waiting', action: { kind: 'openThread', threadId: 'a' } })
    expect(items.find((e) => e.id === 'tray.rowRunning:r')).toMatchObject({ label: 'Running: Busy', action: { kind: 'openThread', threadId: 'r' } })
    expect(items.find((e) => e.id === 'tray.rowUnread:u')).toMatchObject({ label: 'Unread: Done' })
    const ja = trayMenuModel({ ...model, locale: 'ja' }).flatMap((entry) => (entry.kind === 'item' ? [entry.label] : []))
    expect(ja).toContain('承認待ち: Waiting')
    expect(ja).toContain('未読: Done')
  })

  it('names all approvals but at most 10 running / unread, with "N more" for the rest', () => {
    const model = { ...input('en'), approvals: rows(12, 'a'), running: rows(11, 'r'), unread: rows(13, 'u') }
    const entries = trayMenuModel(model).flatMap((entry) => (entry.kind === 'item' ? [entry] : []))
    expect(entries.filter((e) => e.id.startsWith('tray.rowApproval:a'))).toHaveLength(12)
    expect(entries.filter((e) => /^tray\.rowRunning:r\d/.test(e.id))).toHaveLength(10)
    expect(entries.find((e) => e.id === 'tray.rowRunning:more')).toMatchObject({ label: '1 more', action: 'show' })
    expect(entries.find((e) => e.id === 'tray.rowUnread:more')).toMatchObject({ label: '3 more' })
    expect(entries.find((e) => e.id === 'summary')?.label).toBe('Running 11 / Unread 13')
  })

  it('cuts a long title to 40 characters plus an ellipsis, on one line, and names an untitled conversation', () => {
    expect(clipTitle('a'.repeat(40))).toBe('a'.repeat(40))
    expect(clipTitle('b'.repeat(41))).toBe(`${'b'.repeat(40)}…`)
    expect(clipTitle('line one\n  line two')).toBe('line one line two')
    expect(clipTitle('😀'.repeat(41))).toBe(`${'😀'.repeat(40)}…`)
    const model = { ...input('ja'), unread: [row('x', '')] }
    expect(trayMenuModel(model).some((e) => e.kind === 'item' && e.label === '未読: 名前のない会話')).toBe(true)
  })

  it('goes straight to the conversation from the summary row when only one is named', () => {
    const one = trayMenuModel({ ...input('en'), unread: [row('only')] }).find((e) => e.kind === 'item' && e.id === 'summary')
    expect(one).toMatchObject({ action: { kind: 'openThread', threadId: 'only' } })
    const two = trayMenuModel({ ...input('en'), unread: rows(2) }).find((e) => e.kind === 'item' && e.id === 'summary')
    expect(two).toMatchObject({ action: 'show' })
  })

  it('rebuilds when a title changes', () => {
    expect(trayMenuSignature({ ...input('en'), unread: [row('x', 'old')] })).not.toBe(trayMenuSignature({ ...input('en'), unread: [row('x', 'new')] }))
  })
})

describe('trayThreadLists (TODO 1303)', () => {
  const thread = (over: Partial<BadgeThread> = {}): BadgeThread => ({ unread: false, title: 'T', recency: 0, ...over })
  const approval = (threadId: string, requestedAt: number): ApprovalItem =>
    ({ id: `${threadId}-${requestedAt}`, threadId, threadTitle: 'old title', requestedAt }) as unknown as ApprovalItem

  it('puts a conversation in one list only (approval, then running, then unread) and orders by recency', () => {
    const threads = new Map<string, BadgeThread>([
      ['wait', thread({ title: 'W', unread: true })],
      ['run-old', thread({ title: 'R1', running: true, recency: 1 })],
      ['run-new', thread({ title: 'R2', running: true, recency: 9 })],
      ['read', thread({ title: 'U1', unread: true, recency: 5 })],
      ['quiet', thread()],
      ['both', thread({ title: 'B', unread: true, running: true, recency: 3 })]
    ])
    const lists = trayThreadLists(threads, [approval('wait', 20), approval('wait', 10)])
    expect(lists.approvals).toEqual([{ threadId: 'wait', title: 'W' }])
    expect(lists.running.map((r) => r.threadId)).toEqual(['run-new', 'both', 'run-old'])
    expect(lists.unread.map((r) => r.threadId)).toEqual(['read'])
  })

  it('gives a deleted conversation (not in the map) no row even when an approval is still queued', () => {
    expect(trayThreadLists(new Map(), [approval('gone', 1)]).approvals).toEqual([])
  })

  it('orders approvals by the time of the oldest request', () => {
    const threads = new Map<string, BadgeThread>([['a', thread({ title: 'A' })], ['b', thread({ title: 'B' })]])
    expect(trayThreadLists(threads, [approval('b', 5), approval('a', 9), approval('b', 1)]).approvals.map((r) => r.threadId)).toEqual(['b', 'a'])
  })
})

describe('recent folders and recent conversations (TODO 1301)', () => {
  const ids = (model: TrayMenuInput) => trayMenuModel(model).map((entry) => (entry.kind === 'separator' ? '---' : entry.id))

  it('puts the folders on top, then "Choose Folder…", and each folder starts a new conversation there', () => {
    const model = { ...input('en'), home: '/Users/me', folders: ['/Users/me/git/aios', '/Users/me/memo', '/Users/me'] }
    expect(ids(model).slice(0, 6)).toEqual(['folder:0', 'folder:1', 'folder:2', 'pickFolder', '---', 'show'])
    const items = trayMenuModel(model).flatMap((entry) => (entry.kind === 'item' ? [entry] : []))
    expect(items.find((e) => e.id === 'folder:0')).toMatchObject({ label: 'aios', action: { kind: 'newInFolder', path: '/Users/me/git/aios' } })
    expect(items.find((e) => e.id === 'folder:2')).toMatchObject({ label: '~' })
    expect(items.find((e) => e.id === 'pickFolder')).toMatchObject({ label: 'Choose Folder…', action: 'pickFolder' })
    expect(trayMenuModel({ ...model, locale: 'ja' }).some((e) => e.kind === 'item' && e.label === 'フォルダを選ぶ…')).toBe(true)
  })

  it('adds the parent name only to folders that share a name', () => {
    expect(folderLabels(['/a/work/app', '/a/play/app', '/a/other'], '/Users/me')).toEqual(['app (work)', 'app (play)', 'other'])
    expect(folderLabels(['/Users/me/app', '/x/app'], '/Users/me')).toEqual(['app (~)', 'app (x)'])
    expect(folderLabels(['/Users/me/proj/', '/'], '/Users/me')).toEqual(['proj', '/'])
  })

  it('lists at most 8 folders', () => {
    const folders = Array.from({ length: 12 }, (_, i) => `/p/f${i}`)
    expect(ids({ ...input('en'), folders }).filter((id) => id.startsWith('folder:'))).toHaveLength(8)
  })

  it('puts the 10 newest conversations in a submenu, and leaves it out when there are none', () => {
    expect(ids(input('en'))).not.toContain('recent')
    const entry = trayMenuModel({ ...input('en'), recent: rows(12, 'r') }).find((e) => e.kind === 'submenu')
    expect(entry).toMatchObject({ kind: 'submenu', id: 'recent', label: 'Recent Conversations' })
    if (entry?.kind !== 'submenu') throw new Error('expected a submenu')
    expect(entry.items).toHaveLength(10)
    expect(entry.items[0]).toMatchObject({ kind: 'item', label: 'r title 0', action: { kind: 'openThread', threadId: 'r0' } })
  })

  it('rebuilds when the folder list changes', () => {
    expect(trayMenuSignature({ ...input('en'), folders: ['/a'] })).not.toBe(trayMenuSignature({ ...input('en'), folders: ['/a', '/b'] }))
  })
})

describe('dictation row (TODO 1304)', () => {
  const ids = (model: TrayMenuInput) => trayMenuModel(model).map((entry) => (entry.kind === 'separator' ? '---' : entry.id))

  it('adds "New Thread with Dictation" right after "New Thread" only where dictation works', () => {
    expect(ids(input('en'))).not.toContain('dictate')
    const model = { ...input('en'), dictate: true }
    expect(ids(model).slice(2, 5)).toEqual(['show', 'newThread', 'dictate'])
    expect(trayMenuModel(model).find((e) => e.kind === 'item' && e.id === 'dictate')).toMatchObject({ label: 'New Thread with Dictation', enabled: true, action: 'dictate' })
    expect(trayMenuModel({ ...model, locale: 'ja' }).some((e) => e.kind === 'item' && e.label === '音声入力で新しい会話')).toBe(true)
  })

  it('rebuilds when dictation becomes available', () => {
    expect(trayMenuSignature(input('en'))).not.toBe(trayMenuSignature({ ...input('en'), dictate: true }))
  })
})

describe('upcoming scheduled runs (TODO 1305)', () => {
  const at = (h: number, m = 0, dayOffset = 0): number => new Date(2026, 10, 22 + dayOffset, h, m).getTime()
  const now = at(10)
  const job = (id: string, nextRunAt: number | null, over: Partial<{ enabled: boolean; kind: string }> = {}) => ({
    id, name: `job ${id}`, enabled: true, kind: 'prompt', nextRunAt, ...over
  })

  it('picks the nearest 3 of today\'s remaining runs, skipping disabled, timeless and plugin jobs', () => {
    const rows = selectUpcomingJobs(
      [job('d', at(18)), job('a', at(11)), job('off', at(12), { enabled: false }), job('none', null), job('plug', at(11, 30), { kind: 'plugin' }), job('b', at(13)), job('c', at(15)), job('tomorrow', at(9, 0, 1))],
      now
    )
    expect(rows.map((r) => r.jobId)).toEqual(['a', 'b', 'c'])
    expect(rows.every((r) => r.today)).toBe(true)
  })

  it('with nothing left today, picks only the next run, marked as not today', () => {
    const rows = selectUpcomingJobs([job('later', at(9, 0, 2)), job('next', at(8, 0, 1))], now)
    expect(rows).toEqual([{ jobId: 'next', name: 'job next', atMs: at(8, 0, 1), today: false }])
    expect(selectUpcomingJobs([], now)).toEqual([])
    expect(selectUpcomingJobs([job('past', at(8, 0, -1))], now)).toEqual([])
  })

  it('formats absolute times, with the date when it is not today', () => {
    expect(formatRunTime({ atMs: at(9, 5), today: true })).toBe('09:05')
    expect(formatRunTime({ atMs: at(15, 30, 1), today: false })).toBe('11/23 15:30')
  })

  it('adds a greyed heading and one row per run that opens the schedule screen; nothing when there are none', () => {
    const ids = (model: TrayMenuInput) => trayMenuModel(model).map((entry) => (entry.kind === 'separator' ? '---' : entry.id))
    expect(ids(input('en'))).not.toContain('scheduleHeader')
    const model = { ...input('en'), schedule: [{ jobId: 'x', name: 'Backup', atMs: at(15, 30), today: true }] }
    expect(ids(model).slice(-6)).toEqual(['pending', '---', 'scheduleHeader', 'schedule:x', '---', 'quit'])
    const items = trayMenuModel(model).flatMap((entry) => (entry.kind === 'item' ? [entry] : []))
    expect(items.find((e) => e.id === 'scheduleHeader')).toMatchObject({ label: 'Upcoming', enabled: false, action: null })
    expect(items.find((e) => e.id === 'schedule:x')).toMatchObject({ label: '15:30  Backup', enabled: true, action: { kind: 'openSchedule', jobId: 'x' } })
    expect(trayMenuModel({ ...model, locale: 'ja' }).some((e) => e.kind === 'item' && e.label === '次の予定')).toBe(true)
  })

  it('does not rebuild as time passes: the same rows give the same signature', () => {
    const model = { ...input('en'), schedule: [{ jobId: 'x', name: 'Backup', atMs: at(15, 30), today: true }] }
    expect(trayMenuSignature(model)).toBe(trayMenuSignature({ ...model }))
    expect(trayMenuSignature(model)).not.toBe(trayMenuSignature(input('en')))
  })
})

describe('recentThreadRows (TODO 1301)', () => {
  it('returns the newest first and cuts at the limit', () => {
    const threads = new Map<string, BadgeThread>([
      ['old', { unread: false, title: 'O', recency: 1 }],
      ['new', { unread: false, title: 'N', recency: 9 }],
      ['mid', { unread: true, title: 'M', recency: 5 }]
    ])
    expect(recentThreadRows(threads, 2)).toEqual([{ threadId: 'new', title: 'N' }, { threadId: 'mid', title: 'M' }])
  })
})

describe('MenuBarPreference (TODO 1269)', () => {
  it('defaults to ON (TODO 1301), keeps a stored OFF, and the AI entry is display', () => {
    expect(APP_MENU_BAR.parse(null)).toBe(true)
    expect(APP_MENU_BAR.parse('false')).toBe(false)
    expect(APP_MENU_BAR.parse('true')).toBe(true)
    expect(settingDefaults().menuBar).toBe(true)
    expect(agentSettingAccess(APP_MENU_BAR)).toBe('display')
  })

  it('remembers being turned on or off and calls onChange each time', () => {
    const settings = new MemorySettings()
    const changed = vi.fn()
    const preference = new MenuBarPreference(settings, changed, true)
    expect(preference.state()).toEqual({ enabled: true, supported: true })
    expect(preference.set(false)).toBe(false)
    expect(settings.values.get('app.menuBar')).toBe('false')
    expect(new MenuBarPreference(settings, changed, true).get()).toBe(false)
    changed.mockClear()
    expect(preference.set(true)).toBe(true)
    expect(settings.values.get('app.menuBar')).toBe('true')
    expect(preference.get()).toBe(true)
    preference.set(false)
    expect(preference.get()).toBe(false)
    expect(changed).toHaveBeenCalledTimes(2)
    // A new instance reads what was remembered.
    settings.writeTyped(APP_MENU_BAR, true)
    expect(new MenuBarPreference(settings, changed, true).get()).toBe(true)
  })

  it('does nothing on set and returns false even with a remembered value on an OS without a menu bar', () => {
    const settings = new MemorySettings()
    settings.writeTyped(APP_MENU_BAR, true)
    const changed = vi.fn()
    const preference = new MenuBarPreference(settings, changed, false)
    expect(preference.get()).toBe(false)
    expect(preference.set(true)).toBe(false)
    expect(changed).not.toHaveBeenCalled()
    expect(preference.state()).toEqual({ enabled: false, supported: false, reason: 'platform' })
  })

  it('is unsupported in a non-default userData (dev, verification builds, copies) even on macOS, and says why', () => {
    const settings = new MemorySettings()
    settings.writeTyped(APP_MENU_BAR, true)
    const changed = vi.fn()
    const preference = new MenuBarPreference(settings, changed, true, false)
    expect(preference.get()).toBe(false)
    expect(preference.set(true)).toBe(false)
    expect(changed).not.toHaveBeenCalled()
    expect(preference.state()).toEqual({ enabled: false, supported: false, reason: 'instance' })
  })
})

describe('user strings in menu labels (wave 98 review)', () => {
  it('doubles every ampersand so the menu shows it instead of eating it as an accelerator marker', () => {
    expect(menuLabelText('R&D')).toBe('R&&D')
    expect(menuLabelText('a & b && c')).toBe('a && b &&&& c')
    expect(menuLabelText('plain')).toBe('plain')
  })

  it('applies it to conversation titles, folder names and job names, not to the signature input', () => {
    const model: TrayMenuInput = {
      ...input('en'),
      running: [row('r', 'Q&A')],
      recent: [row('x', 'Tom & Jerry')],
      folders: ['/Users/me/R&D'],
      home: '/Users/me'
    }
    const labels = trayMenuModel(model).flatMap((entry) => (entry.kind === 'item' ? [entry.label] : entry.kind === 'separator' ? [] : entry.items.flatMap((i) => (i.kind === 'item' ? [i.label] : []))))
    expect(labels).toContain('Running: Q&&A')
    expect(labels).toContain('Tom && Jerry')
    expect(labels.some((l) => l.includes('R&&D'))).toBe(true)
    expect(trayMenuSignature(model)).toBe(trayMenuSignature({ ...model }))
  })
})
