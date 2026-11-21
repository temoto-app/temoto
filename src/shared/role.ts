/**
 * Roles (TODO 972, ARCHITECTURE 4.3.4). **The user-facing word is "Teammate"**; the identifiers (types, table, columns, keys) stay `role`
 * (owner decision 2026-11-21).
 *
 * A role is the parent of conversations: the things that stay the same across its conversations - name, working folder, standing
 * instructions, default Model / Thinking - are on the role, and a conversation is the disposable unit a role starts (VISION 3).
 * Conversations without a role are allowed and listed as before (no default role is made).
 *
 * Pure types and the input check shared by main and the renderer. Independent of electron and the DOM.
 */
import { isThinkingLevel, type ThinkingLevel } from './agent.js'

/** Upper limit of a role's name. */
export const MAX_ROLE_NAME = 80
/**
 * Upper limit of the standing instructions. They are passed to the backend on every launch of the role's conversations (an argument,
 * not the prompt), so they are kept to a page.
 */
export const MAX_ROLE_INSTRUCTIONS = 4_000

/** One role as the renderer sees it (the working folder is a URI, 12.7). */
export interface Role {
  readonly id: string
  readonly name: string
  /** Working folder (`file://`). null means "no affiliation" (each conversation gets its own scratch area, T19). */
  readonly cwdUri: string | null
  /** The user's standing instructions for every conversation of this role. Empty means none. */
  readonly instructions: string
  /** null means the settings' default model. */
  readonly modelId: string | null
  /** null means the settings' default thinking. */
  readonly thinking: ThinkingLevel | null
  /**
   * TODO 983 stage 4 (owner decision 2026-11-21): every conversation of this role starts in strict mode (by hand and from a scheduled job;
   * a job's own `approvalStrict` is combined with OR). main always sets it; omitted (an older shape) means false.
   */
  readonly approvalStrict?: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

/** What the editor sends to create / update a role. */
export interface RoleInput {
  readonly name: string
  readonly cwdUri: string | null
  readonly instructions: string
  readonly modelId: string | null
  readonly thinking: ThinkingLevel | null
  /** TODO 983 stage 4: start every conversation of the role in strict mode. Omitted means false. */
  readonly approvalStrict?: boolean
}

export type RoleInputProblem = 'invalid-value' | 'role-name-empty'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Code-review (wave 96 fix Y): the standing instructions without control characters other than tab and newline (CR LF / CR become LF).
 * They travel as a process argument, and a NUL there makes `spawn` throw (`ERR_INVALID_ARG_VALUE`), so no conversation of the Teammate
 * could start. Used by the input check and again right before the launch (a row saved before this check existed).
 */
export function cleanRoleInstructions(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[^\P{Cc}\t\n]/gu, '')
}

/** Code-review (wave 96 fix Y): a role's name on one line - control characters (newlines and tabs too) become one space. */
export function cleanRoleName(text: string): string {
  return text.replace(/\p{Cc}+/gu, ' ')
}

/**
 * Checks a role input from the renderer (main calls it again; the working folder is additionally checked by `FsAccess.assertAllowed`).
 * The name is trimmed and cut at `MAX_ROLE_NAME`; the instructions are kept as written (only trailing white space is dropped).
 * Control characters are dropped from both (`cleanRoleName` / `cleanRoleInstructions`) rather than refused: they are invisible in the editor,
 * so refusing would leave the user with an error they cannot see the cause of.
 */
export function validateRoleInput(value: unknown): RoleInput | RoleInputProblem {
  if (!isRecord(value)) return 'invalid-value'
  const rawName = value['name']
  if (typeof rawName !== 'string') return 'invalid-value'
  const name = cleanRoleName(rawName).trim().slice(0, MAX_ROLE_NAME)
  if (name === '') return 'role-name-empty'
  const cwdUri = value['cwdUri'] ?? null
  if (cwdUri !== null && (typeof cwdUri !== 'string' || !cwdUri.startsWith('file:'))) return 'invalid-value'
  const instructions = value['instructions'] ?? ''
  if (typeof instructions !== 'string' || instructions.length > MAX_ROLE_INSTRUCTIONS) return 'invalid-value'
  const modelId = value['modelId'] ?? null
  if (modelId !== null && (typeof modelId !== 'string' || modelId === '' || modelId.length > 200)) return 'invalid-value'
  const thinking = value['thinking'] ?? null
  if (thinking !== null && !isThinkingLevel(thinking)) return 'invalid-value'
  const approvalStrict = value['approvalStrict'] ?? false
  if (typeof approvalStrict !== 'boolean') return 'invalid-value'
  return { name, cwdUri, instructions: cleanRoleInstructions(instructions).trimEnd(), modelId, thinking, approvalStrict }
}

/** An empty draft for the "new Teammate" editor. */
export function emptyRoleInput(): RoleInput {
  return { name: '', cwdUri: null, instructions: '', modelId: null, thinking: null, approvalStrict: false }
}

/** The editable part of a role (for opening the editor on an existing row). */
export function roleInputOf(role: Role): RoleInput {
  return {
    name: role.name,
    cwdUri: role.cwdUri,
    instructions: role.instructions,
    modelId: role.modelId,
    thinking: role.thinking,
    approvalStrict: role.approvalStrict === true
  }
}
