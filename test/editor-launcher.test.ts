/**
 * Open in an external editor (item 115, `src/main/editor/launcher.ts` / `preference.ts`).
 * `execFile` is replaced by an injected function (`run`), so no real editor is started. Does not call the model either.
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { EditorLauncher, type ExecFileLike } from '../src/main/editor/launcher.js'
import { EditorPreference } from '../src/main/editor/preference.js'

/** A fake that records the arguments of the called `run`. Binaries listed in `fails` return ENOENT. */
function fakeRun(fails: readonly string[] = []): {
  run: ExecFileLike
  calls: { bin: string; args: readonly string[] }[]
} {
  const calls: { bin: string; args: readonly string[] }[] = []
  const run: ExecFileLike = (bin, args, _options, callback) => {
    calls.push({ bin, args: [...args] })
    if (fails.includes(bin)) {
      callback(Object.assign(new Error('not found'), { code: 'ENOENT' }))
      return
    }
    callback(null)
  }
  return { run, calls }
}

const allowAll = (uri: string): string => uri.replace('file://', '')

describe('EditorLauncher (項目 115)', () => {
  it('行番号ありで VS Code を呼ぶ (-g file:line)', async () => {
    const { run, calls } = fakeRun()
    const launcher = new EditorLauncher({ assertAllowed: allowAll, getEditorId: () => 'vscode', run })
    const ok = await launcher.open('file:///work/a.ts', { line: 12 })
    expect(ok).toBe(true)
    expect(calls).toEqual([{ bin: 'code', args: ['-g', '/work/a.ts:12'] }])
  })

  it('行番号なしはパスだけ', async () => {
    const { run, calls } = fakeRun()
    const launcher = new EditorLauncher({ assertAllowed: allowAll, getEditorId: () => 'vscode', run })
    await launcher.open('file:///work/a.ts')
    expect(calls).toEqual([{ bin: 'code', args: ['/work/a.ts'] }])
  })

  it('Zed は goto フラグを使わず `file:line` をそのまま渡す', async () => {
    const { run, calls } = fakeRun()
    const launcher = new EditorLauncher({ assertAllowed: allowAll, getEditorId: () => 'zed', run })
    await launcher.open('file:///work/a.ts', { line: 3 })
    expect(calls).toEqual([{ bin: 'zed', args: ['/work/a.ts:3'] }])
  })

  it('asDirectory: true では行番号を無視し、assertAllowed をディレクトリとして呼ぶ', async () => {
    const { run, calls } = fakeRun()
    const seen: boolean[] = []
    const launcher = new EditorLauncher({
      assertAllowed: (uri, asDirectory) => {
        seen.push(asDirectory)
        return uri.replace('file://', '')
      },
      getEditorId: () => 'vscode',
      run
    })
    await launcher.open('file:///work', { line: 5, asDirectory: true })
    expect(seen).toEqual([true])
    expect(calls).toEqual([{ bin: 'code', args: ['/work'] }])
  })

  it('拒否された URI は開かない (投げない)', async () => {
    const { run, calls } = fakeRun()
    const launcher = new EditorLauncher({
      assertAllowed: () => {
        throw new Error('denied')
      },
      getEditorId: () => 'vscode',
      run
    })
    const ok = await launcher.open('file:///nope')
    expect(ok).toBe(false)
    expect(calls).toEqual([])
  })

  it('見つからない (ENOENT) と macOS では `open -a` に落ちる (行番号は失う)', async () => {
    const { run, calls } = fakeRun(['code'])
    const launcher = new EditorLauncher({
      assertAllowed: allowAll,
      getEditorId: () => 'vscode',
      run,
      platform: 'darwin'
    })
    const ok = await launcher.open('file:///work/a.ts', { line: 9 })
    expect(ok).toBe(true)
    expect(calls).toEqual([
      { bin: 'code', args: ['-g', '/work/a.ts:9'] },
      { bin: 'open', args: ['-a', 'VS Code', '/work/a.ts'] }
    ])
  })

  it('macOS 以外はフォールバックが無く、そのまま失敗として返る', async () => {
    const { run, calls } = fakeRun(['code'])
    const launcher = new EditorLauncher({
      assertAllowed: allowAll,
      getEditorId: () => 'vscode',
      run,
      platform: 'linux'
    })
    const ok = await launcher.open('file:///work/a.ts')
    expect(ok).toBe(false)
    expect(calls).toEqual([{ bin: 'code', args: ['/work/a.ts'] }])
  })

  it('空 / 非文字列の uri は開かない', async () => {
    const { run, calls } = fakeRun()
    const launcher = new EditorLauncher({ assertAllowed: allowAll, getEditorId: () => 'vscode', run })
    expect(await launcher.open('')).toBe(false)
    expect(await launcher.open(123)).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('EditorPreference (項目 115)', () => {
  let db: Db

  const open = (): Db => {
    const database = new Database(':memory:')
    runMigrations(database)
    return database
  }

  it('既定は VS Code、選び直すと永続化する', () => {
    db = open()
    const settings = new AppSettingsStore(db)
    const pref = new EditorPreference(settings)
    expect(pref.get()).toBe('vscode')
    expect(pref.set('cursor')).toBe('cursor')
    expect(pref.get()).toBe('cursor')
    // It can still be read again by another instance (the equivalent of a restart).
    expect(new EditorPreference(settings).get()).toBe('cursor')
    db.close()
  })
})
