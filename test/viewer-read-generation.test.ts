/**
 * TODO 673 (code-review fix, critical 5): `ReadGenerationTracker` is a state machine so that, when switching quickly to another file in the same window (`viewId`),
 * only 'the read called last' may call `watch.track`, regardless of the order in which the `read()` calls complete. It is the pure part split out of `ViewerBroker.read`,
 * so it can be checked without creating real variations in `await` ordering.
 */
import { describe, expect, it } from 'vitest'
import { ReadGenerationTracker } from '../src/main/capability/viewer.js'

describe('ReadGenerationTracker', () => {
  it('viewId が無ければ (省略) 常に 0 を返し、isLatest は常に false', () => {
    const tracker = new ReadGenerationTracker()
    expect(tracker.begin(undefined)).toBe(0)
    expect(tracker.isLatest(undefined, 0)).toBe(false)
  })

  it('呼び出し順どおりに終われば、最後の世代だけが最新 (素直なケース)', () => {
    const tracker = new ReadGenerationTracker()
    const g1 = tracker.begin(1)
    expect(tracker.isLatest(1, g1)).toBe(true)
    const g2 = tracker.begin(1)
    expect(tracker.isLatest(1, g1)).toBe(false)
    expect(tracker.isLatest(1, g2)).toBe(true)
  })

  // Main point: the case where completion order overtakes call order. Even if the second read (fast, binary) completes right after it starts, after the first read
  // (slow, with a text await) has started, its track is not the latest, so it is skipped, and only the second read's track is valid.
  it('完了順が呼び出し順を追い越しても、呼び出し順で後の世代だけが最新のまま', () => {
    const tracker = new ReadGenerationTracker()
    const slowGeneration = tracker.begin(7) // The first (slow text read) starts first
    const fastGeneration = tracker.begin(7) // The second (fast binary read) starts later
    // The second completes first and tracks.
    expect(tracker.isLatest(7, fastGeneration)).toBe(true)
    // Even if the first completes later, it is no longer the latest, so it must not track.
    expect(tracker.isLatest(7, slowGeneration)).toBe(false)
  })

  it('窓 (viewId) ごとに独立している (同じ番号の世代でも別の窓の最新を踏まない)', () => {
    const tracker = new ReadGenerationTracker()
    tracker.begin(1) // Advance the generation of viewId 1 to 2
    const a = tracker.begin(1)
    const b = tracker.begin(2) // viewId 2 starts from 1 (it can be the same number as a)
    expect(tracker.isLatest(1, a)).toBe(true)
    expect(tracker.isLatest(2, b)).toBe(true)
    // Checking the generation number of viewId 2 (b) against viewId 1 is not the latest either (even with the same number, the windows differ).
    expect(tracker.isLatest(1, b)).toBe(false)
  })
})
