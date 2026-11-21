/**
 * @vitest-environment jsdom
 *
 * TODO 880: turns ```mermaid in an answer into a diagram. Judging (no drawing in the middle of a stream; telling a code block apart), lazy loading,
 * null when it cannot be drawn, and inlining for export (no `<script>`). The mermaid library itself is replaced (neither the model nor the rendering is called).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '../src/shared/markdown/render.js'
import {
  inlineMermaidDiagrams,
  isMermaidCodeBlock,
  mermaidSourceOf,
  mermaidSources,
  sanitizeDiagramSvg,
  shouldDrawDiagrams
} from '../src/renderer/src/thread/mermaid-blocks.js'
import { collectMermaidSources, exportDocumentHtml } from '../src/renderer/src/thread/export-pdf.js'

const loaded = vi.fn()
const mermaidMock = {
  initialize: vi.fn(),
  parse: vi.fn(async (...args: unknown[]): Promise<boolean> => args.length >= 0),
  render: vi.fn(async (...args: unknown[]) => ({
    svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${String(args[1]).length}</text><script>alert(1)</script></svg>`
  }))
}
vi.mock('mermaid', () => {
  loaded()
  return { default: mermaidMock }
})

const FENCE = '```mermaid\ngraph TD\nA-->B\n```\n'

describe('描く / 描かない', () => {
  it('回答の流れの途中は描かない', () => {
    expect(shouldDrawDiagrams({ streaming: true })).toBe(false)
    expect(shouldDrawDiagrams({ streaming: false })).toBe(true)
  })

  it('mermaid の .code-block だけを見分け、原文は data-code から戻す', () => {
    const host = document.createElement('div')
    host.innerHTML = renderMarkdown(FENCE + '\n```ts\nconst a = 1\n```\n').html
    const blocks = Array.from(host.querySelectorAll<HTMLElement>('.code-block'))
    expect(blocks.map(isMermaidCodeBlock)).toEqual([true, false])
    expect(mermaidSourceOf(blocks[0] as HTMLElement)).toBe('graph TD\nA-->B\n')
  })
})

describe('renderDiagram (遅延・失敗は null)', () => {
  beforeEach(() => {
    vi.resetModules()
    mermaidMock.parse.mockImplementation(async () => true)
    mermaidMock.render.mockClear()
    mermaidMock.initialize.mockClear()
  })

  it('import しただけでは mermaid を読まず、初めて描くときに読む。strict で初期化する', async () => {
    loaded.mockClear()
    const mod = await import('../src/renderer/src/thread/mermaid-render.js')
    expect(loaded).not.toHaveBeenCalled()
    const svg = await mod.renderDiagram('graph TD\nA-->B', 'light')
    expect(svg).toContain('<svg')
    expect(loaded).toHaveBeenCalledTimes(1)
    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: 'strict', startOnLoad: false, htmlLabels: false })
    )
  })

  it('構文エラー (parse が false) は null、render を呼ばない', async () => {
    mermaidMock.parse.mockImplementation(async () => false)
    const mod = await import('../src/renderer/src/thread/mermaid-render.js')
    expect(await mod.renderDiagram('not a diagram', 'light')).toBeNull()
    expect(mermaidMock.render).not.toHaveBeenCalled()
  })

  it('render が例外でも null (画面を壊さない)', async () => {
    mermaidMock.render.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    const mod = await import('../src/renderer/src/thread/mermaid-render.js')
    expect(await mod.renderDiagram('graph TD\nX-->Y', 'light')).toBeNull()
  })

  it('テーマの変数は CSS 変数から読み、空は渡さない (色を直書きしない)', async () => {
    const mod = await import('../src/renderer/src/thread/mermaid-render.js')
    const vars = mod.themeVariablesFrom((name) => (name === '--fg' ? ' #123456 ' : ''))
    expect(vars['primaryTextColor']).toBe('#123456')
    expect(vars['lineColor']).toBeUndefined()
  })
})

describe('書き出しのインライン化', () => {
  const answer = `前\n\n${FENCE}\n後\n\n\`\`\`mermaid\nbroken\n\`\`\`\n`

  it('原文を集める (mermaid 以外のフェンスは拾わない)', () => {
    const turns = [{ number: 1, question: null, answers: [answer, '```ts\nx\n```'] }]
    expect(collectMermaidSources(turns)).toEqual(['graph TD\nA-->B\n', 'broken\n'])
    expect(mermaidSources(renderMarkdown('```ts\nx\n```').html)).toEqual([])
  })

  it('描けた図は <figure> のインライン SVG に、描けなかったものはコードの塊のまま。script は入らない', () => {
    const svgs = new Map([['graph TD\nA-->B\n', '<svg xmlns="http://www.w3.org/2000/svg"><text>A</text><script>alert(1)</script></svg>']])
    const html = exportDocumentHtml({
      title: 't',
      meta: 'm',
      lang: 'ja',
      appCss: '',
      format: 'html',
      turns: [{ number: 1, question: null, answers: [answer] }],
      diagrams: svgs
    })
    expect(html).toContain('<figure class="mermaid-diagram"><svg')
    expect(html).toContain('<text>A</text>')
    expect(html).not.toContain('<script')
    expect(html).toContain('data-code="broken%0A"')
    expect(html.match(/<div class="code-block"/g)).toHaveLength(1)
  })

  it('diagrams が無ければ何も変えない', () => {
    const base = renderMarkdown(answer).html
    expect(inlineMermaidDiagrams(base, new Map())).toBe(base)
  })

  it('sanitizeDiagramSvg: スクリプト・イベント・外部参照・foreignObject を落とし、図の style は残す', () => {
    const clean = sanitizeDiagramSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:red}</style><a href="https://x"><rect onclick="x()" class="a"/></a><foreignObject><div>h</div></foreignObject><script>1</script></svg>'
    )
    expect(clean).not.toMatch(/script|onclick|href|foreignObject/i)
    expect(clean).toContain('<style>')
    expect(clean).toContain('<rect')
  })

  it('キャッシュの鍵は画面のライトと書き出しで別 (TODO 880 code-review)', async () => {
    const mod = await import('../src/renderer/src/thread/mermaid-render.js')
    expect(mod.diagramCacheScope('light')).toBe('export')
    expect(mod.diagramCacheScope('screen', 'light')).toBe('screen:light')
    expect(mod.diagramCacheScope('screen', 'dark')).toBe('screen:dark')
    mermaidMock.render.mockClear()
    await mod.renderDiagram('graph TD\nQ-->R', 'screen')
    await mod.renderDiagram('graph TD\nQ-->R', 'light')
    expect(mermaidMock.render).toHaveBeenCalledTimes(2)
  })
})

describe('fitSvgToNaturalSize (TODO 884)', () => {
  it('width="100%" と style の max-width を外し、viewBox の幅を px の width にする', async () => {
    const { fitSvgToNaturalSize } = await import('../src/renderer/src/thread/mermaid-render.js')
    const out = fitSvgToNaturalSize(
      '<svg id="m1" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 123.4px; background: none;" viewBox="0 0 123.4 56"><g/></svg>'
    )
    expect(out).toContain('width="124"')
    expect(out).not.toContain('100%')
    expect(out).not.toMatch(/max-width/)
    expect(out).toContain('background: none')
    expect(out).toContain('viewBox="0 0 123.4 56"')
    expect(out.endsWith('<g/></svg>')).toBe(true)
  })

  it('style が max-width だけなら style ごと外す。viewBox が読めなければそのまま', async () => {
    const { fitSvgToNaturalSize } = await import('../src/renderer/src/thread/mermaid-render.js')
    expect(fitSvgToNaturalSize('<svg width="100%" style="max-width: 10px;" viewBox="0 0 10 5"></svg>')).toBe(
      '<svg width="10" viewBox="0 0 10 5"></svg>'
    )
    const odd = '<svg width="100%"><g/></svg>'
    expect(fitSvgToNaturalSize(odd)).toBe(odd)
  })
})
