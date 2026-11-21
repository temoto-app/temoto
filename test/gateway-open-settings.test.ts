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

describe('gateway の openSettings (GatewayRequests)', () => {
  it('表にある名前なら、その会話を出している窓のうち 1 窓だけに設定の指示を届ける (承認箱には積まない)', async () => {
    const { requests, sent, approvals } = gateway([3, 7])
    const result = await requests.handle({ sessionId: 's1', kind: OPEN_SETTINGS_TOOL, payload: { name: 'bashDenyPatterns' } })
    expect(result).toEqual({ opened: true, name: 'bashDenyPatterns', windows: 1 })
    expect(sent).toEqual([
      [3, { kind: 'settings', threadId: 't1', name: 'bashDenyPatterns' }]
    ])
    expect(approvals).toEqual([])
  })

  it('表に無い名前・文字列でない名前・内部の鍵は断り、窓へは何も送らない', async () => {
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

  it('その会話を出している窓が無ければ、開けなかったと返す', async () => {
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

  it('知らないセッションは断る', async () => {
    const { requests } = gateway([3])
    await expect(requests.handle({ sessionId: 'zz', kind: OPEN_SETTINGS_TOOL, payload: { name: 'theme' } })).rejects.toThrow(
      'unknown session'
    )
  })
})

describe('設定名と設定エディタの欄', () => {
  it('checkSettingName は道具の名前の集合と同じ', () => {
    for (const name of AGENT_SETTING_NAMES) expect(checkSettingName(name)).toEqual({ ok: true, value: name })
    expect(checkSettingName('nope').ok).toBe(false)
  })

  it('どの設定名にも、それを value (歯車なしの欄は id) に持つ設定エディタの欄がちょうど 1 つある。欄の無い名前は隠しファイルと束の数だけ (renderer が寄せる先)', () => {
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
