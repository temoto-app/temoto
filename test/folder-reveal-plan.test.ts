import { describe, expect, it } from 'vitest'
import { planFolderReveal } from '../src/renderer/src/file-tree.js'

describe('planFolderReveal (TODO 887)', () => {
  it('ファイルが同じ画面に収まるならフォルダを先頭に', () => {
    expect(planFolderReveal(5, 12, 24, 480)).toEqual({ index: 5, align: 'start' })
  })
  it('収まらなければファイルの行を中央に', () => {
    expect(planFolderReveal(5, 40, 24, 480)).toEqual({ index: 40, align: 'center' })
  })
  it('ファイルが無い・フォルダより前・高さ不明は従来どおりフォルダを中央に', () => {
    expect(planFolderReveal(5, -1, 24, 480)).toEqual({ index: 5, align: 'center' })
    expect(planFolderReveal(5, 3, 24, 480)).toEqual({ index: 5, align: 'center' })
    expect(planFolderReveal(5, 8, 24, 0)).toEqual({ index: 5, align: 'center' })
  })
  it('ちょうど画面の最後の行は収まる / 1 行はみ出すと収まらない', () => {
    expect(planFolderReveal(0, 19, 24, 480)).toEqual({ index: 0, align: 'start' })
    expect(planFolderReveal(0, 20, 24, 480)).toEqual({ index: 20, align: 'center' })
  })
})
