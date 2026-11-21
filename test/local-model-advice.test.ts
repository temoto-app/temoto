/**
 * TODO 1066: the recommendations for this PC (detection of the runtime environment, the recommendation table, and the entry points for fetching and derived models).
 * Calls neither the real Ollama nor OpenCode (a fake fetch and fake tools are used). Does not call a model either.
 */
import { describe, expect, it } from 'vitest'
import { OpenCodeAdapter, serverConfigOf } from '../src/main/session/adapter-opencode/index.js'
import { loadOpenCodeTable } from '../src/main/session/adapter-opencode/compat.js'
import { brokenModelNoteOf } from '../src/main/session/adapter-opencode/local.js'
import { PullTracker, adviseOf, parsePullLine, pullModel, budgetOf, parameterOf, runtimeOf, versionAtLeast } from '../src/main/session/adapter-opencode/advice.js'
import { detectHardware, macGpuBudget, parseAppleChip, parseNvidiaSmi, type HardwareDeps } from '../src/main/os/hardware.js'
import type { HardwareProfile } from '../src/shared/local-models.js'
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

describe('実行環境の検出 (OS の口、偽の道具)', () => {
  it('Apple Silicon の世代と Neural Accelerator', () => {
    expect(parseAppleChip('Apple M5')).toEqual({ name: 'Apple M5', generation: 5, neuralAccelerators: true })
    expect(parseAppleChip('Apple M4 Pro')?.neuralAccelerators).toBe(false)
    expect(parseAppleChip('Intel(R) Core(TM) i7')).toBeNull()
  })
  it('nvidia-smi の出力から一番大きい VRAM', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 3060, 12288\r\nNVIDIA GeForce RTX 4090, 24564\n')).toEqual({
      name: 'NVIDIA GeForce RTX 4090',
      vramBytes: 24564 * 1024 * 1024
    })
    expect(parseNvidiaSmi('')).toBeNull()
    expect(parseNvidiaSmi('garbage')).toBeNull()
  })
  it('macOS の GPU の上限: wired_limit があればそれ、0 なら既定の割合', () => {
    expect(macGpuBudget(24 * GiB, 0)).toEqual({ bytes: 16 * GiB, source: 'default-fraction' })
    expect(macGpuBudget(64 * GiB, null)).toEqual({ bytes: 48 * GiB, source: 'default-fraction' })
    expect(macGpuBudget(24 * GiB, 20480)).toEqual({ bytes: 20 * GiB, source: 'wired-limit' })
  })
  it('Mac は sysctl を読む', async () => {
    const deps = fakeDeps({}, { '/usr/sbin/sysctl': '0\n' })
    const profile = await detectHardware(deps)
    expect(profile).toMatchObject({ os: 'mac', gpu: { kind: 'apple' }, gpuBudgetBytes: 16 * GiB, budgetSource: 'default-fraction' })
    expect(deps.calls).toEqual(['/usr/sbin/sysctl'])
  })
  it('Windows は NVIDIA の VRAM だけ。無ければ unknown', async () => {
    const withGpu = await detectHardware(
      fakeDeps({ platform: 'win32', cpu: 'AMD Ryzen 9', totalmem: 64 * GiB }, { 'nvidia-smi': 'NVIDIA GeForce RTX 4080, 16376\n' })
    )
    expect(withGpu).toMatchObject({ os: 'windows', gpu: { kind: 'nvidia', vramBytes: 16376 * 1024 * 1024 }, budgetSource: 'vram' })
    const without = await detectHardware(fakeDeps({ platform: 'win32', cpu: 'Intel', totalmem: 16 * GiB }, {}))
    expect(without).toMatchObject({ gpu: { kind: 'unknown' }, gpuBudgetBytes: null, budgetSource: 'unknown' })
  })
})

describe('推奨 (adviseOf)', () => {
  const ready = (version: string, h: HardwareProfile = m5) => runtimeOf(advice, h, version, true)

  it('この Mac (M5 / 24GB): 先頭は gpt-oss:20b の 128k、MLX の 26b は載らない', () => {
    const r = adviseOf(advice, m5, ready('0.40.16'), [], new Map())
    expect(r.cpuOnly).toBe(false)
    expect(r.picks.map((p) => [p.model, p.context])).toEqual([
      ['gpt-oss:20b', 131072],
      ['gemma4:12b-mlx', 16384],
      ['qwen3:14b', 32768]
    ])
    expect(r.picks.every((p) => p.action === 'pull')).toBe(true)
  })
  it('MLX を動かせない古い版では MLX のモデルを出さない', () => {
    const r = adviseOf(advice, m5, ready('0.30.0'), [], new Map())
    expect(r.picks.some((p) => p.nativeFormat)).toBe(false)
  })
  it('64GB の Mac は MoE の 35b が先頭', () => {
    const big: HardwareProfile = { ...m5, memoryBytes: 64 * GiB, gpuBudgetBytes: 48 * GiB }
    expect(adviseOf(advice, big, ready('0.40.16', big), [], new Map()).picks[0]?.model).toBe('qwen3.6:35b-a3b-coding-nvfp4')
  })
  it('NVIDIA: VRAM に全部載るものだけ (MLX は出さない)', () => {
    const r16 = adviseOf(advice, nvidia(16), ready('0.40.16', nvidia(16)), [], new Map())
    expect(r16.picks[0]?.model).toBe('gpt-oss:20b')
    expect(r16.picks.some((p) => p.nativeFormat)).toBe(false)
    const r8 = adviseOf(advice, nvidia(8), ready('0.40.16', nvidia(8)), [], new Map())
    expect(r8.picks.map((p) => p.model)).toEqual(['qwen3:4b'])
  })
  it('GPU が分からなければ CPU の見込み (メモリの 75%)', () => {
    const cpu: HardwareProfile = { ...nvidia(8), gpu: { kind: 'unknown', name: null, vramBytes: null }, gpuBudgetBytes: null, budgetSource: 'unknown' }
    expect(budgetOf(advice, cpu)).toEqual({ bytes: 48 * GiB, cpuOnly: true })
  })
  it('取得済み → 派生モデルを作る、作った文脈長が推奨と同じなら済み', () => {
    const installed = adviseOf(advice, m5, ready('0.40.16'), ['gpt-oss:20b'], new Map())
    expect(installed.picks[0]).toMatchObject({ installed: true, tunedModel: 'aios-gpt-oss:20b', tunedContext: null, action: 'tune' })
    const stale = adviseOf(advice, m5, ready('0.40.16'), ['gpt-oss:20b', 'aios-gpt-oss:20b'], new Map([['aios-gpt-oss:20b', 32768]]))
    expect(stale.picks[0]).toMatchObject({ tunedContext: 32768, action: 'tune' })
    const done = adviseOf(advice, m5, ready('0.40.16'), ['gpt-oss:20b', 'aios-gpt-oss:20b'], new Map([['aios-gpt-oss:20b', 131072]]))
    expect(done.picks[0]?.action).toBeNull()
  })
  it('実行系が応答しなければ操作を出さない', () => {
    const r = adviseOf(advice, m5, runtimeOf(advice, m5, null, false), [], new Map())
    expect(r.runtime.reachable).toBe(false)
    expect(r.picks.length).toBeGreaterThan(0)
    expect(r.picks.every((p) => p.action === null)).toBe(true)
  })
  it('/api/show の parameters から num_ctx', () => {
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

/** A fake Ollama. pull / create only record the call and return success. */
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

  it('おすすめ: 入っているものと派生モデルの文脈長を見る。何も書き換えない', async () => {
    const o = fakeOllama(['gpt-oss:20b', 'aios-gpt-oss:20b'], { 'aios-gpt-oss:20b': 131072 })
    const adapter = new OpenCodeAdapter({ link, env, fetch: o.fetch, hardware }, table)
    const r = await adapter.localModels!.advise(false)
    expect(r?.runtime).toEqual({ reachable: true, version: '0.40.16', nativeFormat: true })
    expect(r?.picks[0]).toMatchObject({ model: 'gpt-oss:20b', installed: true, tunedContext: 131072, action: null })
    expect(o.calls.some((c) => c.url.endsWith('/api/pull') || c.url.endsWith('/api/create'))).toBe(false)
  })

  it('押した「取得」: おすすめにある名前だけ pull する', async () => {
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

  it('押した「派生モデルを作る」: FROM + num_ctx。取得していなければ断る', async () => {
    const o = fakeOllama(['gpt-oss:20b'])
    const adapter = new OpenCodeAdapter({ link, env, fetch: o.fetch, hardware }, table)
    expect(await adapter.localModels!.act('tune', 'gpt-oss:20b')).toEqual({ ok: true })
    expect(o.calls.find((c) => c.url.endsWith('/api/create'))?.body).toEqual({
      model: 'aios-gpt-oss:20b',
      from: 'gpt-oss:20b',
      parameters: { num_ctx: 131072 },
      stream: false
    })
    const notYet = await adapter.localModels!.act('tune', 'gemma4:12b-mlx')
    expect(notYet.ok).toBe(false)
  })

  it('実行系が応答しなければ断る', async () => {
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

describe('派生モデルの文脈長を provider の limit に', () => {
  it('contexts のあるモデルだけ limit (context と output)', () => {
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

describe('読み込めないモデル = 壊れたダウンロードの案内 (TODO 1066)', () => {
  const real = 'mlx runner failed: Error: layer 5: missing attention q/o projections'
  it('実物の失敗の文 (2026-10-31) は Ollama のモデルのときだけ当たる。派生モデルは元の名前に戻す', () => {
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
  it('壊れた印のある取得済みモデルは「取り直し」(pull) になり、派生モデルの作成より先', () => {
    const runtime = runtimeOf(advice, m5, '0.40.16', true)
    const r = adviseOf(advice, m5, runtime, ['gpt-oss:20b', 'aios-gpt-oss:20b'], new Map([['aios-gpt-oss:20b', 131072]]), new Set(['gpt-oss:20b']))
    expect(r.picks[0]).toMatchObject({ model: 'gpt-oss:20b', installed: true, broken: true, action: 'pull' })
    expect(r.picks[1]).toMatchObject({ broken: false })
    // An item that was not fetched does not get the broken mark
    expect(adviseOf(advice, m5, runtime, [], new Map(), new Set(['gpt-oss:20b'])).picks[0]?.broken).toBe(false)
  })
  it('失敗を見るとアダプターが覚え、取得が成功しただけでは消えず、そのモデルで会話が読み込めたら消える。自動では取得しない', async () => {
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
  it('走っている操作の軽い口は何も問い合わせない (取得の進み具合だけ返す)', () => {
    const o = fakeOllama(['gemma4:12b-mlx'])
    const adapter = new OpenCodeAdapter({ env: { OLLAMA_HOST: 'http://ollama.test:11434' }, fetch: o.fetch, hardware: async () => m5 }, table)
    expect(adapter.localModels!.activity()).toEqual([])
    const inner = adapter as unknown as { acting: Map<string, string>; progress: Map<string, { completed: number; total: number }> }
    inner.acting.set('gemma4:12b-mlx', 'pull')
    inner.progress.set('gemma4:12b-mlx', { completed: 1, total: 4 })
    expect(adapter.localModels!.activity()).toEqual([{ model: 'gemma4:12b-mlx', running: 'pull', progress: { completed: 1, total: 4 } }])
    expect(o.calls).toEqual([])
  })
  it('接続の切断・メモリ不足でも出る文は壊れた印の語に入れない', () => {
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

describe('取得の進み具合 (TODO 1066)', () => {
  it('parsePullLine: 層の大きさ・error・読めない行', () => {
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
  it('PullTracker: 層ごとに合算し、超えた分は total で頭打ち', () => {
    const t = new PullTracker()
    const line = (digest: string, total: number, completed: number) => parsePullLine(JSON.stringify({ status: 'pulling', digest, total, completed }))!
    expect(t.update(parsePullLine('{"status":"pulling manifest"}')!)).toEqual({ completed: 0, total: 0 })
    expect(t.update(line('a', 100, 10))).toEqual({ completed: 10, total: 100 })
    expect(t.update(line('b', 300, 30))).toEqual({ completed: 40, total: 400 })
    expect(t.update(line('a', 100, 100))).toEqual({ completed: 130, total: 400 })
    expect(t.update(line('b', 300, 999))).toEqual({ completed: 400, total: 400 })
  })
  it('pullModel: stream: true で呼び、行の途中で切れても進み具合を渡し、success で成功', async () => {
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
  it('pullModel: error の行・success が来ない終わり・HTTP の失敗は失敗', async () => {
    const code = (r: Awaited<ReturnType<typeof pullModel>>): string | undefined => parseReason(r.ok ? null : r.code)?.code
    const errored = await pullModel(table, 'http://x', 'm', (async () => streamOf(['{"status":"pulling manifest"}\n{"error":"pull model manifest: file does not exist"}\n'])) as unknown as typeof fetch)
    expect(code(errored)).toBe('local-model-failed')
    const cut = await pullModel(table, 'http://x', 'm', (async () => streamOf(['{"status":"pulling manifest"}\n'])) as unknown as typeof fetch)
    expect(code(cut)).toBe('local-model-failed')
    const http = await pullModel(table, 'http://x', 'm', (async () => new Response('{"error":"nope"}', { status: 500 })) as unknown as typeof fetch)
    expect(code(http)).toBe('local-model-failed')
  })
  it('アダプター: 取得の最中は advise が running と progress を返し、終わったら消える', async () => {
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
