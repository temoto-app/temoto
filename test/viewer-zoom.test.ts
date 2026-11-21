import { describe, expect, it } from 'vitest'
import {
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  cssSize,
  formatScale,
  initialScale,
  pinchScale,
  stepScale
} from '../plugins/_shared/zoom'

describe('initialScale (TODO 1188)', () => {
  const stage = { stageWidth: 800, stageHeight: 600 }
  it('大きい画像は等倍', () => {
    expect(initialScale({ width: 1000, height: 500, ...stage, dpr: 2 })).toBe(1)
    expect(initialScale({ width: 129, height: 10, ...stage, dpr: 1 })).toBe(1)
  })
  it('小さい画像は枠に収まる最大の整数倍', () => {
    expect(initialScale({ width: 16, height: 16, ...stage, dpr: 1 })).toBe(16)
    expect(initialScale({ width: 100, height: 100, ...stage, dpr: 1 })).toBe(6)
    expect(initialScale({ width: 128, height: 64, ...stage, dpr: 1 })).toBe(6)
  })
  it('dpr を物理 px で数える', () => {
    expect(initialScale({ width: 100, height: 100, ...stage, dpr: 2 })).toBe(12)
  })
  it('shrinkToFit は大きい絵を枠に収めるだけで拡大しない', () => {
    expect(initialScale({ width: 1600, height: 600, ...stage, dpr: 1, shrinkToFit: true })).toBe(0.5)
    expect(initialScale({ width: 400, height: 300, ...stage, dpr: 1, shrinkToFit: true })).toBe(1)
    expect(initialScale({ width: 1600, height: 600, ...stage, dpr: 2, shrinkToFit: true })).toBe(1)
    expect(initialScale({ width: 16, height: 16, ...stage, dpr: 1, shrinkToFit: true })).toBe(16)
    expect(initialScale({ width: 1600, height: 600, ...stage, dpr: 1 })).toBe(1)
  })
  it('上限 16 倍、枠が不明なら等倍', () => {
    expect(initialScale({ width: 4, height: 4, ...stage, dpr: 1 })).toBe(16)
    expect(initialScale({ width: 16, height: 16, stageWidth: 0, stageHeight: 0, dpr: 1 })).toBe(1)
    expect(initialScale({ width: 0, height: 0, ...stage, dpr: 1 })).toBe(1)
  })
})

describe('stepScale / pinchScale / clamp', () => {
  it('段を進む', () => {
    expect(stepScale(1, 1)).toBe(1.5)
    expect(stepScale(1, -1)).toBe(0.75)
    expect(stepScale(5, 1)).toBe(6)
    expect(stepScale(5, -1)).toBe(4)
  })
  it('範囲を出ない', () => {
    expect(stepScale(MAX_SCALE, 1)).toBe(MAX_SCALE)
    expect(stepScale(MIN_SCALE, -1)).toBe(MIN_SCALE)
    expect(clampScale(1000)).toBe(MAX_SCALE)
    expect(clampScale(0)).toBe(MIN_SCALE)
    expect(pinchScale(MAX_SCALE, -100)).toBe(MAX_SCALE)
  })
  it('ピンチの向き', () => {
    expect(pinchScale(1, -5)).toBeGreaterThan(1)
    expect(pinchScale(1, 5)).toBeLessThan(1)
  })
})

describe('表示', () => {
  it('倍率の文字列と CSS の大きさ', () => {
    expect(formatScale(1)).toBe('100%')
    expect(formatScale(16)).toBe('1600%')
    expect(formatScale(0.125)).toBe('12.5%')
    expect(cssSize(100, 1, 2)).toBe(50)
    expect(cssSize(100, 3, 1)).toBe(300)
  })
})
