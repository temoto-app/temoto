/**
 * TODO 1221 (ARCHITECTURE 5.2.1 'fullscreen'): fullscreen for Web content. Neither the model nor electron is used: a fake WebContentsView and window are passed to `WebViewHost`.
 *
 * The worst case is **failing to exit and leaving the view over the whole window**, so each entry (⌃⌘F and the page's fullscreen) and each exit path (⌃⌘F again, Esc,
 * switching tabs, closing a tab, hiding or closing the pane, closing the window, a cover, the view crashing, the window's fullscreen being released from outside,
 * and the key that moves focus to the field) is pinned down one by one.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { FULLSCREEN_HINT_MS, WebViewHost, type WebViewLike } from '../src/main/web/host.js'
import {
  FULLSCREEN_HINT_HEIGHT,
  FULLSCREEN_HINT_WIDTH,
  fullscreenHintBounds,
  fullscreenHintHtml,
  fullscreenHintUrl
} from '../src/main/web/fullscreen-hint.js'
import { isFullscreenExitKey, type WebViewEvent, type WebViewInput } from '../src/shared/web-view.js'
import { coverTarget, shouldHideWebView } from '../src/renderer/src/web-cover.js'
import { FULLSCREEN_ITEM, fullScreenAccelerator } from '../src/main/menu-model.js'
import { reservedKeybindings } from '../src/shared/keybindings.js'
import { NATIVE_DICTIONARIES } from '../src/main/i18n-native.js'

class FakeContents extends EventEmitter {
  url = ''
  destroyed = false
  focused = 0
  scripts: string[] = []
  loadURL(url: string): Promise<void> {
    this.url = url
    return Promise.resolve()
  }
  getURL(): string {
    return this.url
  }
  reload(): void {}
  stop(): void {}
  focus(): void {
    this.focused++
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  close(): void {
    this.destroyed = true
  }
  findInPage(): number {
    return 1
  }
  stopFindInPage(): void {}
  capturePage(): Promise<{ isEmpty(): boolean; toJPEG(q: number): Uint8Array }> {
    return Promise.resolve({ isEmpty: () => true, toJPEG: () => new Uint8Array() })
  }
  setWindowOpenHandler(): void {}
  executeJavaScriptInIsolatedWorld(_world: number, scripts: { code: string }[]): Promise<unknown> {
    for (const script of scripts) this.scripts.push(script.code)
    return Promise.resolve(undefined)
  }
}

class FakeView {
  readonly webContents = new FakeContents()
  bounds: { x: number; y: number; width: number; height: number } | null = null
  visible: boolean[] = []
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = bounds
  }
  setVisible(visible: boolean): void {
    this.visible.push(visible)
  }
}

const CONTENT = { width: 1200, height: 800 }
const FULL = { x: 0, y: 0, width: 1200, height: 800 }
const PANE = { x: 600, y: 40, width: 600, height: 760 }

interface Rig {
  host: WebViewHost
  views: FakeView[]
  events: WebViewEvent[]
  /** The window's fullscreen (fake). */
  window: { fullScreen: boolean; calls: boolean[] }
  hint: boolean[]
  timers: { fn: () => void; ms: number; cleared: boolean }[]
}

function setup(windowFullScreen = false): Rig {
  const views: FakeView[] = []
  const events: WebViewEvent[] = []
  const window = { fullScreen: windowFullScreen, calls: [] as boolean[] }
  const hint: boolean[] = []
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
  const host = new WebViewHost({
    createView: () => {
      const view = new FakeView()
      views.push(view)
      return view as unknown as WebViewLike
    },
    removeView: () => undefined,
    openExternal: () => undefined,
    send: (event) => events.push(event),
    zoom: () => 1,
    contentSize: () => CONTENT,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
    isWindowFullScreen: () => window.fullScreen,
    setWindowFullScreen: (on) => {
      window.calls.push(on)
      window.fullScreen = on
    },
    fullscreenHint: (show) => hint.push(show)
  })
  return { host, views, events, window, hint, timers }
}

/** A state where one Web page is shown (the pane's rectangle, and shown). */
function showing(rig: Rig, tabId = 't1'): FakeView {
  rig.host.setBounds(PANE)
  rig.host.load('https://example.com/', tabId)
  void rig.host.setVisible(true, false)
  const view = rig.views.at(-1)
  if (view === undefined) throw new Error('no view')
  return view
}

function fullscreenEvents(events: readonly WebViewEvent[]): (string | null)[] {
  return events.flatMap((event) => (event.kind === 'fullscreen' ? [event.mode] : []))
}

function keyDown(key: string, mods: Partial<WebViewInput> = {}): WebViewInput {
  return { type: 'keyDown', key, meta: false, control: false, shift: false, alt: false, ...mods }
}

/** The promise after exiting: there is no fullscreen state, and the view does not remain over the whole window. */
function expectExited(rig: Rig, view: FakeView): void {
  expect(rig.host.fullscreenMode).toBeNull()
  expect(view.bounds).not.toEqual(FULL)
  expect(fullscreenEvents(rig.events).at(-1)).toBeNull()
}

describe('⌃⌘F (fullscreen for only the Web content)', () => {
  it('when a Web page is shown, makes the window fullscreen and the view fill the whole window; pressing again restores both window and view', () => {
    const rig = setup()
    const view = showing(rig)
    expect(view.bounds).toEqual(PANE)
    expect(rig.host.toggleContentFullscreen()).toBe(true)
    expect(rig.host.fullscreenMode).toBe('content')
    expect(rig.window.calls).toEqual([true])
    expect(view.bounds).toEqual(FULL)
    expect(view.webContents.focused).toBe(1) // Focus moves to the page so that Esc reaches the page
    expect(rig.hint).toEqual([true])
    expect(fullscreenEvents(rig.events)).toEqual(['content'])

    expect(rig.host.toggleContentFullscreen()).toBe(true)
    expect(rig.window.calls).toEqual([true, false])
    expect(view.bounds).toEqual(PANE)
    expect(rig.hint).toEqual([true, false])
    expectExited(rig, view)
  })

  it('when no Web page is shown (no view, or hidden by a cover), returns false and the caller makes the window fullscreen', () => {
    const rig = setup()
    expect(rig.host.toggleContentFullscreen()).toBe(false)
    showing(rig)
    void rig.host.setVisible(false, false)
    expect(rig.host.toggleContentFullscreen()).toBe(false)
    expect(rig.window.calls).toEqual([])
  })

  it('a window that was fullscreen already does not leave window fullscreen on exit', () => {
    const rig = setup(true)
    const view = showing(rig)
    rig.host.toggleContentFullscreen()
    expect(rig.window.calls).toEqual([])
    expect(view.bounds).toEqual(FULL)
    rig.host.toggleContentFullscreen()
    expect(rig.window.calls).toEqual([])
    expect(rig.window.fullScreen).toBe(true)
    expectExited(rig, view)
  })

  it('a pane rectangle that arrives during fullscreen is only remembered; on exit it returns to the latest rectangle', () => {
    const rig = setup()
    const view = showing(rig)
    rig.host.toggleContentFullscreen()
    const moved = { x: 500, y: 40, width: 700, height: 760 }
    rig.host.setBounds(moved)
    expect(view.bounds).toEqual(FULL)
    rig.host.windowResized()
    expect(view.bounds).toEqual(FULL)
    rig.host.toggleContentFullscreen()
    expect(view.bounds).toEqual(moved)
  })

  it('the tooltip disappears after a few seconds (the timer also stops on exit)', () => {
    const rig = setup()
    showing(rig)
    rig.host.toggleContentFullscreen()
    const timer = rig.timers.find((t) => t.ms === FULLSCREEN_HINT_MS)
    expect(timer).toBeDefined()
    timer?.fn()
    expect(rig.hint).toEqual([true, false])
    rig.host.toggleContentFullscreen()
    expect(rig.hint).toEqual([true, false]) // After it is gone, it is not erased twice
  })
})

describe('fullscreen requested by a page (Fullscreen API)', () => {
  it('enter-html-full-screen goes fullscreen and leave-html-full-screen exits', () => {
    const rig = setup()
    const view = showing(rig)
    view.webContents.emit('enter-html-full-screen')
    expect(rig.host.fullscreenMode).toBe('page')
    expect(rig.window.calls).toEqual([true])
    expect(view.bounds).toEqual(FULL)
    view.webContents.emit('leave-html-full-screen')
    expect(rig.window.calls).toEqual([true, false])
    expectExited(rig, view)
  })

  it('refuses a request from a view that is not shown (a hidden tab) and makes the page leave fullscreen', () => {
    const rig = setup()
    const first = showing(rig, 't1')
    showing(rig, 't2')
    first.webContents.emit('enter-html-full-screen')
    expect(rig.host.fullscreenMode).toBeNull()
    expect(rig.window.calls).toEqual([])
    expect(first.webContents.scripts.some((code) => code.includes('exitFullscreen'))).toBe(true)
  })

  it('when a page goes fullscreen inside ⌃⌘F fullscreen, leaving returns to ⌃⌘F fullscreen (same as Chrome)', () => {
    const rig = setup()
    const view = showing(rig)
    rig.host.toggleContentFullscreen()
    view.webContents.emit('enter-html-full-screen')
    expect(rig.host.fullscreenMode).toBe('page')
    view.webContents.emit('leave-html-full-screen')
    expect(rig.host.fullscreenMode).toBe('content')
    expect(view.bounds).toEqual(FULL)
    expect(rig.window.calls).toEqual([true])
    rig.host.toggleContentFullscreen()
    expectExited(rig, view)
    expect(rig.window.calls).toEqual([true, false])
  })

  it('when we leave, also makes the page leave fullscreen (document.exitFullscreen)', () => {
    const rig = setup()
    const view = showing(rig)
    view.webContents.emit('enter-html-full-screen')
    rig.host.toggleContentFullscreen()
    expect(view.webContents.scripts.filter((code) => code.includes('exitFullscreen'))).toHaveLength(1)
    // A leave-html-full-screen that arrives later does nothing.
    view.webContents.emit('leave-html-full-screen')
    expect(rig.window.calls).toEqual([true, false])
    expectExited(rig, view)
  })
})

describe('exit paths (do not leave the view over the whole window)', () => {
  /** Enters fullscreen, then calls `leave` and checks that it has exited. */
  function exitsBy(leave: (rig: Rig, view: FakeView) => void, mode: 'content' | 'page' = 'content'): Rig {
    const rig = setup()
    const view = showing(rig)
    if (mode === 'content') rig.host.toggleContentFullscreen()
    else view.webContents.emit('enter-html-full-screen')
    expect(rig.host.fullscreenMode).toBe(mode)
    leave(rig, view)
    expect(rig.host.fullscreenMode).toBeNull()
    expect(rig.window.fullScreen).toBe(false)
    expect(fullscreenEvents(rig.events).at(-1)).toBeNull()
    return rig
  }

  it('Esc (page focused): not passed to the page and not made a key to send back', () => {
    for (const mode of ['content', 'page'] as const) {
      const rig = exitsBy((_rig, view) => {
        const event = { prevented: false, preventDefault: () => (event.prevented = true) }
        view.webContents.emit('before-input-event', event, keyDown('Escape'))
        expect(event.prevented).toBe(true)
      }, mode)
      expect(rig.events.some((event) => event.kind === 'shortcut')).toBe(false)
    }
  })

  it('Esc when not fullscreen is passed to the page', () => {
    const rig = setup()
    const view = showing(rig)
    const event = { prevented: false, preventDefault: () => (event.prevented = true) }
    view.webContents.emit('before-input-event', event, keyDown('Escape'))
    expect(event.prevented).toBe(false)
    expect(rig.host.escapeFullscreen()).toBe(false)
  })

  it('Esc (renderer focused: escapeFullscreen)', () => {
    exitsBy((rig) => expect(rig.host.escapeFullscreen()).toBe(true))
  })

  it('switched to another tab (showing a live view / creating a new view)', () => {
    exitsBy((rig) => rig.host.load('https://other.example/', 't2'))
    const rig = setup()
    showing(rig, 't1')
    showing(rig, 't2')
    rig.host.load('https://example.com/', 't1') // Swap the live t1 into view
    rig.host.toggleContentFullscreen()
    rig.host.load('https://example.com/', 't2')
    expect(rig.host.fullscreenMode).toBeNull()
    expect(rig.window.fullScreen).toBe(false)
  })

  it('navigating within the page of the same tab does not exit (stays in ⌃⌘F fullscreen)', () => {
    const rig = setup()
    showing(rig, 't1')
    rig.host.toggleContentFullscreen()
    rig.host.load('https://example.com/next', 't1')
    expect(rig.host.fullscreenMode).toBe('content')
  })

  it('closed the fullscreen tab', () => {
    exitsBy((rig) => rig.host.dropTab('t1'))
  })

  it('switched to a file (hides the pane)', () => {
    exitsBy((rig) => rig.host.hide())
  })

  it('closed the pane with ✕ / reloaded the renderer', () => {
    exitsBy((rig) => rig.host.close())
  })

  it('closed the window', () => {
    exitsBy((rig) => rig.host.dispose())
  })

  it('a cover (dialog, settings) appeared', () => {
    exitsBy((rig) => void rig.host.setVisible(false, false))
  })

  it('the page process crashed', () => {
    exitsBy((_rig, view) => view.webContents.emit('render-process-gone'))
  })

  it('window fullscreen was undone from outside: only the view is restored without touching the window', () => {
    const rig = exitsBy((rig) => {
      rig.window.fullScreen = false
      rig.host.windowLeftFullScreen()
    })
    expect(rig.window.calls).toEqual([true]) // Does not stack setFullScreen(false) on exit.
  })

  it('the key that focuses the URL or search field (⌘L) exits first so the field is visible, then sends', () => {
    const rig = exitsBy((rig, view) => {
      rig.host.setShortcuts([{ id: 'webFocusAddress', key: 'l', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }])
      const event = { preventDefault: () => undefined }
      view.webContents.emit('before-input-event', event, keyDown('l', { meta: true }))
    })
    expect(rig.events.at(-1)).toEqual({ kind: 'shortcut', id: 'webFocusAddress' })
  })

  it('however many times it exits, window fullscreen is not undone twice', () => {
    const rig = setup()
    const view = showing(rig)
    rig.host.toggleContentFullscreen()
    rig.host.hide()
    rig.host.close()
    rig.host.dispose()
    expect(rig.window.calls).toEqual([true, false])
    expect(fullscreenEvents(rig.events)).toEqual(['content', null])
    expect(view.bounds).toEqual(PANE)
  })
})

describe('pure functions', () => {
  it('isFullscreenExitKey: only a keyDown of Esc without modifiers', () => {
    expect(isFullscreenExitKey(keyDown('Escape'))).toBe(true)
    expect(isFullscreenExitKey({ ...keyDown('Escape'), type: 'keyUp' })).toBe(false)
    expect(isFullscreenExitKey(keyDown('Escape', { shift: true }))).toBe(false)
    expect(isFullscreenExitKey(keyDown('Escape', { meta: true }))).toBe(false)
    expect(isFullscreenExitKey(keyDown('f', { meta: true, control: true }))).toBe(false)
  })

  it('coverTarget: during fullscreen, looks at the cover over the whole window', () => {
    const pane = { left: 600, top: 40, right: 1200, bottom: 800 }
    const viewport = { left: 0, top: 0, right: 1200, bottom: 800 }
    const dialog = { left: 100, top: 100, right: 400, bottom: 300 } // Only over the conversation pane
    expect(shouldHideWebView(coverTarget(pane, viewport, false), [dialog])).toBe(false)
    expect(shouldHideWebView(coverTarget(pane, viewport, true), [dialog])).toBe(true)
  })

  it('the tooltip rectangle is top center, and narrows its width in a narrow window', () => {
    expect(fullscreenHintBounds(1200)).toEqual({
      x: (1200 - FULLSCREEN_HINT_WIDTH) / 2,
      y: 24,
      width: FULLSCREEN_HINT_WIDTH,
      height: FULLSCREEN_HINT_HEIGHT
    })
    const narrow = fullscreenHintBounds(300)
    expect(narrow.width).toBeLessThanOrEqual(300)
    expect(narrow.x).toBeGreaterThanOrEqual(0)
  })

  it('tooltip HTML: escapes the wording and renders Esc as a key shape; no JS and no color literals', () => {
    const html = fullscreenHintHtml('Press Esc to <exit>')
    expect(html).toContain('<kbd>Esc</kbd>')
    expect(html).toContain('&#60;exit&#62;')
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
    expect(fullscreenHintUrl('x').startsWith('data:text/html;charset=utf-8,')).toBe(true)
    for (const locale of ['ja', 'en'] as const) {
      expect(NATIVE_DICTIONARIES[locale]['web.fullscreenHint']).toContain('Esc')
      expect(NATIVE_DICTIONARIES[locale][FULLSCREEN_ITEM.label]).not.toBe('')
    }
  })

  it('the menu keys are the same as the role (⌃⌘F / F11) and are in the reserved key table', () => {
    expect(fullScreenAccelerator('darwin')).toBe('Ctrl+Cmd+F')
    expect(fullScreenAccelerator('other')).toBe('F11')
    expect(reservedKeybindings('mac').map(([key]) => key)).toContain('Ctrl+Cmd+F')
    expect(reservedKeybindings('other').map(([key]) => key)).toContain('F11')
  })
})
