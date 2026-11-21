/**
 * The handoff text for "lighten and continue in a new conversation" (TODO 961). A pure function shared by main (assembly and send) and the renderer (the band's threshold).
 *
 * - The material is the same `ExportTurn` as the conversation export (TODO 818): only the text of the user's messages and the parent's answers (tool_use /
 *   tool_result / thinking / subagents are not included). The body is already redacted (the same path as `SessionManager.exportTurns`).
 * - **No summarizing.** Only when it is too large, it is cut mechanically (`HANDOFF_MAX_TOKENS`):
 *   1. If one message or answer exceeds `HANDOFF_TEXT_MAX_TOKENS`, keep the head, drop the rest, and write the amount dropped.
 *   2. If the whole still exceeds the limit, keep the first turn (the first request) and as many turns from the newest side as fit,
 *      and replace the turns in between with one line saying "questions a to b (n questions) are in the original conversation".
 *   3. If the newest turn alone exceeds the limit, drop the first turn too and cut the newest turn at the limit.
 * - Token counts are estimates (`estimateTokens`): ASCII counts 1 per 3.5 characters, everything else 1 per character (counting on the upper side, same as the measurement of TODO 961).
 * - The preface to the model is a fixed English sentence (independent of the display language; the model reads the conversation's language from the body).
 */
import type { ExportTurn } from './conversation-export.js'

/** The conversation size at which the band shows "lighten and continue in a new conversation" (the total input of the last call, the owner decision of TODO 961). */
export const HANDOFF_MIN_CONVERSATION_TOKENS = 150_000
/** Whether the conversation size C (estimated tokens) is at or above the threshold for offering a handoff (TODO 996: the band's look and the handoff button use the same decision). */
export function offersHandoff(conversationTokens: number): boolean {
  return conversationTokens >= HANDOFF_MIN_CONVERSATION_TOKENS
}
/** The limit of the handoff text (estimated tokens). Twice the median S (about 1.5 x 10^4) of conversations with C >= 300 thousand. */
export const HANDOFF_MAX_TOKENS = 30_000
/** The limit for one message or answer (estimated tokens). */
export const HANDOFF_TEXT_MAX_TOKENS = 6_000

/** The estimated token count. ASCII is 1 per 3.5 characters, everything else 1 per character. */
export function estimateTokens(text: string): number {
  let ascii = 0
  let other = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) ascii += 1
    else other += 1
  }
  return Math.ceil(ascii / 3.5 + other)
}

/** Keeps `max` tokens (estimated) from the head. Unchanged if not over. */
function cutHead(text: string, max: number): { text: string; omitted: number } {
  const total = estimateTokens(text)
  if (total <= max) return { text, omitted: 0 }
  let used = 0
  let end = 0
  for (const ch of text) {
    used += ch.charCodeAt(0) < 0x80 ? 1 / 3.5 : 1
    if (used > max) break
    end += ch.length
  }
  const kept = text.slice(0, end)
  return { text: kept, omitted: Math.max(0, total - estimateTokens(kept)) }
}

function capText(text: string, max: number): string {
  const cut = cutHead(text, max)
  return cut.omitted === 0 ? cut.text : `${cut.text}\n\n[… about ${cut.omitted} tokens omitted]`
}

/** The Markdown of one turn. */
function turnBlock(turn: ExportTurn): string {
  const lines: string[] = []
  const label = turn.number > 0 ? `Turn ${turn.number}` : 'Before the first message'
  if (turn.question !== null) {
    lines.push(`## ${label} — User`, '', capText(turn.question.text, HANDOFF_TEXT_MAX_TOKENS), '')
  }
  for (const answer of turn.answers) {
    lines.push(`### ${label} — Assistant`, '', capText(answer, HANDOFF_TEXT_MAX_TOKENS), '')
  }
  return lines.join('\n')
}

/**
 * The reason for handing off (TODO 1018). `lighten` is 961's "lighten and continue in a new conversation", and `switch-backend` is when a model of
 * another backend was chosen in the Model picker and the thread branched (the original conversation was with a different agent). Only one sentence of the preface differs.
 */
export type HandoffPurpose = 'lighten' | 'switch-backend'

function header(title: string, purpose: HandoffPurpose): string {
  const why =
    purpose === 'switch-backend'
      ? '. That conversation was held with a different coding agent; it continues here with you.'
      : ' to save context.'
  return [
    '# Earlier conversation (carried over)',
    '',
    `The text below is the earlier conversation "${title}", carried over into this new conversation${why}`,
    "It keeps only the user's messages and the assistant's replies, word for word. Tool calls, tool results and thinking were left out;",
    'nothing was summarized. Files read or edited there are not included — read them again if you need them.',
    ''
  ].join('\n')
}

const FOOTER = '\n---\n\n# New message\n\n'

export interface HandoffText {
  /** The text put at the head of the first send (the end is up to the "# New message" heading). An empty string if there is no turn. */
  readonly text: string
  /** The estimated token count of `text` (S). */
  readonly tokens: number
  /** The number of turns dropped because of the limit. */
  readonly omittedTurns: number
}

export function buildHandoffText(
  turns: readonly ExportTurn[],
  title: string,
  purpose: HandoffPurpose = 'lighten'
): HandoffText {
  if (turns.length === 0) return { text: '', tokens: 0, omittedTurns: 0 }
  const head = header(title, purpose)
  const blocks = turns.map(turnBlock)
  const fixed = estimateTokens(head) + estimateTokens(FOOTER)
  const budget = Math.max(0, HANDOFF_MAX_TOKENS - fixed)
  const sizes = blocks.map(estimateTokens)
  const all = sizes.reduce((sum, n) => sum + n, 0)
  if (all <= budget) return finish(head + blocks.join('\n') + FOOTER, 0)

  // The first turn plus as many as fit from the newest side. The middle becomes one line (leave a little room for that line).
  const marker = (from: ExportTurn, to: ExportTurn, count: number): string =>
    `[${count === 1 ? `Turn ${to.number} was` : `Turns ${from.number}–${to.number} (${count} turns) were`} omitted here; they remain in the earlier conversation.]\n`
  const reserve = 40
  const lastIndex = blocks.length - 1
  const firstSize = sizes[0] ?? 0
  const keepFirst = lastIndex > 0 && firstSize + (sizes[lastIndex] ?? 0) + reserve <= budget
  let room = budget - reserve - (keepFirst ? firstSize : 0)
  let start = blocks.length
  for (let i = lastIndex; i >= (keepFirst ? 1 : 0); i--) {
    const size = sizes[i] ?? 0
    if (size > room) break
    room -= size
    start = i
  }
  if (start === blocks.length) {
    // The newest turn alone exceeds the limit: cut the newest turn at the limit.
    const omitted = lastIndex
    const block = capText(blocks[lastIndex] ?? '', budget - reserve)
    const prefix = omitted > 0 ? marker(turns[0]!, turns[lastIndex - 1]!, omitted) : ''
    return finish(head + prefix + block + FOOTER, omitted)
  }
  const firstKept = keepFirst ? 1 : 0
  const omitted = start - firstKept
  const parts = [
    ...(keepFirst ? [blocks[0]!] : []),
    ...(omitted > 0 ? [marker(turns[firstKept]!, turns[start - 1]!, omitted)] : []),
    ...blocks.slice(start)
  ]
  return finish(head + parts.join('\n') + FOOTER, omitted)
}

function finish(text: string, omittedTurns: number): HandoffText {
  return { text, tokens: estimateTokens(text), omittedTurns }
}

/** The estimate shown in the band (TODO 961). `baseTokens` (B) is the fixed cost of a new conversation; null if unknown. */
export interface HandoffEstimate {
  readonly baseTokens: number | null
  readonly handoffTokens: number
}
