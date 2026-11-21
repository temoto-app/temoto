import { afterEach, describe, expect, it, vi } from 'vitest'
import { LINK_POPOVER_MS, popoverKindFor, useLinkPopover } from '../src/renderer/src/linkNoticeStore'

afterEach(() => {
  useLinkPopover.getState().clear()
  vi.useRealTimers()
})

describe('リンクの吹き出し (TODO 995)', () => {
  it('見つからない / 除外だけ吹き出しにする', () => {
    expect(popoverKindFor('link-not-found')).toBe('notFound')
    expect(popoverKindFor('link-excluded')).toBe('denied')
    expect(popoverKindFor('link-ambiguous')).toBeNull()
    expect(popoverKindFor('path-denied')).toBeNull()
  })

  it('数秒で消え、続けて出した方が先の消し忘れで消されない', () => {
    vi.useFakeTimers()
    const { show } = useLinkPopover.getState()
    show({ x: 1, y: 2 }, 'notFound')
    expect(useLinkPopover.getState().popover).toMatchObject({ x: 1, y: 2, kind: 'notFound' })
    vi.advanceTimersByTime(LINK_POPOVER_MS - 100)
    show({ x: 5, y: 6 }, 'denied')
    vi.advanceTimersByTime(200)
    expect(useLinkPopover.getState().popover).toMatchObject({ x: 5, y: 6, kind: 'denied' })
    vi.advanceTimersByTime(LINK_POPOVER_MS)
    expect(useLinkPopover.getState().popover).toBeNull()
  })
})
