/**
 * Loads the OpenCode table (`compat/opencode.json`) (TODO 529, ARCHITECTURE 4.6.1).
 * Only the table holds backend-specific words (commands, API paths, event type names, setting keys);
 * the code in this directory looks them up by the table's keys (constraint 6, OpenCode edition).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentFeature, AgentFeatureMap } from '@shared/agent.js'
import { AGENT_FEATURES } from '@shared/agent.js'
import type { OutboundTable } from '../../approval/outbound.js'
import type { ApprovalReplyTable } from '../../approval/replies.js'

/** TODO 1066: `ollamaAdvice` in `compat/opencode.json` (the meaning is in the table's `$comment`). */
export interface OllamaAdviceTable {
  readonly versionPath: string
  readonly showPath: string
  readonly pullPath: string
  readonly createPath: string
  readonly showParametersKey: string
  readonly contextParameter: string
  readonly tunedPrefix: string
  readonly nativeFormatMinVersion: string
  readonly defaultContext: number
  readonly minContext: number
  readonly contextSteps: readonly number[]
  readonly memoryHeadroom: number
  readonly vramHeadroom: number
  readonly outputFraction: number
  readonly maxPicks: number
  readonly showTimeoutMs: number
  readonly pullTimeoutMs: number
  readonly createTimeoutMs: number
  /** Words contained in a failure message that says the model cannot be loaded (lowercase substring match, an estimate. May be empty). */
  readonly brokenModelPatterns?: readonly string[]
  readonly models: readonly {
    readonly model: string
    readonly format: string
    readonly nativeFormat: boolean
    readonly moe: boolean
    readonly maxContext: number
    readonly baseGb: number
    readonly kvGbPer1k: number
    readonly source: string
  }[]
}

export interface OpenCodeTable {
  readonly command: string
  readonly minVersion: string
  readonly versionArgs: readonly string[]
  readonly serve: {
    readonly args: readonly string[]
    readonly listeningPattern: string
    readonly passwordEnv: string
    readonly basicUser: string
    readonly configEnv: string
    readonly directoryHeader: string
    readonly startTimeoutMs: number
  }
  readonly backend: { readonly id: string; readonly label: string }
  readonly mcp: { readonly serverName: string; readonly timeoutMs: number }
  readonly permission: {
    readonly rules: Readonly<Record<string, string>>
    readonly reply: { readonly allow: string; readonly deny: string }
    readonly actions: Readonly<Record<string, string>>
    /** TODO 1020: confirmation for a path outside the working folder. `resources` is `<directory><resourceSuffix>`. */
    readonly externalDirectory: { readonly action: string; readonly resourceSuffix: string }
    /**
     * TODO 1024: permission request for an MCP tool (action `<server>_<tool>`, the arguments are in `metadata[inputKey]`). The approval inbox name is
     * `outbound.mcpPrefix` + server + `outbound.mcpSeparator` + tool. The server name is looked up with serve's `serversPath`.
     */
    readonly mcp: {
      readonly inputKey: string
      readonly actionSeparator: string
      readonly sanitizePattern: string
      readonly serversPath: string
    }
  }
  /** TODO 1020: keys of the arguments of write tools (diff in the approval frame, draft conflicts). */
  readonly writes: {
    readonly tools: readonly string[]
    readonly pathKeys: readonly string[]
    readonly replace: { readonly old: string; readonly new: string; readonly all: string }
    readonly overwrite: string
    readonly patch: string
    readonly patchFilePattern: string
  }
  /** TODO 1020: the text returned to the model on rejection. An empty string means "attach no message" (= OpenCode stops the turn). */
  readonly approvalReplies: ApprovalReplyTable
  /** TODO 1020: the backend-specific words in the outbound-operation decision (the vocabulary is in `compat/outbound.json`). */
  readonly outbound: OutboundTable
  /** TODO 1042: write destinations that would persist, that are specific to OpenCode (settings and the plugin location). The shared table is `compat/outbound.json`. */
  readonly persistence?: { readonly paths: Readonly<Record<string, readonly string[]>> }
  /** TODO 1043: words specific to OpenCode among the marks for conversations that read secrets and the routes out. */
  readonly secrets?: {
    readonly readTools: readonly string[]
    readonly pathKeys: readonly string[]
    readonly egressTools: readonly string[]
    readonly paths?: Readonly<Record<string, readonly string[]>>
  }
  readonly events: {
    readonly connected: string
    readonly executionStarted: string
    readonly executionEnded: readonly string[]
    readonly executionInterrupted: string
    readonly executionFailed: string
    readonly stepStarted: string
    readonly stepEnded: string
    readonly stepFailed: string
    readonly textDelta: string
    readonly textEnded: string
    readonly reasoningDelta: string
    readonly toolInputStarted: string
    readonly toolCalled: string
    readonly toolSuccess: string
    readonly toolError: string
    readonly permissionAsked: string
    readonly permissionReplied: string
    readonly modelSelected: string
    readonly mcpStatusChanged: string
    readonly compacted: string
    readonly mcpToolCarrier: string
  }
  readonly models: {
    readonly preferred: readonly string[]
    readonly freeSuffix: string
    readonly localProviders: readonly string[]
  }
  readonly ollama: {
    readonly providerId: string
    readonly name: string
    readonly npm: string
    readonly hostEnv: string
    readonly defaultHost: string
    readonly defaultPort: number
    readonly tagsPath: string
    readonly apiPath: string
    readonly timeoutMs: number
    /** TODO 1078: how to read whether the user's settings have a provider (`GET /api/config`). */
    readonly userConfig: {
      readonly path: string
      readonly documentType: string
      /** Key of the location of the file that was read. A document without it comes from env (`OPENCODE_CONFIG_CONTENT`), so it is not counted. */
      readonly pathKey: string
      readonly infoKey: string
      readonly providerKeys: readonly string[]
    }
    readonly pullCommand: string
    readonly installUrl: string
  }
  /** TODO 1066: recommendations for this PC (the recommendation table, and the entry points for fetching and derived models). If absent, no recommendations are shown. */
  readonly ollamaAdvice?: OllamaAdviceTable
  readonly install: { readonly command: string; readonly url: string }
  /** TODO 529 stage 2: provider guidance in the settings section (guidance only, nothing is executed). */
  readonly providerGuides?: {
    readonly setupCommand: string
    readonly providers: readonly {
      readonly label: string
      readonly providerIds: readonly string[]
      readonly url: string
      /** TODO 1101: 'subscription-or-key' = subscription login or an API key. If absent, guidance for API key only. */
      readonly setup?: 'subscription-or-key'
      /** TODO 1101: adds a note for providers that do not use subscription login. */
      readonly apiKeyOnly?: boolean
      /** TODO 1102: the usage page. For providers that have one, guidance is added (aios does not read the window). */
      readonly usageUrl?: string
    }[]
    /** TODO 1102: words contained in a limit-failure message (lowercase substring match). May be empty or absent. */
    readonly usageLimitPatterns?: readonly string[]
  }
  readonly features: Partial<Record<AgentFeature, boolean>>
}

function candidateDirs(): readonly string[] {
  const here = fileURLToPath(new URL('.', import.meta.url))
  return [
    join(here, '../../../../compat'), // src/main/session/adapter-opencode → repo/compat (dev, vitest)
    join(here, '../../compat'), // out/main → repo/compat (build)
    join(process.cwd(), 'compat')
  ]
}

let cached: OpenCodeTable | null = null

export function loadOpenCodeTable(): OpenCodeTable {
  if (cached !== null) return cached
  const errors: string[] = []
  for (const dir of candidateDirs()) {
    const file = join(dir, 'opencode.json')
    try {
      cached = JSON.parse(readFileSync(file, 'utf8')) as OpenCodeTable
      return cached
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`)
    }
  }
  throw new Error(`opencode table not found\n${errors.join('\n')}`)
}

/** For tests. */
export function setOpenCodeTableForTest(table: OpenCodeTable | null): void {
  cached = table
}

/** Expands the table's `features` into the table of all features (keys that are missing are false). */
export function featureMapOf(table: OpenCodeTable): AgentFeatureMap {
  const out = {} as Record<AgentFeature, boolean>
  for (const feature of AGENT_FEATURES) out[feature] = table.features[feature] === true
  return out
}

/** `<providerID>/<modelID>` <-> `{ providerID, id }`. The provider is everything up to the first `/` (the model id may contain `/`). */
export function splitModelId(id: string): { readonly providerID: string; readonly id: string } | null {
  const at = id.indexOf('/')
  if (at <= 0 || at === id.length - 1) return null
  return { providerID: id.slice(0, at), id: id.slice(at + 1) }
}

export function joinModelId(model: { readonly providerID: string; readonly id: string }): string {
  return `${model.providerID}/${model.id}`
}
