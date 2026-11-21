/**
 * TODO 1060 stage 2 (wave 60 bundle D, ARCHITECTURE 7.6.8): the gateway's `openSettings {name}`.
 *
 *  - The name is checked against the same table as `getSettings` / `setSetting`; a name not in the table, or a value that is not a string, is refused (nothing is sent to a window)
 *  - If it passes, only the window showing that conversation receives `{ kind: 'settings', threadId, name }`. It is not put in the approval inbox
 *  - If no window shows that conversation, it returns that it could not be opened
 *  - Setting names correspond 1:1 to the settings editor's fields (the `value` of `SETTINGS_ITEMS`), so the renderer can move to the field
 *
 * Uses neither the model nor Electron.
 */
import { describe, expect, it } from 'vitest'
import { AGENT_SETTING_NAMES, checkSettingName } from '../src/main/agent-settings.js'
import { GatewayRequests, OPEN_SETTINGS_TOOL, type GatewayRequestHost } from '../src/main/session/gateway-requests.js'
import type { ApprovalRequestInput } from '../src/main/approval/broker.js'
import { SETTINGS_ITEMS } from '../src/renderer/src/settings-model.js'
import type { Thread, ViewerCommand } from '../src/shared/thread.js'

function thread(): Thread {
  return { id: 't1', title: 'T', backend: 'x', cwdUri: 'file:///tmp', worktreeUri: null, approvalStrict: false } as unknown as Thread
}

function gateway(views: readonly number[]): {
  requests: GatewayRequests
  sent: [number, ViewerCommand][]
  approvals: ApprovalRequestInput[]
} {
  const sent: [number, ViewerCommand][] = []
  const approvals: ApprovalRequestInput[] = []
  const host: Partial<GatewayRequestHost> = {
    isStopped: () => false,
    threadIdForSession: (sessionId) => (sessionId === 's1' ? 't1' : undefined),
    getThread: () => thread(),
    getLive: () => undefined,
    viewsOf: (threadId) => (threadId === 't1' ? views : []),
    // Instead of "the front window → the first", the test picks the first window.
    primaryViewOf: (threadId) => (threadId === 't1' ? (views[0] ?? null) : null),
    onViewerCommand: (viewId, command) => {
      sent.push([viewId, command])
    },
    requestApproval: async (input) => {
      approvals.push(input)
      return { allowed: true, by: 'user', message: '' }
    }
  }
  return { requests: new GatewayRequests(host as GatewayRequestHost), sent, approvals }
}

describe('gateway openSettings (GatewayRequests)', () => {
  it('for a name in the table, delivers the settings instruction to only one of the windows showing that conversation (does not queue it in the approval inbox)', async () => {
    const { requests, sent, approvals } = gateway([3, 7])
    const result = await requests.handle({ sessionId: 's1', kind: OPEN_SETTINGS_TOOL, payload: { name: 'bashDenyPatterns' } })
    expect(result).toEqual({ opened: true, name: 'bashDenyPatterns', windows: 1 })
    expect(sent).toEqual([
      [3, { kind: 'settings', threadId: 't1', name: 'bashDenyPatterns' }]
    ])
    expect(approvals).toEqual([])
  })

  it('names not in the table, non-string names and internal keys are refused and nothing is sent to windows', async () => {
    const { requests, sent } = gateway([3])
    for (const name of ['nope', 'webTabReadConsent', 'ui.theme', 42, undefined, '__proto__', 'toString']) {
      const result = (await requests.handle({ sessionId: 's1', kind: OPEN_SETTINGS_TOOL, payload: { name } })) as {
        opened?: boolean
        error?: string
      }
      expect(result.opened, String(name)).toBe(false)
      expect(result.error).toContain('unknown setting')
    }
    expect(sent).toEqual([])
  })

  it('when no window shows that conversation, returns that it could not open', async () => {
    const { requests, sent } = gateway([])
    const result = (await requests.handle({ sessionId: 's1', kind: OPEN_SETTINGS_TOOL, payload: { name: 'theme' } })) as {
      opened: boolean
      windows: number
      error?: string
    }
    expect(result).toMatchObject({ opened: false, windows: 0 })
    expect(result.error).toBeDefined()
    expect(sent).toEqual([])
  })

  it('refuses an unknown session', async () => {
    const { requests } = gateway([3])
    await expect(requests.handle({ sessionId: 'zz', kind: OPEN_SETTINGS_TOOL, payload: { name: 'theme' } })).rejects.toThrow(
      'unknown session'
    )
  })
})

describe('setting names and settings editor fields', () => {
  it('checkSettingName is the same as the set of tool names', () => {
    for (const name of AGENT_SETTING_NAMES) expect(checkSettingName(name)).toEqual({ ok: true, value: name })
    expect(checkSettingName('nope').ok).toBe(false)
  })

  it('every setting name has exactly one settings editor field holding it as value (id for a field without a gear); names without a field are only the hidden file and the number of bundles (where the renderer redirects)', () => {
    const withoutItem: string[] = []
    for (const name of AGENT_SETTING_NAMES) {
      const byValue = SETTINGS_ITEMS.filter((item) => item.value === name)
      const found = byValue.length > 0 ? byValue : SETTINGS_ITEMS.filter((item) => item.id === name)
      if (found.length === 0) withoutItem.push(name)
      else expect(found, name).toHaveLength(1)
    }
    expect(withoutItem.sort()).toEqual(['bundleMax', 'hiddenFiles'])
  })
})
