/**
 * OpenCodeAdapter - the second backend (TODO 529 / 768 / 874, ARCHITECTURE 4.6.1).
 *
 * Starts `opencode serve` (HTTP + SSE v2 API) as a child process per session and maps it onto the neutral
 * vocabulary of `AgentAdapter`. The CLI subcommands (auth / models) are not called (calling them brings up a resident service,
 * spike 34). Only the version is read with `--version`. Auth files are not touched (the same discipline as constraint 2).
 *
 * Backend-specific words live only in this directory and `compat/opencode.json` (constraint 6, `npm run lint:terms`).
 *
 * Permissions: OpenCode's permission is set to ask, `permission.asked` is handed to main's approval inbox through
 * `SpawnHandlers.onPermission`, and the answer is returned over HTTP. The MCP gateway (search, openFile, plugin tools) is passed through
 * `mcp` in `OPENCODE_CONFIG_CONTENT`.
 *
 * Approval frame (TODO 1020): tool names are mapped to neutral names (`Bash` / `Edit`) by the table's `permission.actions`; the diff, the rejection text and
 * the outbound-operation decision go through the same optional entry points as Claude (`writePreview` / `approvalReply` / `outboundAction`).
 * It has no plan proposal (`planProposal`) (OpenCode's plan is an agent, and there is no tool to present one).
 *
 * Unsupported (degraded in the feature table): image attachments, thinking levels, rewind, forwarding of subagents, reading transcripts.
 */
import { execFile } from 'node:child_process'
import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  AgentFeature,
  AgentStatus,
  AiosEvent,
  JsonValue,
  ModelChoice,
  SessionStartedPayload,
  ThinkingLevel
} from '@shared/agent.js'
import { AGENT_FEATURES } from '@shared/agent.js'
import { formatReason } from '@shared/reason.js'
import { log } from '../../../common/logger.js'
import type { GrantSubject, OutboundDetail, PersistenceDetail } from '@shared/thread.js'
import { classifyOutbound } from '../../approval/outbound.js'
import { classifyPersistence } from '../../approval/persistence.js'
import { classifyEgress, classifySecretRead, type SecretTable } from '../../approval/secrets.js'
import { grantSubjectFor, type ResolvedGrantPath } from '../../approval/grants.js'
import type { ApprovalReply } from '../../approval/reply.js'
import { formatApprovalReply } from '../../approval/replies.js'
import type {
  AgentAdapter,
  AgentInput,
  LocalModelAdvisor,
  AgentSession,
  PermissionAnswer,
  SpawnHandlers,
  SpawnOptions,
  WritePreview
} from '../types.js'
import { featureMapOf, joinModelId, loadOpenCodeTable, splitModelId, type OpenCodeTable } from './compat.js'
import { OpenCodeEventMapper, type ServerEvent } from './events.js'
import {
  detectOllama,
  ollamaBaseOf,
  notInstalledOf,
  ollamaNoteOf,
  providerNotesOf,
  ollamaProviderOf,
  ollamaRowsOf,
  userConfiguresOllama,
  type LocalModels
} from './local.js'
import { OpenCodeServer, type ServerLink } from './server.js'
import { mcpServersOf, mcpToolNameOf } from './mcp.js'
import { writePreviewOf, writeTargetOf } from './writes.js'
import {
  adviseOf,
  capabilitiesOf,
  nativeProviderOf,
  ollamaVersionOf,
  pullModel,
  runtimeOf,
  tunedContextsOf
} from './advice.js'
import { hardwareProfile } from '../../os/hardware.js'
import type { HardwareProfile, LocalContextBlocker, LocalModelAction, LocalModelActionResult, LocalModelActivityRow, LocalModelAdvice, LocalModelProgress } from '@shared/local-models.js'

/** Paths of the v2 API (spike 34, OpenCode 2.1.4). */
const API = {
  event: '/api/event',
  model: '/api/model',
  session: '/api/session',
  prompt: (id: string) => `/api/session/${encodeURIComponent(id)}/prompt`,
  interrupt: (id: string) => `/api/session/${encodeURIComponent(id)}/interrupt`,
  switchModel: (id: string) => `/api/session/${encodeURIComponent(id)}/model`,
  permissionReply: (id: string, requestId: string) =>
    `/api/session/${encodeURIComponent(id)}/permission/${encodeURIComponent(requestId)}/reply`,
  getSession: (id: string) => `/api/session/${encodeURIComponent(id)}`
} as const

const VERSION_TIMEOUT_MS = 10_000
const MODELS_CACHE_MS = 60_000
/**
 * The shortest interval before the list of MCP servers is fetched again (wave 62 review, TODO 1024). Re-fetching after a failure, an empty list or no match
 * waits this long, so a `GET` round trip is not made on every approval. If a server connects later, names are split at the first separator for this long.
 */
export const MCP_SERVERS_RETRY_MS = 5_000

function runVersion(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: VERSION_TIMEOUT_MS, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout, stderr, ok: err === null })
    })
  })
}

function parseVersion(text: string): string | null {
  const m = /(\d+\.\d+\.\d+)/.exec(text)
  return m?.[1] ?? null
}

function versionAtLeast(version: string, min: string): boolean {
  const a = version.split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false
  }
  return true
}

type Rec = Record<string, unknown>
const rec = (value: unknown): Rec => (typeof value === 'object' && value !== null ? (value as Rec) : {})

/** One row of the list (`GET /api/model`) -> `ModelChoice`. Zero-cost ones get a `free` badge, and `preferred` ones come first. */
export function modelChoicesOf(table: OpenCodeTable, rows: readonly unknown[]): ModelChoice[] {
  const choices: { choice: ModelChoice; free: boolean; rank: number }[] = []
  for (const raw of rows) {
    const row = rec(raw)
    const providerID = typeof row['providerID'] === 'string' ? row['providerID'] : null
    const modelID = typeof row['id'] === 'string' ? row['id'] : null
    if (providerID === null || modelID === null) continue
    if (row['status'] !== undefined && row['status'] !== 'active') continue
    const id = joinModelId({ providerID, id: modelID })
    const name = typeof row['name'] === 'string' && row['name'] !== '' ? row['name'] : modelID
    const cost = Array.isArray(row['cost']) ? rec(row['cost'][0]) : rec(row['cost'])
    const free = cost['input'] === 0 && cost['output'] === 0
    const local = table.models.localProviders.includes(providerID)
    const label = `${providerID}/${name}${free && !local ? table.models.freeSuffix : ''}`
    const rank = table.models.preferred.indexOf(id)
    choices.push({ choice: { id, label, shortLabel: name }, free, rank: rank < 0 ? Number.MAX_SAFE_INTEGER : rank })
  }
  choices.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank
    if (a.free !== b.free) return a.free ? -1 : 1
    return a.choice.label.localeCompare(b.choice.label)
  })
  return choices.map((c) => c.choice)
}

/**
 * The settings passed in `OPENCODE_CONFIG_CONTENT` (gateway + permission + local provider). The catalog serve gets
 * neither the gateway nor the provider (the provider is not added so the catalog list can show whether the user has set it up, TODO 1016).
 */
export function serverConfigOf(
  table: OpenCodeTable,
  gateway: SpawnOptions['gateway'] | null,
  sessionId: string | null,
  local: LocalModels | null = null
): Rec {
  const config: Rec = { permission: { ...table.permission.rules } }
  if (local !== null && local.names.length > 0) {
    config['provider'] = { [table.ollama.providerId]: ollamaProviderOf(table, local) }
  }
  if (gateway !== null && sessionId !== null) {
    config['mcp'] = {
      [table.mcp.serverName]: {
        type: 'local',
        command: [gateway.runtimePath, gateway.scriptPath],
        enabled: true,
        environment: {
          ELECTRON_RUN_AS_NODE: '1',
          AIOS_SOCKET: gateway.socketPath,
          AIOS_TOKEN: gateway.token,
          AIOS_SESSION: sessionId
        },
        timeout: table.mcp.timeoutMs
      }
    }
  }
  return config
}

export interface OpenCodeAdapterOptions {
  /** Test: connect to an already running server instead of starting serve. */
  readonly link?: ServerLink
  readonly command?: string
  readonly env?: NodeJS.ProcessEnv
  /** Test: the fetch that queries Ollama's `/api/tags`. */
  readonly fetch?: typeof fetch
  /** TODO 1066: the runtime environment (a fake value in tests). The default is the OS layer's `hardwareProfile`. */
  readonly hardware?: (force: boolean) => Promise<HardwareProfile>
  /**
   * TODO 1315: the app's root (`app.getAppPath()`: the repository in dev and in the shell, `Contents/Resources/app` in the distributed app).
   * The bundled native provider is looked up only at the table's fixed path under it. Without it, the OpenAI-compatible provider is used.
   */
  readonly appPath?: string
}

/**
 * TODO 1315: the bundled native provider as a `file://` URL, or why it cannot be used (pure apart from the file check).
 * The path is the table's fixed `bundle` under the app's root; no setting or environment variable can point it elsewhere.
 */
export function nativeBundleOf(
  table: OpenCodeTable,
  appPath: string | undefined,
  exists: (path: string) => boolean = readableFile
): { readonly url: string } | { readonly url: null; readonly reason: 'no-table' | 'no-app-path' | 'missing'; readonly path?: string } {
  const native = table.ollama.native
  if (native === undefined) return { url: null, reason: 'no-table' }
  if (appPath === undefined || appPath === '') return { url: null, reason: 'no-app-path' }
  const path = join(appPath, native.bundle)
  if (!exists(path)) return { url: null, reason: 'missing', path }
  // pathToFileURL escapes spaces and the like (`Application Support`, a user name with spaces).
  return { url: pathToFileURL(path).href }
}

function readableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.R_OK)
    const st = statSync(path)
    return st.isFile() && st.size > 0
  } catch {
    return false
  }
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly id: string
  readonly label: string
  readonly transcripts = null
  private readonly table: OpenCodeTable
  private status: AgentStatus | null = null
  private inFlight: Promise<AgentStatus> | null = null
  /** The serve for the model list (no gateway). Started the first time it is needed and stopped by `shutdown`. */
  private catalog: OpenCodeServer | null = null
  private models: { at: number; list: readonly ModelChoice[] } | null = null
  /**
   * The local provider that aios adds (TODO 1016). null means "do not add" (there is no Ollama, or the user's
   * settings already have one). `listModels` decides it together with the catalog list.
   */
  private local: LocalModels | null = null
  private readonly listeners = new Set<() => void>()
  private readonly sessions = new Set<OpenCodeSession>()
  private closed = false
  /** TODO 1066: recommendations for this PC (only when the table has `ollamaAdvice`). */
  readonly localModels: LocalModelAdvisor | undefined
  /** TODO 1066: models on which a fetch or derived-model creation is running (the same one is not run twice). */
  private readonly acting = new Map<string, LocalModelAction>()
  /** TODO 1066: fetch progress (model name -> total bytes). */
  private readonly progress = new Map<string, LocalModelProgress>()
  /** TODO 1066: models that could not be loaded (remembered only while running). A successful fetch does not clear it; it is cleared once a conversation could load that model. */
  private readonly broken = new Set<string>()
  /** TODO 1315: the bundled native provider (looked up once; null = fall back to `/v1`). undefined = not looked up yet. */
  private nativeBundle: string | null | undefined = undefined
  /** TODO 1315: the backend version the "too old for the native provider" line was logged for (logged once per version). */
  private nativeTooOldLogged: string | null = null
  /** Whether the user's own Ollama provider settings (or list row) were found by the last `listModels`. */
  private ownProvider = false

  constructor(
    private readonly options: OpenCodeAdapterOptions = {},
    table: OpenCodeTable = loadOpenCodeTable()
  ) {
    this.table = table
    this.id = table.backend.id
    this.label = table.backend.label
    this.localModels =
      table.ollamaAdvice === undefined
        ? undefined
        : { advise: (force) => this.adviseLocal(force), act: (action, model) => this.actLocal(action, model), activity: () => this.activityLocal() }
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetch ?? fetch
  }

  /**
   * TODO 1315: the bundled native provider's `file://` URL if it can be used now, else null (the OpenAI-compatible `/v1` is used).
   * Needs the bundle under the app's root and a backend at least `native.minVersion` (the loading path is the backend's internals).
   * Each fallback is logged once (structured, no values except the path).
   */
  private nativeUrl(): string | null {
    return this.nativeState().url
  }

  /** The native provider's URL, or why it is not used (`bundle-missing` / `backend-old`). */
  private nativeState(): { readonly url: string; readonly blocker: null } | { readonly url: null; readonly blocker: LocalContextBlocker } {
    const native = this.table.ollama.native
    const missing = { url: null, blocker: { kind: 'bundle-missing' } } as const
    if (native === undefined) return missing
    if (this.nativeBundle === undefined) {
      const found = nativeBundleOf(this.table, this.options.appPath)
      this.nativeBundle = found.url
      if (found.url === null) log.warn('backend.ollama.native-unavailable', { backend: this.id, reason: found.reason, ...(found.path === undefined ? {} : { path: found.path }) })
    }
    if (this.nativeBundle === null) return missing
    const version = this.status?.version ?? null
    if (version === null || !versionAtLeast(version, native.minVersion)) {
      if (version !== null && this.nativeTooOldLogged !== version) {
        this.nativeTooOldLogged = version
        log.warn('backend.ollama.native-version', { backend: this.id, version, minVersion: native.minVersion })
      }
      return { url: null, blocker: { kind: 'backend-old', minVersion: native.minVersion } }
    }
    return { url: this.nativeBundle, blocker: null }
  }

  /**
   * TODO 1066 / 1315: the local provider for the detected models. Derived models' own context lengths (`/api/show`) always; with the native
   * provider also the per-request context length (this PC's recommendation) and `think` (capabilities). Bounded: `/api/show` has a time-out and
   * a hardware probe failure only drops the context length.
   */
  private async localOf(detected: LocalModels): Promise<LocalModels> {
    const url = this.nativeUrl()
    if (url === null) return { ...detected, contexts: await tunedContextsOf(this.table, detected, this.fetchImpl), native: null }
    const [tuned, capabilities, hardware] = await Promise.all([
      tunedContextsOf(this.table, detected, this.fetchImpl),
      capabilitiesOf(this.table, detected, this.fetchImpl),
      (this.options.hardware ?? hardwareProfile)(false).catch(() => null)
    ])
    const native = nativeProviderOf(this.table, detected.names, capabilities, hardware, url)
    return { ...detected, contexts: new Map([...tuned, ...native.contexts]), native }
  }

  /** TODO 1066: runtime environment + Ollama version and installed models -> recommendations. Rewrites nothing. */
  private async adviseLocal(force: boolean): Promise<LocalModelAdvice | null> {
    const advice = this.table.ollamaAdvice
    if (advice === undefined) return null
    const env = this.options.env ?? process.env
    const [hardware, local] = await Promise.all([
      (this.options.hardware ?? hardwareProfile)(force),
      detectOllama(this.table, env, this.options.fetch),
      // The backend version decides whether the native provider is used (cached after the first detection).
      this.getStatus().catch(() => null),
      // Whether the user's own provider settings are used is decided there (cached). A failure leaves it as "not configured".
      this.listModels().catch(() => [])
    ])
    const version = local === null ? null : await ollamaVersionOf(this.table, local.base, this.fetchImpl)
    const runtime = runtimeOf(advice, hardware, version, local !== null)
    // The user's own provider wins: the app's provider is not added, so no context length is sent whatever the bundle says.
    // Only the global settings are visible here (the panel has no conversation folder); a folder's own provider is not.
    const blocker: LocalContextBlocker | null = this.ownProvider ? { kind: 'own-provider' } : this.nativeState().blocker
    return adviseOf(advice, hardware, runtime, local?.names ?? [], blocker, this.broken, {
      running: this.acting,
      progress: this.progress
    })
  }

  /** TODO 1066: only the running operations and their progress. Probes nothing (for the once-a-second refresh). */
  private activityLocal(): readonly LocalModelActivityRow[] {
    return [...this.acting].map(([model, running]) => ({ model, running, progress: running === 'pull' ? (this.progress.get(model) ?? null) : null }))
  }

  /**
   * TODO 1066: the operation the user pressed. The value from the renderer is re-validated against the current recommendations (a name not in the table is not fetched).
   * When it finishes the list is re-fetched (the fetched model and derived models show up in the Model choices).
   */
  private async actLocal(action: LocalModelAction, model: string): Promise<LocalModelActionResult> {
    const advice = await this.adviseLocal(false)
    const pick = advice?.picks.find((p) => p.model === model)
    if (advice === null || pick === undefined) return { ok: false, code: formatReason('local-model-unknown') }
    if (!advice.runtime.reachable) return { ok: false, code: formatReason('local-runtime-down') }
    if (this.acting.has(model)) return { ok: false, code: formatReason('local-model-busy') }
    this.acting.set(model, action)
    const base = ollamaBaseOf(this.table, this.options.env ?? process.env)
    log.info('backend.local.action', { backend: this.id, action })
    try {
      const result = await pullModel(this.table, base, pick.model, this.fetchImpl, (p) => this.progress.set(pick.model, p))
      if (!result.ok) log.warn('backend.local.action.failed', { backend: this.id, action })
      // Even if a fetch succeeds, "broken" is not cleared (Ollama skips layers whose files exist, so a broken layer can remain).
      // It is cleared when a conversation could load that model (`onModelLoaded`). aios does not delete models (`ollama rm` is only shown as guidance in text).
      if (this.models !== null) this.models = { ...this.models, at: 0 }
      await this.listModels().catch(() => undefined)
      return result
    } finally {
      this.acting.delete(model)
      this.progress.delete(model)
    }
  }

  /**
   * TODO 1066 / 1315: the window (the denominator of the pie chart): the context length sent with every request (native provider), or a derived
   * model's own `num_ctx`. Otherwise unknown (null).
   */
  contextWindow(model: string): number | null {
    const split = splitModelId(model)
    if (split === null || split.providerID !== this.table.ollama.providerId) return null
    return this.local?.contexts?.get(split.id) ?? null
  }

  supports(feature: AgentFeature): boolean {
    return featureMapOf(this.table)[feature]
  }

  async getStatus(force = false): Promise<AgentStatus> {
    if (!force && this.status !== null) return this.withNotes(this.status)
    if (this.inFlight === null) {
      this.inFlight = this.detect().finally(() => {
        this.inFlight = null
      })
    }
    const status = await this.inFlight
    // The settings "re-detect" (force) also re-fetches the list and aligns the provider guidance with the current auth state (the catalog serve starts).
    if (force && status.available) {
      // The cache is only expired (listeners are notified only when it changed from the previous list).
      if (this.models !== null) this.models = { ...this.models, at: 0 }
      await this.listModels().catch(() => undefined)
    }
    return this.withNotes(status)
  }

  /**
   * TODO 529 stage 2: attaches provider guidance when it is usable. "Usable" is decided from the catalog list (the `listModels` cache), so
   * the state is built each time it is returned, not on every detection (if the list arrives later, the next display fixes it). The catalog serve is not started here.
   */
  private withNotes(status: AgentStatus): AgentStatus {
    if (!status.available) return status
    const notes = providerNotesOf(this.table, this.models?.list.map((m) => m.id) ?? null)
    return notes.length === 0 ? status : { ...status, notes }
  }

  private async detect(): Promise<AgentStatus> {
    const checkedAt = Date.now()
    const command = this.options.command ?? this.table.command
    const result = this.options.link !== undefined ? { stdout: '0.0.0-test', stderr: '', ok: true } : await runVersion(command, this.table.versionArgs)
    const version = parseVersion(result.stdout)
    const features = featureMapOf(this.table)
    if (version === null) {
      const none = Object.fromEntries(AGENT_FEATURES.map((f) => [f, false])) as AgentStatus['features']
      this.status = {
        available: false,
        version: null,
        loggedIn: false,
        authMethod: null,
        subscriptionType: null,
        features: none,
        degradations: [],
        source: 'unavailable',
        needsProbe: false,
        checkedAt,
        // When it is not found (stderr is empty), a code with install instructions (TODO 1019). If stderr has content, its diagnostic text is used as is.
        message: result.stderr.trim() || notInstalledOf(this.table, this.label),
        messageCode: result.stderr.trim() === '' ? notInstalledOf(this.table, this.label) : null
      }
      log.warn('backend.unavailable', { backend: this.id })
      return this.status
    }
    const tooOld = !versionAtLeast(version, this.table.minVersion)
    // TODO 1019: one line (`message`) for Ollama's state. In tests (with link) it is not queried if there is no fetch.
    const note =
      this.options.link !== undefined && this.options.fetch === undefined
        ? null
        : ollamaNoteOf(this.table, await detectOllama(this.table, this.options.env ?? process.env, this.options.fetch))
    this.status = {
      available: true,
      version,
      // Free models can be used without logging in (spike 34). Authentication per provider is owned by OpenCode itself.
      loggedIn: true,
      authMethod: null,
      subscriptionType: null,
      features: tooOld ? (Object.fromEntries(AGENT_FEATURES.map((f) => [f, false])) as AgentStatus['features']) : features,
      degradations: tooOld
        ? AGENT_FEATURES.map((feature) => ({
            feature,
            reason: `バージョンが古すぎます (必要: ${this.table.minVersion} 以上、検出: ${version})`,
            code: formatReason('agent-version-too-old', { minVersion: this.table.minVersion, version })
          }))
        : [],
      source: 'known-version',
      needsProbe: false,
      checkedAt,
      message: note,
      messageCode: note
    }
    log.info('backend.detected', { backend: this.id, version })
    return this.status
  }

  private catalogServer(): OpenCodeServer {
    if (this.catalog === null) {
      this.catalog = new OpenCodeServer(
        this.table,
        { cwd: process.cwd(), config: serverConfigOf(this.table, null, null), command: this.options.command, env: this.options.env },
        this.options.link ?? null
      )
    }
    return this.catalog
  }

  async listModels(): Promise<readonly ModelChoice[]> {
    if (this.closed) return []
    if (this.models !== null && Date.now() - this.models.at < MODELS_CACHE_MS) return this.models.list
    const status = await this.getStatus()
    if (!status.available) return []
    try {
      const server = this.catalogServer()
      const [res, userConfig, detected] = await Promise.all([
        server.api('GET', API.model),
        server.api('GET', this.table.ollama.userConfig.path),
        detectOllama(this.table, this.options.env ?? process.env, this.options.fetch)
      ])
      const data = rec(res.json)['data']
      let rows: unknown[] = Array.isArray(data) ? [...data] : []
      const isOllamaRow = (row: unknown): boolean => rec(row)['providerID'] === this.table.ollama.providerId
      // If the user has configured a provider themselves, respect it and do not add one (env overrides baseURL).
      // TODO 1078: decide from the user's settings. A row in the list also appears with 2.1.4's auto-detection (it cannot be used in a session).
      // Only on versions where the settings cannot be read (and which do not auto-detect), decide by the list row as before.
      const configured =
        (userConfig.status === 200 ? userConfiguresOllama(this.table, userConfig.json) : null) ?? rows.some(isOllamaRow)
      this.ownProvider = configured
      this.local = !configured && detected !== null && detected.names.length > 0 ? await this.localOf(detected) : null
      // If not configured, the Ollama row in the list comes from auto-detection. It cannot be resolved in a conversation, so remove it and replace it with aios's row
      // (so the same model does not appear twice).
      if (!configured) rows = rows.filter((row) => !isOllamaRow(row))
      if (this.local !== null) rows.push(...ollamaRowsOf(this.table, this.local))
      const list = modelChoicesOf(this.table, rows)
      const changed = this.models === null || JSON.stringify(this.models.list) !== JSON.stringify(list)
      this.models = { at: Date.now(), list }
      if (changed) for (const listener of this.listeners) listener()
      return list
    } catch (err) {
      log.warn('backend.models.failed', { backend: this.id, message: (err as Error).message })
      return this.models?.list ?? []
    }
  }

  onModelsChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  modelLabel(model: string): string | null {
    return this.models?.list.find((m) => m.id === model)?.label ?? null
  }

  modelIdForReported(model: string): string | null {
    return this.models?.list.some((m) => m.id === model) ? model : null
  }

  /** TODO 1020: the target of a write tool (draft conflicts, writes outside the conversation). The name is the one after mapping with `actions`. */
  writeToolTargetPath(toolName: string, input: unknown): string | null {
    return writeTargetOf(this.table, toolName, input)
  }

  /** TODO 1020: the diff in the approval frame (item 97). The argument keys are the table's `writes`. */
  writePreview(toolName: string, input: unknown): WritePreview | null {
    return writePreviewOf(this.table, toolName, input)
  }

  /**
   * TODO 1020: the text returned to the model on rejection (the table's `approvalReplies`). An empty string means "attach no message" - OpenCode
   * turns that into a DeclinedError and stops the turn (the same as "Reject" in the interactive UI).
   */
  approvalReply(reply: ApprovalReply): string | null {
    return formatApprovalReply(this.table.approvalReplies, reply)
  }

  /** TODO 1020 (959): whether this is an outbound operation. The vocabulary and the decision are shared with Claude; only the shell tool names come from the table's `outbound`. */
  outboundAction(toolName: string, input: unknown): OutboundDetail | null {
    return classifyOutbound(this.table.outbound, toolName, input)
  }

  /** TODO 1043: whether the call reads secrets (the table's `secrets`). The decision is shared with Claude. */
  secretReadAction(toolName: string, input: unknown): string | null {
    const table = this.secretTable()
    return table === null ? null : (classifySecretRead(table, toolName, input)?.match ?? null)
  }

  /** TODO 1043: whether this is a route out (asked in a conversation that read secrets). */
  egressAction(toolName: string, input: unknown): string | null {
    const table = this.secretTable()
    return table === null ? null : classifyEgress(table, toolName, input)
  }

  /** TODO 983 stage 2: there is no tool that can be declared read-only (the `tool` rows are not applied). */
  isReadOnlyTool(): boolean {
    return false
  }

  /** TODO 983: the subject of the role permission table (4.2.5 item 3). The decision is shared with Claude; tool names and keys come from the table's `outbound` / `secrets` (after mapping). */
  grantSubjectOf(toolName: string, input: unknown, resolve?: (raw: string) => ResolvedGrantPath | null): GrantSubject | null {
    const secrets = this.table.secrets
    return grantSubjectFor(
      {
        shellTools: this.table.outbound.shellTools,
        commandField: this.table.outbound.commandField,
        readTools: secrets?.readTools ?? [],
        pathKeys: secrets?.pathKeys ?? [],
        fetchTools: secrets?.egressTools ?? [],
        urlField: 'url',
        readOnlyTools: [],
        writeTools: this.table.writes.tools
      },
      toolName,
      input,
      // A patch can span several files (`writeTargetOf` returns only the first), so it is not made a path row (wave 89 automatic security review).
      typeof input === 'object' && input !== null && typeof (input as Record<string, unknown>)[this.table.writes.patch] === 'string'
        ? null
        : this.writeToolTargetPath(toolName, input),
      resolve
    )
  }

  private secretTable(): SecretTable | null {
    const secrets = this.table.secrets
    if (secrets === undefined) return null
    return {
      shellTools: this.table.outbound.shellTools,
      commandField: this.table.outbound.commandField,
      readTools: secrets.readTools,
      pathKeys: secrets.pathKeys,
      egressTools: secrets.egressTools,
      mcpPrefix: this.table.outbound.mcpPrefix,
      ...(secrets.paths === undefined ? {} : { paths: secrets.paths })
    }
  }

  /** TODO 1042: whether the write would persist or bypass a choke point. The decision is shared with Claude; only OpenCode's settings locations come from the table's `persistence`. */
  persistenceAction(toolName: string, input: unknown, resolve?: (path: string) => readonly string[]): PersistenceDetail | null {
    return classifyPersistence(
      {
        shellTools: this.table.outbound.shellTools,
        commandField: this.table.outbound.commandField,
        ...(this.table.persistence === undefined ? {} : { paths: this.table.persistence.paths })
      },
      toolName,
      input,
      this.writeToolTargetPath(toolName, input),
      resolve
    )
  }

  /**
   * The settings passed to the session's serve. The list is fetched first (cached) to decide the local provider.
   * TODO 1078: the list decision sees only the global settings via the catalog serve (no working folder). If `server` (the conversation's folder
   * session serve) is passed, the conversation folder's settings are also queried with a directory, and if a provider is there, it is not added
   * (because the env baseURL would override the user's baseURL). If it cannot be fetched or the response is empty, it falls toward adding.
   */
  async sessionConfigOf(options: SpawnOptions, server?: OpenCodeServer): Promise<Rec> {
    await this.listModels()
    const local = this.local
    if (local !== null && server !== undefined && (await this.folderConfiguresOllama(server, options.cwd))) {
      return serverConfigOf(this.table, options.gateway, options.sessionId, null)
    }
    return serverConfigOf(this.table, options.gateway, options.sessionId, local)
  }

  /** TODO 1078: whether the conversation folder's settings (the session's serve, with a directory) have an Ollama provider. */
  private async folderConfiguresOllama(server: OpenCodeServer, cwd: string): Promise<boolean> {
    try {
      const res = await server.api('GET', this.table.ollama.userConfig.path, undefined, cwd)
      return res.status === 200 && userConfiguresOllama(this.table, res.json) === true
    } catch {
      return false
    }
  }

  async spawn(options: SpawnOptions, handlers: SpawnHandlers): Promise<AgentSession> {
    if (this.closed) throw new Error('backend adapter is shut down')
    // TODO 982: this backend has no drill launch (no narrowing of its tools and permission rules), so a drill never starts here.
    if (options.drill === true) throw new Error('drill launch is not available for this backend')
    const serverOf = (config: Rec): OpenCodeServer =>
      new OpenCodeServer(
        this.table,
        { cwd: options.cwd, config, command: this.options.command, env: this.options.env },
        this.options.link ?? null
      )
    const config = await this.sessionConfigOf(options)
    let server = serverOf(config)
    if (config['provider'] !== undefined) {
      // TODO 1078: if the conversation folder has a user provider, restart with settings that omit aios's provider.
      const checked = await this.sessionConfigOf(options, server)
      if (checked['provider'] === undefined) {
        log.info('backend.ollama.folder-configured', { sessionId: options.sessionId })
        await server.stop()
        server = serverOf(checked)
      }
    }
    const session = new OpenCodeSession(
      this.table,
      server,
      options,
      handlers,
      () => this.status?.version ?? null,
      (model) => {
        this.broken.add(model)
        log.warn('backend.local.broken', { backend: this.id })
      },
      (model) => this.broken.delete(model)
    )
    this.sessions.add(session)
    try {
      await session.open()
    } catch (err) {
      this.sessions.delete(session)
      await server.stop()
      throw err
    }
    session.onClosed(() => this.sessions.delete(session))
    return session
  }

  async shutdown(): Promise<void> {
    this.closed = true
    await Promise.all([...this.sessions].map((session) => session.stop()))
    if (this.catalog !== null) await this.catalog.stop()
    this.catalog = null
  }
}

/** One session = one serve + one OpenCode session + one SSE stream. */
class OpenCodeSession implements AgentSession {
  readonly sessionId: string
  readonly switchRestart = 'never' as const
  private backendSessionId: string | null = null
  private mapper: OpenCodeEventMapper | null = null
  private unsubscribe: (() => void) | null = null
  private seq = 0
  private sawResult = false
  private requested = false
  private exited = false
  private readonly closedListeners = new Set<() => void>()
  /** The turn currently running (from sending the prompt until `result`). */
  private running = false
  private readonly answeredPermissions = new Set<string>()
  /**
   * TODO 1024: this serve's MCP server names (to split a permission request's action). Fetched at the first MCP request. A failure is also
   * remembered as `servers: null`, and it is not re-fetched for `MCP_SERVERS_RETRY_MS` from `at`.
   */
  private mcpServers: { readonly servers: readonly string[] | null; readonly at: number } | null = null
  /** The list being fetched right now (so concurrent approvals do not stack `GET`s). */
  private mcpServersInflight: Promise<void> | null = null

  constructor(
    private readonly table: OpenCodeTable,
    private readonly server: OpenCodeServer,
    private readonly options: SpawnOptions,
    private readonly handlers: SpawnHandlers,
    private readonly backendVersion: () => string | null,
    private readonly onModelBroken: (model: string) => void = () => undefined,
    private readonly onModelLoaded: (model: string) => void = () => undefined
  ) {
    this.sessionId = options.sessionId
  }

  get alive(): boolean {
    return !this.exited
  }

  onClosed(listener: () => void): void {
    this.closedListeners.add(listener)
  }

  private newId(): string {
    return `${this.sessionId}:${(this.seq += 1)}`
  }

  private emit(event: AiosEvent): void {
    if (this.exited) return
    this.handlers.onEvent(event)
  }

  private error(message: string, origin: 'spawn' | 'stream' | 'protocol'): void {
    this.emit({
      id: this.newId(),
      sessionId: this.sessionId,
      threadId: this.options.threadId,
      ts: Date.now(),
      actor: 'main',
      kind: 'error',
      payload: { message, code: null, origin }
    })
  }

  /** Starts serve and creates the session (for a resume, checks the existing one). Emits `session_started`. */
  async open(): Promise<void> {
    const { options } = this
    await this.server.ensure()
    this.server.onExit(() => this.finish(null))
    const model = options.modelId === null ? null : splitModelId(options.modelId)
    let resumed = false
    if (options.resumeBackendSessionId !== null) {
      const existing = await this.server.api('GET', API.getSession(options.resumeBackendSessionId), undefined, options.cwd)
      if (existing.status === 200) {
        this.backendSessionId = options.resumeBackendSessionId
        resumed = true
        if (model !== null) await this.server.api('POST', API.switchModel(this.backendSessionId), { model }, options.cwd)
      } else {
        log.warn('backend.session.resume-missing', { sessionId: this.sessionId, status: existing.status })
      }
    }
    if (this.backendSessionId === null) {
      const created = await this.server.api(
        'POST',
        API.session,
        { location: { directory: options.cwd }, ...(model === null ? {} : { model }) },
        options.cwd
      )
      const id = rec(rec(created.json)['data'])['id'] ?? rec(created.json)['id']
      if (created.status >= 300 || typeof id !== 'string') {
        throw new Error(`backend session was not created (${created.status})`)
      }
      this.backendSessionId = id
    }
    const backendSessionId = this.backendSessionId
    this.mapper = new OpenCodeEventMapper(this.table, {
      sessionId: this.sessionId,
      threadId: options.threadId,
      backendSessionId,
      now: () => Date.now(),
      newId: () => this.newId(),
      modelId: options.modelId,
      onModelBroken: this.onModelBroken,
      onModelLoaded: this.onModelLoaded
    })
    this.unsubscribe = this.server.subscribe(API.event, options.cwd, (ev) => this.onServerEvent(ev))
    const payload: SessionStartedPayload = {
      backendSessionId,
      backendVersion: this.backendVersion(),
      model: options.modelId,
      cwd: options.cwd,
      reportedPermissionMode: null,
      tools: [],
      toolServers: [this.table.mcp.serverName],
      resumed
    }
    this.emit({
      id: this.newId(),
      sessionId: this.sessionId,
      threadId: options.threadId,
      ts: Date.now(),
      actor: 'main',
      kind: 'session_started',
      payload
    })
  }

  private onServerEvent(ev: ServerEvent): void {
    if (this.exited || this.mapper === null) return
    const mapped = this.mapper.map(ev)
    for (const event of mapped.events) this.emit(event)
    if (mapped.ended) {
      this.sawResult = true
      this.running = false
    }
    if (mapped.ask !== null) void this.answerPermission(mapped.ask)
  }

  /** `permission.asked` -> approval inbox -> reply over HTTP (TODO 529). */
  private async answerPermission(ask: NonNullable<ReturnType<OpenCodeEventMapper['map']>['ask']>): Promise<void> {
    if (this.backendSessionId === null || this.answeredPermissions.has(ask.requestId)) return
    this.answeredPermissions.add(ask.requestId)
    const toolName = ask.mcp
      ? await this.mcpToolName(ask.action)
      : (this.table.permission.actions[ask.action] ?? ask.action)
    // The denial count (`result.denials`) also uses the same name as the approval inbox (wave 62 review).
    this.mapper?.resolveAskedToolName(ask.requestId, toolName)
    if (this.exited) return
    let answer: PermissionAnswer
    try {
      answer =
        this.handlers.onPermission === undefined
          ? { allowed: true, message: '' }
          : await this.handlers.onPermission({ toolName, input: ask.input as JsonValue, toolUseId: ask.toolUseId })
    } catch (err) {
      answer = { allowed: false, message: (err as Error).message }
    }
    if (this.exited) return
    const decision = answer.allowed ? this.table.permission.reply.allow : this.table.permission.reply.deny
    const res = await this.server.api(
      'POST',
      API.permissionReply(this.backendSessionId, ask.requestId),
      { decision, ...(answer.allowed || answer.message === '' ? {} : { message: answer.message }) },
      this.options.cwd
    )
    if (res.status >= 300) log.warn('backend.permission.reply-failed', { sessionId: this.sessionId, status: res.status })
  }

  /**
   * TODO 1024: an MCP tool's action (`<server>_<tool>`) -> the approval inbox name (`mcp__<server>__<tool>`). The server name is split using this serve's
   * list (if it cannot be split, re-fetch the list and try only once more. A server can connect later).
   */
  private async mcpToolName(action: string): Promise<string> {
    // One approval fetches at most once. It fetches the first time and when enough time has passed since a failure or an empty result was remembered; a re-fetch after a failed split
    // also happens only when enough time has passed since the last fetch (wave 62 review).
    const due = (): boolean => this.mcpServers === null || Date.now() - this.mcpServers.at >= MCP_SERVERS_RETRY_MS
    let fetched = false
    const empty = this.mcpServers === null || this.mcpServers.servers === null || this.mcpServers.servers.length === 0
    if (empty && due()) {
      await this.lookupMcpServers()
      fetched = true
    }
    let name = mcpToolNameOf(this.table, action, this.mcpServers?.servers ?? null)
    if (!fetched && !this.mcpServerKnown(name) && due()) {
      await this.lookupMcpServers()
      name = mcpToolNameOf(this.table, action, this.mcpServers?.servers ?? null)
    }
    return name
  }

  /** Fetches and remembers the server list (a failure is `servers: null`). If called concurrently, they wait on a single `GET`. */
  private lookupMcpServers(): Promise<void> {
    this.mcpServersInflight ??= this.server
      .api('GET', this.table.permission.mcp.serversPath, undefined, this.options.cwd)
      .then((res) => (res.status >= 200 && res.status < 300 ? mcpServersOf(res.json) : null))
      .catch(() => null)
      .then((servers) => {
        // Even on failure, the previously fetched list is not discarded (only the time advances, so it is not re-fetched right away).
        this.mcpServers = { servers: servers ?? this.mcpServers?.servers ?? null, at: Date.now() }
      })
      .finally(() => {
        this.mcpServersInflight = null
      })
    return this.mcpServersInflight
  }

  private mcpServerKnown(toolName: string): boolean {
    const { mcpPrefix, mcpSeparator } = this.table.outbound
    return (this.mcpServers?.servers ?? []).some((server) => toolName.startsWith(`${mcpPrefix}${server}${mcpSeparator}`))
  }

  send(input: AgentInput): void {
    if (this.exited || this.backendSessionId === null) return
    this.running = true
    // Fix from the TODO 1115 review: the two-argument form `.then(ok, rejected)`. The previous `.then(…).catch(…)` had the catch pick up an exception
    // inside `promptRejected` in the ok branch (thrown by the receiver's onEvent) and call `promptRejected` a second time,
    // emitting error + result twice. Only a POST failure goes to rejected; an exception inside the synthesis is only logged.
    void this.server
      .api('POST', API.prompt(this.backendSessionId), { text: input.text }, this.options.cwd)
      .then(
        (res) => {
          if (res.status >= 300 || res.status === 0) this.promptRejected(`prompt was not accepted (${res.status})`)
        },
        (err: unknown) => this.promptRejected(`prompt was not accepted (${(err as Error).message})`)
      )
      .catch((err: unknown) => {
        log.warn('backend.prompt.rejectEmitFailed', { sessionId: this.sessionId, message: (err as Error).message })
      })
  }

  /**
   * TODO 1115: for a prompt that was not accepted, emit not only `error` but also a `result` with `ok: false`. Without a `result`,
   * the session's `awaitingResult` stays set, every later send becomes queued, and stopping (`interrupt` does nothing when `running` is false)
   * and eviction also stop working.
   */
  private promptRejected(message: string): void {
    if (this.exited) return
    this.running = false
    if (this.mapper === null) {
      this.error(message, 'stream')
      return
    }
    for (const event of this.mapper.rejectedPrompt(message).events) this.emit(event)
    this.sawResult = true
  }

  async interrupt(): Promise<void> {
    if (this.exited || this.backendSessionId === null) return
    if (!this.running) return
    this.mapper?.markInterrupt()
    const res = await this.server.api('POST', API.interrupt(this.backendSessionId), undefined, this.options.cwd)
    if (res.status >= 300 || res.status === 0) throw new Error(`interrupt was not accepted (${res.status})`)
  }

  abort(): void {
    // There is no way to stop the whole process (serve lives as long as the session). Only the turn is stopped.
    void this.interrupt().catch(() => undefined)
  }

  async switchSettings(target: { readonly modelId: string | null; readonly thinking: ThinkingLevel | null }): Promise<boolean> {
    if (this.exited || this.backendSessionId === null) return false
    if (target.modelId === null) return true
    const model = splitModelId(target.modelId)
    if (model === null) return false
    const res = await this.server.api('POST', API.switchModel(this.backendSessionId), { model }, this.options.cwd)
    return res.status < 300 && res.status !== 0
  }

  async stop(): Promise<void> {
    if (this.exited) return
    this.requested = true
    await this.server.stop()
    this.finish(null)
  }

  private finish(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const listener of this.closedListeners) listener()
    if (!this.sawResult && !this.requested) {
      this.handlers.onEvent({
        id: `${this.sessionId}:exit`,
        sessionId: this.sessionId,
        threadId: this.options.threadId,
        ts: Date.now(),
        actor: 'main',
        kind: 'error',
        payload: { message: formatReason('agent-exited-without-result'), code: code === null ? null : String(code), origin: 'exit' }
      })
    }
    this.handlers.onExit({ code, signal: null, sawResult: this.sawResult, requested: this.requested })
  }
}

/** A neutral factory for the composition root. null if the table cannot be read (not registered). */
export function createOpenCodeAdapter(options: OpenCodeAdapterOptions = {}): AgentAdapter | null {
  try {
    return new OpenCodeAdapter(options)
  } catch (err) {
    log.warn('backend.table.missing', { message: (err as Error).message })
    return null
  }
}
