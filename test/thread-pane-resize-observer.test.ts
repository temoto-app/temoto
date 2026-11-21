/**
 * code-review of TODO 906: the ResizeObserver that tracks the marks between the question frames must not be set up again on every render. `jump` (the object returned by useJumpNav) is new on every render, so it must not go into the dependencies of `scrollToSentBottom`.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ThreadPane scrollToSentBottom (TODO 906)', () => {
  it('does not put jump in the dependencies (avoids re-arming the ResizeObserver)', () => {
    const src = readFileSync('src/renderer/src/components/ThreadPane.tsx', 'utf8')
    const start = src.indexOf('const scrollToSentBottom = useCallback')
    const end = src.indexOf('useLayoutEffect', start)
    const block = src.slice(start, end)
    expect(block).toContain('jumpSyncRef.current()')
    expect(block).toMatch(/\}, \[setPinned\]\)/)
  })
})
