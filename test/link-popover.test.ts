import { afterEach, describe, expect, it, vi } from 'vitest'
import { LINK_POPOVER_MS, popoverKindFor, useLinkPopover } from '../src/renderer/src/linkNoticeStore'

afterEach(() => {
  useLinkPopover.getState().clear()
  vi.useRealTimers()
})

describe('link bubble (TODO 995)', () => {
  it('only not-found / excluded become a bubble', () => {
    expect(popoverKindFor('link-not-found')).toBe('notFound')
    expect(popoverKindFor('link-excluded')).toBe('denied')
    expect(popoverKindFor('link-ambiguous')).toBeNull()
    expect(popoverKindFor('path-denied')).toBeNull()
  })

  it("disappears after a few seconds, and one shown afterwards is not cleared by the earlier one's leftover timer", () => {
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
