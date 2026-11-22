/**
 * TODO 982 / 1292 item 2 (ARCHITECTURE 4.2.5 "drill"): the pure parts of a drill - describing an operation a drill stopped with the
 * smallest fields (what it tried, not its body), reading the stored rows back into what the renderer shows, and finding the calls the
 * backend ran without asking aios. The stop itself is in the gateway (`GatewayRequests`), the bookkeeping in `SessionManager`.
 *
 * Nothing here knows a backend's tool names: every judgment goes through the Adapter's existing entry points (constraint 6).
 */
import type { JsonValue } from '@shared/agent.js'
import type { DrillGrantRefusal, DrillOp, DrillTargetKind } from '@shared/drill.js'
import { GATEWAY_TOOL_PREFIX, type RoleGrantOffer, type RoleGrantSubjectKind } from '@shared/thread.js'
import type { GrantCandidate } from '../approval/grants.js'
import type { AgentAdapter } from './types.js'
import type { StoredDrillOp } from './store.js'
import { resolveToolPath } from './viewer-tools.js'
import { summarize } from './gateway-requests.js'

export interface DrillDescription {
  readonly target: { readonly kind: DrillTargetKind; readonly value: string } | null
  readonly subject: string | null
  readonly size: number | null
}

function objectOf(input: JsonValue): Record<string, JsonValue> {
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, JsonValue>) : {}
}

/** The longest string value among the arguments (the body a write or a send would carry). Only its length is kept. */
function longestString(input: JsonValue): number | null {
  let longest: number | null = null
  const visit = (value: JsonValue, depth: number): void => {
    if (depth > 4) return
    if (typeof value === 'string') {
      if (longest === null || value.length > longest) longest = value.length
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
    } else if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) visit(item, depth + 1)
    }
  }
  visit(input, 0)
  return longest
}

/**
 * The smallest description of what a stopped call tried: a recipient and subject (an outbound operation, 959), the path it would write,
 * the command, the URL, the setting's name - in that order - else the one-line summary the approval frame uses. `size` is the length of
 * the body it carried (never the body). Values are masked and cut by the store (`addDrillOp`), which is the persistence gate.
 */
export function describeDrillStop(adapter: AgentAdapter | undefined, toolName: string, input: JsonValue, cwd: string): DrillDescription {
  const args = objectOf(input)
  const outbound = adapter?.outboundAction?.(toolName, input) ?? null
  if (outbound !== null) {
    const body = outbound.body
    if (outbound.to !== null && outbound.to !== '') {
      return { target: { kind: 'to', value: outbound.to }, subject: outbound.subject, size: body === null ? null : body.length }
    }
    if (outbound.command !== null) return { target: { kind: 'command', value: outbound.command }, subject: outbound.subject, size: body === null ? null : body.length }
  }
  const written = adapter?.writeToolTargetPath?.(toolName, input) ?? null
  if (written !== null) {
    const absolute = resolveToolPath(written, cwd) ?? written
    return { target: { kind: 'path', value: absolute }, subject: null, size: longestString(input) }
  }
  const subject = adapter?.grantSubjectOf?.(toolName, input) ?? null
  if (subject !== null && subject.kind === 'command') return { target: { kind: 'command', value: subject.command }, subject: null, size: null }
  if (typeof args['url'] === 'string' && args['url'] !== '') return { target: { kind: 'url', value: args['url'] }, subject: null, size: null }
  if (toolName === `${GATEWAY_TOOL_PREFIX}setSetting` && typeof args['name'] === 'string') {
    return { target: { kind: 'setting', value: args['name'] }, subject: null, size: null }
  }
  const line = summarize(input)
  return { target: line === '' ? null : { kind: 'tool', value: line }, subject: null, size: longestString(input) }
}

const SUBJECT_KINDS: ReadonlySet<string> = new Set<RoleGrantSubjectKind>(['command-prefix', 'command-exact', 'path-prefix', 'host', 'tool'])

/** Reads a stored candidate list back. Anything that does not have the shape main wrote makes the whole list null (no checkbox). */
export function parseDrillCandidates(json: string | null): readonly GrantCandidate[] | null {
  if (json === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 20) return null
  const out: GrantCandidate[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) return null
    const record = item as Record<string, unknown>
    const kind = record['subjectKind']
    const subject = record['subject']
    const hash = record['subjectHash']
    const access = record['access']
    if (typeof kind !== 'string' || !SUBJECT_KINDS.has(kind) || typeof subject !== 'string' || subject === '') return null
    if (hash !== null && typeof hash !== 'string') return null
    if (access !== null && access !== 'read' && access !== 'write') return null
    out.push({ subjectKind: kind as RoleGrantSubjectKind, subject, subjectHash: hash, access })
  }
  return out
}

const REFUSALS: ReadonlySet<string> = new Set<DrillGrantRefusal>([
  'outbound',
  'persistence',
  'side-effect',
  'secret-read',
  'deny-pattern',
  'no-command',
  'question',
  'plan',
  'unattended',
  'gateway',
  'no-subject',
  'secret',
  'covered',
  'unasked'
])

const TARGET_KINDS: ReadonlySet<string> = new Set<DrillTargetKind>(['path', 'command', 'url', 'to', 'setting', 'tool'])

/** The display form of candidates (no hash), the same as the approval frame's `RoleGrantOffer.subjects`. */
export function offerOf(candidates: readonly GrantCandidate[]): RoleGrantOffer['subjects'] {
  return candidates.map((candidate) => ({
    kind: candidate.subjectKind,
    value: candidate.subject,
    ...(candidate.access === null ? {} : { access: candidate.access })
  }))
}

/** A stored row -> what the renderer shows. Without a live Teammate no op can be allowed (`grant` null). */
export function drillOpView(row: StoredDrillOp, roleAlive: boolean): DrillOp {
  const candidates = parseDrillCandidates(row.grantCandidates)
  const refusal = row.grantRefusal !== null && REFUSALS.has(row.grantRefusal) ? (row.grantRefusal as DrillGrantRefusal) : null
  return {
    id: row.id,
    at: row.at,
    toolName: row.toolName,
    origin: 'stopped',
    target:
      row.targetKind !== null && TARGET_KINDS.has(row.targetKind) && row.target !== null
        ? { kind: row.targetKind as DrillTargetKind, value: row.target }
        : null,
    subject: row.subject,
    size: row.size,
    grant: roleAlive && candidates !== null && row.grantedAt === null ? offerOf(candidates) : null,
    grantRefusal: candidates === null ? (refusal ?? 'no-subject') : null,
    granted: row.grantedAt !== null
  }
}

/**
 * The calls the backend ran **without asking aios** during the drill (its own settings let them through - e.g. the user's CLI allow rules,
 * or what it judges read-only). aios cannot stop those (4.2: aios does not decide what reaches approval), so the list shows them rather than
 * hide them. Tools the Adapter knows to be read-only and aios's own gateway tools (stopped at the tool stage anyway) are left out.
 */
export function unaskedDrillOps(
  adapter: AgentAdapter | undefined,
  events: {
    readonly uses: readonly { readonly toolUseId: string; readonly name: string; readonly input: JsonValue; readonly at: number }[]
    readonly asked: ReadonlySet<string>
    readonly askedWithoutId: ReadonlyMap<string, number>
  },
  cwd: string
): readonly DrillOp[] {
  const withoutId = new Map(events.askedWithoutId)
  const out: DrillOp[] = []
  for (const use of events.uses) {
    if (events.asked.has(use.toolUseId)) continue
    const spare = withoutId.get(use.name) ?? 0
    if (spare > 0) {
      withoutId.set(use.name, spare - 1)
      continue
    }
    if (use.name.startsWith(GATEWAY_TOOL_PREFIX)) continue
    if (adapter?.isReadOnlyTool?.(use.name) === true) continue
    const described = describeDrillStop(adapter, use.name, use.input, cwd)
    out.push({
      id: `unasked:${use.toolUseId}`,
      at: use.at,
      toolName: use.name,
      origin: 'unasked',
      target: described.target,
      subject: described.subject,
      size: described.size,
      grant: null,
      grantRefusal: 'unasked',
      granted: false
    })
  }
  return out
}
