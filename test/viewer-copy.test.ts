/**
 * @vitest-environment jsdom
 *
 * viewer side copy button (ARCHITECTURE.md 5.1.2.1, T25).
 *
 * This is **code in plugins/_shared**, so what is checked is:
 *  - exactly one button in each `.code-block`, not attached twice
 *  - what is copied is the **original text before syntax coloring** in `data-code` (indentation kept)
 *  - if `navigator.clipboard.writeText` fails, it falls back to `execCommand('copy')` (the T25 measurement: when Permissions Policy or focus is missing in the opaque-origin iframe)
 *  - after pressing, a checkmark shows for only 1.5 seconds
 * The boundary (constraint 8) itself is checked by test/plugin-boundaries.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachCopyButtons, copyText } from '../plugins/_shared/copy.js'
import { setViewerLocale } from '../plugins/_shared/i18n.js'
import { renderMarkdown } from '../src/shared/markdown/render.js'

function body(source: string): HTMLElement {
  const root = document.createElement('div')
  root.className = 'markdown-body'
  root.innerHTML = renderMarkdown(source).html
  document.body.append(root)
  return root
}

function setClipboard(impl: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(impl) }
  })
}

const writeTextMock = (): ReturnType<typeof vi.fn> =>
  (navigator.clipboard as unknown as { writeText: ReturnType<typeof vi.fn> }).writeText

beforeEach(() => {
  vi.useFakeTimers()
  // Strings are looked up in the language the host sent (7.4.4). Here they are checked with the Japanese strings
  setViewerLocale('ja')
  document.body.textContent = ''
  setClipboard(() => Promise.resolve())
  // jsdom has no execCommand, so one is added in a form that lets us see whether it was called
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => true) })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('viewer のコピーボタン (5.1.2.1、T25)', () => {
  it('フェンスと字下げ記法の両方にボタンが 1 つずつ入る', () => {
    const root = body('```js\nconst a = 1\n```\n\n本文\n\n    indented = 2\n')
    attachCopyButtons(root)
    expect(root.querySelectorAll('.code-block')).toHaveLength(2)
    expect(root.querySelectorAll('button.code-copy')).toHaveLength(2)
    for (const block of Array.from(root.querySelectorAll('.code-block'))) {
      expect(block.querySelectorAll(':scope > button.code-copy')).toHaveLength(1)
    }
  })

  it('二度呼んでもボタンは増えない', () => {
    const root = body('```js\nconst a = 1\n```')
    attachCopyButtons(root)
    attachCopyButtons(root)
    expect(root.querySelectorAll('button.code-copy')).toHaveLength(1)
  })

  it('ボタンには届いた言語の aria-label と title が付く', () => {
    const root = body('```js\nconst a = 1\n```')
    attachCopyButtons(root)
    const button = root.querySelector<HTMLButtonElement>('button.code-copy')
    expect(button?.getAttribute('aria-label')).toBe('コードをコピー')
    expect(button?.title).toBe('コードをコピー')
    expect(button?.type).toBe('button')
    // If English is sent, the English label is used (TODO 66)
    setViewerLocale('en')
    const english = body('```js\nconst a = 1\n```')
    attachCopyButtons(english)
    expect(english.querySelector('button.code-copy')?.getAttribute('aria-label')).toBe('Copy code')
    // The icon is inline SVG, and its color is only currentColor (7.4.1)
    const svg = button?.querySelector('svg')
    expect(svg?.getAttribute('stroke')).toBe('currentColor')
    expect(svg?.getAttribute('fill')).toBe('none')
  })

  it('押すと色分け前の原文 (字下げと末尾の改行つき) が writeText に渡る', async () => {
    const root = body('```python\ndef f(x):\n    return "s"\n```')
    attachCopyButtons(root)
    root.querySelector<HTMLButtonElement>('button.code-copy')?.click()
    await vi.runAllTimersAsync()
    expect(writeTextMock()).toHaveBeenCalledWith('def f(x):\n    return "s"\n')
  })

  it('字下げ記法のブロックも 4 スペースを外した原文をコピーする', async () => {
    const root = body('本文\n\n    const a = 1\n')
    attachCopyButtons(root)
    root.querySelector<HTMLButtonElement>('button.code-copy')?.click()
    await vi.runAllTimersAsync()
    expect(writeTextMock()).toHaveBeenCalledWith('const a = 1\n')
  })

  it('writeText が落ちたら execCommand に回る (Permissions Policy / focus が無いとき)', async () => {
    setClipboard(() => Promise.reject(new Error('NotAllowedError')))
    const ok = await copyText('x = 1\n')
    expect(ok).toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    // The textarea used is not left behind
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('どちらの経路も駄目なら false を返し、投げない', async () => {
    setClipboard(() => Promise.reject(new Error('NotAllowedError')))
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) })
    await expect(copyText('x')).resolves.toBe(false)
  })

  it('入ったら 1.5 秒だけチェックマークに変わる', async () => {
    const root = body('```js\nconst a = 1\n```')
    attachCopyButtons(root)
    const button = root.querySelector<HTMLButtonElement>('button.code-copy')
    expect(button?.classList.contains('copied')).toBe(false)
    button?.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(button?.classList.contains('copied')).toBe(true)
    expect(button?.title).toBe('コピーしました')
    await vi.advanceTimersByTimeAsync(1600)
    expect(button?.classList.contains('copied')).toBe(false)
    expect(button?.title).toBe('コードをコピー')
    expect(button?.querySelectorAll('svg')).toHaveLength(1)
  })

  it('入らなかったときは合図を出さない', async () => {
    setClipboard(() => Promise.reject(new Error('NotAllowedError')))
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) })
    const root = body('```js\nconst a = 1\n```')
    attachCopyButtons(root)
    const button = root.querySelector<HTMLButtonElement>('button.code-copy')
    button?.click()
    await vi.runAllTimersAsync()
    expect(button?.classList.contains('copied')).toBe(false)
  })
})
