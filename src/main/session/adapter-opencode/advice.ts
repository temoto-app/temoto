/**
 * Local Ollama "recommendations for this PC" (TODO 1066, ARCHITECTURE 4.6.1.2).
 *
 * From the runtime environment (`HardwareProfile`, probed by the OS layer) and the recommendation table (`ollamaAdvice` in `compat/opencode.json`),
 * decides which model, quantization and context length fit. **Fetching (`pull`) happens only when the user presses the button**
 * (owner decision 2026-10-31). aios never rewrites Ollama's settings and creates no model in Ollama.
 *
 * TODO 1315: the recommended context length is sent with every request through the native provider (`nativeProviderOf`), with the
 * model's own name. The derived models `<tunedPrefix><model>` that the retired "set context length" button created are only
 * recognized (listed as they are, their own `num_ctx` is read for the window, and the panel says how to remove them).
 */
import type {
  HardwareProfile,
  LocalContextBlocker,
  LocalModelAction,
  LocalModelActionResult,
  LocalModelAdvice,
  LocalModelPick,
  LocalModelProgress,
  LocalRuntimeInfo
} from '@shared/local-models.js'
import { formatReason } from '@shared/reason.js'
import type { OllamaAdviceTable, OpenCodeTable } from './compat.js'
import type { LocalModels, NativeProvider } from './local.js'

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

/** TODO 1315: whether the name is a derived model made by the retired "set context length" button. */
export function isTunedName(advice: OllamaAdviceTable, name: string): boolean {
  return name.startsWith(advice.tunedPrefix)
}

type AdviceRow = OllamaAdviceTable['models'][number]

/**
 * The largest context step that fits the budget for a table row (`baseGb + kvGbPer1k x context / 1000`), or undefined if even
 * `minContext` does not fit. Shared by the recommendation panel and the context length sent with requests.
 */
function fitContextOf(advice: OllamaAdviceTable, row: AdviceRow, budgetBytes: number): number | undefined {
  const steps = [...advice.contextSteps].sort((a, b) => b - a)
  return steps.find((step) => step <= row.maxContext && step >= advice.minContext && sizeOf(row, step) <= budgetBytes)
}

function sizeOf(row: AdviceRow, context: number): number {
  return Math.ceil((row.baseGb + (row.kvGbPer1k * context) / 1000) * GB)
}

/** The table row for an Ollama name (`foo` and `foo:latest` are the same model). */
function rowOf(advice: OllamaAdviceTable, name: string): AdviceRow | undefined {
  return advice.models.find((row) => row.model === name || (!row.model.includes(':') && name === `${row.model}:latest`))
}

/**
 * TODO 1315: the context length sent with every request for an installed model (pure function) - the same value the panel recommends
 * (`adviseOf`), without the panel's cut-offs (`maxPicks`, hiding MLX models the runtime is not known to run). null when the model is not in
 * the table, is a derived model (its own `num_ctx` applies; sending another would stack two settings), or does not fit even at `minContext`.
 */
export function recommendedContextOf(advice: OllamaAdviceTable, hardware: HardwareProfile, name: string): number | null {
  if (isTunedName(advice, name)) return null
  const row = rowOf(advice, name)
  if (row === undefined) return null
  return fitContextOf(advice, row, budgetOf(advice, hardware).bytes) ?? null
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
 * Builds the recommendation (pure function). `installed` is the names from `/api/tags` (empty if there is no response).
 * `contextBlocker` is null when the recommended context length actually reaches Ollama (TODO 1315: the bundled native provider is
 * in use), else why not; the panel says so. Derived models are only called "no longer needed" when the context length is sent.
 */
export function adviseOf(
  advice: OllamaAdviceTable,
  hardware: HardwareProfile,
  runtime: LocalRuntimeInfo,
  installed: readonly string[],
  contextBlocker: LocalContextBlocker | null,
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
  const picks: LocalModelPick[] = []
  for (const row of advice.models) {
    if (picks.length >= advice.maxPicks) break
    if (row.nativeFormat && !runtime.nativeFormat) continue
    // GPU-only formats do not run on the CPU.
    if (row.nativeFormat && budget.cpuOnly) continue
    const context = fitContextOf(advice, row, budget.bytes)
    if (context === undefined) continue
    const isInstalled = runtime.reachable && hasModel(names, row.model)
    const isBroken = isInstalled && broken.has(row.model)
    picks.push({
      model: row.model,
      context,
      estimatedBytes: sizeOf(row, context),
      format: row.format,
      nativeFormat: row.nativeFormat,
      moe: row.moe,
      installed: isInstalled,
      broken: isBroken,
      running: activity.running.get(row.model) ?? null,
      progress: activity.progress.get(row.model) ?? null,
      action: runtime.reachable && (!isInstalled || isBroken) ? 'pull' : null
    })
  }
  // TODO 1315: derived models left by the retired button. They still work; the panel only says how to remove them.
  const legacyModels = runtime.reachable ? installed.filter((name) => isTunedName(advice, name)) : []
  return {
    hardware,
    runtime,
    budgetBytes: budget.bytes,
    cpuOnly: budget.cpuOnly,
    picks,
    defaultContext: advice.defaultContext,
    contextPerRequest: contextBlocker === null,
    contextBlocker,
    legacyModels
  }
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
  const tuned = local.names.filter((name) => isTunedName(advice, name))
  await Promise.all(
    tuned.map(async (name) => {
      const show = await showOf(local.base, advice.showPath, name, advice.showTimeoutMs, fetchImpl)
      const text = show?.[advice.showParametersKey]
      const context = typeof text === 'string' ? parameterOf(text, advice.contextParameter) : null
      // If it cannot be read, treat it as a derived model with unknown context length (no limit is set).
      if (context !== null) out.set(name, context)
    })
  )
  return out
}

/** `/api/show` for one model. null on any failure or time-out (never throws). */
async function showOf(base: string, path: string, model: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<Rec | null> {
  try {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) return null
    return rec(await res.json())
  } catch {
    return null
  }
}

/**
 * TODO 1315: each model's capabilities. `/api/tags` already lists them (Ollama 0.40); only models without the field are asked
 * through `/api/show`, all at once, each bounded by `native.showTimeoutMs` - a slow or stopped Ollama costs at most that long and
 * never blocks a conversation from starting (a model that cannot be asked just gets no `think`).
 */
export async function capabilitiesOf(table: OpenCodeTable, local: LocalModels, fetchImpl: typeof fetch): Promise<Map<string, readonly string[]>> {
  const out = new Map<string, readonly string[]>(local.capabilities ?? [])
  const native = table.ollama.native
  const showPath = table.ollamaAdvice?.showPath
  if (native === undefined || showPath === undefined) return out
  await Promise.all(
    local.names
      .filter((name) => !out.has(name))
      .map(async (name) => {
        const caps = (await showOf(local.base, showPath, name, native.showTimeoutMs, fetchImpl))?.['capabilities']
        if (Array.isArray(caps)) out.set(name, caps.filter((c): c is string => typeof c === 'string'))
      })
  )
  return out
}

/**
 * TODO 1315: what the native provider sends for the installed models (pure function). `url` is the bundle's `file://` URL.
 * Context length: the recommendation for this PC (`recommendedContextOf`); nothing for models outside the table or derived models.
 * `think: true`: models whose capabilities include thinking. Without `hardware` (could not be probed) no context length is sent.
 */
export function nativeProviderOf(
  table: OpenCodeTable,
  names: readonly string[],
  capabilities: ReadonlyMap<string, readonly string[]>,
  hardware: HardwareProfile | null,
  url: string
): NativeProvider {
  const advice = table.ollamaAdvice
  const thinkingCapability = table.ollama.native?.thinkingCapability
  const contexts = new Map<string, number>()
  const thinking = new Set<string>()
  for (const name of names) {
    const context = advice === undefined || hardware === null ? null : recommendedContextOf(advice, hardware, name)
    if (context !== null) contexts.set(name, context)
    if (thinkingCapability !== undefined && capabilities.get(name)?.includes(thinkingCapability) === true) thinking.add(name)
  }
  return { url, contexts, thinking }
}

/** The `limit` added to the provider's `models.<name>` (OpenCode's schema requires both context and output). */
export function limitOf(advice: OllamaAdviceTable, context: number): Rec {
  return { context, output: Math.max(1, Math.floor(context * advice.outputFraction)) }
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
