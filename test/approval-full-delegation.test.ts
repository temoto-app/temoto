/**
 * TODO 1175: full-delegation mode (`ApprovalPolicy.fullDelegation`, ARCHITECTURE 4.2.1 "full-delegation mode"). **Neither the CLI nor the model is called.**
 *
 * What is pinned down:
 * - When ON, outbound operations (including publishing and sending), persistent writes, paths out of a conversation that read secrets, and tools with side effects pass without asking
 *   (the actor is `default` or `rule`), and the reason in the `approval.auto` log is `full-delegation`
 * - Even when ON, questions, requested plans, stop patterns, strict mode, and changes to gate settings (`settingsGate`) are still queued
 * - When OFF, all four are queued as before
 * - The key is `approval.fullDelegation` (default false, owned by main, `gated` from the AI's tools)
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalBroker, type ApprovalRequestInput, type ApprovalResult } from '../src/main/approval/broker.js'
import { log } from '../src/common/logger.js'
import { APPROVAL_FULL_DELEGATION, agentSettingAccess } from '../src/common/settings-keys.js'
import { asPolicyPatch } from '../src/main/ipc/handlers.js'
import type { JsonValue } from '../src/shared/agent.js'
import { DEFAULT_APPROVAL_POLICY, type ApprovalItem, type ApprovalPolicy } from '../src/shared/thread.js'

const question = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/ask-user-question.json'), 'utf8')) as {
  toolName: string
  input: JsonValue
}

const ON: ApprovalPolicy = { ...DEFAULT_APPROVAL_POLICY, fullDelegation: true }
const OFF: ApprovalPolicy = { ...DEFAULT_APPROVAL_POLICY, fullDelegation: false }

function makeBroker(policy: ApprovalPolicy): { broker: ApprovalBroker; queued: () => readonly ApprovalItem[] } {
  let last: readonly ApprovalItem[] = []
  const broker = new ApprovalBroker({ onChanged: (items) => (last = items), onDecided: () => undefined }, policy)
  return { broker, queued: () => last }
}

/** If it is decided immediately, the result; if queued, null (a queued request is left unresolved). */
async function settle(broker: ApprovalBroker, input: ApprovalRequestInput): Promise<ApprovalResult | null> {
  let result: ApprovalResult | null = null
  void broker.request(input).then((r) => (result = r))
  await Promise.resolve()
  await Promise.resolve()
  return result
}

const base = { threadId: 't1', threadTitle: 'T', summary: '' }

const pushRelease: ApprovalRequestInput = {
  ...base,
  toolName: 'Bash',
  input: { command: 'gh release create v1.0.0 --notes "x"' },
  outbound: { channel: 'shell', match: 'gh-release', to: null, subject: null, body: null, command: 'gh release create v1.0.0 --notes "x"' }
}
const sendMail: ApprovalRequestInput = {
  ...base,
  toolName: 'mcp__mail__send',
  input: { to: 'a@example.com' },
  outbound: { channel: 'tool', match: 'send', to: 'a@example.com', subject: 'Hi', body: 'Hello', command: null }
}
const persistence: ApprovalRequestInput = {
  ...base,
  toolName: 'Bash',
  input: { command: 'echo "export X=1" >> ~/.zshrc' },
  persistence: { match: 'shell-startup', target: '/Users/me/.zshrc' }
}
const secretEgress: ApprovalRequestInput = {
  ...base,
  toolName: 'WebFetch',
  input: { url: 'https://example.com' },
  secretRead: 'aws-credentials',
  egress: 'WebFetch'
}
const sideEffect: ApprovalRequestInput = {
  ...base,
  toolName: 'mcp__aios__pluginTool',
  input: { name: 'post' },
  alwaysAsk: true
}

const FOUR: readonly [string, ApprovalRequestInput, string][] = [
  ['outbound operation (publish: gh release create)', pushRelease, 'outbound'],
  ['outbound operation (send: mail)', sendMail, 'outbound'],
  ['persistence write', persistence, 'persistence'],
  ['path out in a conversation that read a secret', secretEgress, 'secret-read'],
  ['tool with side effects', sideEffect, 'side-effect']
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('full delegation mode ON (TODO 1175)', () => {
  it.each(FOUR)('%s passes without asking, and the log reason is full-delegation', async (_label, input) => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {})
    const { broker, queued } = makeBroker(ON)
    const result = await settle(broker, input)
    expect(result).not.toBeNull()
    expect(result?.allowed).toBe(true)
    expect(result?.by).toBe('default')
    expect(queued()).toHaveLength(0)
    const auto = info.mock.calls.filter(([event]) => event === 'approval.auto')
    expect(auto).toHaveLength(1)
    expect(auto[0]?.[1]).toMatchObject({ threadId: 't1', tool: input.toolName, reason: 'full-delegation' })
  })

  it('those matching a rule keep the actor as rule (reason is full-delegation)', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {})
    // Even outside the default allow list (autoAllowAll turned off), a rule on the tool name passes by the rule.
    const { broker } = makeBroker({ ...OFF, autoAllowAll: false, autoAllowTools: [] })
    // The rule is made with "always allow": queue a request that does not go outside, then allow-always. Turn full delegation ON only after the rule is made.
    void broker.request({ ...base, toolName: 'mcp__mail__send', input: {} })
    await Promise.resolve()
    const first = broker.list()[0]
    expect(first).toBeDefined()
    broker.decide(first!.id, { kind: 'allow-always' })
    broker.setPolicy({ ...ON, autoAllowAll: false, autoAllowTools: [] })
    const result = await settle(broker, sendMail)
    expect(result).toMatchObject({ allowed: true, by: 'rule' })
    expect(info.mock.calls.some(([event, fields]) => event === 'approval.auto' && (fields as { reason?: string }).reason === 'full-delegation')).toBe(true)
  })

  it('queues choice questions', async () => {
    const { broker, queued } = makeBroker(ON)
    expect(await settle(broker, { ...base, toolName: question.toolName, input: question.input })).toBeNull()
    expect(queued()[0]?.reason?.kind).toBe('question')
  })

  it('queues plans the user asked for', async () => {
    const { broker, queued } = makeBroker(ON)
    expect(
      await settle(broker, { ...base, toolName: 'ExitPlanMode', input: { plan: '# Plan' }, plan: '# Plan', planRequested: true })
    ).toBeNull()
    expect(queued()[0]?.reason?.kind).toBe('plan')
  })

  it('queues Bash matching a stop pattern (even for outbound operations)', async () => {
    const { broker, queued } = makeBroker({ ...ON, bashDenyPatterns: ['gh release'] })
    expect(await settle(broker, pushRelease)).toBeNull()
    expect(queued()).toHaveLength(1)
    // Bash that is not an outbound operation is the same.
    const plain = makeBroker({ ...ON, bashDenyPatterns: ['rm -rf'] })
    expect(await settle(plain.broker, { ...base, toolName: 'Bash', input: { command: 'rm -rf build' } })).toBeNull()
    expect(plain.queued()[0]?.reason).toEqual({ kind: 'deny-pattern', pattern: 'rm -rf' })
  })

  it('queues all four in a strict-mode thread', async () => {
    for (const [, input] of FOUR) {
      const { broker, queued } = makeBroker(ON)
      expect(await settle(broker, { ...input, strict: true })).toBeNull()
      expect(queued()).toHaveLength(1)
    }
  })

  it("queues requests that change aios's own gate settings (settingsGate)", async () => {
    const { broker, queued } = makeBroker(ON)
    expect(
      await settle(broker, {
        ...base,
        toolName: 'mcp__aios__setSetting',
        input: { name: 'bashDenyPatterns', value: [] },
        alwaysAsk: true,
        settingsGate: true
      })
    ).toBeNull()
    expect(queued()[0]?.reason?.kind).toBe('side-effect')
  })

  it('does not ask for tools outside the default allow-list even with autoAllowAll off (full delegation implies autoAllowAll)', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {})
    const { broker, queued } = makeBroker({ ...ON, autoAllowAll: false, autoAllowTools: [] })
    const result = await settle(broker, sendMail)
    expect(result).toMatchObject({ allowed: true, by: 'default' })
    expect(queued()).toHaveLength(0)
    const plain = await settle(broker, { ...base, toolName: 'mcp__other__tool', input: {} })
    expect(plain).toMatchObject({ allowed: true })
    expect(info.mock.calls.some(([event, fields]) => event === 'approval.auto' && (fields as { reason?: string }).reason === 'full-delegation')).toBe(true)
  })

  it('queues stop patterns even with autoAllowAll off', async () => {
    const { broker, queued } = makeBroker({ ...ON, autoAllowAll: false, autoAllowTools: [], bashDenyPatterns: ['rm -rf'] })
    expect(await settle(broker, { ...base, toolName: 'Bash', input: { command: 'rm -rf /tmp/x' } })).toBeNull()
    expect(queued()[0]?.reason?.kind).toBe('deny-pattern')
  })

  it('with full delegation OFF and autoAllowAll off, queues anything outside the default allow-list', async () => {
    const { broker, queued } = makeBroker({ ...OFF, autoAllowAll: false, autoAllowTools: [] })
    expect(await settle(broker, { ...base, toolName: 'mcp__other__tool', input: {} })).toBeNull()
    expect(queued()[0]?.reason?.kind).toBe('not-default')
  })
})

describe('full delegation mode OFF (TODO 1175)', () => {
  it.each(FOUR)('%s is queued as before', async (_label, input, kind) => {
    const { broker, queued } = makeBroker(OFF)
    expect(await settle(broker, input)).toBeNull()
    expect(queued()[0]?.reason?.kind).toBe(kind)
  })

  it('a missing field (old-shape policy) is OFF too', async () => {
    const { broker } = makeBroker({ autoAllowAll: true, autoAllowTools: [], bashDenyPatterns: [] })
    expect(await settle(broker, sendMail)).toBeNull()
  })

  it('switching from ON back to OFF with setPolicy asks from the next request', async () => {
    const { broker } = makeBroker(ON)
    expect((await settle(broker, sideEffect))?.allowed).toBe(true)
    broker.setPolicy(OFF)
    expect(await settle(broker, sideEffect)).toBeNull()
  })
})

describe('keys and paths (TODO 1175)', () => {
  it("approval.fullDelegation defaults to false, reads only booleans, and is gated from the AI's tools", () => {
    expect(APPROVAL_FULL_DELEGATION.key).toBe('approval.fullDelegation')
    expect(APPROVAL_FULL_DELEGATION.owner).toBe('main')
    expect(APPROVAL_FULL_DELEGATION.parse(null)).toBe(false)
    expect(APPROVAL_FULL_DELEGATION.parse('true')).toBe(true)
    expect(APPROVAL_FULL_DELEGATION.parse('"yes"')).toBe(false)
    expect(APPROVAL_FULL_DELEGATION.parse('{broken')).toBe(false)
    expect(agentSettingAccess(APPROVAL_FULL_DELEGATION)).toBe('gated')
    expect(DEFAULT_APPROVAL_POLICY.fullDelegation).toBe(false)
  })

  it('passes only booleans from the renderer', () => {
    expect(asPolicyPatch({ fullDelegation: true })).toEqual({ fullDelegation: true })
    expect(asPolicyPatch({ fullDelegation: 'true' })).toEqual({})
  })
})
