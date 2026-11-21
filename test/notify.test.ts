/**
 * Desktop notifications (item 72, the end of ARCHITECTURE.md 3.1). Checks only the judgments that do not depend on electron, and
 * the rules for summarizing. Neither the model nor the real `Notification` is used.
 */
import { describe, expect, it } from 'vitest'
import type { ApprovalItem } from '../src/shared/thread.js'
import {
  DesktopNotifier,
  newApprovalItems,
  notifyBody,
  resolveNotifyTitle,
  scheduledNotifyText,
  type DesktopNotification
} from '../src/main/notify.js'

function item(id: string, threadId = 't1'): ApprovalItem {
  return {
    id,
    threadId,
    threadTitle: 'スレッド',
    toolName: 'Bash',
    summary: 'echo hi',
    input: {},
    requestedAt: 0,
    questions: null,
    subtask: null
  }
}

describe('newApprovalItems', () => {
  it('treats all as new when the previous list was empty', () => {
    const next = [item('a'), item('b')]
    expect(newApprovalItems([], next)).toEqual(next)
  })

  it('excludes ids present in the previous list', () => {
    const previous = [item('a')]
    const next = [item('a'), item('b')]
    expect(newApprovalItems(previous, next)).toEqual([item('b')])
  })

  it('is empty when it only decreased (resolved)', () => {
    const previous = [item('a'), item('b')]
    const next = [item('a')]
    expect(newApprovalItems(previous, next)).toEqual([])
  })

  it('keeps the order of next', () => {
    const previous = [item('a')]
    const next = [item('b'), item('a'), item('c')]
    expect(newApprovalItems(previous, next).map((i) => i.id)).toEqual(['b', 'c'])
  })
})

describe('resolveNotifyTitle / notifyBody', () => {
  it('turns a provisional title (empty string) into the default title wording', () => {
    expect(resolveNotifyTitle('', 'ja')).toBe('新しいスレッド')
    expect(resolveNotifyTitle('', 'en')).toBe('New thread')
  })

  it('keeps the title as is when there is one', () => {
    expect(resolveNotifyTitle('わたしのスレッド', 'ja')).toBe('わたしのスレッド')
  })

  it('has only 2 kinds of body', () => {
    expect(notifyBody('approval', 'ja')).toBe('承認待ち')
    expect(notifyBody('turnEnded', 'ja')).toBe('回答しました')
    expect(notifyBody('approval', 'en')).toBe('Waiting for approval')
    expect(notifyBody('turnEnded', 'en')).toBe('Replied')
  })

  it('scheduled run (TODO 323): the heading is ⏰ + title, the end is the start of the response, and a fixed word when empty', () => {
    expect(scheduledNotifyText('done', '朝の確認', '要返信は 2 件', 'ja')).toEqual({
      title: '⏰ 朝の確認',
      body: '要返信は 2 件'
    })
    expect(scheduledNotifyText('done', '朝の確認', '', 'ja').body).toBe('定期実行が終わりました')
    expect(scheduledNotifyText('approval', '', 'x', 'en')).toEqual({
      title: '⏰ New thread',
      body: 'Scheduled run is waiting for approval'
    })
  })
})

/** A fake notification that only records creation, display, and disposal. Checks of clicks are in another test. */
function fakeNotification(log: string[], label: string): DesktopNotification {
  return {
    show: () => log.push(`show:${label}`),
    close: () => log.push(`close:${label}`),
    onClick: () => undefined
  }
}

describe('DesktopNotifier', () => {
  it('creates nothing when OFF', () => {
    const log: string[] = []
    let n = 0
    const notifier = new DesktopNotifier({
      enabled: () => false,
      create: (title, body) => {
        n += 1
        return fakeNotification(log, `${title}/${body}`)
      },
      onClick: () => undefined
    })
    notifier.notify('t1', 'タイトル', '承認待ち')
    expect(n).toBe(0)
    expect(log).toEqual([])
  })

  it('closes the previous one before showing the next for the same thread (groups them)', () => {
    const log: string[] = []
    let counter = 0
    const notifier = new DesktopNotifier({
      enabled: () => true,
      create: () => {
        counter += 1
        return fakeNotification(log, String(counter))
      },
      onClick: () => undefined
    })
    notifier.notify('t1', 'タイトル', '承認待ち')
    notifier.notify('t1', 'タイトル', '回答しました')
    expect(log).toEqual(['show:1', 'close:1', 'show:2'])
  })

  it('a different thread stays independent', () => {
    const log: string[] = []
    let counter = 0
    const notifier = new DesktopNotifier({
      enabled: () => true,
      create: () => {
        counter += 1
        return fakeNotification(log, String(counter))
      },
      onClick: () => undefined
    })
    notifier.notify('t1', 'A', '承認待ち')
    notifier.notify('t2', 'B', '承認待ち')
    expect(log).toEqual(['show:1', 'show:2'])
  })

  it("a click passes that thread's id", () => {
    const clicked: string[] = []
    // To verify onClick directly, intercept the callback of the handle returned from create.
    // The holder is kept in a box (`holder`): with a bare `let`, TS narrows it to "always null inside this function"
    // and does not reflect the reassignment inside the closure in the type.
    const holder: { click: (() => void) | null } = { click: null }
    const notifier = new DesktopNotifier({
      enabled: () => true,
      create: () => ({
        show: () => undefined,
        close: () => undefined,
        onClick: (cb) => {
          holder.click = cb
        }
      }),
      onClick: (threadId) => clicked.push(threadId)
    })
    notifier.notify('thread-9', 'A', 'B')
    expect(holder.click).not.toBeNull()
    holder.click?.()
    expect(clicked).toEqual(['thread-9'])
  })
})
