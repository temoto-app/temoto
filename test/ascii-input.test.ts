// @vitest-environment jsdom
/**
 * TODO 463 (wave 23 bundle C): when a search or filter field gets focus, switch the macOS input source to ASCII, and restore it when leaving.
 *
 *  - main's judgment (`AsciiInputController`): folds the focus per window, and `ascii` happens only once during the switch. After leaving all fields, `restore` runs after
 *    a grace period (100 ms). If focus moves during the grace period to another field (another window, or inside a viewer), it is not restored (to prevent flicker).
 *    Restores at once when sent to the background, when the setting is turned off, or when quitting.
 *  - The helper entry point (`InputSourceHelper`): on non-macOS or with no helper, it wakes nothing and does nothing (regression). `restore` goes only to a live helper.
 *    If it has died, the next `ascii` wakes it again; past a limit, it gives up. Closes stdin when quitting.
 *  - Setting (`input.asciiForSearch`, default true, owner is main).
 *  - renderer (jsdom): reports only focus / blur of fields with the mark (`ASCII_INPUT`). ORed with the viewer's reports.
 *  - viewer (jsdom): the bridge sends focus of a search field inside the iframe (a marked field / CodeMirror's search term field) as `search-focus`.
 *
 * Switching the real input source (Carbon's TIS) can only be checked on a real machine. The helper is a fake. The model is not called.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { type LogLevel, setLogSink } from '../src/common/logger.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { INPUT_ASCII_FOR_SEARCH } from '../src/common/settings-keys.js'
import {
  ASCII_INPUT_GRACE_MS,
  AsciiInputController,
  type AsciiInputCommand
} from '../src/main/input/controller.js'
import {
  InputSourceHelper,
  MAX_HELPER_RESTARTS,
  summarizeReply,
  type HelperProcess
} from '../src/main/input/helper.js'
import { AsciiInputPreference } from '../src/main/input/preference.js'
import {
  SearchFocusAggregator,
  installAsciiInputTracker,
  setViewerSearchFocus
} from '../src/renderer/src/ascii-input.js'
import { ASCII_INPUT_ATTRIBUTE } from '../src/shared/ascii-input.js'
import { isViewerSearchField, watchSearchFocus } from '../plugins/_shared/bridge.js'
import type { ViewerGuestMessage } from '../src/shared/plugin.js'

// ---------------------------------------------------------------------------
// main: AsciiInputController
// ---------------------------------------------------------------------------

function setup(options: { enabled?: () => boolean } = {}) {
  const sent: AsciiInputCommand[] = []
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = []
  const controller = new AsciiInputController({
    helper: { send: (command) => sent.push(command) },
    enabled: options.enabled ?? (() => true),
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    }
  })
  /** Fires every timer that was set and not cleared (the grace period has passed). */
  const elapse = (): void => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback()
  }
  return { controller, sent, timers, elapse }
}

describe('AsciiInputController (TODO 463)', () => {
  it('sends ascii once on focus and restores after the blur grace period', () => {
    const { controller, sent, timers, elapse } = setup()
    controller.report(1, true)
    expect(sent).toEqual(['ascii'])
    controller.report(1, false)
    expect(sent).toEqual(['ascii'])
    expect(timers.at(-1)?.ms).toBe(ASCII_INPUT_GRACE_MS)
    elapse()
    expect(sent).toEqual(['ascii', 'restore'])
    expect(controller.active).toBe(false)
  })

  it('does not restore if it moved to another field during the grace period (prevents flicker)', () => {
    const { controller, sent, elapse } = setup()
    controller.report(1, true)
    controller.report(1, false)
    controller.report(1, true) // Field to field (blur -> focus)
    elapse()
    expect(sent).toEqual(['ascii'])
    expect(controller.active).toBe(true)
  })

  it('only once even when moving to a field in another window; even if focus arrives first, a later blur does not restore', () => {
    const { controller, sent, elapse } = setup()
    controller.report(1, true)
    controller.report(2, true) // Window 2's focus arrived first
    controller.report(1, false) // Window 1's blur arrived late
    elapse()
    expect(sent).toEqual(['ascii'])
    controller.report(2, false)
    elapse()
    expect(sent).toEqual(['ascii', 'restore'])
  })

  it('does not resend ascii during the same switch (if the user changes it themselves in the field, leave it)', () => {
    const { controller, sent } = setup()
    controller.report(1, true)
    controller.report(1, true)
    controller.report(2, true)
    expect(sent).toEqual(['ascii'])
  })

  it('when sent to the background, restores immediately without waiting for the grace period; switches again on the returning focus', () => {
    const { controller, sent, elapse } = setup()
    controller.report(1, true)
    controller.deactivate()
    expect(sent).toEqual(['ascii', 'restore'])
    controller.report(1, false) // A late blur that arrives after is ignored
    elapse()
    expect(sent).toEqual(['ascii', 'restore'])
    controller.report(1, true)
    expect(sent).toEqual(['ascii', 'restore', 'ascii'])
  })

  it('when a window disappears, same as focus leaving (restores after the grace period)', () => {
    const { controller, sent, elapse } = setup()
    controller.report(3, true)
    controller.dropSource(3)
    elapse()
    expect(sent).toEqual(['ascii', 'restore'])
  })

  it('does nothing when the setting is OFF; restores immediately when turned off and switches if in a field when turned on', () => {
    let enabled = false
    const { controller, sent } = setup({ enabled: () => enabled })
    controller.report(1, true)
    expect(sent).toEqual([])
    enabled = true
    controller.settingChanged(true)
    expect(sent).toEqual(['ascii'])
    enabled = false
    controller.settingChanged(false)
    expect(sent).toEqual(['ascii', 'restore'])
  })

  it('on exit, restores immediately and ignores later notices', () => {
    const { controller, sent } = setup()
    controller.report(1, true)
    controller.dispose()
    controller.report(1, true)
    expect(sent).toEqual(['ascii', 'restore'])
  })

  it('does not send a restore command when it has not switched', () => {
    const { controller, sent, elapse } = setup()
    controller.report(1, false)
    controller.deactivate()
    controller.dispose()
    elapse()
    expect(sent).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// main: InputSourceHelper
// ---------------------------------------------------------------------------

class FakeChild implements HelperProcess {
  readonly written: string[] = []
  ended = false
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>()
  private readonly stdoutListeners: Array<(chunk: string) => void> = []
  readonly stdin = {
    write: (chunk: string): boolean => {
      this.written.push(chunk)
      return true
    },
    end: (): void => {
      this.ended = true
    },
    on: (): unknown => undefined
  }
  readonly stdout = {
    on: (_event: 'data', listener: (chunk: Buffer | string) => void): unknown => {
      this.stdoutListeners.push(listener as (chunk: string) => void)
      return undefined
    }
  }
  on(event: string, listener: (...args: never[]) => void): unknown {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return undefined
  }
  kill(): boolean {
    return true
  }
  exit(code: number | null): void {
    for (const listener of this.listeners.get('exit') ?? []) {
      ;(listener as (code: number | null, signal: null) => void)(code, null)
    }
  }
  reply(line: string): void {
    for (const listener of this.stdoutListeners) listener(line)
  }
}

function helperWith(options: { platform?: NodeJS.Platform; exists?: boolean } = {}) {
  const children: FakeChild[] = []
  const spawn = vi.fn((): HelperProcess => {
    const child = new FakeChild()
    children.push(child)
    return child
  })
  const helper = new InputSourceHelper({
    helperPath: '/x/out/input-source-helper/input-source-helper',
    platform: options.platform ?? 'darwin',
    exists: () => options.exists ?? true,
    spawn
  })
  return { helper, spawn, children }
}

describe('InputSourceHelper (TODO 463)', () => {
  it('does not start and does nothing outside macOS', () => {
    const { helper, spawn } = helperWith({ platform: 'linux' })
    expect(helper.available()).toBe(false)
    helper.warm()
    helper.send('ascii')
    helper.send('restore')
    helper.dispose()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('does not start without the helper and does nothing (search is unaffected)', () => {
    const { helper, spawn } = helperWith({ exists: false })
    helper.send('ascii')
    helper.send('ascii')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('starts only once with warm and commands go to stdin one line at a time', () => {
    const { helper, spawn, children } = helperWith()
    helper.warm()
    helper.send('ascii')
    helper.send('restore')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(children[0]?.written).toEqual(['ascii\n', 'restore\n'])
  })

  it('restore only goes to a living helper (does not start a helper with nothing to restore)', () => {
    const { helper, spawn } = helperWith()
    helper.send('restore')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('if it crashes, restarts at the next ascii and gives up after the limit', () => {
    const { helper, spawn, children } = helperWith()
    helper.send('ascii')
    for (let i = 0; i < MAX_HELPER_RESTARTS; i++) {
      children.at(-1)?.exit(1)
      helper.send('restore') // A restore after it died does nothing
      helper.send('ascii')
    }
    expect(spawn).toHaveBeenCalledTimes(MAX_HELPER_RESTARTS + 1)
    children.at(-1)?.exit(1)
    helper.send('ascii')
    expect(spawn).toHaveBeenCalledTimes(MAX_HELPER_RESTARTS + 1)
  })

  it('on exit, closes stdin (the helper restores on EOF and then exits); does nothing afterward', () => {
    const { helper, spawn, children } = helperWith()
    helper.warm()
    helper.dispose()
    expect(children[0]?.ended).toBe(true)
    children[0]?.exit(0)
    helper.send('ascii')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('answer lines are readable even when delivered split', () => {
    const { helper, children } = helperWith()
    helper.warm()
    children[0]?.reply('{"ok":true,"swi')
    children[0]?.reply('tched":true}\n{"ok":true}\n')
    // It only has to not throw (since TODO 675 the log is info -- `input.helper.reply`).
    expect(children[0]?.written).toEqual([])
  })

  it('TODO 675: logs sent, reply, and path presence one line at a time at info (a log to trace whether 463 works on the real machine)', () => {
    const lines: { line: string; level: LogLevel }[] = []
    // Empty the early buffer (lines before the entry point was attached) that an earlier it() accumulated, then attach the entry point that looks only at what comes after.
    setLogSink(() => {})
    setLogSink(null)
    setLogSink((line, level) => lines.push({ line, level }))
    try {
      const { helper, children } = helperWith()
      helper.logResolvedPath()
      helper.warm()
      helper.send('ascii')
      children[0]?.reply('{"ok":true,"switched":true}\n')
      helper.send('restore')
      const events = lines.map((item) => ({ ...JSON.parse(item.line), level: item.level }) as Record<string, unknown>)
      const resolved = events.find((e) => e['event'] === 'input.helper.resolvedPath')
      expect(resolved).toMatchObject({
        level: 'info',
        path: '/x/out/input-source-helper/input-source-helper',
        platform: 'darwin',
        exists: true
      })
      const sent = events.filter((e) => e['event'] === 'input.helper.sent')
      expect(sent).toEqual([
        { ...sent[0], event: 'input.helper.sent', command: 'ascii', level: 'info' },
        { ...sent[1], event: 'input.helper.sent', command: 'restore', level: 'info' }
      ])
      const reply = events.find((e) => e['event'] === 'input.helper.reply')
      expect(reply).toMatchObject({ level: 'info', ok: true, switched: true })
      // The input source ID does not appear.
      expect(JSON.stringify(reply)).not.toMatch(/com\.example|inputmethod/)
    } finally {
      setLogSink(null)
    }
  })

  it('"tried to send but could not" when the helper is absent or there is no stdin is also left at info', () => {
    const lines: { line: string; level: LogLevel }[] = []
    setLogSink((line, level) => lines.push({ line, level }))
    try {
      const { helper } = helperWith({ exists: false })
      helper.send('ascii')
      const events = lines.map((item) => JSON.parse(item.line) as Record<string, unknown>)
      expect(events.some((e) => e['event'] === 'input.helper.sendSkipped' && e['command'] === 'ascii')).toBe(true)
    } finally {
      setLogSink(null)
    }
  })

  it('the log has only the reason word, the input source ID, and the TIS status (TODO 675)', () => {
    expect(
      summarizeReply('{"from":"com.example.inputmethod.Japanese","ok":true,"switched":true,"to":"com.example.Roman"}')
    ).toEqual({ ok: true, switched: true, from: 'com.example.inputmethod.Japanese', to: 'com.example.Roman' })
    expect(summarizeReply('{"ok":false,"error":"select","status":-50,"text":"secret"}')).toEqual({
      ok: false,
      error: 'select',
      status: -50
    })
    expect(summarizeReply('{"ok":true,"restored":false,"reason":"user-changed"}')).toEqual({
      ok: true,
      restored: false,
      reason: 'user-changed'
    })
    expect(summarizeReply('not json')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('input.asciiForSearch (TODO 463)', () => {
  it('defaults to true; a broken value also falls to true', () => {
    expect(INPUT_ASCII_FOR_SEARCH.parse(null)).toBe(true)
    expect(INPUT_ASCII_FOR_SEARCH.parse('nope')).toBe(true)
    expect(INPUT_ASCII_FOR_SEARCH.parse('false')).toBe(false)
    expect(INPUT_ASCII_FOR_SEARCH.owner).toBe('main')
  })

  it('AsciiInputPreference saves it and notifies only on change', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const settings = new AppSettingsStore(db)
    const changes: boolean[] = []
    const preference = new AsciiInputPreference(settings, (enabled) => changes.push(enabled))
    expect(preference.get()).toBe(true)
    preference.set(true)
    preference.set(false)
    expect(changes).toEqual([false])
    expect(new AsciiInputPreference(settings).get()).toBe(false)
    db.close()
  })
})

// ---------------------------------------------------------------------------
// renderer
// ---------------------------------------------------------------------------

describe('SearchFocusAggregator (TODO 463)', () => {
  it("reports the OR of the renderer's field and the viewer's field only when it changes", () => {
    const sent: boolean[] = []
    const aggregator = new SearchFocusAggregator((focused) => sent.push(focused))
    aggregator.setLocal(true)
    aggregator.setViewer('v1', true) // renderer -> viewer field (the viewer's focus comes first, the renderer's blur after)
    aggregator.setLocal(false)
    expect(sent).toEqual([true])
    aggregator.setViewer('v1', false)
    expect(sent).toEqual([true, false])
    aggregator.setViewer('v2', true)
    aggregator.clear()
    expect(sent).toEqual([true, false, true, false])
  })
})

describe('installAsciiInputTracker (TODO 463, jsdom)', () => {
  let uninstall: (() => void) | null = null
  afterEach(() => {
    uninstall?.()
    uninstall = null
    document.body.innerHTML = ''
  })

  it('reports only focus / blur of fields with the mark; the prompt field (no mark) is out of scope', () => {
    const sent: boolean[] = []
    uninstall = installAsciiInputTracker((focused) => sent.push(focused))
    const search = document.createElement('input')
    search.type = 'search'
    search.setAttribute(ASCII_INPUT_ATTRIBUTE, '')
    const prompt = document.createElement('textarea')
    const other = document.createElement('input')
    other.setAttribute(ASCII_INPUT_ATTRIBUTE, '')
    document.body.append(search, prompt, other)

    prompt.focus()
    expect(sent).toEqual([])
    search.focus()
    expect(sent).toEqual([true])
    other.focus() // Field to field: false -> true (main's grace period absorbs it)
    expect(sent.at(-1)).toBe(true)
    prompt.focus()
    expect(sent.at(-1)).toBe(false)
  })

  it("the viewer's notice (setViewerSearchFocus) is folded into the same window's notice; a window blur clears everything", () => {
    const sent: boolean[] = []
    uninstall = installAsciiInputTracker((focused) => sent.push(focused))
    setViewerSearchFocus('pane', true)
    expect(sent).toEqual([true])
    window.dispatchEvent(new Event('blur'))
    expect(sent).toEqual([true, false])
  })
})

// ---------------------------------------------------------------------------
// viewer (the plugin's bridge)
// ---------------------------------------------------------------------------

describe('viewer search field notices (TODO 463, jsdom)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it("fields with the mark and CodeMirror's search term field are targets; the replace field and the body are not", () => {
    document.body.innerHTML = `
      <div class="cm-search"><input name="search"><input name="replace"></div>
      <input class="pdf-find" ${ASCII_INPUT_ATTRIBUTE}>
      <div class="cm-content" contenteditable="true"></div>`
    const [search, replace] = Array.from(document.querySelectorAll('.cm-search input'))
    expect(isViewerSearchField(search ?? null)).toBe(true)
    expect(isViewerSearchField(replace ?? null)).toBe(false)
    expect(isViewerSearchField(document.querySelector('.pdf-find'))).toBe(true)
    expect(isViewerSearchField(document.querySelector('.cm-content'))).toBe(false)
    expect(isViewerSearchField(null)).toBe(false)
  })

  it('sends focus / blur by search-focus; does not resend the same value', () => {
    const sent: ViewerGuestMessage[] = []
    // Look at it in a separate document, so it does not mix with the listeners of earlier tests.
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const win = frame.contentWindow as Window
    watchSearchFocus(win, (message) => sent.push(message))
    const doc = win.document
    doc.body.innerHTML = `<div class="cm-search"><input name="search"><input name="replace"></div><textarea></textarea>`
    const [search, replace] = Array.from(doc.querySelectorAll('input'))
    const body = doc.querySelector('textarea') as HTMLTextAreaElement
    search?.focus()
    search?.focus()
    replace?.focus()
    body.focus()
    expect(sent).toEqual([
      { type: 'search-focus', focused: true },
      { type: 'search-focus', focused: false }
    ])
  })
})
