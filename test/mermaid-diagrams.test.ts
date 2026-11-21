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

describe('draw / do not draw', () => {
  it('does not draw in the middle of an answer stream', () => {
    expect(shouldDrawDiagrams({ streaming: true })).toBe(false)
    expect(shouldDrawDiagrams({ streaming: false })).toBe(true)
  })

  it('picks out only mermaid .code-block and restores the source from data-code', () => {
    const host = document.createElement('div')
    host.innerHTML = renderMarkdown(FENCE + '\n```ts\nconst a = 1\n```\n').html
    const blocks = Array.from(host.querySelectorAll<HTMLElement>('.code-block'))
    expect(blocks.map(isMermaidCodeBlock)).toEqual([true, false])
    expect(mermaidSourceOf(blocks[0] as HTMLElement)).toBe('graph TD\nA-->B\n')
  })
})

describe('renderDiagram (lazy; failure is null)', () => {
  beforeEach(() => {
    vi.resetModules()
    mermaidMock.parse.mockImplementation(async () => true)
    mermaidMock.render.mockClear()
    mermaidMock.initialize.mockClear()
  })

  it('does not load mermaid on import and loads it on the first draw; initializes with strict', async () => {
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

  it('returns null for a syntax error (parse is false) and does not call render', async () => {
    mermaidMock.parse.mockImplementation(async () => false)
    const mod = await import('../src/renderer/src/thread/mermaid-render.js')
    expect(await mod.renderDiagram('not a diagram', 'light')).toBeNull()
    expect(mermaidMock.render).not.toHaveBeenCalled()
  })

  it('returns null even when render throws (does not break the screen)', async () => {
    mermaidMock.render.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    const mod = await import('../src/renderer/src/thread/mermaid-render.js')
    expect(await mod.renderDiagram('graph TD\nX-->Y', 'light')).toBeNull()
  })

  it('reads theme variables from CSS variables and passes none that are empty (no hard-coded colors)', async () => {
    const mod = await import('../src/renderer/src/thread/mermaid-render.js')
    const vars = mod.themeVariablesFrom((name) => (name === '--fg' ? ' #123456 ' : ''))
    expect(vars['primaryTextColor']).toBe('#123456')
    expect(vars['lineColor']).toBeUndefined()
  })
})

describe('inlining on export', () => {
  const answer = `前\n\n${FENCE}\n後\n\n\`\`\`mermaid\nbroken\n\`\`\`\n`

  it('collects the sources (does not pick up non-mermaid fences)', () => {
    const turns = [{ number: 1, question: null, answers: [answer, '```ts\nx\n```'] }]
    expect(collectMermaidSources(turns)).toEqual(['graph TD\nA-->B\n', 'broken\n'])
    expect(mermaidSources(renderMarkdown('```ts\nx\n```').html)).toEqual([])
  })

  it('turns a drawn diagram into an inline SVG in a <figure> and leaves one that failed as a code block; no script gets in', () => {
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

  it('changes nothing when there are no diagrams', () => {
    const base = renderMarkdown(answer).html
    expect(inlineMermaidDiagrams(base, new Map())).toBe(base)
  })

  it("sanitizeDiagramSvg: drops scripts, events, external references and foreignObject and keeps the diagram's style", () => {
    const clean = sanitizeDiagramSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:red}</style><a href="https://x"><rect onclick="x()" class="a"/></a><foreignObject><div>h</div></foreignObject><script>1</script></svg>'
    )
    expect(clean).not.toMatch(/script|onclick|href|foreignObject/i)
    expect(clean).toContain('<style>')
    expect(clean).toContain('<rect')
  })

  it('uses separate cache keys for the on-screen light theme and export (TODO 880 code-review)', async () => {
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
  it('width="100%" and the style\'s max-width are removed and the viewBox width becomes a px width', async () => {
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

  it('removes the whole style when it is only max-width; leaves as is when the viewBox cannot be read', async () => {
    const { fitSvgToNaturalSize } = await import('../src/renderer/src/thread/mermaid-render.js')
    expect(fitSvgToNaturalSize('<svg width="100%" style="max-width: 10px;" viewBox="0 0 10 5"></svg>')).toBe(
      '<svg width="10" viewBox="0 0 10 5"></svg>'
    )
    const odd = '<svg width="100%"><g/></svg>'
    expect(fitSvgToNaturalSize(odd)).toBe(odd)
  })
})
