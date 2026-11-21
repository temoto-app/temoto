/**
 * Local Ollama "recommendations for this PC" (TODO 1066, ARCHITECTURE 4.6.1.2).
 *
 * From the runtime environment (`HardwareProfile`, probed by the OS layer) and the recommendation table (`ollamaAdvice` in `compat/opencode.json`),
 * decides which model, quantization and context length fit. **Fetching (`pull`) and creating a derived model (`create`) happen only when the user presses the button**
 * (owner decision 2026-10-31). aios never rewrites Ollama's settings.
 *
 * The context length cannot be passed through the OpenAI-compatible `/v1` (measured in wave 80), so a derived model
 * `<tunedPrefix><model>` with `FROM <model>` + `num_ctx` is created (the weights are not copied). If a derived model exists,
 * the same value goes into the provider's `limit`.
 */
import type {
  HardwareProfile,
  LocalModelAction,
  LocalModelActionResult,
  LocalModelAdvice,
  LocalModelPick,
  LocalModelProgress,
  LocalRuntimeInfo
} from '@shared/local-models.js'
import { formatReason } from '@shared/reason.js'
import type { OllamaAdviceTable, OpenCodeTable } from './compat.js'
import type { LocalModels } from './local.js'

type Rec = Record<string, unknown>
const rec = (value: unknown): Rec => (typeof value === 'object' && value !== null ? (value as Rec) : {})

/** Unit for table sizes (GB = 10^9 bytes). */
const GB = 1e9

/** `a >= b` (compares only the x.y.z numbers). */
export function versionAtLeast(a: string, b: string): boolean {
  const x = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const y = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return true
}

/**
 * The upper bound (bytes) used for the recommendation, and whether the model does not fit on the GPU (runs on the CPU).
 * Unified memory: the smaller of the GPU limit and memory x (1 - memoryHeadroom) (measured 2026-10-31: loading 18.7GB on a 24GB machine swapped).
 * VRAM: VRAM x (1 - vramHeadroom) (the model must fit entirely in VRAM; if it overflows it falls back to the CPU and is extremely slow).
 * Unknown: memory x (1 - memoryHeadroom), expected to run on the CPU.
 */
export function budgetOf(advice: OllamaAdviceTable, hardware: HardwareProfile): { readonly bytes: number; readonly cpuOnly: boolean } {
  const memory = Math.floor(hardware.memoryBytes * (1 - advice.memoryHeadroom))
  if (hardware.gpuBudgetBytes === null) return { bytes: memory, cpuOnly: true }
  if (hardware.budgetSource === 'vram') return { bytes: Math.floor(hardware.gpuBudgetBytes * (1 - advice.vramHeadroom)), cpuOnly: false }
  return { bytes: Math.min(hardware.gpuBudgetBytes, memory), cpuOnly: false }
}

export function tunedNameOf(advice: OllamaAdviceTable, model: string): string {
  return `${advice.tunedPrefix}${model}`
}

/** Runtime state (the version, and whether GPU-only formats can run). */
export function runtimeOf(advice: OllamaAdviceTable, hardware: HardwareProfile, version: string | null, reachable: boolean): LocalRuntimeInfo {
  const apple = hardware.appleChip !== null
  return {
    reachable,
    version,
    // With no response the version is unknown. On Apple Silicon, report it as expected to fit (the fetch button is not shown).
    nativeFormat: apple && (version === null ? !reachable : versionAtLeast(version, advice.nativeFormatMinVersion))
  }
}

/** Whether `name` is in the set of names (with and without `:latest` are treated as the same). */
function hasModel(names: ReadonlySet<string>, name: string): boolean {
  return names.has(name) || (!name.includes(':') && names.has(`${name}:latest`))
}

/**
 * Builds the recommendation (pure function). `installed` is the names from `/api/tags` (empty if there is no response); `tunedContexts` maps a derived model's name to
 * the context length it was created with (`/api/show`).
 */
export function adviseOf(
  advice: OllamaAdviceTable,
  hardware: HardwareProfile,
  runtime: LocalRuntimeInfo,
  installed: readonly string[],
  tunedContexts: ReadonlyMap<string, number>,
  /** TODO 1066: models that could not be loaded (re-fetching is recommended even if they were already fetched). */
  broken: ReadonlySet<string> = new Set(),
  /** TODO 1066: the operations currently running and fetch progress (model name -> ...). */
  activity: { readonly running: ReadonlyMap<string, LocalModelAction>; readonly progress: ReadonlyMap<string, LocalModelProgress> } = {
    running: new Map(),
    progress: new Map()
  }
): LocalModelAdvice {
  const budget = budgetOf(advice, hardware)
  const names = new Set(installed)
  const steps = [...advice.contextSteps].sort((a, b) => b - a)
  const picks: LocalModelPick[] = []
  for (const row of advice.models) {
    if (picks.length >= advice.maxPicks) break
    if (row.nativeFormat && !runtime.nativeFormat) continue
    // GPU-only formats do not run on the CPU.
    if (row.nativeFormat && budget.cpuOnly) continue
    const sizeAt = (context: number): number => Math.ceil((row.baseGb + (row.kvGbPer1k * context) / 1000) * GB)
    const context = steps.find((step) => step <= row.maxContext && step >= advice.minContext && sizeAt(step) <= budget.bytes)
    if (context === undefined) continue
    const tunedModel = tunedNameOf(advice, row.model)
    const isInstalled = runtime.reachable && hasModel(names, row.model)
    const tunedContext = runtime.reachable && hasModel(names, tunedModel) ? (tunedContexts.get(tunedModel) ?? null) : null
    const isBroken = isInstalled && broken.has(row.model)
    picks.push({
      model: row.model,
      tunedModel,
      context,
      estimatedBytes: sizeAt(context),
      format: row.format,
      nativeFormat: row.nativeFormat,
      moe: row.moe,
      installed: isInstalled,
      tunedContext,
      broken: isBroken,
      running: activity.running.get(row.model) ?? null,
      progress: activity.progress.get(row.model) ?? null,
      // Creating a derived model from a model that cannot be loaded would not work. Re-fetch first.
      action: !runtime.reachable ? null : !isInstalled || isBroken ? 'pull' : tunedContext !== context ? 'tune' : null
    })
  }
  return { hardware, runtime, budgetBytes: budget.bytes, cpuOnly: budget.cpuOnly, picks, defaultContext: advice.defaultContext }
}

/** Reads an integer value from the `parameters` of `/api/show` (one per line, a name followed by a value) (pure function). null if absent. */
export function parameterOf(text: string, key: string): number | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+(\S+)/.exec(line)
    if (match?.[1] !== key) continue
    const value = Number(match[2])
    return Number.isInteger(value) && value > 0 ? value : null
  }
  return null
}

/** `/api/version` -> the version. null if there is no response. */
export async function ollamaVersionOf(table: OpenCodeTable, base: string, fetchImpl: typeof fetch): Promise<string | null> {
  const advice = table.ollamaAdvice
  if (advice === undefined) return null
  try {
    const res = await fetchImpl(`${base}${advice.versionPath}`, { signal: AbortSignal.timeout(table.ollama.timeoutMs) })
    if (!res.ok) return null
    const version = rec(await res.json())['version']
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

/** Reads the context length of derived models (names starting with `tunedPrefix`) via `/api/show`. Ones that cannot be read are left out. */
export async function tunedContextsOf(table: OpenCodeTable, local: LocalModels, fetchImpl: typeof fetch): Promise<Map<string, number>> {
  const advice = table.ollamaAdvice
  const out = new Map<string, number>()
  if (advice === undefined) return out
  const tuned = local.names.filter((name) => name.startsWith(advice.tunedPrefix))
  await Promise.all(
    tuned.map(async (name) => {
      try {
        const res = await fetchImpl(`${local.base}${advice.showPath}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: name }),
          signal: AbortSignal.timeout(advice.showTimeoutMs)
        })
        if (!res.ok) return
        const text = rec(await res.json())[advice.showParametersKey]
        const context = typeof text === 'string' ? parameterOf(text, advice.contextParameter) : null
        if (context !== null) out.set(name, context)
      } catch {
        // If it cannot be read, treat it as a derived model with unknown context length (no limit is set).
      }
    })
  )
  return out
}

/** The `limit` added to the provider's `models.<name>` (OpenCode's schema requires both context and output). */
export function limitOf(advice: OllamaAdviceTable, context: number): Rec {
  return { context, output: Math.max(1, Math.floor(context * advice.outputFraction)) }
}

/** Calls `/api/pull` / `/api/create` once (no streaming). Success is `status: success`. */
async function postOnce(base: string, path: string, body: Rec, timeoutMs: number, fetchImpl: typeof fetch): Promise<LocalModelActionResult> {
  try {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, stream: false }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    const json = rec(await res.json().catch(() => null))
    if (res.ok && json['status'] === 'success') return { ok: true }
    const error = typeof json['error'] === 'string' ? json['error'] : `HTTP ${res.status}`
    return { ok: false, code: formatReason('local-model-failed', { message: error.slice(0, 300) }) }
  } catch (err) {
    return { ok: false, code: formatReason('local-model-failed', { message: (err as Error).message.slice(0, 300) }) }
  }
}

/** One line (NDJSON) of the `/api/pull` stream. null for a line that cannot be read. The shape follows Ollama's API docs (not pulled against the real thing = an estimate). */
export interface PullLine {
  readonly status: string
  readonly digest: string | null
  readonly total: number
  readonly completed: number
  readonly error: string | null
}

export function parsePullLine(line: string): PullLine | null {
  const text = line.trim()
  if (text === '') return null
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  const r = rec(json)
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  return {
    status: typeof r['status'] === 'string' ? r['status'] : '',
    digest: typeof r['digest'] === 'string' && r['digest'] !== '' ? r['digest'] : null,
    total: num(r['total']),
    completed: num(r['completed']),
    error: typeof r['error'] === 'string' ? r['error'] : null
  }
}

/** Sums total / completed per layer (digest) into the overall fetch progress. */
export class PullTracker {
  private readonly layers = new Map<string, { total: number; completed: number }>()

  /** Takes in a line and returns the progress (the total). If there are only lines with no size (manifest, etc.), total is 0. */
  update(line: PullLine): LocalModelProgress {
    if (line.digest !== null && line.total > 0) {
      this.layers.set(line.digest, { total: line.total, completed: Math.min(line.completed, line.total) })
    }
    let total = 0
    let completed = 0
    for (const layer of this.layers.values()) {
      total += layer.total
      completed += layer.completed
    }
    return { completed, total }
  }
}

/**
 * The "fetch" the user pressed. Received as a stream; for each line, passes the summed progress to `onProgress`.
 * `{"status":"success"}` means success; an `{"error":…}` or ending without a success line means failure.
 */
export async function pullModel(
  table: OpenCodeTable,
  base: string,
  model: string,
  fetchImpl: typeof fetch,
  onProgress?: (progress: LocalModelProgress) => void
): Promise<LocalModelActionResult> {
  const advice = table.ollamaAdvice
  if (advice === undefined) return { ok: false, code: formatReason('local-model-unknown') }
  const failed = (message: string): LocalModelActionResult => ({ ok: false, code: formatReason('local-model-failed', { message: message.slice(0, 300) }) })
  try {
    const res = await fetchImpl(`${base}${advice.pullPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal: AbortSignal.timeout(advice.pullTimeoutMs)
    })
    if (!res.ok || res.body === null) {
      const json = rec(await res.json().catch(() => null))
      return failed(typeof json['error'] === 'string' ? json['error'] : `HTTP ${res.status}`)
    }
    const tracker = new PullTracker()
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    let success = false
    const handle = (raw: string): string | null => {
      const line = parsePullLine(raw)
      if (line === null) return null
      if (line.error !== null) return line.error
      if (line.status === 'success') success = true
      onProgress?.(tracker.update(line))
      return null
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const raw of lines) {
        const error = handle(raw)
        if (error !== null) return failed(error)
      }
    }
    const error = handle(pending + decoder.decode())
    if (error !== null) return failed(error)
    return success ? { ok: true } : failed('the download ended before it finished')
  } catch (err) {
    return failed((err as Error).message)
  }
}

/** The "set context length" the user pressed: creates a derived model with `FROM <model>` + `num_ctx` (recreated if the same name exists). */
export function createTuned(
  table: OpenCodeTable,
  base: string,
  pick: Pick<LocalModelPick, 'model' | 'tunedModel' | 'context'>,
  fetchImpl: typeof fetch
): Promise<LocalModelActionResult> {
  const advice = table.ollamaAdvice
  if (advice === undefined) return Promise.resolve({ ok: false, code: formatReason('local-model-unknown') })
  return postOnce(
    base,
    advice.createPath,
    { model: pick.tunedModel, from: pick.model, parameters: { [advice.contextParameter]: pick.context } },
    advice.createTimeoutMs,
    fetchImpl
  )
}
