// @vitest-environment jsdom
/**
 * TODO 352 (wave 19 bundle A): the frame for the user's own message does not go through Markdown and is drawn exactly as typed (owner decision (b)).
 * Draws the real `UserMessage` in jsdom, and checks the CSS rule (`white-space: pre-wrap`) by reading styles.css.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { UserMessage } from '../src/renderer/src/components/UserMessage.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(text: string): HTMLElement {
  act(() => root.render(createElement(UserMessage, { text })))
  return host.querySelector<HTMLElement>('.message.user .user-text')!
}

describe('UserMessage (TODO 352)', () => {
  it('a single newline stays as is (does not collapse into a space as a soft break)', () => {
    const el = render('1 行目\n2 行目')
    expect(el.textContent).toBe('1 行目\n2 行目')
    // Neither a Markdown paragraph (<p>) nor <br>: the string itself
    expect(el.querySelector('p, br')).toBeNull()
  })

  it('`*` and `#` do not become emphasis or headings and stay visible as is', () => {
    const el = render('# 見出しではない\n*強調でもない* と **太字でもない**\n- 箇条書きでもない')
    expect(el.textContent).toBe('# 見出しではない\n*強調でもない* と **太字でもない**\n- 箇条書きでもない')
    expect(el.querySelector('h1, em, strong, ul, li')).toBeNull()
  })

  it('a URL is not made a link and HTML is not interpreted', () => {
    const el = render('https://example.com を見て <b>x</b>')
    expect(el.querySelector('a, b')).toBeNull()
    expect(el.textContent).toBe('https://example.com を見て <b>x</b>')
  })

  it('the attachment mark and the @path line stay one per line like other lines', () => {
    const el = render('(添付: shot.png) @src/a.ts\nこれを見て')
    expect(el.textContent).toBe('(添付: shot.png) @src/a.ts\nこれを見て')
  })

  it('consecutive whitespace and blank lines are as typed', () => {
    const el = render('a    b\n\n\nc')
    expect(el.textContent).toBe('a    b\n\n\nc')
  })
})

describe("CSS of the frame of one's own message (TODO 352)", () => {
  const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

  it('.message.user .user-text is pre-wrap and inherits the look of the previous frame', () => {
    const start = css.indexOf('\n.message.user .user-text {')
    expect(start).toBeGreaterThanOrEqual(0)
    const body = css.slice(start, css.indexOf('}', start))
    expect(body).toContain('white-space: pre-wrap')
    expect(body).toContain('border-left: 2px solid var(--accent)')
    expect(body).toContain('background: var(--bg-raised)')
  })

  it('the old .message.user .markdown rule does not remain', () => {
    expect(css).not.toMatch(/\.message\.user \.markdown/)
  })

  it('ThreadPane draws one\'s own message with UserMessage (does not pass role="user" to the Markdown Message)', () => {
    const src = readFileSync(join(process.cwd(), 'src/renderer/src/components/ThreadPane.tsx'), 'utf8')
    expect(src).toContain('<UserMessage text={item.text} attachments={item.attachments} />')
    expect(src).not.toMatch(/<Message role="user"/)
  })
})

describe('thumbnails of sent images (TODO 550)', () => {
  const thumbnail = 'data:image/webp;base64,UklGRgQAAABXRUJQVlA4IA=='

  it('the reduced version as is, the file as the attachmentImage URL, only the name if neither exists, and lined up above the body', async () => {
    const asked: string[] = []
    ;(window as unknown as { aios: unknown }).aios = {
      threads: {
        attachmentImage: async (uri: string) => {
          asked.push(uri)
          return 'aios-res://local/0123456789abcdef0123456789abcdef/a.png'
        }
      }
    }
    await act(async () =>
      root.render(
        createElement(UserMessage, {
          text: '(添付: x)\n見て',
          attachments: [
            { name: 'Pasted image 1.png', thumbnail },
            { name: 'a.png', uri: 'file:///Users/tester/a.png' },
            { name: 'lost.png' }
          ]
        })
      )
    )
    const row = host.querySelector('.message.user .user-attachments')!
    expect(row.nextElementSibling?.classList.contains('user-text')).toBe(true)
    const images = [...row.querySelectorAll<HTMLImageElement>('img.user-attachment-thumb')]
    expect(images.map((img) => img.getAttribute('src'))).toEqual([
      thumbnail,
      'aios-res://local/0123456789abcdef0123456789abcdef/a.png'
    ])
    expect(asked).toEqual(['file:///Users/tester/a.png'])
    expect(row.querySelector('.user-attachment-name')?.textContent).toContain('lost.png')
  })

  it('TODO 814 / 971: an image pointing at a file opens in the viewer on click, and an image with only a reduced version opens in a temporary view (does not call select)', async () => {
    ;(window as unknown as { aios: unknown }).aios = {
      threads: { attachmentImage: async () => 'aios-res://local/0123456789abcdef0123456789abcdef/a.png' }
    }
    const { useStore } = await import('../src/renderer/src/store.js')
    const selected: string[] = []
    const original = useStore.getState().select
    useStore.setState({ select: ((uri: string) => void selected.push(uri)) as typeof original })
    try {
      await act(async () =>
        root.render(
          createElement(UserMessage, {
            text: '見て',
            attachments: [
              { name: 'Pasted.png', thumbnail },
              { name: 'a.png', uri: 'file:///Users/tester/a.png' },
              { name: 'gone.png', uri: 'file:///Users/tester/gone.png' }
            ]
          })
        )
      )
      const [pasted, file] = [...host.querySelectorAll<HTMLImageElement>('img.user-attachment-thumb')]
      expect(pasted?.classList.contains('clickable')).toBe(true)
      act(() => pasted?.click())
      expect(selected).toEqual([])
      expect(useStore.getState().transient?.kind).toBe('file')
      expect(file?.classList.contains('clickable')).toBe(true)
      act(() => file?.click())
      expect(selected).toEqual(['file:///Users/tester/a.png'])
    } finally {
      useStore.setState({ select: original })
    }
  })

  it('does not show the row of the lineup when there is no attachment', () => {
    render('ただの発言')
    expect(host.querySelector('.user-attachments')).toBeNull()
  })
})
