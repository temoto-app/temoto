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

describe('detectAgentUpdateUnsupported (普段使いの aios だけ)', () => {
  it('既定の userData で、dev・エージェント停止・偽のバックエンドの印が無ければ動く', () => {
    expect(detectAgentUpdateUnsupported({ defaultUserData: true, env: {} })).toBeNull()
  })
  it('--user-data-dir の複製は instance (他の印より先)', () => {
    expect(detectAgentUpdateUnsupported({ defaultUserData: false, env: { AIOS_FIXTURES: '/x' } })).toBe('instance')
  })
  it('dev サーバ・AIOS_DISABLE_AGENT・偽のバックエンドの環境変数', () => {
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

  it('自動の更新が走っている間は真、終われば偽 (失敗でも)', async () => {
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

  it('「今すぐ更新」(手動) でも真', async () => {
    const h = harness()
    const d = deferred()
    h.update.mockImplementationOnce(() => d.promise)
    const done = h.service.updateNow()
    expect(h.service.isUpdating()).toBe(true)
    d.release({ outcome: 'unchanged', before: '2.1.296', after: '2.1.296' })
    await done
    expect(h.service.isUpdating()).toBe(false)
  })

  it('終わりが来なくても上限で偽に戻る', async () => {
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
  it('動かない形では走らせず、「今すぐ更新」は断る', async () => {
    const h = harness({ unsupported: 'instance' })
    h.service.start()
    h.advance(FIRST_RUN_DELAY_MS * 10)
    h.service.tick()
    await settle()
    expect(h.update).not.toHaveBeenCalled()
    expect(h.service.status()).toMatchObject({ supported: false, unsupportedReason: 'instance' })
    await expect(h.service.updateNow()).rejects.toThrow(/agent-update-unsupported/)
  })

  it('バックエンドが口を持たなければ no-backend-support', () => {
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

  it('起動から FIRST_RUN_DELAY_MS 後の最初の刻みで走り、次は 1 日後', async () => {
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

  it('会話が動いている間は待ち、止んだ次の刻みで走る', async () => {
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

  it('TODO 1143: 待っている間は waiting を出し、止んだ次の刻みで走って消える。1 日は待たない', async () => {
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

  it('自動が OFF・バックエンドの設定が止めている間は走らない (「今すぐ更新」は走る)', async () => {
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

  it('上げたら記録を残し、知らせを出し、機能表を検出し直す。未検証の版を写す', async () => {
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

  it('TODO 943: 版を上げた後だけ、検出し直しの後に probe を裏で始める (変わらない・失敗・戻すでは始めない)', async () => {
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

  it('一時的な失敗は 30 分から倍々、利用者が直すまで変わらない失敗は 1 日の固定 (毎分呼ばない)', async () => {
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

  it('上げた版の probe が失敗したら「前の版に戻す」を出す (自動では戻さない)。確かめが通れば消す', async () => {
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

  it('上げた後に版が取れなくなっても「前の版に戻す」を出す', async () => {
    const h = harness()
    await h.service.updateNow()
    h.service.observe(agentStatus({ available: false, version: null }))
    expect(h.service.status().revertTo).toBe('2.1.296')
  })

  it('記録は起動をまたぐ: 次の起動の probe の失敗でも戻せる', () => {
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

  it('戻したら記録を消し、自動の実行を保留する。「今すぐ更新」で保留が外れる', async () => {
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

  it('戻した後の保留は 7 日で自動に解け、自動の実行が再開する (保留の時刻を記録)', async () => {
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

  it('時刻の無い古い保留は、読んだ時刻から数える', () => {
    const h = harness({ settings: { [AGENT_UPDATE_HELD_FROM.key]: '2.1.300' } })
    expect(h.service.status().heldFrom).toBe('2.1.300')
    expect(Number(h.settings.raw.get(AGENT_UPDATE_HELD_AT.key))).toBeGreaterThan(0)
  })

  it('新しい版の確かめが 1 回通ったら確定し、後の無関係な検出の失敗で「戻す」を出さない (版の記録は残す)', async () => {
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

  it('戻すのに失敗したら failed と理由 (記録は残す)', async () => {
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

  it('更新の失敗の差し込み値 (終了コード) を status に通す', async () => {
    const h = harness({
      run: { outcome: 'failed', before: null, after: null, failure: 'agent-update-failed', params: { exitCode: 3 } }
    })
    await h.service.updateNow()
    expect(h.service.status()).toMatchObject({ failure: 'agent-update-failed', failureParams: { exitCode: 3 } })
  })

  it('走っている最中の「今すぐ更新」は同じ仕事を待つ (二重に呼ばない)', async () => {
    const h = harness()
    const first = h.service.updateNow()
    const second = h.service.updateNow()
    await Promise.all([first, second])
    expect(h.update).toHaveBeenCalledTimes(1)
  })

  it('終了処理の後は結果を書かない (12.9)', async () => {
    const h = harness()
    const job = h.service.updateNow()
    h.service.stop()
    await job
    expect(h.settings.raw.has(AGENT_UPDATE_LAST.key)).toBe(false)
    expect(h.redetect).not.toHaveBeenCalled()
  })
})
