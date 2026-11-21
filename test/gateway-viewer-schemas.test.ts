/**
 * The shape of the input of the gateway's ViewerPane tools (TODO 822 / 826, ARCHITECTURE.md 7.6.2).
 * main checks it again too (`test/session-manager.test.ts`), but this is the exact shape the gateway shows the CLI.
 */
import { describe, expect, it } from 'vitest'
import { MAX_GATEWAY_URL, openFileInput, openUrlInput } from '../src/gateway/viewer-schemas.js'

describe('gateway openUrl input (TODO 822)', () => {
  it('passes http(s) URLs', () => {
    for (const url of ['https://mail.google.com/mail/u/0/#drafts', 'http://localhost:3000/', 'HTTPS://example.com']) {
      expect(openUrlInput.safeParse({ url }).success, url).toBe(true)
    }
  })

  it('refuses non-http(s), empty and too-long values', () => {
    for (const url of [
      '',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'mailto:a@example.com',
      'data:text/html,x',
      '/Users/x/a.html',
      `https://example.com/${'a'.repeat(MAX_GATEWAY_URL)}`
    ]) {
      expect(openUrlInput.safeParse({ url }).success, url.slice(0, 40)).toBe(false)
    }
    expect(openUrlInput.safeParse({}).success).toBe(false)
    expect(openUrlInput.safeParse({ url: 42 }).success).toBe(false)
  })
})

describe('gateway openFile input (TODO 1091 part 1)', () => {
  it('page passes only integers of 1 or more', () => {
    expect(openFileInput.safeParse({ path: 'a.pdf', page: 3 }).success).toBe(true)
    expect(openFileInput.safeParse({ path: 'a.pdf' }).success).toBe(true)
    for (const page of [0, -1, 1.5, '2', null, Number.NaN]) {
      expect(openFileInput.safeParse({ path: 'a.pdf', page }).success, String(page)).toBe(false)
    }
  })
})
