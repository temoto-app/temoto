/**
 * The double rendering of the outline list in `aios.markdown` (item 142, found in the 138th proxy verification).
 *
 * `showOutline()` goes through a round trip to plugin-host (`runCommand('outline', …)`). If `render()` runs again
 * from another `resource` event in the meantime, the result of the old generation arrives late and appends one more `div.outline`
 * to the DOM of the new generation (two `div.outline` appear; it reproduces when a `.md` is opened by file-name search).
 *
 * `OutlineGuard` is a pure class that only splits out the generation-number bookkeeping. It does not use `@pluginshared`,
 * so it can be read by a relative import (vitest has no alias for `@pluginshared`; a lesson from item 104).
 */
import { describe, expect, it } from 'vitest'
import { OutlineGuard } from '../plugins/aios.markdown/viewer/outline-guard.js'

describe('OutlineGuard (item 142)', () => {
  it('issues a new generation on every render and the previous one goes stale', () => {
    const guard = new OutlineGuard()
    const first = guard.next()
    expect(guard.isCurrent(first)).toBe(true)

    const second = guard.next()
    expect(second).not.toBe(first)
    // Once a second render has run, the first outline request is already stale
    // (that is, even if it arrives, it must not be appended to the DOM).
    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.isCurrent(second)).toBe(true)
  })

  it('keeps the first generation when there was no re-render', () => {
    const guard = new OutlineGuard()
    const gen = guard.next()
    expect(guard.isCurrent(gen)).toBe(true)
  })

  it("accepts only the latest result even when a stale generation's result arrives late out of order", () => {
    const guard = new OutlineGuard()
    const results: number[] = []
    const genA = guard.next() // First render (before the theme change)
    const genB = guard.next() // Second render (after the theme change; the first outline is still unresolved)

    // The first outline request resolves after the second, because its round trip was slow.
    if (guard.isCurrent(genA)) results.push(genA)
    if (guard.isCurrent(genB)) results.push(genB)

    expect(results).toEqual([genB])
  })
})
