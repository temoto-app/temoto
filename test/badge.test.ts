/**
 * The Dock badge count (TODO 73, ARCHITECTURE.md 3.1 / 4.3).
 *
 * How it counts (owner decision 2026-09-23): the number of threads with unread answers + the number awaiting approval.
 * Even if the same thread has both unread and approval, each counts as 1 (not merged into one, but since these are separate units, they are not zeroed out either).
 */
import { describe, expect, it } from 'vitest'
import { countBadge, type BadgeThread } from '../src/main/session/badge.js'
import type { ApprovalItem } from '../src/shared/thread.js'

function approval(id: string, threadId = 't1'): ApprovalItem {
  return {
    id,
    threadId,
    threadTitle: 'thread',
    toolName: 'Bash',
    summary: 'echo hi',
    input: {},
    requestedAt: Date.now(),
    questions: null,
    subtask: null
  }
}

describe('countBadge (TODO 73)', () => {
  it('0 when unread 0 + approval 0', () => {
    expect(countBadge([], [])).toBe(0)
  })

  it('5 when unread 2 + approval 3', () => {
    const threads: BadgeThread[] = [
      { unread: true },
      { unread: true },
      { unread: false },
      { unread: false }
    ]
    const approvals = [approval('a1'), approval('a2'), approval('a3')]
    expect(countBadge(threads, approvals)).toBe(5)
  })

  it('if the same thread has unread and approval, 1 + 1 (not counted twice, but not merged either)', () => {
    const threads: BadgeThread[] = [{ unread: true }]
    const approvals = [approval('a1', 't1')]
    expect(countBadge(threads, approvals)).toBe(2)
  })

  it('threads without unread are not counted', () => {
    const threads: BadgeThread[] = [{ unread: false }, { unread: false }]
    expect(countBadge(threads, [])).toBe(0)
  })

  it('if there is only approval, the approval count is shown as is', () => {
    expect(countBadge([], [approval('a1'), approval('a2')])).toBe(2)
  })
})
