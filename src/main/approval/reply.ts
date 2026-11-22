/**
 * The **neutral shape** of what is returned to the backend on a denial (items 182 / 183, wave 14 bundle C, ARCHITECTURE.md 4.2).
 *
 * The texts that reach the model ("stop and wait for the user", "the user said: ...", "the user wants to talk about the question")
 * are an agreement with the backend, so they live only in the compat table and the Adapter's `approvalReply` assembles them (constraint 6).
 * The Broker decides only which shape applies; it does not know the texts.
 */

import type { ReasonCode } from '@shared/reason.js'

/**
 * Why aios itself withdrew an approval (TODO 567). Nobody declined (`by: 'system'`).
 * The timeline keeps a reason code (`approval-cancelled-<reason>`) and the renderer draws it in the display language.
 * The model gets the fixed English text from the Adapter's table (`approvalReplies.cancelled`).
 */
export const APPROVAL_CANCEL_REASONS = [
  'session-exited',
  'thread-removed',
  'quit',
  'interrupt',
  'stop',
  // TODO 632: the backend stopped waiting (MCP tool call timeout). Either the gateway received a cancellation notice, or a result
  // arrived for the tool_use of a request sitting in the inbox. Do not leave the dialog on screen (answering it would not get through).
  'tool-timeout',
  // TODO 959: an approval for an unattended scheduled job was not answered before the next scheduled run. Returned as a denial (owner decision 2026-10-24).
  'expired',
  // TODO 1106: in a conversation started with the OS sandbox enabled, a request to run outside the sandbox (an AI retry) arrived. Refused without asking.
  'os-sandbox',
  // TODO 982: the conversation is a drill (a dry run of a Teammate). Every write, command, send and tool with a side effect is stopped and
  // recorded; the model is told to carry on as if it had run. Nobody declined.
  'drill'
] as const
export type ApprovalCancelReason = (typeof APPROVAL_CANCEL_REASONS)[number]

/** Reason code for a withdrawal (put into the timeline's `outcome.message`). */
export function approvalCancelCode(reason: ApprovalCancelReason): ReasonCode {
  return `approval-cancelled-${reason}`
}

/** Reason code for declining without a word (the timeline's `outcome.message`; the display with `reply: 'stop'` adds no text). */
export const APPROVAL_DENIED_USER_CODE: ReasonCode = 'approval-denied-user'

/**
 * Text returned to the model when the Adapter has no table (`approvalReply` is missing or null) (TODO 567).
 * Previously the Broker's fixed Japanese text became the tool_result as is. Unified to English regardless of the display language.
 * The user's instruction (`feedback`) is not built here (null; the caller returns
 * the Broker's `message` as is).
 */
const FALLBACK_CANCELLED: Readonly<Record<ApprovalCancelReason, string>> = {
  'session-exited': 'The permission request was cancelled because the session ended. The tool was NOT run.',
  'thread-removed': 'The permission request was cancelled because the conversation was deleted. The tool was NOT run.',
  quit: 'The permission request was cancelled because the app is quitting. The tool was NOT run.',
  interrupt: 'The permission request was cancelled because the user interrupted with a new message. The tool was NOT run.',
  stop: 'The permission request was cancelled because the user stopped the response. The tool was NOT run.',
  'tool-timeout': 'The permission request was cancelled because it timed out waiting for the user. The tool was NOT run.',
  expired:
    'The permission request was cancelled because nobody answered it before the next scheduled run of this job. The tool was NOT run. Do not retry it; finish without it.',
  'os-sandbox':
    'The permission request was cancelled because this conversation runs with the OS sandbox and commands may not run outside it. The tool was NOT run. Do not retry it outside the sandbox.',
  drill:
    'The permission request was cancelled because this conversation is a drill (a dry run): aios stops every write, command and send and only records what was attempted. The tool was NOT run. Continue as if it had succeeded, and do not retry it.'
}

export function fallbackApprovalReply(reply: ApprovalReply): string | null {
  switch (reply.kind) {
    case 'stop':
      return 'The user denied this tool use. The tool was NOT run. Stop and wait for the user to tell you how to proceed.'
    case 'cancelled':
      return FALLBACK_CANCELLED[reply.reason]
    default:
      return null
  }
}

export type ApprovalReply =
  /** Declined without a word (the permission screen's "deny", the question's "don't answer"). To the backend: "stop and wait". */
  | { readonly kind: 'stop' }
  /** Declined, and wrote what to do instead (the permission screen's "deny" field, the plan's "revise"). */
  | { readonly kind: 'feedback'; readonly text: string }
  /** aios itself withdrew it (TODO 567). Not a user denial; attached only to results with `by: 'system'`. */
  | { readonly kind: 'cancelled'; readonly reason: ApprovalCancelReason }
