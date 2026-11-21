/**
 * Checks on URLs opened in the external browser (`src/main/open-external.ts`, ARCHITECTURE.md 5.1 "External links").
 *
 * The rule is that values coming from the renderer are re-checked in main. This is a regression test for that pure function:
 * the list of allowed and refused schemes, mixed case, whitespace, and `javascript:` sneaking in.
 * It does not call `shell.openExternal` (it passes a fake opener).
 */
import { describe, it, expect } from 'vitest'
import {
  externalUrlProtocol,
  isOpenableExternally,
  openExternalChecked
} from '../src/main/open-external.js'
import { EXTERNAL_PROTOCOLS, MAX_EXTERNAL_URL_LENGTH } from '../src/shared/open-external.js'

describe('isOpenableExternally', () => {
  it('http: / https: / mailto: だけを通す', () => {
    expect(EXTERNAL_PROTOCOLS).toEqual(['http:', 'https:', 'mailto:'])
    expect(isOpenableExternally('http://example.com/')).toBe(true)
    expect(isOpenableExternally('https://example.com/path?q=1#frag')).toBe(true)
    expect(isOpenableExternally('mailto:someone@example.com?subject=hi')).toBe(true)
  })

  it('アプリ内で解釈するスキームは OS に渡さない', () => {
    expect(isOpenableExternally('file:///Users/x/doc.md')).toBe(false)
    expect(isOpenableExternally('thread://abc')).toBe(false)
    expect(isOpenableExternally('aios-res://local/Users/x/a.png')).toBe(false)
    expect(isOpenableExternally('aios-plugin://aios.text/index.html')).toBe(false)
  })

  it('スクリプトと data、その他の OS ハンドラ付きスキームを弾く', () => {
    expect(isOpenableExternally('javascript:alert(1)')).toBe(false)
    expect(isOpenableExternally('vbscript:msgbox')).toBe(false)
    expect(isOpenableExternally('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isOpenableExternally('ftp://example.com/')).toBe(false)
    expect(isOpenableExternally('ssh://host')).toBe(false)
    expect(isOpenableExternally('tel:+81')).toBe(false)
    expect(isOpenableExternally('x-apple.systempreferences:com.apple.preference')).toBe(false)
  })

  it('相対 URL とスキーム無しは弾く (base を与えない)', () => {
    expect(isOpenableExternally('example.com')).toBe(false)
    expect(isOpenableExternally('/etc/passwd')).toBe(false)
    expect(isOpenableExternally('./a.md')).toBe(false)
    expect(isOpenableExternally('//example.com/')).toBe(false)
    expect(isOpenableExternally('#anchor')).toBe(false)
    expect(isOpenableExternally('')).toBe(false)
  })

  it('スキームの大文字混じりは小文字に畳んで判定する', () => {
    expect(isOpenableExternally('HTTPS://EXAMPLE.COM/')).toBe(true)
    expect(isOpenableExternally('Http://example.com/')).toBe(true)
    expect(isOpenableExternally('MailTo:x@example.com')).toBe(true)
    expect(isOpenableExternally('JavaScript:alert(1)')).toBe(false)
    expect(externalUrlProtocol('HTTPS://EXAMPLE.COM/')).toBe('https:')
  })

  it('前後の空白は URL パーサが落とす', () => {
    expect(isOpenableExternally('  https://example.com/  ')).toBe(true)
    expect(isOpenableExternally('\nhttps://example.com/\n')).toBe(true)
    expect(isOpenableExternally('  javascript:alert(1)  ')).toBe(false)
  })

  it('制御文字で割った javascript: は畳まれてから弾かれる', () => {
    // The WHATWG URL parser removes ASCII tabs and newlines, so
    // `java\tscript:` becomes `javascript:`. Do not let it slip through to the allowed side.
    expect(isOpenableExternally('java\tscript:alert(1)')).toBe(false)
    expect(isOpenableExternally('java\nscript:alert(1)')).toBe(false)
    expect(externalUrlProtocol('java\tscript:alert(1)')).toBe('javascript:')
    // Split by a space, it cannot be read as a URL, so it is refused too.
    expect(isOpenableExternally('java script:alert(1)')).toBe(false)
  })

  it('スキームを偽装した文字列に騙されない', () => {
    // Even if it looks like https at the start, it is refused if it does not form a URL (without `//`, the authority becomes `javascript:alert(1)`, and the invalid port makes parsing fail).
    expect(isOpenableExternally('https:javascript:alert(1)')).toBe(false)
    expect(externalUrlProtocol('https:javascript:alert(1)')).toBeNull()
    expect(isOpenableExternally('javascript:https://example.com/')).toBe(false)
    expect(isOpenableExternally('file://example.com/https://x')).toBe(false)
  })

  it('文字列以外と長すぎる値は弾く', () => {
    expect(isOpenableExternally(null)).toBe(false)
    expect(isOpenableExternally(undefined)).toBe(false)
    expect(isOpenableExternally(42)).toBe(false)
    expect(isOpenableExternally({ toString: () => 'https://example.com/' })).toBe(false)
    expect(isOpenableExternally(['https://example.com/'])).toBe(false)
    const long = `https://example.com/${'a'.repeat(MAX_EXTERNAL_URL_LENGTH)}`
    expect(isOpenableExternally(long)).toBe(false)
    expect(isOpenableExternally(`https://example.com/${'a'.repeat(100)}`)).toBe(true)
  })
})

describe('openExternalChecked', () => {
  it('許可した URL だけを opener に渡し、true を返す', async () => {
    const opened: string[] = []
    const open = async (url: string): Promise<void> => {
      opened.push(url)
    }
    expect(await openExternalChecked('https://example.com/', open, 'ipc')).toBe(true)
    expect(await openExternalChecked('mailto:x@example.com', open, 'window-open')).toBe(true)
    expect(opened).toEqual(['https://example.com/', 'mailto:x@example.com'])
  })

  it('拒否した URL は opener を呼ばずに false を返す', async () => {
    let calls = 0
    const open = async (): Promise<void> => {
      calls += 1
    }
    for (const bad of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,x',
      'thread://abc',
      'example.com',
      '',
      null,
      123
    ]) {
      expect(await openExternalChecked(bad, open, 'ipc')).toBe(false)
    }
    expect(calls).toBe(0)
  })

  it('opener が失敗しても例外にせず false を返す', async () => {
    const open = async (): Promise<void> => {
      throw new Error('no handler')
    }
    expect(await openExternalChecked('https://example.com/', open, 'ipc')).toBe(false)
  })
})
