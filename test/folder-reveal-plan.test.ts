import { describe, expect, it } from 'vitest'
import { planFolderReveal } from '../src/renderer/src/file-tree.js'

describe('planFolderReveal (TODO 887)', () => {
  it('when the file fits on the same screen, puts the folder at the top', () => {
    expect(planFolderReveal(5, 12, 24, 480)).toEqual({ index: 5, align: 'start' })
  })
  it("when it does not fit, centers the file's row", () => {
    expect(planFolderReveal(5, 40, 24, 480)).toEqual({ index: 40, align: 'center' })
  })
  it('when there is no file, it is before the folder or the height is unknown, centers the folder as before', () => {
    expect(planFolderReveal(5, -1, 24, 480)).toEqual({ index: 5, align: 'center' })
    expect(planFolderReveal(5, 3, 24, 480)).toEqual({ index: 5, align: 'center' })
    expect(planFolderReveal(5, 8, 24, 0)).toEqual({ index: 5, align: 'center' })
  })
  it('the very last row of the screen fits / one row over does not fit', () => {
    expect(planFolderReveal(0, 19, 24, 480)).toEqual({ index: 0, align: 'start' })
    expect(planFolderReveal(0, 20, 24, 480)).toEqual({ index: 20, align: 'center' })
  })
})
