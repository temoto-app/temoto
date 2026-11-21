/**
 * TODO 1237 (4): the name of the capability accepted by the consent IPC is in one place, `CAPABILITY_NAMES`. Every capability that gets a row in the permissions tab (including `triggers`) is
 * accepted, and unknown names or non-letter characters are refused.
 */
import { describe, expect, it } from 'vitest'
import { CAPABILITY_NAMES, isCapabilityName } from '../src/shared/plugin.js'

describe('isCapabilityName (TODO 1237)', () => {
  it('権限タブに出る能力はどれも受け付ける (triggers を含む)', () => {
    for (const name of ['credentials', 'network', 'fs', 'index', 'ui', 'browser', 'triggers']) {
      expect(isCapabilityName(name)).toBe(true)
    }
    expect(CAPABILITY_NAMES).toContain('triggers')
  })

  it('知らない名前・文字列でない値は断る', () => {
    for (const value of ['', 'exec', 'Triggers', 'toString', '__proto__', 1, null, undefined, {}, ['fs']]) {
      expect(isCapabilityName(value)).toBe(false)
    }
  })
})
