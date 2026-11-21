/**
 * TODO 1061 (1): screenshot of ViewerPane (the gateway's `getViewerScreenshot`).
 *
 * - pure functions: how to shrink to a 1568px long side, how to choose PNG / JPEG, and the check of the rectangle from the renderer (`viewer-screenshot.ts`).
 * - the gateway's response: the image is an MCP `image` block, and the rest is the `text` block before it (`screenshot-response.ts`).
 * - `GatewayRequests`: what to capture is decided by the window's notice; Web goes through the consent of 1052; a file is checked again with `assertAllowed(…, 'read')`.
 * - `WebViewHost.shownContents`: only the view being shown (null while hidden, or when no Web is shown).
 */
import { describe, expect, it } from 'vitest'
import {
  encodeScreenshot,
  fitWithin,
  MAX_SCREENSHOT_EDGE,
  MAX_SCREENSHOT_JPEG_BYTES,
  MAX_SCREENSHOT_PNG_BYTES,
  VIEWER_RECT_SCRIPT,
  VIEWER_RECT_WORLD_ID,
  viewerCaptureRect,
  type NativeImageLike,
  type ScreenshotOutcome
} from '../src/main/session/viewer-screenshot.js'
import { screenshotResponse, VIEWER_SCREENSHOT_NOTICE } from '../src/gateway/screenshot-response.js'
import { GatewayRequests, WEB_TAB_READ_CONSENT_SUMMARY, type GatewayRequestHost } from '../src/main/session/gateway-requests.js'
import { WebViewHost, type WebViewLike } from '../src/main/web/host.js'
import type { ApprovalRequestInput, ApprovalResult } from '../src/main/approval/broker.js'
import { MAX_SCREENSHOT_BASE64_CHARS, MAX_SCREENSHOT_IMAGE_BYTES } from '../src/shared/screenshot.js'
import type { Thread } from '../src/shared/thread.js'
import type { ViewerShownReport } from '../src/shared/viewer-shown.js'
import type { ReadableWebTab } from '../src/main/web/page-text.js'
import { PAGE_TEXT_WORLD_ID } from '../src/main/web/page-text.js'

/** A fake NativeImage. Returns fixed PNG / JPEG sizes. */
class FakeImage implements NativeImageLike {
  resized: { width: number; height: number } | null = null
  qualities: number[] = []
  constructor(
    private readonly size: { width: number; height: number },
    private readonly pngBytes = 1000,
    private readonly jpegBytes: (quality: number) => number = () => 500
  ) {}
  isEmpty(): boolean {
    return this.size.width === 0
  }
  getSize(): { width: number; height: number } {
    return this.size
  }
  resize(options: { width: number; height: number }): NativeImageLike {
    this.resized = options
    const next = new FakeImage(options, this.pngBytes, this.jpegBytes)
    next.qualities = this.qualities
    return next
  }
  toPNG(): Uint8Array {
    return new Uint8Array(this.pngBytes).fill(1)
  }
  toJPEG(quality: number): Uint8Array {
    this.qualities.push(quality)
    return new Uint8Array(this.jpegBytes(quality)).fill(2)
  }
}

describe('viewer-screenshot pure functions (TODO 1061)', () => {
  it('shrinks keeping the ratio when the long side exceeds the limit', () => {
    expect(fitWithin({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 })
    expect(fitWithin({ width: 3136, height: 1000 })).toEqual({ width: MAX_SCREENSHOT_EDGE, height: 500 })
    expect(fitWithin({ width: 1000, height: 3136 })).toEqual({ width: 500, height: MAX_SCREENSHOT_EDGE })
    expect(fitWithin({ width: 0, height: 0 })).toEqual({ width: 1, height: 1 })
  })

  it('a small PNG stays PNG and a large PNG becomes JPEG (quality lowered until it fits the limit); an empty image is null', () => {
    const small = new FakeImage({ width: 2400, height: 1200 })
    const encoded = encodeScreenshot(small)
    expect(small.resized).toMatchObject({ width: MAX_SCREENSHOT_EDGE, height: 784 })
    expect(encoded).toMatchObject({ mimeType: 'image/png', width: MAX_SCREENSHOT_EDGE, height: 784, originalWidth: 2400, originalHeight: 1200 })
    expect(Buffer.from(encoded?.data ?? '', 'base64').length).toBe(1000)

    const photo = new FakeImage({ width: 1000, height: 800 }, MAX_SCREENSHOT_PNG_BYTES + 1, (quality) => (quality >= 60 ? 900 * 1024 : 300 * 1024))
    const jpeg = encodeScreenshot(photo)
    expect(jpeg).toMatchObject({ mimeType: 'image/jpeg', width: 1000, height: 800 })
    expect(photo.qualities).toEqual([80, 60, 45])

    expect(encodeScreenshot(new FakeImage({ width: 0, height: 0 }))).toBeNull()
  })

  it('if JPEG still exceeds the limit at the last stage, shrinks the sides and tries again; null if it still exceeds at the lower bound (58-8)', () => {
    // A fake JPEG whose size grows with the area: at 1000x800 it is 1 MB regardless of quality.
    const bytesFor = (size: { width: number; height: number }): number => Math.round((size.width * size.height) / 800000 * 1024 * 1024)
    class Sized extends FakeImage {
      constructor(size: { width: number; height: number }) {
        super(size, MAX_SCREENSHOT_PNG_BYTES + 1, () => bytesFor(size))
      }
      override resize(options: { width: number; height: number }): NativeImageLike {
        return new Sized(options)
      }
    }
    const encoded = encodeScreenshot(new Sized({ width: 1000, height: 800 }))
    expect(encoded?.mimeType).toBe('image/jpeg')
    expect(Buffer.from(encoded?.data ?? '', 'base64').length).toBeLessThanOrEqual(MAX_SCREENSHOT_JPEG_BYTES)
    expect(encoded?.width).toBeLessThan(1000)
    expect(encoded).toMatchObject({ originalWidth: 1000, originalHeight: 800 })
    // If it is still too big however far it is shrunk (above the cap even at the minimum side), give up.
    class Huge extends FakeImage {
      constructor(size: { width: number; height: number }) {
        super(size, MAX_SCREENSHOT_PNG_BYTES + 1, () => MAX_SCREENSHOT_JPEG_BYTES + 1)
      }
      override resize(options: { width: number; height: number }): NativeImageLike {
        return new Huge(options)
      }
    }
    expect(encodeScreenshot(new Huge({ width: 1000, height: 800 }))).toBeNull()
  })

  it("main's limit and the gateway's limit are the same shared value (58-8)", () => {
    expect(MAX_SCREENSHOT_PNG_BYTES).toBe(MAX_SCREENSHOT_IMAGE_BYTES)
    expect(MAX_SCREENSHOT_JPEG_BYTES).toBeLessThanOrEqual(MAX_SCREENSHOT_IMAGE_BYTES)
    expect(MAX_SCREENSHOT_BASE64_CHARS).toBe(Math.ceil(MAX_SCREENSHOT_IMAGE_BYTES / 3) * 4)
    const okPng = Buffer.alloc(MAX_SCREENSHOT_IMAGE_BYTES, 1).toString('base64')
    expect(screenshotResponse({ kind: 'diff', image: { data: okPng, mimeType: 'image/png' } }).content[1]).toMatchObject({ type: 'image' })
  })

  it('rectangle validation: CSS px → DIP (scale), fit inside the window, null for a wrong shape', () => {
    const content = { width: 1200, height: 800 }
    expect(viewerCaptureRect({ x: 600, y: 40, width: 600, height: 700 }, 1, content)).toEqual({ x: 600, y: 40, width: 600, height: 700 })
    expect(viewerCaptureRect({ x: 500, y: 0, width: 400, height: 500 }, 1.25, content)).toEqual({ x: 625, y: 0, width: 500, height: 625 })
    expect(viewerCaptureRect({ x: 1000, y: 0, width: 600, height: 900 }, 1, content)).toEqual({ x: 1000, y: 0, width: 200, height: 800 })
    for (const bad of [null, 'x', { x: 1, y: 1, width: 0, height: 10 }, { x: 'a', y: 0, width: 1, height: 1 }, { x: 2000, y: 0, width: 10, height: 10 }, { x: NaN, y: 0, width: 1, height: 1 }]) {
      expect(viewerCaptureRect(bad, 1, content)).toBeNull()
    }
  })

  it('the JS that takes the rectangle is a fixed statement in the app and looks at the temporary display first; world differs from 0 / 999 / 1052', () => {
    expect(VIEWER_RECT_SCRIPT).toContain('.viewer-transient, .viewer-pane')
    expect(VIEWER_RECT_SCRIPT).toContain('getBoundingClientRect')
    expect([0, 999, PAGE_TEXT_WORLD_ID]).not.toContain(VIEWER_RECT_WORLD_ID)
  })
})

describe('screenshotResponse (gateway, TODO 1061)', () => {
  it('the image is an image block, and the remaining fields and notes are in the preceding text block', () => {
    const response = screenshotResponse({ kind: 'web', url: 'https://a.example/', width: 10, height: 5, image: { data: 'AAAA', mimeType: 'image/png' } })
    expect(response.content).toHaveLength(2)
    expect(response.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' })
    const meta = JSON.parse((response.content[0] as { text: string }).text) as Record<string, unknown>
    expect(meta).toEqual({ notice: VIEWER_SCREENSHOT_NOTICE, kind: 'web', url: 'https://a.example/', width: 10, height: 5 })
  })

  it('a result with no image (a refusal) is only the same text as respond; a broken image is not passed', () => {
    expect(screenshotResponse({ error: 'no' }).content).toEqual([{ type: 'text', text: '{"error":"no"}' }])
    for (const image of [{ data: 'AA AA', mimeType: 'image/png' }, { data: 'AAAA', mimeType: 'image/svg+xml' }, { data: '', mimeType: 'image/png' }, 'x']) {
      const response = screenshotResponse({ kind: 'file', image })
      expect(response.content).toHaveLength(1)
      expect((response.content[0] as { text: string }).text).toContain('could not be delivered')
    }
  })
})

// ---------------------------------------------------------------------------
// GatewayRequests: getViewerScreenshot
// ---------------------------------------------------------------------------

const PNG_OK: ScreenshotOutcome = { ok: true, data: 'AAAA', mimeType: 'image/png', width: 800, height: 600, originalWidth: 800, originalHeight: 600 }

function setupGateway(options: {
  views?: number[]
  shown?: Map<number, ViewerShownReport>
  tabs?: ReadableWebTab[]
  onApproval?: (setTabs: (tabs: ReadableWebTab[]) => void) => void
  consented?: boolean
  allow?: boolean
  allowedPaths?: (uri: string) => boolean
  web?: ScreenshotOutcome
  pane?: ScreenshotOutcome
}): {
  requests: GatewayRequests
  approvals: ApprovalRequestInput[]
  captures: string[]
  checked: { uri: string; access: unknown }[]
  consent: { value: boolean }
} {
  const approvals: ApprovalRequestInput[] = []
  const captures: string[] = []
  const checked: { uri: string; access: unknown }[] = []
  const consent = { value: options.consented ?? false }
  const tabsRef: { current?: ReadableWebTab[] } = {}
  const host: Partial<GatewayRequestHost> = {
    isStopped: () => false,
    threadIdForSession: (sessionId) => (sessionId === 's1' ? 'th1' : undefined),
    getThread: (id) =>
      id === 'th1'
        ? ({ id, title: 'T', backend: 'x', cwdUri: 'file:///tmp', worktreeUri: null, approvalStrict: false } as unknown as Thread)
        : null,
    getAdapter: () => undefined,
    getLive: () => undefined,
    emitThread: () => undefined,
    record: () => undefined,
    viewsOf: () => options.views ?? [7],
    allViewEntries: () => [],
    viewerShown: (viewId, threadId) => {
      const report = options.shown?.get(viewId) ?? null
      return report !== null && report.threadId === threadId ? report : null
    },
    requestApproval: (input): Promise<ApprovalResult> => {
      approvals.push(input)
      options.onApproval?.((tabs) => {
        tabsRef.current = tabs
      })
      return Promise.resolve(
        (options.allow ?? true)
          ? ({ allowed: true, by: 'user' } as ApprovalResult)
          : ({ allowed: false, by: 'user', message: '' } as ApprovalResult)
      )
    },
    fs: {
      assertAllowed: (uri: string, _asDirectory: boolean, access?: unknown) => {
        checked.push({ uri, access })
        if (options.allowedPaths?.(uri) === false) throw new Error('denied')
        return uri.replace(/^file:\/\//, '')
      }
    } as GatewayRequestHost['fs'],
    webTabs: { list: () => tabsRef.current ?? options.tabs ?? [], read: () => Promise.resolve({ ok: false, reason: 'closed' }) },
    webTabReadConsent: {
      granted: () => consent.value,
      grant: () => {
        consent.value = true
      }
    },
    viewerCapture: {
      web: (viewId, tabId) => {
        captures.push(`web:${viewId}:${tabId}`)
        return Promise.resolve(options.web ?? { ...PNG_OK, url: 'https://b.example/pr/1' })
      },
      pane: (viewId) => {
        captures.push(`pane:${viewId}`)
        return Promise.resolve(options.pane ?? PNG_OK)
      }
    }
  }
  return { requests: new GatewayRequests(host as GatewayRequestHost), approvals, captures, checked, consent }
}

const shoot = (fixture: { requests: GatewayRequests }): Promise<unknown> =>
  fixture.requests.handle({ sessionId: 's1', kind: 'getViewerScreenshot', payload: {} } as never)

const prTab: ReadableWebTab = { tabId: 't2', url: 'https://b.example/pr/1', title: 'PR', active: true }

describe('getViewerScreenshot (TODO 1061)', () => {
  it('Web display: asks for the same consent as 1052 only the first time and captures the tab being shown', async () => {
    const shown = new Map<number, ViewerShownReport>([[7, { threadId: 'th1', kind: 'web', uri: prTab.url }]])
    const fixture = setupGateway({ shown, tabs: [{ ...prTab, active: false, tabId: 't1' }, prTab] })
    const result = (await shoot(fixture)) as Record<string, unknown>
    expect(fixture.approvals).toHaveLength(1)
    expect(fixture.approvals[0]).toMatchObject({ toolName: 'mcp__aios__getViewerScreenshot', summary: WEB_TAB_READ_CONSENT_SUMMARY })
    expect(fixture.consent.value).toBe(true)
    expect(fixture.captures).toEqual(['web:7:t2'])
    expect(result).toMatchObject({ kind: 'web', tabId: 't2', url: 'https://b.example/pr/1', title: 'PR', width: 800, height: 600 })
    expect(result['image']).toEqual({ data: 'AAAA', mimeType: 'image/png' })
    // The second time it does not ask.
    await shoot(fixture)
    expect(fixture.approvals).toHaveLength(1)
  })

  it('Web display: if the tab changes while waiting for consent, captures the tab after the change (58-2)', async () => {
    const shown = new Map<number, ViewerShownReport>([[7, { threadId: 'th1', kind: 'web', uri: prTab.url }]])
    const t1 = { ...prTab, tabId: 't1', active: false }
    const fixture = setupGateway({
      shown,
      tabs: [t1, prTab],
      onApproval: (setTabs) => setTabs([{ ...t1, active: true }, { ...prTab, active: false }])
    })
    const result = (await shoot(fixture)) as Record<string, unknown>
    expect(fixture.captures).toEqual(['web:7:t1'])
    expect(result).toMatchObject({ tabId: 't1' })
  })

  it('Web display: does not capture when refused', async () => {
    const shown = new Map<number, ViewerShownReport>([[7, { threadId: 'th1', kind: 'web', uri: prTab.url }]])
    const fixture = setupGateway({ shown, tabs: [prTab], allow: false })
    expect(await shoot(fixture)).toMatchObject({ error: expect.stringMatching(/NOT/) })
    expect(fixture.captures).toEqual([])
    expect(fixture.consent.value).toBe(false)
  })

  it('file viewer: does not ask for consent; re-validates with assertAllowed (read) before capturing; a refused path is not captured', async () => {
    const shown = new Map<number, ViewerShownReport>([[7, { threadId: 'th1', kind: 'file', uri: 'file:///tmp/a.pdf' }]])
    const fixture = setupGateway({ shown })
    expect(await shoot(fixture)).toMatchObject({ kind: 'file', path: '/tmp/a.pdf', image: { mimeType: 'image/png' } })
    expect(fixture.approvals).toEqual([])
    expect(fixture.checked).toEqual([{ uri: 'file:///tmp/a.pdf', access: 'read' }])
    expect(fixture.captures).toEqual(['pane:7'])

    const denied = setupGateway({ shown, allowedPaths: () => false })
    expect(await shoot(denied)).toMatchObject({ error: expect.stringMatching(/cannot be captured/) })
    expect(denied.captures).toEqual([])
  })

  it('a viewer other than file: (transcript thread://) captures the pane without a path', async () => {
    const shown = new Map<number, ViewerShownReport>([[7, { threadId: 'th1', kind: 'file', uri: 'thread://abc' }]])
    const fixture = setupGateway({ shown })
    const result = (await shoot(fixture)) as Record<string, unknown>
    expect(result).toMatchObject({ kind: 'other', image: { mimeType: 'image/png' } })
    expect(result['path']).toBeUndefined()
    expect(fixture.checked).toEqual([])
    expect(fixture.captures).toEqual(['pane:7'])
  })

  it('a temporary display (diff) is captured as is; adds a note if shrunk', async () => {
    const shown = new Map<number, ViewerShownReport>([[7, { threadId: 'th1', kind: 'diff', uri: null }]])
    const fixture = setupGateway({ shown, pane: { ...PNG_OK, width: 1568, height: 784, originalWidth: 3136, originalHeight: 1568 } })
    expect(await shoot(fixture)).toMatchObject({ kind: 'diff', note: 'Scaled down from 3136x1568.' })
    expect(fixture.checked).toEqual([])
  })

  it('returns error when there is no window, the pane is closed, there is no notice, the tab is blank, or capture failed', async () => {
    expect(await shoot(setupGateway({ views: [] }))).toMatchObject({ error: expect.stringMatching(/No window/) })
    const closed = new Map<number, ViewerShownReport>([[7, { threadId: 'th1', kind: 'none', uri: null }]])
    expect(await shoot(setupGateway({ shown: closed }))).toMatchObject({ error: expect.stringMatching(/closed/) })
    expect(await shoot(setupGateway({}))).toMatchObject({ error: expect.stringMatching(/not known yet/) })
    const blank = new Map<number, ViewerShownReport>([[7, { threadId: 'th1', kind: 'web', uri: 'about:blank' }]])
    expect(await shoot(setupGateway({ shown: blank, tabs: [] }))).toMatchObject({ error: expect.stringMatching(/empty browser tab/) })
    const file = new Map<number, ViewerShownReport>([[7, { threadId: 'th1', kind: 'file', uri: 'file:///tmp/a.md' }]])
    const hidden = setupGateway({ shown: file, pane: { ok: false, reason: 'hidden' } })
    const result = (await shoot(hidden)) as Record<string, unknown>
    expect(result).toMatchObject({ error: expect.stringMatching(/covered/), kind: 'file' })
    expect(result['image']).toBeUndefined()
  })

  it('skips windows with a closed pane and captures a window that has something in front', async () => {
    const shown = new Map<number, ViewerShownReport>([
      [7, { threadId: 'th1', kind: 'none', uri: null }],
      [8, { threadId: 'th1', kind: 'diff', uri: null }]
    ])
    const fixture = setupGateway({ views: [7, 8], shown })
    await shoot(fixture)
    expect(fixture.captures).toEqual(['pane:8'])
  })
})

// ---------------------------------------------------------------------------
// WebViewHost.shownContents
// ---------------------------------------------------------------------------

function fakeView(): WebViewLike {
  let url = ''
  let destroyed = false
  const contents = {
    loadURL: (next: string) => {
      url = next
      return Promise.resolve()
    },
    getURL: () => url,
    reload: () => undefined,
    stop: () => undefined,
    focus: () => undefined,
    isDestroyed: () => destroyed,
    close: () => {
      destroyed = true
    },
    findInPage: () => 0,
    stopFindInPage: () => undefined,
    capturePage: () => Promise.resolve({ isEmpty: () => true, toJPEG: () => new Uint8Array() }),
    setWindowOpenHandler: () => undefined,
    on: () => undefined
  }
  return { webContents: contents, setBounds: () => undefined, setVisible: () => undefined }
}

describe('WebViewHost.shownContents (TODO 1061)', () => {
  it('only the tab of the view being shown; null while hidden or after closing', async () => {
    const host = new WebViewHost({
      createView: fakeView,
      removeView: () => undefined,
      openExternal: () => undefined,
      send: () => undefined,
      zoom: () => 1,
      contentSize: () => ({ width: 100, height: 100 }),
      setTimer: () => 1,
      clearTimer: () => undefined
    })
    expect(host.shownContents()).toBeNull()
    host.load('https://a.example/', 't1')
    // The renderer has not yet said 'show it'.
    expect(host.shownContents()).toBeNull()
    await host.setVisible(true, false)
    expect(host.shownContents()?.tabId).toBe('t1')
    host.load('https://b.example/', 't2')
    expect(host.shownContents()?.tabId).toBe('t2')
    // While hidden by a cover (such as a context menu).
    await host.setVisible(false, false)
    expect(host.shownContents()).toBeNull()
    await host.setVisible(true, false)
    host.hide()
    expect(host.shownContents()).toBeNull()
  })
})
