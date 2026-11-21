/**
 * TODO 1009 stage 2: the entry that moves a PDF body-search hit to its page (the renderer's instruction → the host's sending entry → the bridge's check).
 * It is the same one-time form as the line instruction (item 273, `test/viewer-line.test.ts`). The model is not called.
 */
import { describe, expect, it } from 'vitest'
import { revealMessageFor, viewerLineRequest, viewerPageRequest } from '../src/renderer/src/viewer-line.js'
import { acceptRevealPage } from '../plugins/_shared/bridge.js'

describe('renderer: ページの指示 (viewerPageRequest / revealMessageFor)', () => {
  it('ページは 1 以上の安全な整数だけ受け、uri が null・ページ無し・壊れていれば指示なし', () => {
    expect(viewerPageRequest('file:///a.pdf', { page: 3 }, 1)).toEqual({ uri: 'file:///a.pdf', page: 3, nonce: 1 })
    expect(viewerPageRequest(null, { page: 3 }, 1)).toBeNull()
    expect(viewerPageRequest('file:///a.pdf', undefined, 1)).toBeNull()
    for (const page of [0, -1, 1.5, Number.NaN, null]) {
      expect(viewerPageRequest('file:///a.pdf', { page }, 1)).toBeNull()
    }
  })

  it('viewer が指示のファイルを描いた後に、番号ごとに 1 度だけ reveal-page を送る', () => {
    const request = viewerPageRequest('file:///a.pdf', { page: 7 }, 4)
    expect(revealMessageFor(request, null, 0)).toBeNull()
    expect(revealMessageFor(request, 'file:///other.pdf', 0)).toBeNull()
    expect(revealMessageFor(request, 'file:///a.pdf', 0)).toEqual({ type: 'reveal-page', uri: 'file:///a.pdf', page: 7 })
    expect(revealMessageFor(request, 'file:///a.pdf', 4)).toBeNull()
  })

  it('行の指示は今までどおり reveal のまま', () => {
    const line = viewerLineRequest('file:///a.ts', { line: 5 }, 2)
    expect(revealMessageFor(line, 'file:///a.ts', 0)).toEqual({ type: 'reveal', uri: 'file:///a.ts', line: 5 })
  })
})

describe('bridge: acceptRevealPage', () => {
  it('表示中のファイル宛て・1 以上の整数のページだけ通す', () => {
    expect(acceptRevealPage({ uri: 'file:///a.pdf', page: 2 }, 'file:///a.pdf')).toEqual({ uri: 'file:///a.pdf', page: 2 })
    expect(acceptRevealPage({ uri: 'file:///b.pdf', page: 2 }, 'file:///a.pdf')).toBeNull()
    expect(acceptRevealPage({ uri: 'file:///a.pdf', page: 2 }, null)).toBeNull()
    expect(acceptRevealPage({ uri: 'file:///a.pdf', page: 0 }, 'file:///a.pdf')).toBeNull()
    expect(acceptRevealPage({ uri: 'file:///a.pdf', page: '2' }, 'file:///a.pdf')).toBeNull()
    expect(acceptRevealPage({ uri: 5, page: 2 }, 'file:///a.pdf')).toBeNull()
  })
})
