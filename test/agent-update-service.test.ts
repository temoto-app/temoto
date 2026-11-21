/**
 * TODO 774 (wave 36 bundle D): the body of the backend's own update (`src/main/agent-update/service.ts`).
 *
 * The backend's entry point (`AgentSelfUpdate`) is a fake. The clock and the ticks are also fake, and `tick()` is called by hand.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AgentUpdateService,
  FIRST_RUN_DELAY_MS,
  HOLD_TTL_MS,
  RETRY_BASE_MS,
  RUN_INTERVAL_MS,
  UPDATE_WAIT_CAP_MS,
  detectAgentUpdateUnsupported,
  verificationFailed,
  type AgentUpdateServiceDeps
} from '../src/main/agent-update/service.js'
import {
  AGENT_UPDATE_AUTO,
  AGENT_UPDATE_HELD_AT,
  AGENT_UPDATE_HELD_FROM,
  AGENT_UPDATE_LAST,
  type SettingKey
} from '../src/common/settings-keys.js'
import type { AgentSelfUpdate, AgentSelfUpdateRun } from '../src/main/session/types.js'
import type { AgentStatus, AgentFeatureMap } from '../src/shared/agent.js'
import type { AgentUpdateStatus } from '../src/shared/agent-update.js'
import { formatReason } from '../src/shared/reason.js'

function memorySettings(initial: Record<string, string> = {}) {
  const raw = new Map<string, string>(Object.entries(initial))
  return {
    raw,
    readTyped<T>(def: SettingKey<T>): T {
      return def.parse(raw.get(def.key) ?? null)
    },
    writeTyped<T>(def: SettingKey<T>, value: T): void {
      raw.set(def.key, def.serialize(value))
    }
  }
}

function agentStatus(patch: Partial<AgentStatus> = {}): AgentStatus {
  return {
    available: true,
    version: '2.1.300',
    loggedIn: true,
    authMethod: null,
    subscriptionType: null,
    features: {} as AgentFeatureMap,
    degradations: [],
    source: 'probe',
    needsProbe: true,
    checkedAt: 0,
    message: null,
    messageCode: null,
    ...patch
  }
}

function harness(
  opts: {
    run?: AgentSelfUpdateRun
    settings?: Record<string, string>
    blocker?: string | null
    unsupported?: AgentUpdateServiceDeps['unsupportedReason']
    autoBlocked?: boolean
  } = {}
) {
  let now = 1_000_000
  const settings = memorySettings(opts.settings)
  const update = vi.fn(
    async (): Promise<AgentSelfUpdateRun> =>
      opts.run ?? { outcome: 'updated', before: '2.1.296', after: '2.1.300' }
  )
  const install = vi.fn(
    async (version: string): Promise<AgentSelfUpdateRun> => ({ outcome: 'updated', before: '2.1.300', after: version })
  )
  const backend: AgentSelfUpdate = {
    autoBlockedByBackend: () => opts.autoBlocked ?? false,
    currentVersion: async () => '2.1.296',
    isKnownVersion: (version) => version === '2.1.296',
    update,
    install
  }
  let blocker: string | null = opts.blocker ?? null
  const redetect = vi.fn(async () => agentStatus({ version: '2.1.300', needsProbe: true }))
  const changes: AgentUpdateStatus[] = []
  const prewarm = vi.fn()
  const service = new AgentUpdateService({
    settings,
    unsupportedReason: opts.unsupported ?? null,
    backend,
    blocker: () => blocker,
    redetect,
    prewarm,
    closing: () => false,
    onChanged: (status) => changes.push(status),
    now: () => now,
    schedule: () => () => undefined
  })
  return {
    service,
    settings,
    update,
    install,
    redetect,
    prewarm,
    changes,
    advance(ms: number) {
      now += ms
    },
    setBlocker(next: string | null) {
      blocker = next
    }
  }
}

/** Waits for the run that `tick()` started. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('detectAgentUpdateUnsupported (only the everyday aios)', () => {
  it('runs with the default userData when there are no marks for dev, agent stopped, or fake backend', () => {
    expect(detectAgentUpdateUnsupported({ defaultUserData: true, env: {} })).toBeNull()
  })
  it('a --user-data-dir copy is instance (before the other marks)', () => {
    expect(detectAgentUpdateUnsupported({ defaultUserData: false, env: { AIOS_FIXTURES: '/x' } })).toBe('instance')
  })
  it('environment variables for dev server, AIOS_DISABLE_AGENT, and fake backend', () => {
    expect(detectAgentUpdateUnsupported({ defaultUserData: true, env: { ELECTRON_RENDERER_URL: 'http://x' } })).toBe('dev')
    expect(detectAgentUpdateUnsupported({ defaultUserData: true, env: { AIOS_DISABLE_AGENT: '1' } })).toBe(
      'agent-disabled'
    )
    expect(detectAgentUpdateUnsupported({ defaultUserData: true, env: { AIOS_FAKE_LOG: '/tmp/x' } })).toBe(
      'fake-backend'
    )
  })
})

describe('AgentUpdateService.isUpdating (TODO 787)', () => {
  function deferred() {
    let release: (run: AgentSelfUpdateRun) => void = () => undefined
    const promise = new Promise<AgentSelfUpdateRun>((resolve) => {
      release = resolve
    })
    return { promise, release }
  }

  it('true while an automatic update is running and false when it ends (even on failure)', async () => {
    const h = harness()
    const d = deferred()
    h.update.mockImplementationOnce(() => d.promise)
    expect(h.service.isUpdating()).toBe(false)
    h.advance(FIRST_RUN_DELAY_MS)
    h.service.tick()
    expect(h.service.isUpdating()).toBe(true)
    d.release({ outcome: 'failed', before: null, after: null, failure: 'agent-update-failed' })
    await settle()
    expect(h.service.isUpdating()).toBe(false)
  })

  it('true for "Update now" (manual) too', async () => {
    const h = harness()
    const d = deferred()
    h.update.mockImplementationOnce(() => d.promise)
    const done = h.service.updateNow()
    expect(h.service.isUpdating()).toBe(true)
    d.release({ outcome: 'unchanged', before: '2.1.296', after: '2.1.296' })
    await done
    expect(h.service.isUpdating()).toBe(false)
  })

  it('returns to false at the limit even if the end never comes', async () => {
    const h = harness()
    h.update.mockImplementationOnce(() => new Promise<AgentSelfUpdateRun>(() => undefined))
    void h.service.updateNow()
    expect(h.service.isUpdating()).toBe(true)
    h.advance(UPDATE_WAIT_CAP_MS - 1)
    expect(h.service.isUpdating()).toBe(true)
    h.advance(1)
    expect(h.service.isUpdating()).toBe(false)
  })
})

describe('AgentUpdateService', () => {
  it('does not run in a non-running form and refuses "Update now"', async () => {
    const h = harness({ unsupported: 'instance' })
    h.service.start()
    h.advance(FIRST_RUN_DELAY_MS * 10)
    h.service.tick()
    await settle()
    expect(h.update).not.toHaveBeenCalled()
    expect(h.service.status()).toMatchObject({ supported: false, unsupportedReason: 'instance' })
    await expect(h.service.updateNow()).rejects.toThrow(/agent-update-unsupported/)
  })

  it('no-backend-support when the backend has no path', () => {
    const service = new AgentUpdateService({
      settings: memorySettings(),
      unsupportedReason: null,
      backend: undefined,
      blocker: () => null,
      redetect: async () => agentStatus(),
      closing: () => false,
      onChanged: () => undefined
    })
    expect(service.status().unsupportedReason).toBe('no-backend-support')
  })

  it('runs at the first tick after FIRST_RUN_DELAY_MS from launch and the next one day later', async () => {
    const h = harness({ run: { outcome: 'unchanged', before: '2.1.296', after: '2.1.296' } })
    h.service.tick()
    await settle()
    expect(h.update).not.toHaveBeenCalled()
    h.advance(FIRST_RUN_DELAY_MS)
    h.service.tick()
    await settle()
    expect(h.update).toHaveBeenCalledTimes(1)
    expect(h.service.status().phase).toBe('up-to-date')
    h.advance(RUN_INTERVAL_MS - 1)
    h.service.tick()
    await settle()
    expect(h.update).toHaveBeenCalledTimes(1)
    h.advance(1)
    h.service.tick()
    await settle()
    expect(h.update).toHaveBeenCalledTimes(2)
  })

  it('waits while a conversation is running and runs at the next tick after it stops', async () => {
    const h = harness({ blocker: 'session' })
    h.advance(FIRST_RUN_DELAY_MS)
    h.service.tick()
    await settle()
    expect(h.update).not.toHaveBeenCalled()
    h.setBlocker(null)
    h.service.tick()
    await settle()
    expect(h.update).toHaveBeenCalledTimes(1)
  })

  it('TODO 1143: shows waiting while waiting, runs at the next tick after it stops and clears; does not wait a day', async () => {
    const h = harness({ blocker: 'session' })
    h.advance(FIRST_RUN_DELAY_MS)
    h.service.tick()
    expect(h.service.status().waiting).toBe('session')
    h.advance(60_000)
    h.service.tick()
    expect(h.update).not.toHaveBeenCalled()
    h.setBlocker(null)
    h.advance(60_000)
    h.service.tick()
    await settle()
    expect(h.update).toHaveBeenCalledTimes(1)
    const status = h.service.status()
    expect(status.waiting).toBeNull()
    expect(status.nextCheckAt).toBe((status.checkedAt ?? 0) + RUN_INTERVAL_MS)
  })

  it('does not run while automatic is OFF or the backend setting stops it ("Update now" runs)', async () => {
    const h = harness({ autoBlocked: true })
    h.advance(FIRST_RUN_DELAY_MS)
    h.service.tick()
    await settle()
    expect(h.update).not.toHaveBeenCalled()
    expect(h.service.status().autoBlockedByBackend).toBe(true)
    await h.service.updateNow()
    expect(h.update).toHaveBeenCalledTimes(1)

    const off = harness({ settings: { [AGENT_UPDATE_AUTO.key]: 'false' } })
    off.advance(FIRST_RUN_DELAY_MS)
    off.service.tick()
    await settle()
    expect(off.update).not.toHaveBeenCalled()
    off.service.setAuto(true)
    expect(off.settings.raw.get(AGENT_UPDATE_AUTO.key)).toBe('true')
    off.service.tick()
    await settle()
    expect(off.update).toHaveBeenCalledTimes(1)
  })

  it('after an upgrade, keeps a record, emits a notice, and re-detects the feature table; copies the unverified version', async () => {
    const h = harness()
    await h.service.updateNow()
    const status = h.service.status()
    expect(status.phase).toBe('updated')
    expect(status.notice).toEqual({ from: '2.1.296', to: '2.1.300' })
    expect(status.lastUpdate).toMatchObject({ from: '2.1.296', to: '2.1.300' })
    expect(AGENT_UPDATE_LAST.parse(h.settings.raw.get(AGENT_UPDATE_LAST.key) ?? null)).toMatchObject({
      from: '2.1.296',
      to: '2.1.300'
    })
    expect(h.redetect).toHaveBeenCalledTimes(1)
    expect(status.current).toBe('2.1.300')
    expect(status.unverified).toBe(true)
    expect(status.revertTo).toBeNull()
    h.service.dismissNotice()
    expect(h.service.status().notice).toBeNull()
  })

  it('TODO 943: only after a version upgrade, starts a probe in the background after re-detection (not for unchanged, failed, or reverted)', async () => {
    const h = harness()
    await h.service.updateNow()
    expect(h.prewarm).toHaveBeenCalledTimes(1)
    const order = h.prewarm.mock.invocationCallOrder[0] ?? 0
    expect(order).toBeGreaterThan(h.redetect.mock.invocationCallOrder[0] ?? Infinity)
    await h.service.revert()
    expect(h.prewarm).toHaveBeenCalledTimes(1)

    const same = harness({ run: { outcome: 'unchanged', before: '2.1.296', after: '2.1.296' } })
    await same.service.updateNow()
    expect(same.prewarm).not.toHaveBeenCalled()
    const failed = harness({ run: { outcome: 'failed', before: null, after: null, failure: 'agent-update-failed' } })
    await failed.service.updateNow()
    expect(failed.prewarm).not.toHaveBeenCalled()
  })

  it('transient failures double from 30 minutes; failures that stay until the user fixes them are fixed at 1 day (does not call every minute)', async () => {
    const h = harness({ run: { outcome: 'failed', before: null, after: null, failure: 'agent-update-failed' } })
    h.advance(FIRST_RUN_DELAY_MS)
    h.service.tick()
    await settle()
    expect(h.update).toHaveBeenCalledTimes(1)
    expect(h.service.status()).toMatchObject({ phase: 'failed', failure: 'agent-update-failed' })
    for (let i = 0; i < 29; i += 1) {
      h.advance(60_000)
      h.service.tick()
    }
    await settle()
    expect(h.update).toHaveBeenCalledTimes(1)
    h.advance(60_000)
    h.service.tick()
    await settle()
    expect(h.update).toHaveBeenCalledTimes(2)
    h.advance(RETRY_BASE_MS)
    h.service.tick()
    await settle()
    expect(h.update).toHaveBeenCalledTimes(2)
    h.advance(RETRY_BASE_MS)
    h.service.tick()
    await settle()
    expect(h.update).toHaveBeenCalledTimes(3)

    const managed = harness({ run: { outcome: 'failed', before: null, after: null, failure: 'agent-update-managed' } })
    managed.advance(FIRST_RUN_DELAY_MS)
    managed.service.tick()
    await settle()
    managed.advance(RUN_INTERVAL_MS - 1)
    managed.service.tick()
    await settle()
    expect(managed.update).toHaveBeenCalledTimes(1)
    managed.advance(1)
    managed.service.tick()
    await settle()
    expect(managed.update).toHaveBeenCalledTimes(2)
  })

  it('when the probe of the upgraded version fails, shows "revert to the previous version" (does not revert automatically); clears it when the check passes', async () => {
    const h = harness()
    await h.service.updateNow()
    const failed = agentStatus({
      version: '2.1.300',
      needsProbe: false,
      degradations: [
        { feature: 'structured-io', reason: 'x', code: formatReason('agent-probe-failed', { detail: 'unknown option' }) }
      ]
    })
    expect(verificationFailed(failed)).toBe(true)
    h.service.observe(failed)
    expect(h.service.status().revertTo).toBe('2.1.296')
    expect(h.install).not.toHaveBeenCalled()
    h.service.observe(agentStatus({ version: '2.1.300', needsProbe: false }))
    expect(h.service.status().revertTo).toBeNull()
  })

  it('shows "revert to the previous version" even if the version cannot be obtained after the upgrade', async () => {
    const h = harness()
    await h.service.updateNow()
    h.service.observe(agentStatus({ available: false, version: null }))
    expect(h.service.status().revertTo).toBe('2.1.296')
  })

  it('the record spans launches: a probe failure at the next launch can revert too', () => {
    const h = harness({
      settings: { [AGENT_UPDATE_LAST.key]: JSON.stringify({ from: '2.1.280', to: '2.1.300', at: 1 }) }
    })
    h.service.observe(agentStatus({ version: '2.1.300', needsProbe: true }))
    expect(h.service.status().revertTo).toBeNull()
    h.service.observe(
      agentStatus({
        version: '2.1.300',
        needsProbe: false,
        degradations: [{ feature: 'structured-io', reason: 'x', code: formatReason('agent-probe-failed', { detail: 'x' }) }]
      })
    )
    expect(h.service.status().revertTo).toBe('2.1.280')
  })

  it('after reverting, clears the record and holds the automatic run; "Update now" releases the hold', async () => {
    const h = harness()
    await h.service.updateNow()
    h.service.observe(agentStatus({ available: false, version: null }))
    await h.service.revert()
    expect(h.install).toHaveBeenCalledWith('2.1.296')
    const status = h.service.status()
    expect(status).toMatchObject({ phase: 'reverted', revertTo: null, lastUpdate: null, heldFrom: '2.1.300' })
    expect(h.settings.raw.get(AGENT_UPDATE_HELD_FROM.key)).toBe('2.1.300')
    expect(h.settings.raw.get(AGENT_UPDATE_LAST.key)).toBe('')
    // While held, it does not run automatically.
    h.advance(RUN_INTERVAL_MS * 2)
    h.service.tick()
    await settle()
    expect(h.update).toHaveBeenCalledTimes(1)
    await h.service.updateNow()
    expect(h.update).toHaveBeenCalledTimes(2)
    expect(h.service.status().heldFrom).toBeNull()
    expect(h.settings.raw.get(AGENT_UPDATE_HELD_FROM.key)).toBe('')
  })

  it('the hold after reverting lifts automatically in 7 days and automatic runs resume (the hold time is recorded)', async () => {
    const h = harness()
    await h.service.updateNow()
    h.service.observe(agentStatus({ available: false, version: null }))
    await h.service.revert()
    const heldAt = Number(h.settings.raw.get(AGENT_UPDATE_HELD_AT.key))
    expect(heldAt).toBeGreaterThan(0)
    expect(h.service.status().heldUntil).toBe(heldAt + HOLD_TTL_MS)
    h.advance(HOLD_TTL_MS - 60_000)
    h.service.tick()
    await settle()
    expect(h.update).toHaveBeenCalledTimes(1)
    expect(h.service.status().heldFrom).toBe('2.1.300')
    h.advance(120_000)
    h.service.tick()
    await settle()
    expect(h.service.status()).toMatchObject({ heldFrom: null, heldUntil: null })
    expect(h.settings.raw.get(AGENT_UPDATE_HELD_FROM.key)).toBe('')
    expect(h.settings.raw.get(AGENT_UPDATE_HELD_AT.key)).toBe('')
    expect(h.update).toHaveBeenCalledTimes(2)
  })

  it('an old hold without a time is counted from the time it was read', () => {
    const h = harness({ settings: { [AGENT_UPDATE_HELD_FROM.key]: '2.1.300' } })
    expect(h.service.status().heldFrom).toBe('2.1.300')
    expect(Number(h.settings.raw.get(AGENT_UPDATE_HELD_AT.key))).toBeGreaterThan(0)
  })

  it('once the check of the new version passes it is confirmed, and a later unrelated detection failure does not show "revert" (the version record stays)', async () => {
    const h = harness()
    await h.service.updateNow()
    h.service.observe(agentStatus({ version: '2.1.300', needsProbe: false }))
    expect(h.service.status().lastUpdate).toMatchObject({ from: '2.1.296', to: '2.1.300', confirmed: true })
    // Later the CLI disappeared from PATH (unrelated to the update).
    h.service.observe(agentStatus({ available: false, version: null }))
    expect(h.service.status().revertTo).toBeNull()
    // Stays confirmed across launches.
    const next = harness({ settings: { [AGENT_UPDATE_LAST.key]: h.settings.raw.get(AGENT_UPDATE_LAST.key) ?? '' } })
    next.service.observe(agentStatus({ available: false, version: null }))
    expect(next.service.status().revertTo).toBeNull()
  })

  it('when reverting fails, returns failed and the reason (the record stays)', async () => {
    const h = harness()
    await h.service.updateNow()
    h.install.mockResolvedValueOnce({
      outcome: 'failed',
      before: '2.1.300',
      after: '2.1.300',
      failure: 'agent-update-not-switched',
      params: { version: '2.1.296' }
    })
    await h.service.revert()
    expect(h.service.status()).toMatchObject({
      phase: 'failed',
      failure: 'agent-update-not-switched',
      failureParams: { version: '2.1.296' },
      lastUpdate: { from: '2.1.296', to: '2.1.300' }
    })
  })

  it("passes the update failure's interpolated value (exit code) through to status", async () => {
    const h = harness({
      run: { outcome: 'failed', before: null, after: null, failure: 'agent-update-failed', params: { exitCode: 3 } }
    })
    await h.service.updateNow()
    expect(h.service.status()).toMatchObject({ failure: 'agent-update-failed', failureParams: { exitCode: 3 } })
  })

  it('"Update now" during a run waits for the same job (no double call)', async () => {
    const h = harness()
    const first = h.service.updateNow()
    const second = h.service.updateNow()
    await Promise.all([first, second])
    expect(h.update).toHaveBeenCalledTimes(1)
  })

  it('does not write the result after shutdown (12.9)', async () => {
    const h = harness()
    const job = h.service.updateNow()
    h.service.stop()
    await job
    expect(h.settings.raw.has(AGENT_UPDATE_LAST.key)).toBe(false)
    expect(h.redetect).not.toHaveBeenCalled()
  })
})
