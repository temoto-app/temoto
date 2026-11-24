// @vitest-environment jsdom
/**
 * TODO 312 small observation (wave 18 bundle B): remembers the unsaved viewer drafts per file, and restores them on return.
 *
 * - pure functions (`viewer-drafts.ts`): the restore decision (same mtime / different / same text as the body / unreadable), and how it is written into the table.
 * - ViewerPane (jsdom): draft -> another URI -> back restores the draft, and a `resource` with `draft` is sent to the viewer. Saving removes it from the table. ✕ (close without saving) removes it too. If the disk changes while away, the conflict band appears.
 *   The iframe is not loaded, so `contentWindow` is replaced to receive the port, and `draft` is sent through that port in place of the viewer.
 *   Neither the model nor main is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ViewerResource } from '../src/shared/types.js'
import type { ViewerHostMessage } from '../src/shared/plugin.js'
import {
  installViewerDraftCountReport,
  restoreDraft,
  syncDraft,
  withDraft,
  withoutDraft
} from '../src/renderer/src/viewer-drafts.js'
import { useStore } from '../src/renderer/src/store.js'
import { useLocale } from '../src/renderer/src/localeStore.js'
import { en } from '../src/renderer/src/i18n/en.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// themeStore looks up `matchMedia` when it loads (jsdom does not have it).
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

const text = (body: string, mtimeMs: number, extra: Partial<{ truncated: boolean; readOnly: boolean }> = {}): ViewerResource => ({
  kind: 'text',
  text: body,
  truncated: extra.truncated ?? false,
  size: body.length,
  mtimeMs,
  ...(extra.readOnly === undefined ? {} : { readOnly: extra.readOnly })
})

describe('restoreDraft (decision on return)', () => {
  it('leaves things as they are when nothing was remembered', () => {
    const resource = text('disk', 1)
    expect(restoreDraft(undefined, resource)).toEqual({ resource, draft: null, conflict: false, forget: false })
  })

  it('restores the draft when mtime equals the base (no conflict)', () => {
    const resource = text('disk', 5)
    expect(restoreDraft({ text: 'mine', baseMtimeMs: 5 }, resource)).toEqual({
      resource,
      draft: 'mine',
      conflict: false,
      forget: false
    })
  })

  it("restores as a conflict when mtime differs, and resets the content's mtime to the base (main refuses a normal save)", () => {
    const restored = restoreDraft({ text: 'mine', baseMtimeMs: 5 }, text('changed', 9))
    expect(restored.draft).toBe('mine')
    expect(restored.conflict).toBe(true)
    expect(restored.resource).toMatchObject({ kind: 'text', text: 'changed', mtimeMs: 5 })
  })

  it('does not restore a draft identical to the disk content and removes it from the table', () => {
    expect(restoreDraft({ text: 'same', baseMtimeMs: 1 }, text('same', 2))).toMatchObject({
      draft: null,
      conflict: false,
      forget: true
    })
  })

  it('does not restore unreadable, truncated, or read-only files but keeps them in the table', () => {
    const stored = { text: 'mine', baseMtimeMs: 1 }
    for (const resource of [
      { kind: 'error', message: 'not-found' } as const,
      text('disk', 1, { truncated: true }),
      text('disk', 1, { readOnly: true })
    ]) {
      expect(restoreDraft(stored, resource)).toEqual({ resource, draft: null, conflict: false, forget: false })
    }
  })
})

describe('installViewerDraftCountReport (TODO 103 code-review)', () => {
  it("sends the count only when the table's count changes (no body, no URI); does not send an initial 0", () => {
    let state = { viewerDrafts: {} as Record<string, { text: string; baseMtimeMs: number }> }
    let listener: ((next: typeof state, previous: typeof state) => void) | null = null
    const store = {
      getState: () => state,
      subscribe: (fn: (next: typeof state, previous: typeof state) => void) => {
        listener = fn
        return () => {
          listener = null
        }
      }
    }
    const sent: unknown[] = []
    const stop = installViewerDraftCountReport(store, (count) => {
      sent.push(count)
    })
    expect(sent).toEqual([])
    const setTable = (table: typeof state.viewerDrafts): void => {
      const previous = state
      state = { viewerDrafts: table }
      listener?.(state, previous)
    }
    setTable({ 'file:///a': { text: 'secret', baseMtimeMs: 1 } })
    // The same count (only the body changed) is not sent
    setTable({ 'file:///a': { text: 'secret 2', baseMtimeMs: 1 } })
    setTable({ 'file:///a': { text: 'x', baseMtimeMs: 1 }, 'file:///b': { text: 'y', baseMtimeMs: 2 } })
    setTable({})
    expect(sent).toEqual([1, 2, 0])
    stop()
    expect(listener).toBeNull()
  })
})

describe('syncDraft / table operations', () => {
  it('does nothing when there is no content shown (in the middle of switching)', () => {
    expect(syncDraft('x', null)).toEqual({ kind: 'none' })
    expect(syncDraft(null, text('a', 1))).toEqual({ kind: 'none' })
  })

  it('remembers the draft with its base mtime when it differs from the body, and forgets it when equal', () => {
    expect(syncDraft('b', text('a', 3))).toEqual({ kind: 'remember', draft: { text: 'b', baseMtimeMs: 3 } })
    expect(syncDraft('a', text('a', 3))).toEqual({ kind: 'forget' })
  })

  it('writing the same value or deleting a missing key returns the same table', () => {
    const table = withDraft({}, 'file:///a', { text: 'x', baseMtimeMs: 1 })
    expect(withDraft(table, 'file:///a', { text: 'x', baseMtimeMs: 1 })).toBe(table)
    expect(withoutDraft(table, 'file:///b')).toBe(table)
    expect(withoutDraft(table, 'file:///a')).toEqual({})
  })
})

// ---- ViewerPane (jsdom) ----

const A = 'file:///work/a.ts'
const B = 'file:///work/b.ts'
const PLUGIN = { pluginId: 'aios.text', name: 'Text', url: 'aios-plugin://aios.text/index.html', editable: true }

interface Disk {
  [uri: string]: { text: string; mtimeMs: number }
}

let disk: Disk
let container: HTMLDivElement
let root: Root
let guestPort: MessagePort | null
let received: ViewerHostMessage[]
const write = vi.fn()

/** A fake `window.aios`. Only what ViewerPane and the store touch is made realistic; everything else is a no-op function. */
function fakeAios(): unknown {
  const viewer = {
    open: async () => PLUGIN,
    read: async (_pluginId: string, uri: string): Promise<ViewerResource> => {
      const file = disk[uri]
      return file === undefined ? { kind: 'error', message: 'not-found' } : text(file.text, file.mtimeMs)
    },
    close: async () => undefined,
    untrackWatch: () => undefined,
    write: async (_pluginId: string, uri: string, body: string, expected: number | null) => {
      write(uri, body, expected)
      const file = disk[uri]
      if (file === undefined) return { ok: false, mtimeMs: 0, size: 0, reason: 'not-found' }
      if (expected !== null && expected !== file.mtimeMs) return { ok: false, mtimeMs: 0, size: 0, reason: 'conflict' }
      disk[uri] = { text: body, mtimeMs: file.mtimeMs + 1 }
      return { ok: true, mtimeMs: file.mtimeMs + 1, size: body.length, reason: null }
    },
    command: async () => ({ ok: true, result: null }),
    reportDraft: async () => undefined
  }
  const noop = (): (() => void) => () => undefined
  const deep = (path: string): unknown =>
    new Proxy(() => Promise.resolve(undefined), {
      get: (_target, key) => (typeof key === 'string' ? deep(`${path}.${key}`) : undefined),
      apply: () => (path.includes('.on') ? noop() : Promise.resolve(undefined))
    })
  return new Proxy(
    { viewer, app: { onMenuCommand: noop, openExternal: async () => undefined } },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : deep(String(key))) }
  )
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (check()) return
    await flush()
  }
  throw new Error(`timed out: ${label}`)
}

// TODO 969: the save button appears only when there are changes (dirty). Undefined when there are no changes.
// TODO 1006: `.viewer-saved` (✅ Saved) right after saving disappears after 1.5 s of real time, so under load the wait can be extended and missed. Saving is checked by the button disappearing (the display itself is checked by the pure functions in viewer-view-mode).
const saveButton = (): HTMLButtonElement | undefined =>
  container.querySelector<HTMLButtonElement>('.viewer-header button.viewer-save') ?? undefined

const lastResource = (): Extract<ViewerHostMessage, { type: 'resource' }> | undefined =>
  [...received].reverse().find((m): m is Extract<ViewerHostMessage, { type: 'resource' }> => m.type === 'resource')

/** Receives a port instead of the iframe (jsdom does not load `aios-plugin://`). */
async function connectFrame(): Promise<void> {
  await until(() => container.querySelector('iframe') !== null, 'iframe')
  const frame = container.querySelector('iframe') as HTMLIFrameElement
  Object.defineProperty(frame, 'contentWindow', {
    configurable: true,
    get: () => ({
      postMessage: (_message: unknown, _origin: string, transfer: MessagePort[]) => {
        guestPort = transfer[0] ?? null
        guestPort?.addEventListener('message', (event: MessageEvent) => {
          received.push(event.data as ViewerHostMessage)
        })
        guestPort?.start()
      }
    })
  })
  await act(async () => {
    frame.dispatchEvent(new Event('load'))
  })
  await until(() => guestPort !== null, 'port')
}

async function open(uri: string): Promise<void> {
  await act(async () => {
    useStore.getState().select(uri)
  })
  await until(() => lastResource()?.uri === uri, `resource ${uri}`)
}

async function typeDraft(body: string): Promise<void> {
  guestPort?.postMessage({ type: 'draft', uri: lastResource()?.uri, text: body })
  await until(() => saveButton()?.textContent === en['viewer.save'], 'dirty')
}

describe('ViewerPane: per-file drafts (TODO 312)', () => {
  beforeEach(async () => {
    disk = {
      [A]: { text: 'const a = 1\n', mtimeMs: 100 },
      [B]: { text: 'const b = 2\n', mtimeMs: 200 }
    }
    guestPort = null
    received = []
    write.mockClear()
    ;(window as unknown as { aios: unknown }).aios = fakeAios()
    useLocale.setState({ resolved: 'en' })
    useStore.setState({
      selectedUri: null,
      viewerDirty: false,
      draftConflict: null,
      viewerDrafts: {},
      transient: null,
      roots: []
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const { ViewerPane } = await import('../src/renderer/src/components/ViewerPane.js')
    await act(async () => {
      root.render(createElement(ViewerPane))
    })
    await act(async () => {
      useStore.getState().select(A)
    })
    await connectFrame()
    await until(() => lastResource()?.uri === A, 'first resource')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    guestPort?.close()
  })

  it("**TODO 938: a draft about A arriving after B was sent does not become B's draft** (saving does not overwrite B with A's body)", async () => {
    await open(B)
    // The viewer has not yet handled B's resource, so A's body is sent for A (one keystroke in the gap of a switch)
    guestPort?.postMessage({ type: 'draft', uri: A, text: 'const a = 1\nTYPED\n' })
    for (let i = 0; i < 5; i += 1) await flush()
    expect(useStore.getState().viewerDrafts[B]).toBeUndefined()
    expect(saveButton()).toBeUndefined()
    // A draft for B is received as before
    guestPort?.postMessage({ type: 'draft', uri: B, text: 'const b = 3\n' })
    await until(() => useStore.getState().viewerDrafts[B] !== undefined, 'B draft')
    expect(useStore.getState().viewerDrafts[B]?.text).toBe('const b = 3\n')
    expect(useStore.getState().viewerDrafts[A]).toBeUndefined()
  })

  it("a draft from an old bridge that does not state its uri becomes the current file's draft by the old matching (not discarded)", async () => {
    await open(B)
    guestPort?.postMessage({ type: 'draft', text: 'const b = OLD\n' })
    await until(() => useStore.getState().viewerDrafts[B] !== undefined, 'B draft (no uri)')
    expect(useStore.getState().viewerDrafts[B]?.text).toBe('const b = OLD\n')
  })

  it('draft → another URI → back restores the draft and sends it to the viewer with the draft', async () => {
    await typeDraft('const a = 42\n')
    await open(B)
    // B has no draft. A's draft remains in the table
    expect(lastResource()?.draft).toBeUndefined()
    expect(saveButton()).toBeUndefined()
    expect(useStore.getState().viewerDrafts[A]).toEqual({ text: 'const a = 42\n', baseMtimeMs: 100 })
    expect(useStore.getState().viewerDrafts[B]).toBeUndefined()

    await open(A)
    const back = lastResource()
    expect(back?.draft).toBe('const a = 42\n')
    // The body stays as it is on disk (for the heading list of aios.markdown)
    expect(back?.resource).toMatchObject({ kind: 'text', text: 'const a = 1\n' })
    await until(() => saveButton()?.textContent === en['viewer.save'], 'restored dirty')
    expect(useStore.getState().viewerDirty).toBe(true)
    expect(useStore.getState().draftConflict).toBeNull()
  })

  it('saving removes it from the table, and it does not reappear after returning', async () => {
    await typeDraft('const a = 7\n')
    await act(async () => saveButton()?.click())
    await until(() => saveButton() === undefined, 'saved')
    expect(write).toHaveBeenCalledWith(A, 'const a = 7\n', 100)
    expect(useStore.getState().viewerDrafts).toEqual({})
    await open(B)
    await open(A)
    expect(lastResource()?.draft).toBeUndefined()
    expect(lastResource()?.resource).toMatchObject({ text: 'const a = 7\n' })
  })

  it('a restored draft can be saved (using the base mtime)', async () => {
    await typeDraft('const a = 8\n')
    await open(B)
    await open(A)
    await until(() => saveButton()?.textContent === en['viewer.save'], 'restored')
    await act(async () => saveButton()?.click())
    await until(() => saveButton() === undefined, 'saved')
    expect(write).toHaveBeenCalledWith(A, 'const a = 8\n', 100)
    expect(disk[A]?.text).toBe('const a = 8\n')
    expect(useStore.getState().viewerDrafts).toEqual({})
  })

  it('closing with ⌘W, then "Close without saving", removes it from the table (TODO 1326: no ✕ in the heading)', async () => {
    await typeDraft('const a = 9\n')
    expect(container.querySelector('.viewer-header .viewer-close')).toBeNull()
    const { closeTabOrWindow } = await import('../src/renderer/src/shortcut-actions.js')
    await act(async () => closeTabOrWindow())
    const discard = [...container.querySelectorAll<HTMLButtonElement>('.viewer-confirm button')].find(
      (button) => button.textContent === en['viewer.closeWithoutSaving']
    )
    expect(discard).toBeDefined()
    await act(async () => discard?.click())
    expect(useStore.getState().selectedUri).toBeNull()
    expect(useStore.getState().viewerDrafts).toEqual({})
  })

  it('returning the edit to the original body removes it from the table', async () => {
    await typeDraft('const a = 3\n')
    guestPort?.postMessage({ type: 'draft', uri: lastResource()?.uri, text: 'const a = 1\n' })
    await until(() => saveButton() === undefined, 'clean again')
    expect(useStore.getState().viewerDrafts).toEqual({})
  })

  it('when the disk changed while away, restores the draft and shows the conflict band', async () => {
    await typeDraft('const a = 5\n')
    await open(B)
    disk[A] = { text: 'const a = 1 // edited\n', mtimeMs: 150 }
    await open(A)
    expect(lastResource()?.draft).toBe('const a = 5\n')
    await until(() => container.querySelector('.draft-conflict') !== null, 'conflict banner')
    expect(container.querySelector('.draft-conflict')?.textContent).toContain(
      en['viewer.draftConflict.changedWhileAway']
    )
    expect(useStore.getState().draftConflict).toEqual({ uri: A, toolName: null })
    // While in conflict, a normal save is not possible (only from the band's actions, TODO 313 bundle J)
    expect(saveButton()?.disabled).toBe(true)
    // 'Overwrite and save' writes without passing the mtime
    const overwrite = [...container.querySelectorAll<HTMLButtonElement>('.draft-conflict button')].find(
      (button) => button.textContent === en['viewer.draftConflict.overwrite']
    )
    await act(async () => overwrite?.click())
    await until(() => saveButton() === undefined, 'overwritten')
    expect(write).toHaveBeenLastCalledWith(A, 'const a = 5\n', null)
    expect(useStore.getState().viewerDrafts).toEqual({})
    expect(container.querySelector('.draft-conflict')).toBeNull()
  })

  it('「ディスクの内容を読み直す」 in the conflict band discards the draft and removes it from the table too', async () => {
    await typeDraft('const a = 6\n')
    await open(B)
    disk[A] = { text: 'const a = 1 // edited\n', mtimeMs: 150 }
    await open(A)
    await until(() => container.querySelector('.draft-conflict') !== null, 'conflict banner')
    const reload = [...container.querySelectorAll<HTMLButtonElement>('.draft-conflict button')].find(
      (button) => button.textContent === en['viewer.draftConflict.reload']
    )
    await act(async () => reload?.click())
    await until(() => saveButton() === undefined, 'reloaded')
    expect(useStore.getState().viewerDrafts).toEqual({})
    expect(lastResource()?.resource).toMatchObject({ text: 'const a = 1 // edited\n' })
    expect(lastResource()?.draft).toBeUndefined()
  })

  it('closing the viewer (selection dropped, not ✕, e.g. switching threads) keeps the draft', async () => {
    await typeDraft('const a = 11\n')
    await act(async () => useStore.getState().select(null))
    expect(useStore.getState().viewerDrafts[A]?.text).toBe('const a = 11\n')
    await act(async () => useStore.getState().select(A))
    await until(() => saveButton()?.textContent === en['viewer.save'], 'restored after reopen')
  })
})
