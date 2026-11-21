/**
 * A ```mermaid diagram (TODO 880). `MarkdownBody` overlays it on the mermaid `.code-block` with a portal.
 *
 * Until it can be drawn, and when it could not be drawn, nothing is shown and the code block (`<pre>`) stays visible as is. Once drawn, the `<pre>` is
 * hidden and the diagram is shown, and a small toggle button switches between diagram / code (the copy button `CopyButton` stays as it was).
 * The SVG is made by mermaid with `securityLevel: 'strict'` and passed through `sanitizeDiagramSvg` once more before being inserted.
 */
import { useEffect, useState } from 'react'
import { useT } from '../i18n/index.js'
import { renderDiagram } from '../thread/mermaid-render.js'
import { sanitizeDiagramSvg } from '../thread/mermaid-blocks.js'

/** A generation counter to redraw when `<html data-theme>` changes (light / dark). */
function useThemeGeneration(): number {
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    const observer = new MutationObserver(() => setGeneration((n) => n + 1))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return generation
}

export function MermaidView({ code, host }: { code: string; host: HTMLElement }): React.JSX.Element | null {
  const t = useT()
  const generation = useThemeGeneration()
  const [svg, setSvg] = useState<string | null>(null)
  const [showCode, setShowCode] = useState(false)
  useEffect(() => {
    let alive = true
    void renderDiagram(code, 'screen').then((result) => {
      if (alive) setSvg(result === null ? null : sanitizeDiagramSvg(result))
    })
    return () => {
      alive = false
    }
  }, [code, generation])
  const drawn = svg !== null && svg !== ''
  // The `<pre>` is hidden by a class on the outer node (it is DOM outside React, so attach / detach in an effect).
  useEffect(() => {
    host.classList.toggle('mermaid-drawn', drawn && !showCode)
    return () => host.classList.remove('mermaid-drawn')
  }, [host, drawn, showCode])
  if (!drawn) return null
  const label = showCode ? t('common.diagramShowDiagram') : t('common.diagramShowCode')
  return (
    <>
      {showCode ? null : <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />}
      <button
        type="button"
        className="diagram-toggle"
        title={label}
        aria-label={label}
        onClick={() => setShowCode((v) => !v)}
      >
        {showCode ? t('common.diagramShowDiagram') : t('common.diagramShowCode')}
      </button>
    </>
  )
}
