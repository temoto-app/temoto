/**
 * TODO 1041: the frame of the reserved-send button (🕒) was cut at the top by `.composer-frame` (overflow: hidden). `MenuPopover`'s `above` portals into the body and places itself with position: fixed.
 * This checks the pure function that computes that position (from the button's rectangle → bottom / right).
 */
import { describe, expect, it } from 'vitest'
import { popoverPlacement } from '../src/renderer/src/components/MenuPopover.js'

const viewport = { width: 1000, height: 800 }

describe('popoverPlacement (TODO 1041)', () => {
  it("right-aligned: puts the frame's bottom edge 4px above the button's top edge and its right edge on the button's right edge", () => {
    expect(popoverPlacement({ top: 700, left: 900, right: 930 }, viewport, 'right')).toEqual({ bottom: 104, right: 70 })
  })

  it("left-aligned: aligns with the button's left edge", () => {
    expect(popoverPlacement({ top: 700, left: 40, right: 70 }, viewport, 'left')).toEqual({ bottom: 104, left: 40 })
  })

  it('keeps a 4px margin even when too close to the window edge', () => {
    expect(popoverPlacement({ top: 900, left: -10, right: 1010 }, viewport, 'right')).toEqual({ bottom: 4, right: 4 })
    expect(popoverPlacement({ top: 0, left: -10, right: 5 }, viewport, 'left')).toEqual({ bottom: 804, left: 4 })
  })
})
