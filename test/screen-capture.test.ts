/**
 * TODO 957: take a screenshot of part of the screen and attach it (`src/main/paste/screen-capture.ts`). Does not call the real screencapture or the window
 * (they are replaced). Checks that the window is always restored even on cancel or failure, and that no temporary image file remains.
 */
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  SCREENCAPTURE_ARGS,
  SCREENCAPTURE_PATH,
  captureScreenRegion,
  createCaptureHeadsUp,
  shouldShowCaptureHeadsUp,
  type ScreenCaptureDeps
} from '../src/main/paste/screen-capture.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

function makeDeps(over: Partial<ScreenCaptureDeps> & { write?: Buffer | null } = {}): {
  deps: ScreenCaptureDeps
  restore: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  files: string[]
} {
  const restore = vi.fn()
  const hide = vi.fn(() => restore)
  const files: string[] = []
  const { write, ...rest } = over
  const deps: ScreenCaptureDeps = {
    platform: 'darwin',
    screenAccess: () => 'granted',
    hideWindows: hide,
    run: async (file) => {
      files.push(file)
      if (write !== null) await writeFile(file, write ?? PNG)
      return { spawnFailed: false }
    },
    wait: async () => undefined,
    ...rest
  }
  return { deps, restore, hide, files }
}

describe('TODO 957: 画面の撮影', () => {
  it('撮れたら PNG の添付にする。窓を隠して戻し、一時ファイルを残さない', async () => {
    const { deps, restore, hide, files } = makeDeps()
    const result = await captureScreenRegion(deps, { keepWindows: false }, 8_000_000)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.attachment).toMatchObject({ kind: 'image', mediaType: 'image/png', bytes: PNG.length })
      expect(result.attachment.uri.startsWith('aios-clipboard:')).toBe(true)
      expect(result.attachment.base64).toBe(PNG.toString('base64'))
    }
    expect(hide).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(files).toHaveLength(1)
    expect(existsSync(dirname(files[0] ?? ''))).toBe(false)
  })

  it('keepWindows (⌥) なら窓を隠さない', async () => {
    const { deps, hide } = makeDeps()
    const result = await captureScreenRegion(deps, { keepWindows: true }, 8_000_000)
    expect(result.ok).toBe(true)
    expect(hide).not.toHaveBeenCalled()
  })

  it('Esc の取り消し (ファイルが無い) は capture-cancelled。窓は戻す', async () => {
    const { deps, restore } = makeDeps({ write: null })
    const result = await captureScreenRegion(deps, { keepWindows: false }, 8_000_000)
    expect(result).toEqual({ ok: false, reason: 'capture-cancelled' })
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('起動できなければ capture-failed。run が投げても窓を戻す', async () => {
    const failed = makeDeps({ run: async () => ({ spawnFailed: true }) })
    expect(await captureScreenRegion(failed.deps, { keepWindows: false }, 1e6)).toEqual({
      ok: false,
      reason: 'capture-failed'
    })
    expect(failed.restore).toHaveBeenCalledTimes(1)
    const thrown = makeDeps({
      run: async () => {
        throw new Error('boom')
      }
    })
    expect(await captureScreenRegion(thrown.deps, { keepWindows: false }, 1e6)).toEqual({
      ok: false,
      reason: 'capture-failed'
    })
    expect(thrown.restore).toHaveBeenCalledTimes(1)
  })

  it('画面収録が denied なら撮らずに capture-permission。macOS 以外は capture-unavailable', async () => {
    const denied = makeDeps({ screenAccess: () => 'denied' })
    expect(await captureScreenRegion(denied.deps, { keepWindows: false }, 1e6)).toEqual({
      ok: false,
      reason: 'capture-permission'
    })
    expect(denied.hide).not.toHaveBeenCalled()
    expect(denied.files).toHaveLength(0)
    const linux = makeDeps({ platform: 'linux' })
    expect(await captureScreenRegion(linux.deps, { keepWindows: false }, 1e6)).toEqual({
      ok: false,
      reason: 'capture-unavailable'
    })
  })

  it('PNG でない・大きすぎるものは断る', async () => {
    const notPng = makeDeps({ write: Buffer.from('hello world, not an image') })
    expect(await captureScreenRegion(notPng.deps, { keepWindows: true }, 1e6)).toEqual({
      ok: false,
      reason: 'capture-failed'
    })
    const big = makeDeps()
    expect(await captureScreenRegion(big.deps, { keepWindows: true }, 4)).toEqual({
      ok: false,
      reason: 'paste-too-large'
    })
  })

  it('呼ぶのは固定のパスと固定の引数だけ', () => {
    expect(SCREENCAPTURE_PATH).toBe('/usr/sbin/screencapture')
    expect(SCREENCAPTURE_ARGS).toEqual(['-i', '-x', '-t', 'png'])
  })
})

describe('TODO 1064: 初回の撮影の前の案内', () => {
  it('macOS で未案内・許可が拒否でないときだけ出る', () => {
    expect(shouldShowCaptureHeadsUp('darwin', 'not-determined', false)).toBe(true)
    expect(shouldShowCaptureHeadsUp('darwin', 'granted', false)).toBe(true)
    expect(shouldShowCaptureHeadsUp('darwin', 'granted', true)).toBe(false)
    expect(shouldShowCaptureHeadsUp('darwin', 'denied', false)).toBe(false)
    expect(shouldShowCaptureHeadsUp('darwin', 'restricted', false)).toBe(false)
    expect(shouldShowCaptureHeadsUp('linux', 'granted', false)).toBe(false)
  })
})

describe('TODO 1064 review: 済みの印は表示後の確認でだけ書く', () => {
  it('問い合わせでは書かず、確認で書き、その後は出ない', () => {
    let shown = false
    const h = createCaptureHeadsUp({ shown: () => shown, markShown: () => (shown = true) }, 'darwin', () => 'granted')
    expect(h.query()).toBe(true)
    expect(h.query()).toBe(true) // If the renderer could not show it, the next one also appears.
    expect(shown).toBe(false)
    h.confirm()
    expect(shown).toBe(true)
    expect(h.query()).toBe(false)
  })
  it('設定が無ければ出さず、確認も何もしない', () => {
    const h = createCaptureHeadsUp(null, 'darwin', () => 'granted')
    expect(h.query()).toBe(false)
    expect(() => h.confirm()).not.toThrow()
  })
})
