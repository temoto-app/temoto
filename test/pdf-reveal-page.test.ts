/**
 * TODO 1009 stage 2: the entry that moves a PDF body-search hit to its page (the renderer's instruction → the host's sending entry → the bridge's check).
 * It is the same one-time form as the line instruction (item 273, `test/viewer-line.test.ts`). The model is not called.
 */
import { describe, expect, it } from 'vitest'
import { revealMessageFor, viewerLineRequest, viewerPageRequest } from '../src/renderer/src/viewer-line.js'
import { acceptRevealPage } from '../plugins/_shared/bridge.js'

describe('renderer: page request (viewerPageRequest / revealMessageFor)', () => {
  it('accepts only a safe integer page of 1 or more, and gives no request when uri is null, there is no page or it is broken', () => {
    expect(viewerPageRequest('file:///a.pdf', { page: 3 }, 1)).toEqual({ uri: 'file:///a.pdf', page: 3, nonce: 1 })
    expect(viewerPageRequest(null, { page: 3 }, 1)).toBeNull()
    expect(viewerPageRequest('file:///a.pdf', undefined, 1)).toBeNull()
    for (const page of [0, -1, 1.5, Number.NaN, null]) {
      expect(viewerPageRequest('file:///a.pdf', { page }, 1)).toBeNull()
    }
  })

  it('after the viewer has drawn the requested file, sends reveal-page once per number', () => {
    const request = viewerPageRequest('file:///a.pdf', { page: 7 }, 4)
    expect(revealMessageFor(request, null, 0)).toBeNull()
    expect(revealMessageFor(request, 'file:///other.pdf', 0)).toBeNull()
    expect(revealMessageFor(request, 'file:///a.pdf', 0)).toEqual({ type: 'reveal-page', uri: 'file:///a.pdf', page: 7 })
    expect(revealMessageFor(request, 'file:///a.pdf', 4)).toBeNull()
  })

  it('a line request stays reveal as before', () => {
    const line = viewerLineRequest('file:///a.ts', { line: 5 }, 2)
    expect(revealMessageFor(line, 'file:///a.ts', 0)).toEqual({ type: 'reveal', uri: 'file:///a.ts', line: 5 })
  })
})

describe('bridge: acceptRevealPage', () => {
  it('passes only pages that are addressed to the displayed file and are integers of 1 or more', () => {
    expect(acceptRevealPage({ uri: 'file:///a.pdf', page: 2 }, 'file:///a.pdf')).toEqual({ uri: 'file:///a.pdf', page: 2 })
    expect(acceptRevealPage({ uri: 'file:///b.pdf', page: 2 }, 'file:///a.pdf')).toBeNull()
    expect(acceptRevealPage({ uri: 'file:///a.pdf', page: 2 }, null)).toBeNull()
    expect(acceptRevealPage({ uri: 'file:///a.pdf', page: 0 }, 'file:///a.pdf')).toBeNull()
    expect(acceptRevealPage({ uri: 'file:///a.pdf', page: '2' }, 'file:///a.pdf')).toBeNull()
    expect(acceptRevealPage({ uri: 5, page: 2 }, 'file:///a.pdf')).toBeNull()
  })
})
