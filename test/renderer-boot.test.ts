// @vitest-environment jsdom
/**
 * The renderer's boot entry (TODO 807, ARCHITECTURE 3.1 "launch order"): nothing but `boot.*` is called before main answers, the
 * notice is invisible at first, main's resolved look is written into the query before the app loads, and an abandoned launch loads
 * nothing. No model is called.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootLocale, bootNoticeText, bootTheme, queryWithLook, startBoot } from '../src/renderer/src/boot.js'
import type { BootAnswer } from '../src/shared/boot.js'
import { LOCALES } from '../src/shared/locale.js'
import { PRODUCT_NAME } from '../src/shared/product.js'
import { BOOT_NOTICE } from '../src/renderer/src/i18n/boot-notice.js'

describe('boot entry helpers', () => {
  it('takes the theme and language of the first frame from the query, else from the OS', () => {
    expect(bootTheme('?aios-theme=dark', false)).toBe('dark')
    expect(bootTheme('?aios-theme=neon', true)).toBe('dark')
    expect(bootTheme('', false)).toBe('light')
    expect(bootLocale('?aios-locale=ja', 'en-US')).toBe('ja')
    expect(bootLocale('', 'ja-JP')).toBe('ja')
    expect(bootLocale('?aios-locale=fr', 'de')).toBe('en')
  })

  it('names the keychain item after the data name in the query, in both languages (on macOS)', () => {
    const ja = bootNoticeText('ja', '?aios-data=aios&aios-os=mac')
    expect(ja.body).toContain('"aios Safe Storage"')
    expect(ja.title).not.toContain('{app}')
    const en = bootNoticeText('en', '?aios-data=Temoto&aios-os=mac')
    expect(en.body).toContain('Temoto Safe Storage')
    // A value that does not look like a data name is not shown (the product's data name is).
    expect(bootNoticeText('en', '?aios-data=%3Cb%3E&aios-os=mac').body).not.toContain('<b>')
  })

  it('wave 106 review Z5: off macOS (or without the OS in the query) the notice only says the app is starting', () => {
    for (const locale of LOCALES) {
      for (const search of ['?aios-data=aios&aios-os=other', '?aios-data=aios', '?aios-data=aios&aios-os=darwin2']) {
        const shown = bootNoticeText(locale, search)
        expect(shown.body).toBeNull()
        expect(shown.title).toContain(PRODUCT_NAME)
        expect(JSON.stringify(shown)).not.toMatch(/Safe Storage|macOS|キーチェーン|keychain/i)
      }
    }
  })

  it('the notice words exist in every language with the same placeholders, and the product name is not hard-coded', () => {
    expect(Object.keys(BOOT_NOTICE).sort()).toEqual([...LOCALES].sort())
    const names = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort()
    for (const locale of LOCALES) {
      const words = BOOT_NOTICE[locale]
      expect(names(words.title)).toEqual(names(BOOT_NOTICE.ja.title))
      expect(names(words.macKeychain)).toEqual(names(BOOT_NOTICE.ja.macKeychain))
      expect(`${words.title} ${words.macKeychain}`).not.toContain(PRODUCT_NAME)
      const shown = bootNoticeText(locale, '?aios-os=mac')
      expect(`${shown.title} ${shown.body ?? ''}`).not.toMatch(/\{\w+\}/)
      expect(shown.title).toContain(PRODUCT_NAME)
    }
  })

  it('writes the resolved look into the query and keeps the other keys', () => {
    const next = queryWithLook('?aios-theme=light&aios-locale=en&aios-thread-collapse=5&aios-data=aios', {
      theme: 'dark',
      locale: 'ja',
      threadCollapseDays: 0
    })
    const params = new URLSearchParams(next)
    expect(params.get('aios-theme')).toBe('dark')
    expect(params.get('aios-locale')).toBe('ja')
    expect(params.get('aios-thread-collapse')).toBe('0')
    expect(params.get('aios-data')).toBe('aios')
  })
})

describe('startBoot', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    window.history.replaceState(null, '', '/')
    vi.unstubAllGlobals()
  })

  function fakeApi(answer: Promise<BootAnswer>): { painted: ReturnType<typeof vi.fn>; wait: ReturnType<typeof vi.fn> } {
    const painted = vi.fn()
    const wait = vi.fn(() => answer)
    // Only `boot` exists: any other call before the answer would throw here.
    Object.defineProperty(window, 'aios', { value: { boot: { painted, wait } }, configurable: true })
    window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      callback(0)
      return 0
    }
    window.matchMedia = ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia
    return { painted, wait }
  }

  it('reports the first frame, waits, rewrites the query, removes the notice, then loads the app', async () => {
    window.history.replaceState(null, '', '/index.html?aios-theme=light&aios-locale=en&aios-data=aios&aios-os=mac')
    let release: (answer: BootAnswer) => void = () => undefined
    const api = fakeApi(new Promise<BootAnswer>((resolve) => (release = resolve)))
    const loadApp = vi.fn(async () => {
      // The app's stores read the query at import: it already carries main's values.
      expect(new URLSearchParams(window.location.search).get('aios-theme')).toBe('dark')
      expect(document.querySelector('.boot-notice')).toBeNull()
    })
    const running = startBoot(loadApp)
    expect(api.painted).toHaveBeenCalledTimes(1)
    expect(document.documentElement.dataset['theme']).toBe('light')
    const notice = document.querySelector('.boot-notice')
    expect(notice?.textContent).toContain('aios Safe Storage')
    expect(loadApp).not.toHaveBeenCalled()
    release({ ready: true, look: { theme: 'dark', locale: 'ja', threadCollapseDays: 3 } })
    await running
    expect(loadApp).toHaveBeenCalledTimes(1)
    expect(new URLSearchParams(window.location.search).get('aios-thread-collapse')).toBe('3')
    expect(window.location.pathname).toBe('/index.html')
  })

  it('an abandoned launch (quit while waiting) loads nothing and keeps the notice', async () => {
    fakeApi(Promise.resolve({ ready: false }))
    const loadApp = vi.fn(async () => undefined)
    await startBoot(loadApp)
    expect(loadApp).not.toHaveBeenCalled()
    expect(document.querySelector('.boot-notice')).not.toBeNull()
  })

  it('wave 106 review Z5: off macOS the notice on screen has the title only, no keychain sentence', async () => {
    window.history.replaceState(null, '', '/index.html?aios-theme=light&aios-locale=en&aios-data=aios&aios-os=other')
    fakeApi(Promise.resolve({ ready: false }))
    await startBoot(vi.fn(async () => undefined))
    const notice = document.querySelector('.boot-notice')
    expect(notice?.querySelector('.boot-notice-title')?.textContent).toContain(PRODUCT_NAME)
    expect(notice?.querySelector('.boot-notice-body')).toBeNull()
    expect(notice?.textContent).not.toMatch(/Safe Storage|keychain/i)
  })
})
