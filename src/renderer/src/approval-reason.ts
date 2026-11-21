/**
 * The one line in the approval frame saying "why we are asking" (TODO 994).
 *
 * Turns the reason decided when main's Broker queued the item (`ApprovalItem.reason`, the decision order of 4.2.1) into a
 * dictionary key and the values to substitute. The wording itself is in `i18n/{ja,en}.ts`. With no reason or `unknown`, nothing is shown (null).
 * It is a pure function so the mapping can be checked without rendering React (`test/approval-reason.test.ts`).
 */
import type { ApprovalItem } from '@shared/thread.js'
import type { MessageKey, MessageParams } from './i18n/index.js'

export interface ApprovalReasonMessage {
  readonly key: MessageKey
  readonly params?: MessageParams
}

/** TODO 1015: the scheduled job that started this approval's thread (only one that still exists under Settings -> scheduled runs). */
export interface ApprovalScheduledJob {
  readonly id: string
  readonly name: string
  /** The job's current `approvalStrict`. If false, strictness does not come from the job (an old thread). */
  readonly approvalStrict: boolean
}

export function approvalReasonMessage(
  item: ApprovalItem,
  scheduledJob: ApprovalScheduledJob | null = null
): ApprovalReasonMessage | null {
  const reason = item.reason ?? null
  if (reason === null) return null
  switch (reason.kind) {
    case 'strict':
      // TODO 1015: in a scheduled job's thread, the place to turn it off is the job's settings (with the thread's ⋯ it would be strict again the next morning).
      if (scheduledJob !== null && scheduledJob.approvalStrict)
        return { key: 'approval.reason.strictScheduled', params: { job: scheduledJob.name } }
      return { key: 'approval.reason.strict' }
    case 'outbound':
      return { key: 'approval.reason.outbound', params: { match: reason.match } }
    case 'persistence':
      // TODO 1042: a write that lingers or removes a choke point. Shown when the write target (a path or a key) is known.
      return reason.target === null
        ? { key: 'approval.reason.persistenceKind', params: { match: reason.match } }
        : { key: 'approval.reason.persistence', params: { target: reason.target } }
    case 'secret-read':
      // TODO 1043: a route out of the conversation after a secret was read. What was read (the kind) and which route.
      return { key: 'approval.reason.secretRead', params: { source: reason.source, egress: reason.egress } }
    case 'deny-pattern':
      return { key: 'approval.reason.denyPattern', params: { pattern: reason.pattern } }
    case 'not-default':
      return { key: 'approval.reason.notDefault', params: { tool: item.toolName } }
    case 'no-command':
      return { key: 'approval.reason.noCommand' }
    case 'side-effect':
      return { key: 'approval.reason.sideEffect' }
    case 'question':
      return { key: 'approval.reason.question' }
    case 'plan':
      return { key: 'approval.reason.plan' }
    case 'unknown':
      return null
  }
}
