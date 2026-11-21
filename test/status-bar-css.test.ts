/**
 * A small observation for TODO 351 (proxy verification run 23, wave 18 bundle D): when the sidebar is narrowed to about 300px, the 'rescan' button at the bottom of Files wraps one character per line (the Japanese label is split into single characters). It is the same pattern as 333-c (the viewer header): `.status-bar button` lacked `white-space: nowrap` / `flex-shrink: 0`. It follows the same approach as `viewer-header-css.test.ts` (jsdom does not compute real layout, so whether it actually wraps is checked on a device).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

/** The body of the rules for the given selector (concatenated if they are split across several places). */
function rulesFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g')
  return [...css.matchAll(re)].map((m) => m[1] ?? '').join('\n')
}

describe("observation: the sidebar's 「再走査」 button does not wrap vertically", () => {
  it('.status-bar button does not wrap and does not shrink', () => {
    const rules = rulesFor('.status-bar button')
    expect(rules).toContain('white-space: nowrap')
    expect(rules).toContain('flex-shrink: 0')
  })
})
