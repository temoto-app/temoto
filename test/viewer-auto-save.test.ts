// @vitest-environment jsdom
/**
 * TODO 555 (wave 28 bundle D): viewer autosave (the same as VS Code's `files.autoSave`: off / afterDelay / onFocusChange).
 *
 * - pure functions: the defaults and checks of the setting keys (`viewer.autoSave` / `viewer.autoSaveDelay`), `sanitizeAutoSavePatch`,
 *   `canAutoSave` / `armsDelay` / `planBackgroundSave`, and `AutoSavePreference` (main, notice to all windows).
 * - focus watch (`watchFrameFocusLoss`): parent blur -> entered the iframe -> parent focusin / the window lost focus as a whole.
 * - ViewerPane (jsdom): with off, nothing is saved. afterDelay saves once after it goes quiet, against the base mtime. If the disk side has changed,
 *   the conflict band shows (no overwrite). Text typed during the save round trip is kept (the version is not advanced). Read-only is excluded.
 *   On moving to another file it saves in the background. ✕ saves without checking and closes. onFocusChange fires when focus leaves.
 *
 * The iframe is not loaded, so `contentWindow` is replaced to receive the port (same as viewer-drafts.test.ts).
 * Neither the model nor main is used.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ViewerResource } from '../src/shared/types.js'
import type { ViewerHostMessage } from '../src/shared/plugin.js'
import {
  DEFAULT_AUTO_SAVE,
  MAX_AUTO_SAVE_DELAY_MS,
  MIN_AUTO_SAVE_DELAY_MS,
  sanitizeAutoSavePatch
} from '../src/shared/auto-save.js'
import { VIEWER_AUTO_SAVE, VIEWER_AUTO_SAVE_DELAY } from '../src/common/settings-keys.js'
import { AutoSavePreference } from '../src/main/auto-save.js'
import type { AppSettingsStore } from '../src/common/settings.js'
import {
  armsDelay,
  canAutoSave,
  planBackgroundSave,
  watchFrameFocusLoss
} from '../src/renderer/src/viewer-auto-save.js'
import { useAutoSave } from '../src/renderer/src/autoSaveStore.js'
import { currentPaneSaver, settleInFlightSaves } from '../src/renderer/src/viewer-drafts-close.js'
import { useStore } from '../src/renderer/src/store.js'
import { useLocale } from '../src/renderer/src/localeStore.js'
import { en } from '../src/renderer/src/i18n/en.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
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

describe('settings (TODO 555)', () => {
  it('the default is off / 1000 ms (same as VS Code), a broken value gives the default, and the wait time is clamped into range', () => {
    expect(VIEWER_AUTO_SAVE.parse(null)).toBe('off')
    expect(VIEWER_AUTO_SAVE.parse('"afterDelay"')).toBe('afterDelay')
    expect(VIEWER_AUTO_SAVE.parse('"onWindowChange"')).toBe('off')
    expect(VIEWER_AUTO_SAVE.parse('{')).toBe('off')
    expect(VIEWER_AUTO_SAVE.serialize('onFocusChange')).toBe('"onFocusChange"')
    expect(VIEWER_AUTO_SAVE_DELAY.parse(null)).toBe(1000)
    expect(VIEWER_AUTO_SAVE_DELAY.parse('2500')).toBe(2500)
    expect(VIEWER_AUTO_SAVE_DELAY.parse('5')).toBe(MIN_AUTO_SAVE_DELAY_MS)
    expect(VIEWER_AUTO_SAVE_DELAY.parse(String(10 * MAX_AUTO_SAVE_DELAY_MS))).toBe(MAX_AUTO_SAVE_DELAY_MS)
    expect(VIEWER_AUTO_SAVE_DELAY.parse('abc')).toBe(1000)
    expect(DEFAULT_AUTO_SAVE).toEqual({ mode: 'off', delayMs: 1000 })
  })

  it('sanitizeAutoSavePatch: drops broken fields', () => {
    expect(sanitizeAutoSavePatch({ mode: 'afterDelay', delayMs: 1234.6 })).toEqual({ mode: 'afterDelay', delayMs: 1235 })
    expect(sanitizeAutoSavePatch({ mode: 'nope', delayMs: 'x' })).toEqual({})
    expect(sanitizeAutoSavePatch(null)).toEqual({})
    expect(sanitizeAutoSavePatch({ delayMs: Number.NaN })).toEqual({})
  })

  it('AutoSavePreference: writes only the changed key and notifies all windows, and does nothing for the same value', () => {
    const stored = new Map<string, string>()
    const settings = {
      readTyped: <T,>(key: { key: string; parse: (raw: string | null) => T }) => key.parse(stored.get(key.key) ?? null),
      writeTyped: <T,>(key: { key: string; serialize: (v: T) => string }, value: T) => {
        stored.set(key.key, key.serialize(value))
      }
    } as unknown as AppSettingsStore
    const changed = vi.fn()
    const preference = new AutoSavePreference(settings, changed)
    expect(preference.get()).toEqual({ mode: 'off', delayMs: 1000 })
    expect(preference.set({ mode: 'afterDelay' })).toEqual({ mode: 'afterDelay', delayMs: 1000 })
    expect([...stored.keys()]).toEqual(['viewer.autoSave'])
    expect(preference.set({ mode: 'afterDelay' })).toEqual({ mode: 'afterDelay', delayMs: 1000 })
    expect(changed).toHaveBeenCalledTimes(1)
    preference.set({ delayMs: 300 })
    expect(stored.get('viewer.autoSaveDelay')).toBe('300')
    expect(changed).toHaveBeenLastCalledWith({ mode: 'afterDelay', delayMs: 300 })
    // Same after re-reading
    expect(new AutoSavePreference(settings).get()).toEqual({ mode: 'afterDelay', delayMs: 300 })
  })
})

describe('decision (viewer-auto-save.ts)', () => {
  const gate = {
    mode: 'afterDelay' as const,
    editable: true,
    dirty: true,
    saving: false,
    conflict: false,
    failedBefore: false
  }

  it('does not auto-save when off, not editable, no draft, saving, in conflict, or the same draft that was refused before', () => {
    expect(canAutoSave(gate)).toBe(true)
    expect(armsDelay(gate)).toBe(true)
    expect(canAutoSave({ ...gate, mode: 'off' })).toBe(false)
    expect(canAutoSave({ ...gate, editable: false })).toBe(false)
    expect(canAutoSave({ ...gate, dirty: false })).toBe(false)
    expect(canAutoSave({ ...gate, saving: true })).toBe(false)
    expect(canAutoSave({ ...gate, conflict: true })).toBe(false)
    expect(canAutoSave({ ...gate, failedBefore: true })).toBe(false)
    // onFocusChange does not start a timer (it is called from the focus watch)
    expect(canAutoSave({ ...gate, mode: 'onFocusChange' })).toBe(true)
    expect(armsDelay({ ...gate, mode: 'onFocusChange' })).toBe(false)
  })

  it('planBackgroundSave: the draft remembered in the table with the base mtime, and does not write when off, no draft, or in conflict', () => {
    const stored = { text: 'x', baseMtimeMs: 5 }
    const base = { mode: 'afterDelay' as const, uri: 'file:///a', pluginId: 'aios.text', stored, conflictUri: null }
    expect(planBackgroundSave(base)).toEqual({ pluginId: 'aios.text', uri: 'file:///a', text: 'x', baseMtimeMs: 5 })
    expect(planBackgroundSave({ ...base, mode: 'onFocusChange' })).not.toBeNull()
    expect(planBackgroundSave({ ...base, mode: 'off' })).toBeNull()
    expect(planBackgroundSave({ ...base, stored: undefined })).toBeNull()
    expect(planBackgroundSave({ ...base, pluginId: null })).toBeNull()
    expect(planBackgroundSave({ ...base, conflictUri: 'file:///a' })).toBeNull()
    expect(planBackgroundSave({ ...base, conflictUri: 'file:///b' })).not.toBeNull()
  })
})

describe('watchFrameFocusLoss (onFocusChange)', () => {
  it('calls after entering the iframe when focus moves to another place in the parent, or when the whole window loses focus', async () => {
    vi.useFakeTimers()
    try {
      const frame = document.createElement('iframe')
      const input = document.createElement('input')
      document.body.append(frame, input)
      let windowFocused = true
      const hasFocus = vi.spyOn(document, 'hasFocus').mockImplementation(() => windowFocused)
      const losses: string[] = []
      const stop = watchFrameFocusLoss(window, () => frame, (reason) => losses.push(reason), 100)
      // Focus enters the iframe: blur on the parent window, activeElement is the iframe
      frame.focus()
      window.dispatchEvent(new Event('blur'))
      vi.advanceTimersByTime(1)
      expect(losses).toEqual([])
      // To another app (the window loses focus as a whole)
      windowFocused = false
      vi.advanceTimersByTime(150)
      expect(losses).toEqual(['window'])
      // Not called when coming back. Called when moving to a parent input field
      windowFocused = true
      vi.advanceTimersByTime(150)
      expect(losses).toEqual(['window'])
      input.focus()
      expect(losses).toEqual(['window', 'focus'])
      // Moving around within the parent does not call it (it has not entered the iframe)
      document.body.append(document.createElement('button'))
      ;(document.body.lastElementChild as HTMLButtonElement).focus()
      expect(losses).toEqual(['window', 'focus'])
      stop()
      hasFocus.mockRestore()
      frame.remove()
      input.remove()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---- ViewerPane (jsdom) ----

const A = 'file:///work/a.ts'
const B = 'file:///work/b.ts'
const PLUGIN = { pluginId: 'aios.text', name: 'Text', url: 'aios-plugin://aios.text/index.html', editable: true }

let disk: Record<string, { text: string; mtimeMs: number }>
let readOnly: boolean
let container: HTMLDivElement
let root: Root
let guestPort: MessagePort | null
let received: ViewerHostMessage[]
/** Entry point to hold writes (for a test that types during the save round trip). null means do not hold. */
let writeGate: Promise<void> | null
const write = vi.fn()

function text(body: string, mtimeMs: number): ViewerResource {
  return { kind: 'text', text: body, truncated: false, size: body.length, mtimeMs, ...(readOnly ? { readOnly: true } : {}) }
}

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
      if (writeGate !== null) await writeGate
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

// TODO 993: so that flush / sleep do not stop in tests that swap time for a fake clock, keep the real setTimeout first
const realSetTimeout = globalThis.setTimeout.bind(globalThis)

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => realSetTimeout(resolve, 0))
    })
  }
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (check()) return
    await flush()
  }
  throw new Error(`timed out: ${label}`)
}

const resources = (): Extract<ViewerHostMessage, { type: 'resource' }>[] =>
  received.filter((m): m is Extract<ViewerHostMessage, { type: 'resource' }> => m.type === 'resource')
const lastResource = (): Extract<ViewerHostMessage, { type: 'resource' }> | undefined => resources().at(-1)
// TODO 969: the save button appears only when there are changes (dirty). Undefined when there are no changes; right after saving, `.viewer-saved` (✅ Saved)
const saveButton = (): HTMLButtonElement | undefined =>
  container.querySelector<HTMLButtonElement>('.viewer-header button.viewer-save') ?? undefined
const savedFlash = (): boolean => container.querySelector('.viewer-header .viewer-saved') !== null

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

async function mount(mode: 'off' | 'afterDelay' | 'onFocusChange', delayMs = 50): Promise<void> {
  useAutoSave.setState({ mode, delayMs })
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
}

async function typeDraft(body: string): Promise<void> {
  guestPort?.postMessage({ type: 'draft', uri: A, text: body })
  await until(() => useStore.getState().viewerDrafts[A]?.text === body, `draft ${body}`)
}

async function sleep(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => realSetTimeout(resolve, ms))
  })
}

/** Advance the fake clock by `ms` (only the autosave wait; keystrokes stay real async). */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

describe('ViewerPane: auto-save (TODO 555)', () => {
  beforeEach(() => {
    disk = {
      [A]: { text: 'const a = 1\n', mtimeMs: 100 },
      [B]: { text: 'const b = 2\n', mtimeMs: 200 }
    }
    readOnly = false
    guestPort = null
    received = []
    writeGate = null
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
  })

  afterEach(async () => {
    vi.useRealTimers()
    await act(async () => root.unmount())
    container.remove()
    guestPort?.close()
    useAutoSave.setState(DEFAULT_AUTO_SAVE)
  })

  it('with off (default) it does not save even after waiting, and moving to another file only leaves the draft in the table', async () => {
    await mount('off')
    await typeDraft('const a = 2\n')
    await sleep(120)
    await act(async () => {
      useStore.getState().select(B)
    })
    await until(() => lastResource()?.uri === B, 'B')
    await flush()
    expect(write).not.toHaveBeenCalled()
    expect(useStore.getState().viewerDrafts[A]?.text).toBe('const a = 2\n')
  })

  it('afterDelay: re-arms on every keystroke and saves once with the base mtime after it goes quiet', async () => {
    await mount('afterDelay', 80)
    // TODO 993: a real-time sleep failed past the wait (80 ms) under heavy parallel runs. Only the wait timer uses the fake clock
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await typeDraft('const a = 2\n')
    await advance(40)
    await typeDraft('const a = 3\n')
    await advance(40)
    expect(write).not.toHaveBeenCalled()
    await advance(40)
    await until(() => write.mock.calls.length === 1, 'auto save')
    expect(write).toHaveBeenCalledWith(A, 'const a = 3\n', 100)
    await until(() => savedFlash() && saveButton() === undefined, 'saved')
    expect(useStore.getState().viewerDrafts).toEqual({})
    await advance(120)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('afterDelay: if the disk side changed, does not auto-save and shows the conflict band (does not overwrite), and does not write automatically afterwards either', async () => {
    await mount('afterDelay', 30)
    disk[A] = { text: 'changed by someone\n', mtimeMs: 150 }
    await typeDraft('const a = 2\n')
    await until(() => useStore.getState().draftConflict !== null, 'conflict')
    expect(useStore.getState().draftConflict).toEqual({ uri: A, toolName: null, autoSave: true })
    expect(disk[A]?.text).toBe('changed by someone\n')
    expect(container.querySelector('.draft-conflict')?.textContent).toContain(en['viewer.draftConflict.autoSaveSkipped'])
    expect(container.querySelector('.viewer-banner.error')).toBeNull()
    await typeDraft('const a = 3\n')
    await sleep(100)
    expect(write).toHaveBeenCalledTimes(1)
    // The band's 'overwrite and save' can still be used as before
    const overwrite = [...container.querySelectorAll<HTMLButtonElement>('.draft-conflict button')].find(
      (button) => button.textContent === en['viewer.draftConflict.overwrite']
    )
    await act(async () => overwrite?.click())
    await until(() => disk[A]?.text === 'const a = 3\n', 'overwritten')
    expect(useStore.getState().draftConflict).toBeNull()
  })

  it('characters typed during the save round trip remain: the draft is not discarded and the saved body is not re-sent to the viewer', async () => {
    await mount('afterDelay', 30)
    let open: () => void = () => undefined
    writeGate = new Promise((resolve) => {
      open = resolve
    })
    await typeDraft('const a = 2\n')
    await until(() => write.mock.calls.length === 1, 'save started')
    const pushedBefore = resources().length
    // Type while writing
    await typeDraft('const a = 22\n')
    // code-review (TODO 712): set up the gate for the second one before releasing the first. When the first finishes, dirty stays and the state goes back to idle
    // (`newer` is true), so the afterDelay timer starts again right away. In a full-suite parallel run, if `flush()` is late, the second autosave can finish
    // before the assert in this section (`newer` becomes false, revision advances, and an extra `resource` is sent). This was seen failing for real.
    // Holding the second one here makes the result independent of real time.
    const releaseFirst = open
    let openSecond: () => void = () => undefined
    writeGate = new Promise((resolve) => {
      openSecond = resolve
    })
    releaseFirst()
    await until(() => disk[A]?.text === 'const a = 2\n', 'first write landed')
    await flush()
    // The new draft remains and is not re-sent to the viewer (keeps the characters typed in the editor and the cursor)
    expect(resources().length).toBe(pushedBefore)
    expect(useStore.getState().viewerDrafts[A]).toEqual({ text: 'const a = 22\n', baseMtimeMs: 101 })
    // The next autosave uses the new base (101)
    await until(() => write.mock.calls.length === 2, 'second save')
    writeGate = null
    openSecond()
    expect(write).toHaveBeenLastCalledWith(A, 'const a = 22\n', 101)
    await until(() => disk[A]?.text === 'const a = 22\n', 'second write landed')
  })

  it('code-review (606): the flush before closing waits for the save in progress and then writes with the latest base and draft (not a false conflict)', async () => {
    await mount('off')
    let open: () => void = () => undefined
    writeGate = new Promise((resolve) => {
      open = resolve
    })
    await typeDraft('const a = 2\n')
    await act(async () => saveButton()?.click())
    await until(() => write.mock.calls.length === 1, 'save started')
    // Type while writing (the render holds this draft and the old base 100)
    await typeDraft('const a = 22\n')
    const pane = currentPaneSaver()
    expect(pane).not.toBeNull()
    let result: string | null = null
    // Finish writing right after the wait, before it is redrawn (same order as `flushDrafts`)
    await act(async () => {
      writeGate = null
      open()
      await settleInFlightSaves()
      result = await pane!.save()
    })
    expect(result).toBe('saved')
    expect(write).toHaveBeenLastCalledWith(A, 'const a = 22\n', 101)
    expect(disk[A]?.text).toBe('const a = 22\n')
  })

  it('code-review (606): when the awaited save cleared the draft, the flush writes nothing', async () => {
    await mount('off')
    let open: () => void = () => undefined
    writeGate = new Promise((resolve) => {
      open = resolve
    })
    await typeDraft('const a = 2\n')
    await act(async () => saveButton()?.click())
    await until(() => write.mock.calls.length === 1, 'save started')
    const pane = currentPaneSaver()
    let result: string | null = null
    await act(async () => {
      writeGate = null
      open()
      await settleInFlightSaves()
      result = await pane!.save()
    })
    expect(result).toBe('saved')
    expect(write).toHaveBeenCalledTimes(1)
    expect(disk[A]).toEqual({ text: 'const a = 2\n', mtimeMs: 101 })
  })

  it('code-review: when moving to another file during the save round trip, does not touch the displayed file (contents, draft)', async () => {
    await mount('afterDelay', 30)
    // B has a draft from before leaving (TODO 312)
    useStore.setState({ viewerDrafts: { [B]: { text: 'const b = 99\n', baseMtimeMs: 200 } } })
    let open: () => void = () => undefined
    writeGate = new Promise((resolve) => {
      open = resolve
    })
    await typeDraft('const a = 2\n')
    await until(() => write.mock.calls.length === 1, 'save started')
    // Move to B while writing; B's load finishes first
    await act(async () => {
      useStore.getState().select(B)
    })
    await until(() => lastResource()?.uri === B, 'B shown')
    expect(lastResource()?.draft).toBe('const b = 99\n')
    await until(() => useStore.getState().viewerDirty, 'B dirty')
    writeGate = null
    open()
    await until(() => disk[A]?.text === 'const a = 2\n', 'A written')
    await flush()
    // B stays as it is (not blank, the draft is not lost, the unsaved mark remains)
    expect(useStore.getState().selectedUri).toBe(B)
    expect(useStore.getState().viewerDirty).toBe(true)
    expect(saveButton()?.textContent).toBe(en['viewer.save'])
    expect(useStore.getState().viewerDrafts[B]).toEqual({ text: 'const b = 99\n', baseMtimeMs: 200 })
    expect(lastResource()?.uri).toBe(B)
    // The draft of the saved A is cleared from the table
    expect(useStore.getState().viewerDrafts[A]).toBeUndefined()
    expect(disk[B]?.text).toBe('const b = 2\n')
  })

  it('a read-only viewer is out of scope', async () => {
    readOnly = true
    await mount('afterDelay', 20)
    guestPort?.postMessage({ type: 'draft', uri: A, text: 'nope\n' })
    await sleep(80)
    expect(write).not.toHaveBeenCalled()
  })

  it('when moving to another file, saves the draft of the file being left in the background even before the wait time', async () => {
    await mount('afterDelay', 10_000)
    await typeDraft('const a = 5\n')
    await act(async () => {
      useStore.getState().select(B)
    })
    await until(() => write.mock.calls.length === 1, 'background save')
    expect(write).toHaveBeenCalledWith(A, 'const a = 5\n', 100)
    await until(() => useStore.getState().viewerDrafts[A] === undefined, 'forgotten')
    expect(disk[A]?.text).toBe('const a = 5\n')
  })

  it('when the background save is refused by a conflict, the draft stays in the table, and on return it is the conflict band as before', async () => {
    await mount('onFocusChange')
    await typeDraft('const a = 6\n')
    disk[A] = { text: 'other\n', mtimeMs: 160 }
    await act(async () => {
      useStore.getState().select(B)
    })
    await until(() => write.mock.calls.length === 1, 'background save tried')
    await flush()
    expect(useStore.getState().viewerDrafts[A]?.text).toBe('const a = 6\n')
    await act(async () => {
      useStore.getState().select(A)
    })
    await until(() => useStore.getState().draftConflict?.uri === A, 'conflict on return')
    expect(disk[A]?.text).toBe('other\n')
  })

  it('✕ saves and closes without asking', async () => {
    await mount('onFocusChange')
    await typeDraft('const a = 8\n')
    const close = container.querySelector<HTMLButtonElement>('.viewer-close')
    await act(async () => close?.click())
    await until(() => useStore.getState().selectedUri === null, 'closed')
    expect(container.querySelector('.viewer-confirm')).toBeNull()
    expect(disk[A]?.text).toBe('const a = 8\n')
  })

  it('onFocusChange: saves when focus moves from the viewer to another place in the parent', async () => {
    await mount('onFocusChange')
    const frame = container.querySelector('iframe') as HTMLIFrameElement
    await act(async () => {
      frame.focus()
      window.dispatchEvent(new Event('blur'))
    })
    await typeDraft('const a = 9\n')
    await sleep(10)
    expect(write).not.toHaveBeenCalled()
    const input = document.createElement('input')
    document.body.append(input)
    await act(async () => input.focus())
    await until(() => disk[A]?.text === 'const a = 9\n', 'saved on blur')
    input.remove()
  })
})
