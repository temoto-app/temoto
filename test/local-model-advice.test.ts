/**
 * TODO 1066: the recommendations for this PC (detection of the runtime environment, the recommendation table, and the entry point for fetching).
 * TODO 1315: the context length sent with every request (`recommendedContextOf` / `nativeProviderOf`); the derived-model button is retired.
 * Calls neither the real Ollama nor OpenCode (a fake fetch and fake tools are used). Does not call a model either.
 */
import { describe, expect, it } from 'vitest'
import { OpenCodeAdapter, serverConfigOf } from '../src/main/session/adapter-opencode/index.js'
import { loadOpenCodeTable } from '../src/main/session/adapter-opencode/compat.js'
import { brokenModelNoteOf } from '../src/main/session/adapter-opencode/local.js'
import {
  PullTracker,
  adviseOf,
  nativeProviderOf,
  parsePullLine,
  pullModel,
  budgetOf,
  parameterOf,
  recommendedContextOf,
  runtimeOf,
  versionAtLeast
} from '../src/main/session/adapter-opencode/advice.js'
import { detectHardware, macGpuBudget, parseAppleChip, parseNvidiaSmi, type HardwareDeps } from '../src/main/os/hardware.js'
import { isLocalModelAction, type HardwareProfile } from '../src/shared/local-models.js'
import { parseReason } from '../src/shared/reason.js'

const table = loadOpenCodeTable()
const advice = table.ollamaAdvice!
const GiB = 1024 ** 3

/** This Mac (MacBook Air M5 / 24GB, values detected on 2026-11-13). */
const m5: HardwareProfile = {
  os: 'mac',
  arch: 'arm64',
  cpu: 'Apple M5',
  appleChip: { name: 'Apple M5', generation: 5, neuralAccelerators: true },
  gpu: { kind: 'apple', name: 'Apple M5', vramBytes: null },
  memoryBytes: 24 * GiB,
  gpuBudgetBytes: 16 * GiB,
  budgetSource: 'default-fraction'
}

function nvidia(vramGiB: number): HardwareProfile {
  return {
    os: 'windows',
    arch: 'x64',
    cpu: 'AMD Ryzen 9',
    appleChip: null,
    gpu: { kind: 'nvidia', name: 'NVIDIA GeForce RTX', vramBytes: vramGiB * GiB },
    memoryBytes: 64 * GiB,
    gpuBudgetBytes: vramGiB * GiB,
    budgetSource: 'vram'
  }
}

function fakeDeps(over: Partial<HardwareDeps>, outputs: Record<string, string | null>): HardwareDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    platform: 'darwin',
    arch: 'arm64',
    totalmem: 24 * GiB,
    cpu: 'Apple M5',
    run: async (command) => {
      calls.push(command)
      return outputs[command] ?? null
    },
    calls,
    ...over
  }
}

describe('detecting the runtime environment (the OS layer, fake tools)', () => {
  it('Apple Silicon generation and Neural Accelerator', () => {
    expect(parseAppleChip('Apple M5')).toEqual({ name: 'Apple M5', generation: 5, neuralAccelerators: true })
    expect(parseAppleChip('Apple M4 Pro')?.neuralAccelerators).toBe(false)
    expect(parseAppleChip('Intel(R) Core(TM) i7')).toBeNull()
  })
  it('the largest VRAM from the nvidia-smi output', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 3060, 12288\r\nNVIDIA GeForce RTX 4090, 24564\n')).toEqual({
      name: 'NVIDIA GeForce RTX 4090',
      vramBytes: 24564 * 1024 * 1024
    })
    expect(parseNvidiaSmi('')).toBeNull()
    expect(parseNvidiaSmi('garbage')).toBeNull()
  })
  it('macOS GPU limit: wired_limit if present, and the default ratio if 0', () => {
    expect(macGpuBudget(24 * GiB, 0)).toEqual({ bytes: 16 * GiB, source: 'default-fraction' })
    expect(macGpuBudget(64 * GiB, null)).toEqual({ bytes: 48 * GiB, source: 'default-fraction' })
    expect(macGpuBudget(24 * GiB, 20480)).toEqual({ bytes: 20 * GiB, source: 'wired-limit' })
  })
  it('Mac reads sysctl', async () => {
    const deps = fakeDeps({}, { '/usr/sbin/sysctl': '0\n' })
    const profile = await detectHardware(deps)
    expect(profile).toMatchObject({ os: 'mac', gpu: { kind: 'apple' }, gpuBudgetBytes: 16 * GiB, budgetSource: 'default-fraction' })
    expect(deps.calls).toEqual(['/usr/sbin/sysctl'])
  })
  it('Windows is NVIDIA VRAM only; unknown if there is none', async () => {
    const withGpu = await detectHardware(
      fakeDeps({ platform: 'win32', cpu: 'AMD Ryzen 9', totalmem: 64 * GiB }, { 'nvidia-smi': 'NVIDIA GeForce RTX 4080, 16376\n' })
    )
    expect(withGpu).toMatchObject({ os: 'windows', gpu: { kind: 'nvidia', vramBytes: 16376 * 1024 * 1024 }, budgetSource: 'vram' })
    const without = await detectHardware(fakeDeps({ platform: 'win32', cpu: 'Intel', totalmem: 16 * GiB }, {}))
    expect(without).toMatchObject({ gpu: { kind: 'unknown' }, gpuBudgetBytes: null, budgetSource: 'unknown' })
  })
})

describe('recommendation (adviseOf)', () => {
  const ready = (version: string, h: HardwareProfile = m5) => runtimeOf(advice, h, version, true)

  it('this Mac (M5 / 24GB): the first is gpt-oss:20b at 128k, and the MLX 26b does not fit', () => {
    const r = adviseOf(advice, m5, ready('0.40.16'), [], null)
    expect(r.cpuOnly).toBe(false)
    expect(r.picks.map((p) => [p.model, p.context])).toEqual([
      ['gpt-oss:20b', 131072],
      ['gemma4:12b-mlx', 16384],
      ['qwen3:14b', 32768]
    ])
    expect(r.picks.every((p) => p.action === 'pull')).toBe(true)
  })
  it('older versions that cannot run MLX do not show MLX models', () => {
    const r = adviseOf(advice, m5, ready('0.30.0'), [], null)
    expect(r.picks.some((p) => p.nativeFormat)).toBe(false)
  })
  it('a 64GB Mac has the MoE 35b first', () => {
    const big: HardwareProfile = { ...m5, memoryBytes: 64 * GiB, gpuBudgetBytes: 48 * GiB }
    expect(adviseOf(advice, big, ready('0.40.16', big), [], null).picks[0]?.model).toBe('qwen3.6:35b-a3b-coding-nvfp4')
  })
  it('NVIDIA: only what fits entirely in VRAM (no MLX)', () => {
    const r16 = adviseOf(advice, nvidia(16), ready('0.40.16', nvidia(16)), [], null)
    expect(r16.picks[0]?.model).toBe('gpt-oss:20b')
    expect(r16.picks.some((p) => p.nativeFormat)).toBe(false)
    const r8 = adviseOf(advice, nvidia(8), ready('0.40.16', nvidia(8)), [], null)
    expect(r8.picks.map((p) => p.model)).toEqual(['qwen3:4b'])
  })
  it('if the GPU is unknown, the CPU estimate (75% of memory)', () => {
    const cpu: HardwareProfile = { ...nvidia(8), gpu: { kind: 'unknown', name: null, vramBytes: null }, gpuBudgetBytes: null, budgetSource: 'unknown' }
    expect(budgetOf(advice, cpu)).toEqual({ bytes: 48 * GiB, cpuOnly: true })
  })
  it('already pulled means nothing left to press (the context length goes with every request); derived models are listed as legacy (TODO 1315)', () => {
    const installed = adviseOf(advice, m5, ready('0.40.16'), ['gpt-oss:20b'], null)
    expect(installed.picks[0]).toMatchObject({ installed: true, action: null })
    expect(installed.picks[0]).not.toHaveProperty('tunedModel')
    expect(installed).toMatchObject({ contextPerRequest: true, legacyModels: [] })
    const legacy = adviseOf(advice, m5, ready('0.40.16'), ['gpt-oss:20b', 'aios-gpt-oss:20b', 'aios-qwen3:8b'], { kind: 'bundle-missing' })
    expect(legacy).toMatchObject({ contextPerRequest: false, legacyModels: ['aios-gpt-oss:20b', 'aios-qwen3:8b'] })
    // Nothing is known about installed models when the runtime does not respond.
    expect(adviseOf(advice, m5, runtimeOf(advice, m5, null, false), ['aios-gpt-oss:20b'], null).legacyModels).toEqual([])
  })
  it('recommendedContextOf: the panel value for table models, nothing for unknown or derived ones, `:latest` matches (TODO 1315)', () => {
    expect(recommendedContextOf(advice, m5, 'gpt-oss:20b')).toBe(131072)
    expect(recommendedContextOf(advice, m5, 'qwen3:8b')).toBe(32768)
    // The panel hides the 26b MLX model on this Mac because it does not fit; nothing is sent for it either.
    expect(recommendedContextOf(advice, m5, 'gemma4:26b-nvfp4')).toBeNull()
    // The same value as the panel's pick.
    expect(recommendedContextOf(advice, m5, 'gemma4:12b-mlx')).toBe(adviseOf(advice, m5, ready('0.40.16'), [], null).picks.find((p) => p.model === 'gemma4:12b-mlx')?.context)
    expect(recommendedContextOf(advice, m5, 'llama3.2:3b')).toBeNull()
    expect(recommendedContextOf(advice, m5, 'aios-gpt-oss:20b')).toBeNull()
    const latest = { ...advice, models: [{ ...advice.models[1]!, model: 'tiny' }] }
    expect(recommendedContextOf(latest, m5, 'tiny:latest')).toBe(recommendedContextOf(latest, m5, 'tiny'))
    expect(recommendedContextOf(advice, nvidia(8), 'gpt-oss:20b')).toBeNull()
  })
  it('nativeProviderOf: think only with the thinking capability, no context length without hardware (TODO 1315)', () => {
    const caps = new Map([
      ['gpt-oss:20b', ['completion', 'thinking']],
      ['llama3.2:3b', ['completion']]
    ])
    const plan = nativeProviderOf(table, ['gpt-oss:20b', 'llama3.2:3b', 'aios-gpt-oss:20b'], caps, m5, 'file:///x.mjs')
    expect([...plan.contexts]).toEqual([['gpt-oss:20b', 131072]])
    expect([...plan.thinking]).toEqual(['gpt-oss:20b'])
    expect(nativeProviderOf(table, ['gpt-oss:20b'], caps, null, 'file:///x.mjs').contexts.size).toBe(0)
  })
  it('if the runtime does not respond, no action is offered', () => {
    const r = adviseOf(advice, m5, runtimeOf(advice, m5, null, false), [], null)
    expect(r.runtime.reachable).toBe(false)
    expect(r.picks.length).toBeGreaterThan(0)
    expect(r.picks.every((p) => p.action === null)).toBe(true)
  })
  it('num_ctx from the parameters of /api/show', () => {
    expect(parameterOf('temperature                    1\nnum_ctx                        32768', 'num_ctx')).toBe(32768)
    expect(parameterOf('temperature 1', 'num_ctx')).toBeNull()
    expect(versionAtLeast('0.40.16', '0.31.0')).toBe(true)
    expect(versionAtLeast('0.30.9', '0.31.0')).toBe(false)
  })
})

interface Call {
  readonly url: string
  readonly body: Record<string, unknown> | null
}

/** A fake Ollama. pull only records the call and returns success. */
function fakeOllama(names: string[], contexts: Record<string, number> = {}): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    calls.push({ url, body })
    const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 })
    if (url.endsWith('/api/tags')) return json({ models: names.map((name) => ({ name, capabilities: ['completion', 'tools'] })) })
    if (url.endsWith('/api/version')) return json({ version: '0.40.16' })
    if (url.endsWith('/api/show')) {
      const ctx = contexts[String(body?.['model'])]
      return json({ parameters: ctx === undefined ? 'temperature 1' : `temperature 1\nnum_ctx ${ctx}` })
    }
    if (url.endsWith('/api/pull') || url.endsWith('/api/create')) return json({ status: 'success' })
    return new Response('not found', { status: 404 })
  }
  return { fetch: impl as typeof fetch, calls }
}

describe('OpenCodeAdapter.localModels', () => {
  const link = { baseUrl: 'http://127.0.0.1:1', authorization: 'x' }
  const env = { OLLAMA_HOST: 'http://ollama.test:11434' }
  const hardware = async (): Promise<HardwareProfile> => m5

  it('recommendations: looks at installed models; rewrites nothing and creates no model', async () => {
    const o = fakeOllama(['gpt-oss:20b', 'aios-gpt-oss:20b'], { 'aios-gpt-oss:20b': 131072 })
    const adapter = new OpenCodeAdapter({ link, env, fetch: o.fetch, hardware }, table)
    const r = await adapter.localModels!.advise(false)
    expect(r?.runtime).toEqual({ reachable: true, version: '0.40.16', nativeFormat: true })
    expect(r?.picks[0]).toMatchObject({ model: 'gpt-oss:20b', installed: true, action: null })
    expect(r?.legacyModels).toEqual(['aios-gpt-oss:20b'])
    // No app path in the test: the bundled provider is not found, so the panel says the context length cannot be sent.
    expect(r?.contextPerRequest).toBe(false)
    expect(o.calls.some((c) => c.url.endsWith('/api/pull') || c.url.endsWith('/api/create'))).toBe(false)
  })

  it('pressed 「取得」: pulls only names in the recommendations', async () => {
    const o = fakeOllama([])
    const adapter = new OpenCodeAdapter({ link, env, fetch: o.fetch, hardware }, table)
    expect(await adapter.localModels!.act('pull', 'gpt-oss:20b')).toEqual({ ok: true })
    const pull = o.calls.find((c) => c.url.endsWith('/api/pull'))
    expect(pull).toEqual({ url: 'http://ollama.test:11434/api/pull', body: { model: 'gpt-oss:20b', stream: true } })

    const unknown = await adapter.localModels!.act('pull', 'evil/model:latest')
    expect(unknown.ok).toBe(false)
    expect(parseReason(unknown.ok ? null : unknown.code)?.code).toBe('local-model-unknown')
    expect(o.calls.filter((c) => c.url.endsWith('/api/pull'))).toHaveLength(1)
  })

  it('the retired 「文脈長を設定」 is not an action any more (TODO 1315)', () => {
    expect(isLocalModelAction('pull')).toBe(true)
    expect(isLocalModelAction('tune')).toBe(false)
  })

  it('refuses if the runtime does not respond', async () => {
    const adapter = new OpenCodeAdapter(
      {
        link,
        env,
        hardware,
        fetch: (async () => {
          throw new Error('ECONNREFUSED')
        }) as typeof fetch
      },
      table
    )
    const r = await adapter.localModels!.act('pull', 'gpt-oss:20b')
    expect(r.ok).toBe(false)
    expect(parseReason(r.ok ? null : r.code)?.code).toBe('local-runtime-down')
  })
})

describe("derived model context length into the provider's limit", () => {
  it('only models with contexts get limit (context and output)', () => {
    const config = serverConfigOf(table, null, null, {
      base: 'http://localhost:11434',
      names: ['gpt-oss:20b', 'aios-gpt-oss:20b'],
      contexts: new Map([['aios-gpt-oss:20b', 32768]])
    })
    const models = (config['provider'] as Record<string, { models: Record<string, unknown> }>)['ollama']!.models
    expect(models['gpt-oss:20b']).toEqual({ name: 'gpt-oss:20b' })
    expect(models['aios-gpt-oss:20b']).toEqual({ name: 'aios-gpt-oss:20b', limit: { context: 32768, output: 8192 } })
  })
})

describe('unloadable model = guidance for a broken download (TODO 1066)', () => {
  const real = 'mlx runner failed: Error: layer 5: missing attention q/o projections'
  it('the real failure sentence (2026-10-31) matches only for Ollama models; a derived model is traced back to the original name', () => {
    const hit = brokenModelNoteOf(table, 'ollama/gemma4:12b-mlx', real)
    expect(hit?.model).toBe('gemma4:12b-mlx')
    const note = parseReason(hit?.note ?? null)
    expect(note?.code).toBe('local-model-broken')
    expect(note?.params).toEqual({ message: real, model: 'gemma4:12b-mlx' })
    expect(brokenModelNoteOf(table, 'ollama/aios-gpt-oss:20b', 'Unable to load model: x')?.model).toBe('gpt-oss:20b')
    expect(brokenModelNoteOf(table, 'openai/gpt-5', real)).toBeNull()
    expect(brokenModelNoteOf(table, null, real)).toBeNull()
    expect(brokenModelNoteOf(table, 'ollama/gpt-oss:20b', 'rate limit')).toBeNull()
    expect(brokenModelNoteOf({ ...table, ollamaAdvice: { ...advice, brokenModelPatterns: [] } }, 'ollama/gpt-oss:20b', real)).toBeNull()
  })
  it('a pulled model with the broken marker becomes 「取り直し」 (pull)', () => {
    const runtime = runtimeOf(advice, m5, '0.40.16', true)
    const r = adviseOf(advice, m5, runtime, ['gpt-oss:20b', 'aios-gpt-oss:20b'], null, new Set(['gpt-oss:20b']))
    expect(r.picks[0]).toMatchObject({ model: 'gpt-oss:20b', installed: true, broken: true, action: 'pull' })
    expect(r.picks[1]).toMatchObject({ broken: false })
    // An item that was not fetched does not get the broken mark
    expect(adviseOf(advice, m5, runtime, [], null, new Set(['gpt-oss:20b'])).picks[0]?.broken).toBe(false)
  })
  it('the adapter remembers on seeing a failure; a successful pull alone does not clear it, and it clears when a conversation loads with that model; it does not pull automatically', async () => {
    const o = fakeOllama(['gemma4:12b-mlx'])
    const adapter = new OpenCodeAdapter(
      { link: { baseUrl: 'http://127.0.0.1:1', authorization: 'x' }, env: { OLLAMA_HOST: 'http://ollama.test:11434' }, fetch: o.fetch, hardware: async () => m5 },
      table
    )
    ;(adapter as unknown as { broken: Set<string> }).broken.add('gemma4:12b-mlx')
    const before = await adapter.localModels!.advise(false)
    expect(before?.picks.find((p) => p.model === 'gemma4:12b-mlx')).toMatchObject({ broken: true, action: 'pull' })
    expect(o.calls.some((c) => c.url.endsWith('/api/pull'))).toBe(false)
    expect(await adapter.localModels!.act('pull', 'gemma4:12b-mlx')).toEqual({ ok: true })
    const after = await adapter.localModels!.advise(false)
    // Ollama skips the layer that holds the file, so a successful fetch is not evidence that the model could be loaded.
    expect(after?.picks.find((p) => p.model === 'gemma4:12b-mlx')?.broken).toBe(true)
    ;(adapter as unknown as { broken: Set<string> }).broken.delete('gemma4:12b-mlx')
    expect((await adapter.localModels!.advise(false))?.picks.find((p) => p.model === 'gemma4:12b-mlx')?.broken).toBe(false)
  })
  it('the light entry point of a running action queries nothing (returns only pull progress)', () => {
    const o = fakeOllama(['gemma4:12b-mlx'])
    const adapter = new OpenCodeAdapter({ env: { OLLAMA_HOST: 'http://ollama.test:11434' }, fetch: o.fetch, hardware: async () => m5 }, table)
    expect(adapter.localModels!.activity()).toEqual([])
    const inner = adapter as unknown as { acting: Map<string, string>; progress: Map<string, { completed: number; total: number }> }
    inner.acting.set('gemma4:12b-mlx', 'pull')
    inner.progress.set('gemma4:12b-mlx', { completed: 1, total: 4 })
    expect(adapter.localModels!.activity()).toEqual([{ model: 'gemma4:12b-mlx', running: 'pull', progress: { completed: 1, total: 4 } }])
    expect(o.calls).toEqual([])
  })
  it("sentences that also appear for a connection drop or out of memory do not go into the broken marker's terms", () => {
    for (const generic of ['unexpected EOF', 'model runner has unexpectedly stopped', 'llama runner process has terminated: signal: killed']) {
      expect(brokenModelNoteOf(table, 'ollama/gpt-oss:20b', generic)).toBeNull()
    }
  })
})

/** A fake stream that cuts the output into chunks mid-line. */
function streamOf(chunks: string[]): Response {
  const enc = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c))
        controller.close()
      }
    }),
    { status: 200 }
  )
}

describe('pull progress (TODO 1066)', () => {
  it('parsePullLine: layer size, error and unreadable lines', () => {
    expect(parsePullLine('{"status":"pulling abc","digest":"sha256:abc","total":100,"completed":40}')).toEqual({
      status: 'pulling abc',
      digest: 'sha256:abc',
      total: 100,
      completed: 40,
      error: null
    })
    expect(parsePullLine('{"error":"boom"}')?.error).toBe('boom')
    expect(parsePullLine('{"status":"pulling manifest"}')).toMatchObject({ digest: null, total: 0, completed: 0 })
    expect(parsePullLine('')).toBeNull()
    expect(parsePullLine('not json')).toBeNull()
  })
  it('PullTracker: sums per layer, and capped at total when exceeded', () => {
    const t = new PullTracker()
    const line = (digest: string, total: number, completed: number) => parsePullLine(JSON.stringify({ status: 'pulling', digest, total, completed }))!
    expect(t.update(parsePullLine('{"status":"pulling manifest"}')!)).toEqual({ completed: 0, total: 0 })
    expect(t.update(line('a', 100, 10))).toEqual({ completed: 10, total: 100 })
    expect(t.update(line('b', 300, 30))).toEqual({ completed: 40, total: 400 })
    expect(t.update(line('a', 100, 100))).toEqual({ completed: 130, total: 400 })
    expect(t.update(line('b', 300, 999))).toEqual({ completed: 400, total: 400 })
  })
  it('pullModel: calls with stream: true, passes progress even when cut in the middle of a line, and succeeds on success', async () => {
    const seen: unknown[] = []
    let body: unknown = null
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return streamOf([
        '{"status":"pulling manifest"}\n{"status":"pulling a","digest":"sha256:a","total":200,"compl',
        'eted":50}\n{"status":"pulling a","digest":"sha256:a","total":200,"completed":200}\n',
        '{"status":"verifying sha256 digest"}\n{"status":"success"}'
      ])
    }) as unknown as typeof fetch
    const r = await pullModel(table, 'http://x', 'gpt-oss:20b', fetchImpl, (p) => seen.push(p))
    expect(r).toEqual({ ok: true })
    expect(body).toEqual({ model: 'gpt-oss:20b', stream: true })
    expect(seen).toContainEqual({ completed: 50, total: 200 })
    expect(seen.at(-1)).toEqual({ completed: 200, total: 200 })
  })
  it('pullModel: an error line, an end without success and an HTTP failure are failures', async () => {
    const code = (r: Awaited<ReturnType<typeof pullModel>>): string | undefined => parseReason(r.ok ? null : r.code)?.code
    const errored = await pullModel(table, 'http://x', 'm', (async () => streamOf(['{"status":"pulling manifest"}\n{"error":"pull model manifest: file does not exist"}\n'])) as unknown as typeof fetch)
    expect(code(errored)).toBe('local-model-failed')
    const cut = await pullModel(table, 'http://x', 'm', (async () => streamOf(['{"status":"pulling manifest"}\n'])) as unknown as typeof fetch)
    expect(code(cut)).toBe('local-model-failed')
    const http = await pullModel(table, 'http://x', 'm', (async () => new Response('{"error":"nope"}', { status: 500 })) as unknown as typeof fetch)
    expect(code(http)).toBe('local-model-failed')
  })
  it('adapter: while pulling, advise returns running and progress, and it disappears when finished', async () => {
    const o = fakeOllama([])
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const enc = new TextEncoder()
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/api/pull')) {
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(enc.encode('{"status":"pulling a","digest":"sha256:a","total":1000,"completed":250}\n'))
              await gate
              controller.enqueue(enc.encode('{"status":"success"}\n'))
              controller.close()
            }
          }),
          { status: 200 }
        )
      }
      return o.fetch(input as string, init)
    }) as typeof fetch
    const adapter = new OpenCodeAdapter(
      { link: { baseUrl: 'http://127.0.0.1:1', authorization: 'x' }, env: { OLLAMA_HOST: 'http://ollama.test:11434' }, fetch: fetchImpl, hardware: async () => m5 },
      table
    )
    const done = adapter.localModels!.act('pull', 'gpt-oss:20b')
    let during = null
    for (let i = 0; i < 50 && during === null; i += 1) {
      await new Promise((r) => setTimeout(r, 5))
      const a = await adapter.localModels!.advise(false)
      const pick = a?.picks.find((p) => p.model === 'gpt-oss:20b')
      if (pick?.progress != null) during = pick
    }
    expect(during).toMatchObject({ running: 'pull', progress: { completed: 250, total: 1000 } })
    release()
    expect(await done).toEqual({ ok: true })
    const after = (await adapter.localModels!.advise(false))?.picks.find((p) => p.model === 'gpt-oss:20b')
    expect(after).toMatchObject({ running: null, progress: null })
  })
})
