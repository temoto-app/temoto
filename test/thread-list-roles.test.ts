// @vitest-environment jsdom
/**
 * TODO 972 (ARCHITECTURE 4.3.4): the thread list folds the conversations of a role (shown as a "Teammate") under its heading.
 *
 * - `arrangeRoleGroups`: groups in order of their newest conversation, empty roles after them (not while filtering), recent order inside,
 *   a folded heading keeps only the selected row, and carries the strongest mark of its rows
 * - `roleCreateInput`: "New conversation" sends the role id and concrete Model / Thinking, no folder
 * - `ThreadList`: the heading is above the ordinary rows, the role's rows are indented, conversations without a role are unchanged,
 *   and the chevron folds / unfolds (remembered per window)
 *
 * Neither a model nor Electron is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ThreadSummary } from '../src/shared/thread.js'
import type { Role } from '../src/shared/role.js'
import { arrangeRoleGroups } from '../src/renderer/src/thread-sort.js'
import { roleCreateInput } from '../src/renderer/src/thread-list-heading.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roleA = { id: 'ra', name: 'Secretary' }
const roleB = { id: 'rb', name: 'Accountant' }
const roleC = { id: 'rc', name: 'Empty' }

describe('arrangeRoleGroups (TODO 972)', () => {
  const rows = [
    { id: 't1', roleId: 'rb', attention: 0 as const },
    { id: 't2', roleId: 'ra', attention: 1 as const },
    { id: 't3', roleId: 'rb', attention: 2 as const }
  ]

  it('orders groups by their newest conversation, keeps recent order inside, and puts empty roles last', () => {
    const items = arrangeRoleGroups([roleA, roleB, roleC], rows, new Set(), null)
    expect(items.map((item) => (item.kind === 'role' ? `role:${item.key}:${item.count}` : item.kind === 'thread' ? item.id : item.kind))).toEqual([
      'role:rb:2',
      't1',
      't3',
      'role:ra:1',
      't2',
      'role:rc:0'
    ])
    expect(items.filter((item) => item.kind === 'thread').every((item) => item.kind === 'thread' && item.inRole === true)).toBe(true)
  })

  it('while filtering (includeEmpty false) a role without a matching conversation is left out', () => {
    const items = arrangeRoleGroups([roleA, roleB, roleC], rows.slice(0, 1), new Set(), null, false)
    expect(items.filter((item) => item.kind === 'role').map((item) => (item.kind === 'role' ? item.key : ''))).toEqual(['rb'])
  })

  it('a folded heading keeps only the selected row and carries the strongest mark', () => {
    const items = arrangeRoleGroups([roleA, roleB], rows, new Set(['rb']), 't3')
    const heading = items.find((item) => item.kind === 'role' && item.key === 'rb')
    expect(heading).toMatchObject({ collapsed: true, attention: 2, count: 2 })
    expect(items.filter((item) => item.kind === 'thread').map((item) => (item.kind === 'thread' ? item.id : ''))).toEqual([
      't3',
      't2'
    ])
  })
})

describe('roleCreateInput (TODO 972)', () => {
  const backend = {
    id: 'fake',
    modelSelect: true,
    thinkingLevel: true,
    models: [
      { id: 'model-a', label: 'A' },
      { id: 'model-b', label: 'B' }
    ]
  } as never

  it("sends the role id and concrete values: the role's choice, then the settings' default; no folder", () => {
    expect(roleCreateInput({ id: 'ra', modelId: 'model-b', thinking: 'high' }, backend, null)).toEqual({
      roleId: 'ra',
      backend: 'fake',
      modelId: 'model-b',
      thinking: 'high'
    })
    const fallback = roleCreateInput({ id: 'ra', modelId: null, thinking: null }, backend, {
      defaultModelId: 'model-a',
      defaultThinking: 'low'
    })
    expect(fallback).toEqual({ roleId: 'ra', backend: 'fake', modelId: 'model-a', thinking: 'low' })
    expect('cwdUri' in fallback || 'scratch' in fallback).toBe(false)
  })

  it("wave 96 fix Y: a role's Model that left the list is replaced by the settings' default (an unloaded list keeps it for main to judge)", () => {
    const settings = { defaultModelId: 'model-a', defaultThinking: 'low' as const }
    expect(roleCreateInput({ id: 'ra', modelId: 'model-gone', thinking: 'high' }, backend, settings)).toEqual({
      roleId: 'ra',
      backend: 'fake',
      modelId: 'model-a',
      thinking: 'high'
    })
    const unloaded = { id: 'fake', modelSelect: true, thinkingLevel: true, models: [] } as never
    expect(roleCreateInput({ id: 'ra', modelId: 'model-gone', thinking: null }, unloaded, settings).modelId).toBe('model-gone')
  })
})

describe('ThreadList with roles (TODO 972)', () => {
  let root: Root
  let host: HTMLDivElement
  const now = Date.now()
  const summaryOf = (id: string, roleId?: string): ThreadSummary =>
    ({
      thread: {
        id,
        title: `title ${id}`,
        cwdName: 'aios',
        cwdUri: 'file:///Users/me/git/aios',
        forkedFrom: null,
        rainbow: null,
        unread: false,
        createdAt: now,
        updatedAt: now,
        lastEventAt: now,
        ...(roleId === undefined ? {} : { roleId })
      },
      runtime: { state: 'idle', pendingApprovals: 0, subtasks: [] },
      preview: null
    }) as unknown as ThreadSummary
  const role = (id: string, name: string): Role => ({
    id,
    name,
    cwdUri: null,
    instructions: '',
    modelId: null,
    thinking: null,
    createdAt: 0,
    updatedAt: 0
  })

  beforeEach(async () => {
    localStorage.clear()
    ;(window as unknown as { aios: unknown }).aios = { threads: { listDeleted: async () => [] } }
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    useThreads.setState({
      selectThread: vi.fn(async () => undefined),
      threadOrder: ['t1', 't2', 't3'],
      threadsById: { t1: summaryOf('t1', 'ra'), t2: summaryOf('t2'), t3: summaryOf('t3', 'ra') },
      activeThreadId: null
    } as never)
    const { useRoles, resetRolesForTest } = await import('../src/renderer/src/roleStore.js')
    resetRolesForTest()
    useRoles.getState().setRoles([role('ra', 'Secretary'), role('rb', 'Accountant')])
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const shape = (): string[] =>
    [...host.querySelectorAll('.thread-role, .thread-row')].map((el) =>
      el.classList.contains('thread-role')
        ? `role:${el.querySelector('.thread-role-name')?.textContent ?? ''}`
        : `${el.classList.contains('grouped') ? '  ' : ''}${el.querySelector('.thread-row-title')?.textContent ?? ''}`
    )

  it('puts the role headings above the ordinary rows, indents the role rows, and shows an empty role', async () => {
    const { ThreadList } = await import('../src/renderer/src/components/ThreadList.js')
    await act(async () => root.render(createElement(ThreadList)))
    expect(shape()).toEqual(['role:Secretary', '  title t1', '  title t3', 'role:Accountant', 'title t2'])
    // The ordinary row keeps its first line (the cwd name); a role row does not (it is drawn like a cwd-group row).
    const rows = [...host.querySelectorAll('.thread-row')]
    expect(rows[2]?.querySelector('.thread-row-cwd')?.textContent).toBe('aios')
    expect(rows[0]?.querySelector('.thread-row-cwd')).toBeNull()
  })

  it('the chevron folds and unfolds the role, and the state is remembered in localStorage', async () => {
    const { ThreadList } = await import('../src/renderer/src/components/ThreadList.js')
    await act(async () => root.render(createElement(ThreadList)))
    const toggle = host.querySelector<HTMLButtonElement>('.thread-role[data-role-key="ra"] .thread-role-toggle')!
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    act(() => toggle.click())
    expect(shape()).toEqual(['role:Secretary', 'role:Accountant', 'title t2'])
    expect(JSON.parse(localStorage.getItem('aios.roleCollapsed') ?? '[]')).toEqual(['ra'])
    act(() => host.querySelector<HTMLButtonElement>('.thread-role[data-role-key="ra"] .thread-role-toggle')!.click())
    expect(shape()).toEqual(['role:Secretary', '  title t1', '  title t3', 'role:Accountant', 'title t2'])
  })

  it('while filtering, a folded role heading is unfolded so that a match is not hidden', async () => {
    const { useRoles } = await import('../src/renderer/src/roleStore.js')
    const { useThreadFilter } = await import('../src/renderer/src/threadFilterStore.js')
    const { ThreadList } = await import('../src/renderer/src/components/ThreadList.js')
    useRoles.getState().toggleCollapsed('ra')
    await act(async () => root.render(createElement(ThreadList)))
    expect(shape()).toEqual(['role:Secretary', 'role:Accountant', 'title t2'])
    await act(async () => useThreadFilter.getState().setQuery('aios'))
    expect(shape()).toEqual(['role:Secretary', '  title t1', '  title t3', 'title t2'])
    await act(async () => useThreadFilter.getState().setQuery(''))
    expect(shape()).toEqual(['role:Secretary', 'role:Accountant', 'title t2'])
  })

  it('TODO 1288: the filter also matches the name of the Teammate and keeps all of its conversations', async () => {
    const { useThreadFilter } = await import('../src/renderer/src/threadFilterStore.js')
    const { ThreadList } = await import('../src/renderer/src/components/ThreadList.js')
    await act(async () => root.render(createElement(ThreadList)))
    await act(async () => useThreadFilter.getState().setQuery('secre'))
    expect(shape()).toEqual(['role:Secretary', '  title t1', '  title t3'])
    // A name that matches neither the folder nor a Teammate leaves nothing.
    await act(async () => useThreadFilter.getState().setQuery('nomatch'))
    expect(shape()).toEqual([])
    await act(async () => useThreadFilter.getState().setQuery(''))
  })

  it('TODO 1288: a conversation moved under a Teammate jumps below its heading by the usual list update, and a context menu row calls moveThread', async () => {
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const { ThreadList } = await import('../src/renderer/src/components/ThreadList.js')
    const moveThread = vi.fn(async () => undefined)
    ;(window as unknown as { aios: unknown }).aios = { threads: { listDeleted: async () => [] }, roles: { moveThread } }
    await act(async () => root.render(createElement(ThreadList)))
    const plainRow = [...host.querySelectorAll<HTMLElement>('.thread-row')].find((el) => el.textContent?.includes('title t2'))!
    await act(async () => {
      plainRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))
    })
    const labels = [...document.querySelectorAll('.context-menu [role="menuitem"], .context-menu button')].map((el) => el.textContent ?? '')
    expect(labels.some((label) => label.includes('Move to Teammate: Accountant'))).toBe(true)
    expect(labels.some((label) => label.includes('Remove from Teammate'))).toBe(false)
    const item = [...document.querySelectorAll<HTMLElement>('.context-menu [role="menuitem"], .context-menu button')].find((el) =>
      el.textContent?.includes('Move to Teammate: Accountant')
    )!
    await act(async () => item.click())
    expect(moveThread).toHaveBeenCalledWith('t2', 'rb')
    // main pushes the list again with the new row: the conversation now sits under its heading.
    await act(async () => useThreads.setState({ threadsById: { ...useThreads.getState().threadsById, t2: summaryOf('t2', 'rb') } }))
    expect(shape()).toEqual(['role:Secretary', '  title t1', '  title t3', 'role:Accountant', '  title t2'])
  })

  it('with no roles at all the list is exactly the ordinary one (a stale roleId is an ordinary row)', async () => {
    const { useRoles } = await import('../src/renderer/src/roleStore.js')
    useRoles.getState().setRoles([])
    const { ThreadList } = await import('../src/renderer/src/components/ThreadList.js')
    await act(async () => root.render(createElement(ThreadList)))
    expect(shape()).toEqual(['title t1', 'title t2', 'title t3'])
  })
})

describe('teammateMenuItems (TODO 1288)', () => {
  const roles = [
    { id: 'ra', name: 'Secretary' },
    { id: 'rb', name: 'Accountant' }
  ] as unknown as readonly Role[]
  const t = ((key: string, params?: Record<string, string>) => `${key}${params?.['name'] === undefined ? '' : `:${params['name']}`}`) as never
  const summary = (thread: Record<string, unknown>, state = 'idle'): ThreadSummary =>
    ({ thread: { id: 't', ...thread }, runtime: { state, pendingApprovals: 0, subtasks: [] } }) as unknown as ThreadSummary

  it('offers every other Teammate, and "remove" only when the conversation has one', async () => {
    const { teammateMenuItems } = await import('../src/renderer/src/components/ThreadList.js')
    const plain = teammateMenuItems(summary({}), roles, t, () => undefined)
    expect(plain.map((item) => item.key)).toEqual(['move-role-ra', 'move-role-rb'])
    const inRole = teammateMenuItems(summary({ roleId: 'ra' }), roles, t, () => undefined)
    expect(inRole.map((item) => item.key)).toEqual(['move-role-rb', 'move-out'])
    expect(teammateMenuItems(summary({}), [], t, () => undefined)).toEqual([])
  })

  it('grays the rows while running and for a conversation started by a scheduled job or a trigger', async () => {
    const { teammateMenuItems } = await import('../src/renderer/src/components/ThreadList.js')
    expect(teammateMenuItems(summary({}, 'running'), roles, t, () => undefined).every((item) => item.disabled === true)).toBe(true)
    expect(teammateMenuItems(summary({ scheduledJobId: 'j' }), roles, t, () => undefined).every((item) => item.disabled === true)).toBe(true)
    expect(teammateMenuItems(summary({ triggerOrigin: {} }), roles, t, () => undefined).every((item) => item.disabled === true)).toBe(true)
    expect(teammateMenuItems(summary({}), roles, t, () => undefined).some((item) => item.disabled === true)).toBe(false)
  })

  it('selecting calls back with the role id, or null for "remove"', async () => {
    const { teammateMenuItems } = await import('../src/renderer/src/components/ThreadList.js')
    const move = vi.fn()
    const items = teammateMenuItems(summary({ roleId: 'ra' }), roles, t, move)
    items[0]!.onSelect()
    items[1]!.onSelect()
    expect(move.mock.calls).toEqual([['rb'], [null]])
  })
})
