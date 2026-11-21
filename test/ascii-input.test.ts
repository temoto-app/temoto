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
  it('focus で ascii を 1 回、blur の猶予の後に restore', () => {
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

  it('猶予の間に別の欄へ移ったら戻さない (ちらつき防止)', () => {
    const { controller, sent, elapse } = setup()
    controller.report(1, true)
    controller.report(1, false)
    controller.report(1, true) // Field to field (blur -> focus)
    elapse()
    expect(sent).toEqual(['ascii'])
    expect(controller.active).toBe(true)
  })

  it('別の窓の欄へ移っても 1 回だけ。focus が先に届いても後の blur で戻さない', () => {
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

  it('同じ切り替えの間は ascii を送り直さない (利用者が欄の中で自分で替えたらそのまま)', () => {
    const { controller, sent } = setup()
    controller.report(1, true)
    controller.report(1, true)
    controller.report(2, true)
    expect(sent).toEqual(['ascii'])
  })

  it('背面に回ったら猶予を待たずにすぐ戻す。戻ってきた focus で切り替え直す', () => {
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

  it('窓が消えたら focus が外れたのと同じ (猶予の後に戻す)', () => {
    const { controller, sent, elapse } = setup()
    controller.report(3, true)
    controller.dropSource(3)
    elapse()
    expect(sent).toEqual(['ascii', 'restore'])
  })

  it('設定が OFF なら何もしない。切ったらすぐ戻し、入れたら欄にいれば切り替える', () => {
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

  it('終わるときはすぐ戻し、以後の報せは無視する', () => {
    const { controller, sent } = setup()
    controller.report(1, true)
    controller.dispose()
    controller.report(1, true)
    expect(sent).toEqual(['ascii', 'restore'])
  })

  it('切り替えていなければ戻す命令も送らない', () => {
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
  it('macOS 以外では起こさず何もしない', () => {
    const { helper, spawn } = helperWith({ platform: 'linux' })
    expect(helper.available()).toBe(false)
    helper.warm()
    helper.send('ascii')
    helper.send('restore')
    helper.dispose()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('ヘルパーが無ければ起こさず何もしない (検索はそのまま)', () => {
    const { helper, spawn } = helperWith({ exists: false })
    helper.send('ascii')
    helper.send('ascii')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('warm で 1 回だけ起こし、命令は stdin に 1 行ずつ', () => {
    const { helper, spawn, children } = helperWith()
    helper.warm()
    helper.send('ascii')
    helper.send('restore')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(children[0]?.written).toEqual(['ascii\n', 'restore\n'])
  })

  it('restore は生きているヘルパーにだけ (戻す物の無いヘルパーを起こさない)', () => {
    const { helper, spawn } = helperWith()
    helper.send('restore')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('落ちたら次の ascii で起こし直し、上限を超えたら諦める', () => {
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

  it('終わるときは stdin を閉じる (ヘルパーは EOF で戻してから終わる)。以後は何もしない', () => {
    const { helper, spawn, children } = helperWith()
    helper.warm()
    helper.dispose()
    expect(children[0]?.ended).toBe(true)
    children[0]?.exit(0)
    helper.send('ascii')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('答えの行は分割されて届いても読める', () => {
    const { helper, children } = helperWith()
    helper.warm()
    children[0]?.reply('{"ok":true,"swi')
    children[0]?.reply('tched":true}\n{"ok":true}\n')
    // It only has to not throw (since TODO 675 the log is info -- `input.helper.reply`).
    expect(children[0]?.written).toEqual([])
  })

  it('TODO 675: 送った・返事・パスの有無を info で 1 行ずつ (463 が実機で効いているかを追うログ)', () => {
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

  it('ヘルパーが居ない・stdin が無いときの「送ろうとしたが送れなかった」も info で残る', () => {
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

  it('ログには理由の語と入力ソースの ID・TIS の status だけ (TODO 675)', () => {
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
  it('既定は真。壊れた値も真に倒す', () => {
    expect(INPUT_ASCII_FOR_SEARCH.parse(null)).toBe(true)
    expect(INPUT_ASCII_FOR_SEARCH.parse('nope')).toBe(true)
    expect(INPUT_ASCII_FOR_SEARCH.parse('false')).toBe(false)
    expect(INPUT_ASCII_FOR_SEARCH.owner).toBe('main')
  })

  it('AsciiInputPreference が保存し、変わったときだけ知らせる', () => {
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
  it('renderer の欄と viewer の欄の OR を、変わったときだけ報せる', () => {
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

describe('installAsciiInputTracker (TODO 463、jsdom)', () => {
  let uninstall: (() => void) | null = null
  afterEach(() => {
    uninstall?.()
    uninstall = null
    document.body.innerHTML = ''
  })

  it('印のある欄の focus / blur だけを報せる。プロンプト欄 (印なし) は対象外', () => {
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

  it('viewer の報せ (setViewerSearchFocus) も同じ窓の報せに畳む。窓の blur で全部外す', () => {
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

describe('viewer の検索欄の知らせ (TODO 463、jsdom)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('印のある欄と CodeMirror の検索語の欄が対象。置換の欄・本文は対象外', () => {
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

  it('focus / blur を search-focus で送る。同じ値は送り直さない', () => {
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
