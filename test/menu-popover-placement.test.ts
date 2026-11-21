/**
 * TODO 1041: the frame of the reserved-send button (🕒) was cut at the top by `.composer-frame` (overflow: hidden). `MenuPopover`'s `above` portals into the body and places itself with position: fixed.
 * This checks the pure function that computes that position (from the button's rectangle → bottom / right).
 */
import { describe, expect, it } from 'vitest'
import { popoverPlacement } from '../src/renderer/src/components/MenuPopover.js'

const viewport = { width: 1000, height: 800 }

describe('popoverPlacement (TODO 1041)', () => {
  it('右揃え: ボタンの上端の 4px 上に枠の下端、ボタンの右端に枠の右端を揃える', () => {
    expect(popoverPlacement({ top: 700, left: 900, right: 930 }, viewport, 'right')).toEqual({ bottom: 104, right: 70 })
  })

  it('左揃え: ボタンの左端に揃える', () => {
    expect(popoverPlacement({ top: 700, left: 40, right: 70 }, viewport, 'left')).toEqual({ bottom: 104, left: 40 })
  })

  it('窓の端に寄りすぎても 4px の余白を残す', () => {
    expect(popoverPlacement({ top: 900, left: -10, right: 1010 }, viewport, 'right')).toEqual({ bottom: 4, right: 4 })
    expect(popoverPlacement({ top: 0, left: -10, right: 5 }, viewport, 'left')).toEqual({ bottom: 804, left: 4 })
  })
})
