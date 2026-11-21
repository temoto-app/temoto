/**
 * TODO 1225 fix X (ARCHITECTURE 7.2.1): the fixed table of the extension setting item format (`format`). Hand-written validation that answers in time proportional to the length even for long input (it does not use a regex that backtracks).
 */
import { describe, expect, it } from 'vitest'
import { isSettingFormat, matchesSettingFormat, SETTING_FORMATS } from '../src/shared/setting-format.js'

describe('setting-format', () => {
  it('the table has only email, hostname and email-or-domain', () => {
    expect(SETTING_FORMATS).toEqual(['email', 'hostname', 'email-or-domain'])
    expect(isSettingFormat('email')).toBe(true)
    for (const value of ['uri', 'regex', '', null, 1]) expect(isSettingFormat(value)).toBe(false)
  })

  it('email: local@domain (the domain has at least 2 labels)', () => {
    for (const ok of ['a@b.co', 'A.B+c_d@Ex-ample.COM', `${'a'.repeat(64)}@x.com`]) expect(matchesSettingFormat('email', ok), ok).toBe(true)
    for (const bad of ['a@b', '@b.com', 'a@@b.com', 'a b@c.com', '<a@b.com>', `${'a'.repeat(65)}@x.com`, 'a@-b.com', 'a@b.com.', 'b.com']) {
      expect(matchesSettingFormat('email', bad), bad).toBe(false)
    }
  })

  it('hostname: at least 1 label, alphanumeric at the start and end, labels up to 63 characters and the whole up to 253', () => {
    for (const ok of ['localhost', 'a.b', 'x-1.example.com', `${'a'.repeat(63)}.com`]) expect(matchesSettingFormat('hostname', ok), ok).toBe(true)
    for (const bad of ['', '-a', 'a-', 'a..b', '.a', 'a.', 'a_b.com', `${'a'.repeat(64)}.com`, `${'a.'.repeat(127)}com`, 'a b']) {
      expect(matchesSettingFormat('hostname', bad), bad).toBe(false)
    }
  })

  it('email-or-domain: an address, @domain or a domain (at least 2 labels)', () => {
    for (const ok of ['bob@acme.com', '@acme.com', 'acme.com']) expect(matchesSettingFormat('email-or-domain', ok), ok).toBe(true)
    for (const bad of ['localhost', '@localhost', 'Alice <a@b.com>', 'a@x.com b@y.com', '@']) {
      expect(matchesSettingFormat('email-or-domain', bad), bad).toBe(false)
    }
  })

  it('a long input is refused without looking inside / within the limit it answers in time proportional to the length', () => {
    const started = Date.now()
    for (let i = 0; i < 10_000; i += 1) {
      expect(matchesSettingFormat('email-or-domain', `${'a'.repeat(60)}@${'b'.repeat(60)}.${'c'.repeat(60)}`)).toBe(true)
      expect(matchesSettingFormat('email-or-domain', 'a'.repeat(2_000))).toBe(false)
    }
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
