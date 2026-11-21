// @vitest-environment jsdom
/**
 * Items 253 / 258 (wave 15 bundle B): the two drop entry points, checked in jsdom through to their dispatch.
 *
 * It renders the same combination as ThreadPane's outer frame (the real Composer inside a frame with `usePaneDrop`), and checks that
 * - a Drop on the frame (the conversation pane) attaches (`addAttachment`), and the cover appears and disappears when leaving
 * - a Drop on the textarea does not attach, and the full path goes in at the cursor position (spaces become `\ `)
 * - an attachment outside the reference scope appears in the band above the Composer (`dropStore`)
 * It covers both `text/uri-list` (aios's file list) and Finder's `File` (`drop.uriFor`). Neither the model nor Electron is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachOutcome } from '../src/renderer/src/threadStore.js'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const addAttachment = vi.fn<(threadId: string, uri: string) => Promise<AttachOutcome>>(async () => ({ ok: true, outside: null }))

const trace = vi.fn<(entry: unknown) => void>()

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  addAttachment.mockClear()
  trace.mockClear()
  ;(window as unknown as { aios: unknown }).aios = {
    // In tests, Finder's File is a fake that carries `{ uri }`. The real preload is webUtils.getPathForFile → URI.
    drop: { uriFor: (file: { uri?: string }) => file.uri ?? '', trace },
    attachments: { pick: vi.fn(async () => []) },
    threads: { setPlanMode: vi.fn() },
    fs: {}
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** The frame with the same combination as ThreadPane. */
async function render(): Promise<{ pane: HTMLElement; textarea: HTMLTextAreaElement }> {
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  useThreads.setState({ addAttachment, drafts: {} })
  const { Composer } = await import('../src/renderer/src/components/Composer.js')
  const { usePaneDrop } = await import('../src/renderer/src/pane-drop.js')
  function Pane(): React.JSX.Element {
    const drop = usePaneDrop('t1')
    return createElement(
      'div',
      { className: drop.dragging ? 'thread-pane pane-dropping' : 'thread-pane', ...drop.handlers },
      drop.dragging ? createElement('div', { className: 'pane-drop-overlay' }) : null,
      createElement('div', { className: 'thread-body' }),
      createElement(Composer, { threadId: 't1' })
    )
  }
  act(() => root.render(createElement(Pane)))
  return {
    pane: host.querySelector<HTMLElement>('.thread-pane')!,
    textarea: host.querySelector<HTMLTextAreaElement>('textarea.composer-input')!
  }
}

interface FakeTransfer {
  types: string[]
  files: { uri: string }[]
  getData(format: string): string
}

function transfer(uris: { files?: string[]; listed?: string[] }): FakeTransfer {
  return {
    types: [...(uris.files ? ['Files'] : []), ...(uris.listed ? ['text/uri-list'] : [])],
    files: (uris.files ?? []).map((uri) => ({ uri })),
    getData: (format) => (format === 'text/uri-list' ? (uris.listed ?? []).join('\n') : '')
  }
}

function fire(target: Element, type: string, dataTransfer: FakeTransfer, init: EventInit = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

const settle = (): Promise<void> => act(async () => {})

describe('a drop on the whole conversation pane is an attachment (item 253)', () => {
  it('dropping on the timeline makes both a Finder File and an aios file list URI an attachment', async () => {
    const { pane } = await render()
    const body = pane.querySelector('.thread-body')!
    const data = transfer({ files: ['file:///Users/me/a.png'], listed: ['file:///Users/me/b.md'] })
    const drop = fire(body, 'drop', data)
    await settle()
    expect(drop.defaultPrevented).toBe(true)
    expect(addAttachment.mock.calls).toEqual([
      ['t1', 'file:///Users/me/a.png'],
      ['t1', 'file:///Users/me/b.md']
    ])
  })

  it('does not accept non-files (such as a text selection)', async () => {
    const { pane } = await render()
    const data = { types: ['text/plain'], files: [], getData: () => 'x' }
    const over = fire(pane, 'dragover', data)
    const drop = fire(pane, 'drop', data)
    await settle()
    expect(over.defaultPrevented).toBe(false)
    expect(drop.defaultPrevented).toBe(false)
    expect(addAttachment).not.toHaveBeenCalled()
    expect(pane.classList.contains('pane-dropping')).toBe(false)
  })

  it('the overlay appears while dragging, does not flicker across child elements, disappears when leaving the pane and when dropped', async () => {
    const { pane, textarea } = await render()
    const data = transfer({ files: ['file:///a.png'] })
    fire(pane.querySelector('.thread-body')!, 'dragover', data)
    expect(pane.querySelector('.pane-drop-overlay')).not.toBeNull()
    // From a child to another child (relatedTarget is inside the pane) — does not disappear
    const inside = new Event('dragleave', { bubbles: true, cancelable: true })
    Object.defineProperty(inside, 'relatedTarget', { value: textarea })
    act(() => {
      pane.querySelector('.thread-body')!.dispatchEvent(inside)
    })
    expect(pane.querySelector('.pane-drop-overlay')).not.toBeNull()
    // No relatedTarget, or outside the pane (it left the pane) — disappears
    fire(pane, 'dragleave', data)
    expect(pane.querySelector('.pane-drop-overlay')).toBeNull()
    fire(pane, 'dragover', data)
    expect(pane.querySelector('.pane-drop-overlay')).not.toBeNull()
    fire(textarea, 'drop', data) // Disappears on a Drop on the textarea too
    await settle()
    expect(pane.querySelector('.pane-drop-overlay')).toBeNull()
  })

  it('an attachment outside the reference scope appears in the permission band above the Composer', async () => {
    addAttachment.mockResolvedValueOnce({ ok: true, outside: 'file:///Volumes/x/out.png' })
    const { pane } = await render()
    fire(pane.querySelector('.thread-body')!, 'drop', transfer({ files: ['file:///Volumes/x/out.png'] }))
    await settle()
    expect(host.querySelector('.composer-permission .paths')!.textContent).toBe('out.png')
    // TODO 624: the band's wording shows that adding it does not take effect for this send.
    expect(host.querySelector('.composer-allow-hint')!.textContent).toBe('Becomes readable starting with the next turn')
  })
})

describe('does not stay silent when something cannot be attached (TODO 489)', () => {
  beforeEach(async () => {
    const { useDropNotices } = await import('../src/renderer/src/dropStore.js')
    useDropNotices.setState({ failed: {}, outside: {} })
  })

  it('non-images in an excluded temporary folder and the like show the file name and reason in the band above the Composer, and can be closed', async () => {
    addAttachment.mockResolvedValueOnce({ ok: false, reason: 'attach-temp-not-image' })
    const { pane } = await render()
    const uri = 'file:///var/folders/xx/T/TemporaryItems/NSIRD_screencaptureui_ab/%E3%83%A1%E3%83%A2.txt'
    fire(pane.querySelector('.thread-body')!, 'drop', transfer({ files: [uri] }))
    await settle()
    const strip = host.querySelector('.composer-attach-failed')
    expect(strip).not.toBeNull()
    expect(strip!.querySelector('.paths')!.textContent).toBe('メモ.txt')
    // The reason is given as wording, not as the raw code (7.4.4).
    expect(strip!.textContent).not.toContain('attach-temp-not-image')
    expect(strip!.textContent).toMatch(/PNG \/ JPEG \/ GIF \/ WebP/)
    expect(host.querySelector('.composer-permission:not(.composer-attach-failed)')).toBeNull()
    act(() => strip!.querySelector('button')!.click())
    expect(host.querySelector('.composer-attach-failed')).toBeNull()
  })

  it('TODO 600: when 「参照範囲に追加」 is refused, shows the folder name and reason instead of silently removing the band; does not show folders that passed', async () => {
    const { useDropNotices } = await import('../src/renderer/src/dropStore.js')
    useDropNotices.setState({ allowFailed: {} })
    const allowDir = vi.fn(async (_threadId: string, dirUri: string) => {
      if (dirUri.endsWith('/Caches')) throw new Error("Error invoking remote method 'aios:thread/allowDir': Error: aios-reason:allow-dir-excluded")
      return {}
    })
    ;(window as unknown as { aios: { threads: Record<string, unknown> } }).aios.threads.allowDir = allowDir
    addAttachment
      .mockResolvedValueOnce({ ok: true, outside: 'file:///Users/me/Library/Caches/a.txt' })
      .mockResolvedValueOnce({ ok: true, outside: 'file:///tmp/b.txt' })
      .mockResolvedValueOnce({ ok: true, outside: 'file:///tmp/c.txt' })
    const { pane } = await render()
    fire(
      pane.querySelector('.thread-body')!,
      'drop',
      transfer({ files: ['file:///Users/me/Library/Caches/a.txt', 'file:///tmp/b.txt', 'file:///tmp/c.txt'] })
    )
    await settle()
    const permission = host.querySelector('.composer-permission:not(.composer-attach-failed)')!
    await act(async () => {
      ;(permission.querySelector('button') as HTMLButtonElement).click()
    })
    await settle()
    // The same folder is added only once.
    expect(allowDir.mock.calls.map(([, dir]) => dir)).toEqual(['file:///Users/me/Library/Caches', 'file:///tmp'])
    expect(host.querySelector('.composer-permission:not(.composer-attach-failed)')).toBeNull()
    const strip = host.querySelector('.composer-allow-failed')
    expect(strip).not.toBeNull()
    expect([...strip!.querySelectorAll('.paths')].map((e) => e.textContent)).toEqual(['Caches'])
    expect(strip!.textContent).not.toContain('allow-dir-excluded')
    act(() => (strip!.querySelector('button') as HTMLButtonElement).click())
    expect(host.querySelector('.composer-allow-failed')).toBeNull()
  })

  it('when a re-drop attaches successfully, the failure for that URI disappears', async () => {
    const uri = 'file:///var/folders/xx/T/shot.png'
    addAttachment.mockResolvedValueOnce({ ok: false, reason: 'attach-gone' })
    const { pane } = await render()
    fire(pane.querySelector('.thread-body')!, 'drop', transfer({ files: [uri] }))
    await settle()
    expect(host.querySelector('.composer-attach-failed')).not.toBeNull()
    fire(pane.querySelector('.thread-body')!, 'drop', transfer({ files: [uri] }))
    await settle()
    expect(host.querySelector('.composer-attach-failed')).toBeNull()
  })

  it('route log: reports only the counts of the first dragover and drop per drag to main (no paths)', async () => {
    const { pane } = await render()
    const data = transfer({ files: ['file:///var/folders/xx/T/shot.png', ''] })
    fire(pane, 'dragover', data)
    fire(pane, 'dragover', data)
    fire(pane, 'drop', data)
    await settle()
    expect(trace.mock.calls.map(([entry]) => entry)).toEqual([
      { stage: 'pane-dragover' },
      { stage: 'pane-drop', files: 2, uris: 1, emptyPaths: 1, action: 'attach' }
    ])
    // The next drag writes dragover once again.
    fire(pane, 'dragover', data)
    expect(trace).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(trace.mock.calls)).not.toContain('shot.png')
  })
})

describe('a drop on the prompt textarea inserts a full path (item 258)', () => {
  function setValue(textarea: HTMLTextAreaElement, value: string, caret: number): void {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, value)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.setSelectionRange(caret, caret)
    })
  }

  it('does not attach; a path written like Terminal goes at the cursor (a space becomes `\\ `)', async () => {
    const { textarea } = await render()
    setValue(textarea, '見て  ください', 3)
    const drop = fire(textarea, 'drop', transfer({ files: ['file:///Users/me/my%20shot%20(1).png'] }))
    await settle()
    expect(drop.defaultPrevented).toBe(true)
    expect(addAttachment).not.toHaveBeenCalled()
    expect(textarea.value).toBe('見て /Users/me/my\\ shot\\ \\(1\\).png ください')
  })

  it('multiple paths are space-separated; the aios file list URI (text/uri-list) is the same', async () => {
    const { textarea } = await render()
    fire(
      textarea,
      'drop',
      transfer({ files: ['file:///a/x.png'], listed: ['file:///b/%E6%97%A5%E6%9C%AC.md'] })
    )
    await settle()
    expect(addAttachment).not.toHaveBeenCalled()
    expect(textarea.value).toBe('/a/x.png /b/日本.md ')
  })

  it('over the textarea only the textarea lights up (path-drop) and returns when leaving; the pane overlay does not appear', async () => {
    const { pane, textarea } = await render()
    const data = transfer({ files: ['file:///a.png'] })
    fire(textarea, 'dragover', data)
    expect(textarea.classList.contains('path-drop')).toBe(true)
    expect(host.querySelector('.composer-drop-hint')).not.toBeNull()
    // The cover is in the DOM, but the CSS (`:has(.path-drop)`) hides it. That the rule exists is checked separately.
    fire(textarea, 'dragleave', data)
    expect(textarea.classList.contains('path-drop')).toBe(false)
    expect(host.querySelector('.composer-drop-hint')).toBeNull()
    expect(pane).toBeTruthy()
  })

  it('a drop on the textarea does not bubble to the outer frame (not attached twice)', async () => {
    const { textarea } = await render()
    fire(textarea, 'drop', transfer({ files: ['file:///a/x.png'] }))
    await settle()
    expect(addAttachment).not.toHaveBeenCalled()
  })

  it('CSS: the rule hiding the overlay over the textarea and the rule lighting the textarea are written with color tokens only', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync('src/renderer/src/styles.css', 'utf8')
    expect(css).toContain('.thread-pane:has(.composer-input.path-drop) .pane-drop-overlay { display: none; }')
    expect(css).toMatch(/\.composer-input\.path-drop \{[^}]*var\(--accent-bg\)[^}]*var\(--accent\)/)
    expect(css).not.toContain('.composer.dragging')
  })
})

describe('TODO 563 / 913: the entry that opens a dropped file (openDroppedUris) and the full-surface attachment by the overlay', () => {
  /** Fires drag events with an x coordinate. The pane's width is 400px (left edge at 100). */
  function fireAt(target: Element, type: string, data: FakeTransfer, clientX: number): Event {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: data })
    Object.defineProperty(event, 'clientX', { value: clientX })
    act(() => {
      target.dispatchEvent(event)
    })
    return event
  }

  it('openDroppedUris: opens the first file that passes the gate (skips folders); reports the reason when refused', async () => {
    const { openDroppedUris } = await import('../src/renderer/src/drop-open.js')
    const open = vi.fn<(uri: string) => void>()
    const notice = vi.fn<(reason: string) => void>()
    const check = vi.fn(async () => ({
      allowed: [
        { uri: 'file:///d', isDirectory: true },
        { uri: 'file:///a.py', isDirectory: false }
      ],
      denied: []
    }))
    expect(await openDroppedUris(['file:///d', 'file:///a.py'], check, { open, notice })).toBe('opened')
    expect(open).toHaveBeenCalledWith('file:///a.py')
    const denying = vi.fn(async () => ({ allowed: [], denied: [{ uri: 'file:///x', reason: 'path-excluded' }] }))
    expect(await openDroppedUris(['file:///x'], denying, { open, notice })).toBe('denied')
    expect(notice).toHaveBeenCalledWith('path-excluded')
    expect(await openDroppedUris([], check, { open, notice })).toBe('none')
  })

  it('a drop anywhere on the pane is an attachment (action is attach); the overlay is one sheet, not split left and right (TODO 913)', async () => {
    const { pane } = await render()
    pane.getBoundingClientRect = () => new DOMRect(100, 0, 400, 300)
    const data = transfer({ files: ['file:///Users/me/b.png'] })
    for (const x of [150, 450]) {
      fireAt(pane, 'dragover', data, x)
      expect(host.querySelectorAll('.pane-drop-overlay').length).toBe(1)
      expect(host.querySelector('.pane-drop-zone')).toBeNull()
      fireAt(pane, 'drop', data, x)
      await settle()
      expect(addAttachment).toHaveBeenLastCalledWith('t1', 'file:///Users/me/b.png')
    }
    expect(trace).toHaveBeenCalledWith({ stage: 'pane-drop', files: 1, uris: 1, emptyPaths: 0, action: 'attach' })
    expect(trace).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'open' }))
  })
})

describe('TODO 677: a native drag from the Files tree is handled the same as the existing text/uri-list', () => {
  afterEach(async () => {
    const { endFilesDrag } = await import('../src/renderer/src/files-drag.js')
    endFilesDrag()
  })

  it('becomes an attachment if there is a remembered URI even when DataTransfer has neither `Files` nor `text/uri-list`', async () => {
    const { beginFilesDrag } = await import('../src/renderer/src/files-drag.js')
    beginFilesDrag(['file:///Users/me/from-tree.ts'])
    const { pane } = await render()
    // Which type a native drag really arrives with can only be checked on a real device, so here "no type" is simulated.
    const data = { types: [], files: [], getData: () => '' }
    fire(pane.querySelector('.thread-body')!, 'drop', data)
    await settle()
    expect(addAttachment).toHaveBeenCalledWith('t1', 'file:///Users/me/from-tree.ts')
  })
})
