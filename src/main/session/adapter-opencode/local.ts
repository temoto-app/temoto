/**
 * Finds the local Ollama and makes it an OpenCode provider (TODO 1016, ARCHITECTURE 4.6.1).
 *
 * OpenCode has no Ollama as a default provider, so unless the user's `opencode.json` exists,
 * `ollama/gpt-oss:20b` and the like do not appear in the list. aios does not write the user's settings; it adds the provider only to the session serve's
 * `OPENCODE_CONFIG_CONTENT`. Words are looked up from the table (`ollama` in `compat/opencode.json`).
 */
import { formatReason } from '@shared/reason.js'
import { limitOf } from './advice.js'
import { splitModelId, type OpenCodeTable } from './compat.js'

export interface LocalModels {
  /** `http://host:port` (no trailing `/`). */
  readonly base: string
  readonly names: readonly string[]
  /**
   * TODO 1315: `capabilities` per model as listed by `/api/tags` (only the rows that carry the field). A model missing here is
   * asked through `/api/show` when the native provider is used.
   */
  readonly capabilities?: ReadonlyMap<string, readonly string[]>
  /**
   * The context window per model, put into the provider's `limit` (tells OpenCode the window size so compaction timing matches).
   * TODO 1066: for a derived model (a name starting with `ollamaAdvice.tunedPrefix`) it is the `num_ctx` it was created with (`/api/show`).
   * TODO 1315: with the native provider it is also the context length sent with every request (`native.contexts`).
   */
  readonly contexts?: ReadonlyMap<string, number>
  /** TODO 1315: the native provider (Ollama's own API). null / absent = the OpenAI-compatible `/v1` provider. */
  readonly native?: NativeProvider | null
}

/** TODO 1315: what the native provider sends (`ollamaProviderOf` turns it into the model entries). */
export interface NativeProvider {
  /** `file://` URL of the bundled provider (from `pathToFileURL`; spaces and the like are escaped). */
  readonly url: string
  /** Model name -> the context length sent with every request. Only models in the recommendation table; never a derived model. */
  readonly contexts: ReadonlyMap<string, number>
  /** Models whose capabilities include thinking (sent with `think: true`). */
  readonly thinking: ReadonlySet<string>
}

type Rec = Record<string, unknown>
const rec = (value: unknown): Rec => (typeof value === 'object' && value !== null ? (value as Rec) : {})

/** `OLLAMA_HOST` (`0.0.0.0`, `host:port`, `http://host`, etc.) -> `http://host:port`. Aligned with the same default as the CLI. */
export function ollamaBaseOf(table: OpenCodeTable, env: NodeJS.ProcessEnv): string {
  const raw = env[table.ollama.hostEnv]?.trim() ?? ''
  if (raw === '') return table.ollama.defaultHost
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`)
    // 0.0.0.0 means "listen on everything", so as a destination to connect to it is this machine.
    if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = 'localhost'
    if (url.port === '' && url.protocol === 'http:') url.port = String(table.ollama.defaultPort)
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return table.ollama.defaultHost
  }
}

/** `/api/tags` -> the names of models usable in a conversation. null if there is no response or it is broken (not treated as an error). */
export async function detectOllama(
  table: OpenCodeTable,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch
): Promise<LocalModels | null> {
  const base = ollamaBaseOf(table, env)
  try {
    const res = await fetchImpl(`${base}${table.ollama.tagsPath}`, { signal: AbortSignal.timeout(table.ollama.timeoutMs) })
    if (!res.ok) return null
    const models = rec(await res.json())['models']
    if (!Array.isArray(models)) return null
    const names: string[] = []
    const capabilities = new Map<string, readonly string[]>()
    for (const raw of models) {
      const row = rec(raw)
      const name = row['name']
      if (typeof name !== 'string' || name === '') continue
      const caps = row['capabilities']
      if (Array.isArray(caps) && !caps.includes('completion')) continue
      names.push(name)
      if (Array.isArray(caps)) capabilities.set(name, caps.filter((c): c is string => typeof c === 'string'))
    }
    names.sort((a, b) => a.localeCompare(b))
    return { base, names, capabilities }
  } catch {
    return null
  }
}

/**
 * The value put into `provider.<id>` (the shape from spike 34).
 * TODO 1315: with `local.native`, the bundled provider (`file://`) talks to Ollama's own `/api`, and each model entry carries
 * `options: { think?, options: { num_ctx } }` (the nested `options` is what reaches the request body - spike 40). Without it, the
 * OpenAI-compatible provider on `/v1` as before (the context length cannot be sent there).
 */
export function ollamaProviderOf(table: OpenCodeTable, local: LocalModels): Rec {
  const native = local.native ?? null
  const spec = table.ollama.native
  const parameter = table.ollamaAdvice?.contextParameter
  const useNative = native !== null && spec !== undefined
  return {
    npm: useNative ? native.url : table.ollama.npm,
    name: table.ollama.name,
    options: { baseURL: `${local.base}${useNative ? spec.apiPath : table.ollama.apiPath}` },
    models: Object.fromEntries(
      local.names.map((name) => {
        const entry: Rec = { name }
        // The window OpenCode is told and the context length sent are the same value.
        const perRequest = useNative ? native.contexts.get(name) : undefined
        const context = perRequest ?? local.contexts?.get(name)
        const advice = table.ollamaAdvice
        if (context !== undefined && advice !== undefined) entry['limit'] = limitOf(advice, context)
        if (useNative) {
          const options: Rec = {}
          if (native.thinking.has(name)) options[spec.modelOptions.think] = true
          if (perRequest !== undefined && parameter !== undefined) options[spec.modelOptions.options] = { [parameter]: perRequest }
          if (Object.keys(options).length > 0) entry['options'] = options
        }
        return [name, entry]
      })
    )
  }
}

/** The maximum number of model names listed on one line of the settings (the rest becomes an ellipsis). */
const NOTE_MODELS = 3

/**
 * TODO 1019: the one-line Ollama state shown in the OpenCode section (`AgentStatus.messageCode`). Guidance only, nothing is executed.
 * No response -> `ollama-down`; responds but no model usable in a conversation -> `ollama-no-model`; otherwise `ollama-ready`.
 * `pull` is the table's `ollama.pullCommand`.
 */
export function ollamaNoteOf(table: OpenCodeTable, local: LocalModels | null): string {
  const pull = table.ollama.pullCommand
  if (local === null) return formatReason('ollama-down', { pull })
  if (local.names.length === 0) return formatReason('ollama-no-model', { pull })
  const shown = local.names.slice(0, NOTE_MODELS).join(', ')
  return formatReason('ollama-ready', {
    count: local.names.length,
    models: local.names.length > NOTE_MODELS ? `${shown}, …` : shown
  })
}

/**
 * TODO 529 stage 2: one line each of provider guidance (the table's `providerGuides`). `models` is the ids from the catalog list (`<provider>/<model>`);
 * null if not fetched yet (then only the usage guidance). Only models of authenticated providers appear in the list (2.1.4).
 */
export function providerNotesOf(table: OpenCodeTable, models: readonly string[] | null): string[] {
  const guides = table.providerGuides
  if (guides === undefined) return []
  // TODO 1101: login is needed only when using the user's own subscription (free models and local Ollama do not need it).
  const notes: string[] = guides.providers.length > 0 ? [formatReason('provider-intro')] : []
  for (const guide of guides.providers) {
    const count = (models ?? []).filter((id) => guide.providerIds.some((p) => id.startsWith(`${p}/`))).length
    if (count > 0) notes.push(formatReason('provider-ready', { provider: guide.label, count }))
    else if (guide.setup === 'subscription-or-key') {
      notes.push(formatReason('provider-setup-login', { provider: guide.label, command: guides.setupCommand, url: guide.url }))
    } else {
      notes.push(formatReason('provider-setup', { provider: guide.label, command: guides.setupCommand, url: guide.url }))
    }
    if (guide.apiKeyOnly === true) notes.push(formatReason('provider-api-key-only', { provider: guide.label }))
    if (guide.usageUrl !== undefined) notes.push(formatReason('provider-usage', { provider: guide.label, url: guide.usageUrl }))
  }
  return notes
}

/** A numbers-only word (such as 429) matches only when it is not surrounded by alphanumerics or `_` (so it does not match a digit run in a request id). */
function messageHasPattern(lower: string, pattern: string): boolean {
  const p = pattern.toLowerCase()
  if (!/^[0-9]+$/.test(p)) return lower.includes(p)
  return new RegExp(`(?<![0-9a-z_])${p}(?![0-9a-z_])`).test(lower)
}

/**
 * TODO 1102: returns a reason code that adds guidance to the usage page to a failure message that looks like a limit. null if it does not match.
 * `model` is `<provider>/<id>` (the model in use). Only for a provider with the table's `usageUrl`, it checks with the words of `usageLimitPatterns`.
 * If the table is empty or has no words, always null (the matching strings have not been captured on a real machine).
 */
export function usageLimitNoteOf(table: OpenCodeTable, model: string | null, message: string): string | null {
  const guides = table.providerGuides
  const patterns = guides?.usageLimitPatterns ?? []
  if (guides === undefined || model === null || patterns.length === 0) return null
  const guide = guides.providers.find((g) => g.usageUrl !== undefined && g.providerIds.some((p) => model.startsWith(`${p}/`)))
  if (guide?.usageUrl === undefined) return null
  const lower = message.toLowerCase()
  if (!patterns.some((p) => p !== '' && messageHasPattern(lower, p))) return null
  // The original message is not truncated (so the message persisted is not reduced).
  return formatReason('usage-limit', { message, url: guide.usageUrl })
}

/** TODO 1066: the name of the model to fetch for an Ollama model (`<provider>/<id>`) (the original name for a derived model). null if it is not an Ollama one. */
export function baseModelOf(table: OpenCodeTable, model: string): string | null {
  const advice = table.ollamaAdvice
  const split = splitModelId(model)
  if (advice === undefined || split === null || split.providerID !== table.ollama.providerId) return null
  return split.id.startsWith(advice.tunedPrefix) ? split.id.slice(advice.tunedPrefix.length) : split.id
}

/**
 * TODO 1066: whether this is a failure to load the model (possibly a broken download). `model` is `<provider>/<id>` (the model in use).
 * Only for an Ollama model whose message contains a word from the table's `brokenModelPatterns`, returns the name of the model to re-fetch (the original name for a derived model) and
 * a reason code with guidance attached. null if it does not match. The original message is not truncated. Some of the matching words are estimates (the table's `$comment`).
 */
export function brokenModelNoteOf(table: OpenCodeTable, model: string | null, message: string): { readonly model: string; readonly note: string } | null {
  const advice = table.ollamaAdvice
  const patterns = advice?.brokenModelPatterns ?? []
  if (advice === undefined || model === null || patterns.length === 0) return null
  const split = splitModelId(model)
  if (split === null || split.providerID !== table.ollama.providerId) return null
  const lower = message.toLowerCase()
  if (!patterns.some((p) => p !== '' && lower.includes(p.toLowerCase()))) return null
  const base = baseModelOf(table, model) ?? split.id
  return { model: base, note: formatReason('local-model-broken', { message, model: base }) }
}

/** TODO 1019: the reason when the executable is not found (how to install is the table's `install.command`). */
export function notInstalledOf(table: OpenCodeTable, label: string): string {
  return formatReason('backend-not-installed', { backend: label, install: table.install.command })
}

/**
 * TODO 1078: whether the user's settings (the list of settings OpenCode read, the table's `ollama.userConfig`) have an Ollama provider.
 * null if the response shape cannot be read (the caller decides as before by "is there a row in the list").
 * It is not decided by a list row - 2.1.4 finds Ollama by itself and shows it in the list, but that row cannot be resolved in a session.
 */
export function userConfiguresOllama(table: OpenCodeTable, json: unknown): boolean | null {
  const spec = table.ollama.userConfig
  const sources = Array.isArray(json) ? json : rec(json)['data']
  if (!Array.isArray(sources)) return null
  return sources.some((raw) => {
    const source = rec(raw)
    if (source['type'] !== spec.documentType) return false
    // A document with no location comes from env (settings aios itself passed). It is not the user's settings.
    if (typeof source[spec.pathKey] !== 'string') return false
    const info = rec(source[spec.infoKey])
    return spec.providerKeys.some((key) => Object.hasOwn(rec(info[key]), table.ollama.providerId))
  })
}

/** Rows of the same shape as the list (`GET /api/model`). Mixed in and arranged with `modelChoicesOf`. */
export function ollamaRowsOf(table: OpenCodeTable, local: LocalModels): Rec[] {
  return local.names.map((name) => ({ providerID: table.ollama.providerId, id: name, name, cost: [], status: 'active' }))
}
