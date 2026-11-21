/**
 * Builds the text returned to the model on a denial (items 182 / 183, wave 14 bundle C).
 *
 * Independent of the backend (moved out of the adapter directory in the TODO 1020 review).
 * The texts copy what the backend's interactive screen returns and **live only in the compat table
 * (`approvalReplies`)** (constraint 6). This is a pure function that just fills values into a template;
 * `test/approval-reply.test.ts` covers it.
 */
import type { ApprovalCancelReason, ApprovalReply } from './reply.js'

export interface ApprovalReplyTable {
  readonly stop: string
  readonly feedback: string
  /**
   * Text for when aios itself withdraws an approval (TODO 567). The CLI has no matching screen, so this is
   * aios's own text (English). One sentence per reason. Previously the Broker's fixed Japanese text became
   * the tool_result as is.
   */
  readonly cancelled: Readonly<Record<ApprovalCancelReason, string>>
}

function fill(template: string, values: Readonly<Record<string, string>>): string {
  // Replace in a single pass (so a literal like `{feedback}` inside the user's text is not substituted a second time).
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole)
}

export function formatApprovalReply(table: ApprovalReplyTable, reply: ApprovalReply): string {
  switch (reply.kind) {
    case 'stop':
      return table.stop
    case 'cancelled':
      return table.cancelled[reply.reason]
    case 'feedback':
      return fill(table.feedback, { feedback: reply.text })
  }
}
