/**
 * @vitest-environment jsdom
 *
 * TODO 1146 stage 2: the display position of `aios.markdown`. Preview reports the scroll amount (`offset`) and restores it with `restore-position`.
 * Source uses the top line of the editor (`line`). Positions in another unit are not used. The viewer's entry point is read as it is; only the bridge and the editor are replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: never) => void
const handlers: Record<string, Handler> = {}
const reports: Array<{ uri: string; position: unknown }> = []
const restoreTopLine = vi.fn()
let topLineHandler: ((line: number) => void) | undefined

vi.mock('../plugins/_shared/bridge.js', () => ({
  connect: () =>
    new Proxy(
      {},
      {
        get: (_t, name: string) => {
          if (name === 'runCommand') return () => Promise.resolve([])
          if (name === 'reportScrollPosition') return (uri: string, position: unknown) => void reports.push({ uri, position })
          if (name.startsWith('on')) return (h: Handler) => void (handlers[name] = h)
          return () => undefined
        }
      }
    )
}))
vi.mock('../plugins/_shared/editor.js', () => ({
  createEditor: (_host: unknown, options: { onTopLine?: (line: number) => void }) => {
    topLineHandler = options.onTopLine
    return { destroy: () => undefined, setHighlight: () => undefined, revealLine: () => undefined, restoreTopLine }
  }
}))

const URI = 'file:///a.md'
function resource(): void {
  handlers.onResource?.({
    uri: URI,
    editable: true,
    theme: 'light',
    highlightQuery: null,
    draft: null,
    resource: { kind: 'text', text: '# Title\n\nbody\n', revision: 'r1' }
  } as never)
}

let root: HTMLElement
const added: Array<[string, EventListenerOrEventListenerObject]> = []

beforeEach(async () => {
  reports.length = 0
  restoreTopLine.mockClear()
  vi.resetModules()
  const original = document.addEventListener.bind(document)
  vi.spyOn(document, 'addEventListener').mockImplementation((type: string, listener: unknown, options?: unknown) => {
    added.push([type, listener as EventListenerOrEventListenerObject])
    original(type, listener as EventListener, options as boolean)
  })
  document.body.innerHTML = '<div id="root"></div>'
  root = document.getElementById('root')!
  await import('../plugins/aios.markdown/viewer/main.js')
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const [type, listener] of added.splice(0)) document.removeEventListener(type, listener)
})

describe('aios.markdown view position (TODO 1146 stage 2)', () => {
  it('Preview: reports offset on scroll and restores scrollTop from the restore-position offset', () => {
    resource()
    const body = root.querySelector<HTMLElement>('.markdown-body')!
    body.scrollTop = 420
    body.dispatchEvent(new Event('scroll'))
    expect(reports).toEqual([{ uri: URI, position: { kind: 'offset', value: 420 } }])

    body.scrollTop = 0
    handlers.onRestorePosition?.({ uri: URI, position: { kind: 'offset', value: 300 } } as never)
    expect(body.scrollTop).toBe(300)
  })

  it('Preview: ignores other units (line / page) and messages addressed to another file', () => {
    resource()
    const body = root.querySelector<HTMLElement>('.markdown-body')!
    handlers.onRestorePosition?.({ uri: URI, position: { kind: 'line', value: 5 } } as never)
    handlers.onRestorePosition?.({ uri: URI, position: { kind: 'page', value: 5 } } as never)
    handlers.onRestorePosition?.({ uri: 'file:///other.md', position: { kind: 'offset', value: 300 } } as never)
    expect(body.scrollTop).toBe(0)
    expect(restoreTopLine).not.toHaveBeenCalled()
  })

  it('Source: reports the top line as line and restores by line; does not use offset', () => {
    resource()
    handlers.onSetViewMode?.('source' as never)
    expect(topLineHandler).toBeDefined()
    topLineHandler?.(120)
    expect(reports).toEqual([{ uri: URI, position: { kind: 'line', value: 120 } }])

    handlers.onRestorePosition?.({ uri: URI, position: { kind: 'offset', value: 300 } } as never)
    expect(restoreTopLine).not.toHaveBeenCalled()
    handlers.onRestorePosition?.({ uri: URI, position: { kind: 'line', value: 120 } } as never)
    expect(restoreTopLine).toHaveBeenCalledWith(120)
  })
})
