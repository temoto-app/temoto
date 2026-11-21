/**
 * @vitest-environment jsdom
 *
 * TODO 892: a `**` next to a full-width symbol also becomes bold, even when Japanese text follows.
 */
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/shared/markdown/render.js'

const html = (s: string): string => renderMarkdown(s).html

describe('TODO 892: CJK の隣の強調', () => {
  it('閉じの ** の前が全角の記号で、後ろが日本語', () => {
    expect(html('**先にいる 30 人のプレイヤー（ボット）**という表記')).toContain(
      '<strong>先にいる 30 人のプレイヤー（ボット）</strong>という表記'
    )
  })
  it('開きの ** の前が日本語 / 英字で、後ろが全角の記号', () => {
    expect(html('文**（ボット）**です')).toContain('文<strong>（ボット）</strong>です')
    expect(html('a**（ボット）**です')).toContain('a<strong>（ボット）</strong>です')
    expect(html('これは**「重要」**です')).toContain('<strong>「重要」</strong>')
    expect(html('**終わり。**次')).toContain('<strong>終わり。</strong>次')
  })
  it('従来の挙動は変えない', () => {
    expect(html('**bold** text')).toContain('<strong>bold</strong>')
    expect(html('2 ** 3 ** 4')).not.toContain('<strong>')
    expect(html('日本語 ** 日本語')).not.toContain('<strong>')
    expect(html('*em*')).toContain('<em>em</em>')
    expect(html('**(a)**b')).not.toContain('<strong>')
  })
  it('コードの中は変えない', () => {
    expect(html('`**（a）**です`')).toContain('<code>**（a）**です</code>')
    expect(html('```\n**（a）**です\n```')).not.toContain('<strong>')
  })
})
