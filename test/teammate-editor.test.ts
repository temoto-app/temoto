// @vitest-environment jsdom
/**
 * The Teammate editor: "New conversation" creates one conversation even when pressed repeatedly, and the counts use the EN singular.
 * Neither a model nor Electron is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Role } from '../src/shared/role.js'
import { translate } from '../src/renderer/src/i18n/index.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('TeammateEditor', () => {
  let root: Root
  let host: HTMLDivElement
  const role: Role = {
    id: 'ra',
    name: 'Secretary',
    cwdUri: null,
    instructions: '',
    modelId: null,
    thinking: null,
    createdAt: 0,
    updatedAt: 0
  }

  beforeEach(async () => {
    localStorage.clear()
    ;(window as unknown as { aios: unknown }).aios = {
      threads: { createOptions: async () => ({ backends: [], defaultBackend: '', cwdHistory: [] }) },
      roles: { remove: async () => [] },
      // TODO 983 stage 4: the editor of an existing Teammate shows its grant table.
      approvals: { roleGrants: async () => [], onChanged: () => () => undefined }
    }
    const { useRoles, resetRolesForTest } = await import('../src/renderer/src/roleStore.js')
    resetRolesForTest()
    useRoles.getState().setRoles([role])
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('pressing "New conversation" repeatedly while one is being created makes only one', async () => {
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    let release: (ok: boolean) => void = () => undefined
    const create = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)))
    useThreads.setState({ createThreadInRole: create, threadOrder: [], threadsById: {} } as never)
    const { TeammateEditor } = await import('../src/renderer/src/components/TeammateEditor.js')
    await act(async () => root.render(createElement(TeammateEditor, { roleId: 'ra' })))
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === translate('en', 'roles.newThread'))!
    expect(button).toBeDefined()
    act(() => button.click())
    act(() => button.click())
    expect(create).toHaveBeenCalledTimes(1)
    expect(button.disabled).toBe(true)
    await act(async () => release(true))
    expect(button.disabled).toBe(false)
    act(() => button.click())
    expect(create).toHaveBeenCalledTimes(2)
    await act(async () => release(true))
  })

  it('983 stage 4: the strict toggle is OFF by default and saved with the role; the table of what this Teammate is allowed lists role:<id>', async () => {
    const update = vi.fn(async () => [role])
    const roleGrants = vi.fn(async () => [
      {
        id: 'g1',
        toolName: 'Bash',
        kind: 'command-prefix' as const,
        value: 'docker build',
        scope: 'forever' as const,
        expiresAt: null,
        threadTitle: null,
        createdAt: 0,
        lastUsedAt: null,
        useCount: 0
      }
    ])
    const removeRoleGrant = vi.fn(async () => true)
    const aios = (window as unknown as { aios: Record<string, unknown> }).aios
    aios['roles'] = { remove: async () => [], update }
    aios['approvals'] = { roleGrants, removeRoleGrant, onChanged: () => () => undefined }
    const { TeammateEditor } = await import('../src/renderer/src/components/TeammateEditor.js')
    await act(async () => root.render(createElement(TeammateEditor, { roleId: 'ra' })))
    const strict = [...host.querySelectorAll<HTMLLabelElement>('label.schedule-check')].find((label) =>
      label.textContent?.includes(translate('en', 'roles.field.strict'))
    )
    const box = strict?.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(box?.checked).toBe(false)
    act(() => box?.click())
    await act(async () => host.querySelector<HTMLFormElement>('form')?.requestSubmit())
    expect(update).toHaveBeenCalledWith('ra', expect.objectContaining({ approvalStrict: true }))
    expect(roleGrants).toHaveBeenCalledWith('role:ra')
    expect(host.textContent).toContain(translate('en', 'roleGrants.titleTeammate'))
    const cross = host.querySelector<HTMLButtonElement>('.role-grants button')
    await act(async () => cross?.click())
    expect(removeRoleGrant).toHaveBeenCalledWith('role:ra', 'g1')
  })
})

describe('TeammateEditor standing instructions note (TODO 1288)', () => {
  let root: Root
  let host: HTMLDivElement
  beforeEach(() => {
    localStorage.clear()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })
  const open = async (standingInstructions: boolean | undefined): Promise<string> => {
    const backend = { id: 'b', label: 'B', available: true, modelSelect: false, thinkingLevel: false, models: [], ...(standingInstructions === undefined ? {} : { standingInstructions }) }
    ;(window as unknown as { aios: unknown }).aios = {
      threads: { createOptions: async () => ({ backends: [backend], defaultBackend: 'b', cwdHistory: [] }) },
      roles: { remove: async () => [] }
    }
    const { useRoles, resetRolesForTest } = await import('../src/renderer/src/roleStore.js')
    resetRolesForTest()
    useRoles.getState().setRoles([])
    const { TeammateEditor } = await import('../src/renderer/src/components/TeammateEditor.js')
    await act(async () => root.render(createElement(TeammateEditor, { roleId: null })))
    await act(async () => undefined)
    return host.textContent ?? ''
  }

  it('says the instructions are ignored when the default backend cannot take them', async () => {
    expect(await open(false)).toContain(translate('en', 'roles.field.instructionsIgnored'))
  })

  it('says nothing when the default backend takes them or it is not known', async () => {
    expect(await open(true)).not.toContain(translate('en', 'roles.field.instructionsIgnored'))
    expect(await open(undefined)).not.toContain(translate('en', 'roles.field.instructionsIgnored'))
  })
})

describe('roles counts (EN singular)', () => {
  it('uses the singular for 1 and the plural otherwise; JA keeps the same keys', () => {
    expect(translate('en', 'roles.conversations.one', { count: 1 })).toBe('1 conversation')
    expect(translate('en', 'roles.conversations.other', { count: 2 })).toBe('2 conversations')
    expect(translate('en', 'roles.jobs.one', { count: 1 })).toBe('1 scheduled run')
    expect(translate('en', 'roles.jobs.other', { count: 0 })).toBe('0 scheduled runs')
    expect(translate('ja', 'roles.conversations.one', { count: 1 })).toBe('会話 1 件')
    expect(translate('ja', 'roles.jobs.other', { count: 3 })).toBe('定期実行 3 件')
  })
})
