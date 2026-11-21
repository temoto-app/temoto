/**
 * Notice of draft conflicts (item 97, second half; ARCHITECTURE.md 4.5.1 / 7.6.2).
 *
 *  - Takes the target paths of write tools out of compat's toolKinds (adapter/progress.ts)
 *  - Checks them against the per-window draft memory (`DraftConflictTracker` in main/session/draft-conflicts.ts)
 *  - The renderer checks the notice from main once more (renderer/draft-conflict.ts)
 *
 * It wakes neither the model nor Electron.
 */
import { describe, expect, it } from 'vitest'
import { loadCompatTable } from '../src/main/session/adapter/compat.js'
import { writeToolTargetPath } from '../src/main/session/adapter/progress.js'
import { DraftConflictTracker } from '../src/main/session/draft-conflicts.js'
import { acceptDraftConflict } from '../src/renderer/src/draft-conflict.js'
import type { ViewerCommand } from '../src/shared/thread.js'

const table = loadCompatTable()

describe('writeToolTargetPath (compat の toolKinds、項目 97 後半)', () => {
  it('Edit / Write / NotebookEdit は書き込み系。パス引数の鍵は progress.ts の PATH_KEYS と同じ', () => {
    expect(writeToolTargetPath(table, 'Edit', { file_path: '/a/b.txt' })).toBe('/a/b.txt')
    expect(writeToolTargetPath(table, 'Write', { file_path: '/a/b.txt' })).toBe('/a/b.txt')
    expect(writeToolTargetPath(table, 'NotebookEdit', { notebook_path: '/a/b.ipynb' })).toBe(
      '/a/b.ipynb'
    )
  })

  it('読むだけのツール (Read) は write を持たないので null', () => {
    expect(writeToolTargetPath(table, 'Read', { file_path: '/a/b.txt' })).toBeNull()
  })

  it('表に無いツール・空文字・引数が無い・オブジェクトでない入力は null', () => {
    expect(writeToolTargetPath(table, 'NoSuchTool', { file_path: '/a' })).toBeNull()
    expect(writeToolTargetPath(table, 'Edit', { file_path: '  ' })).toBeNull()
    expect(writeToolTargetPath(table, 'Edit', {})).toBeNull()
    expect(writeToolTargetPath(table, 'Edit', 'not an object')).toBeNull()
    expect(writeToolTargetPath(table, 'Edit', null)).toBeNull()
  })
})

describe('DraftConflictTracker (窓ごとの下書きの記憶と照合)', () => {
  it('下書きの URI と一致する窓だけを返す。大文字小文字・正規化の違いも畳み込んで一致させる', () => {
    const t = new DraftConflictTracker()
    t.reportDraft(1, 'file:///Users/x/A.txt')
    t.reportDraft(2, 'file:///Users/x/b.txt')
    t.reportDraft(3, null)
    expect(t.conflictsAmong([1, 2, 3], 'file:///users/x/a.txt')).toEqual([1])
    expect(t.conflictsAmong([1, 2, 3], 'file:///Users/x/b.txt')).toEqual([2])
    expect(t.conflictsAmong([1, 2, 3], 'file:///Users/x/c.txt')).toEqual([])
  })

  it('viewIds に無い窓は対象外 (呼び出し側が ThreadViews.viewsOf で先に絞る前提)', () => {
    const t = new DraftConflictTracker()
    t.reportDraft(1, 'file:///a.txt')
    expect(t.conflictsAmong([2], 'file:///a.txt')).toEqual([])
  })

  it('下書きが消えたら対象から外れる (null の再報告)', () => {
    const t = new DraftConflictTracker()
    t.reportDraft(1, 'file:///a.txt')
    expect(t.conflictsAmong([1], 'file:///a.txt')).toEqual([1])
    t.reportDraft(1, null)
    expect(t.conflictsAmong([1], 'file:///a.txt')).toEqual([])
  })

  it('窓が閉じたら記憶も消える (close)', () => {
    const t = new DraftConflictTracker()
    t.reportDraft(1, 'file:///a.txt')
    t.close(1)
    expect(t.conflictsAmong([1], 'file:///a.txt')).toEqual([])
  })

  it('TODO 103 (code-review): 下書きの表の件数 (離れたファイルの分) も hasAny に入る。0 と close で忘れる', () => {
    const t = new DraftConflictTracker()
    expect(t.hasAny()).toBe(false)
    t.reportStored(1, 3)
    expect(t.hasAny()).toBe(true)
    // Not involved in the check (the URI of the file currently being viewed)
    expect(t.conflictsAmong([1], 'file:///a.txt')).toEqual([])
    t.reportStored(1, 0)
    expect(t.hasAny()).toBe(false)
    t.reportStored(2, 1)
    t.close(2)
    expect(t.hasAny()).toBe(false)
  })

  it('TODO 606: hasIn は窓ごと (いま見ているファイルの下書きか、表の件数)', () => {
    const t = new DraftConflictTracker()
    expect(t.hasIn(1)).toBe(false)
    t.reportDraft(1, 'file:///a.txt')
    t.reportStored(2, 1)
    expect(t.hasIn(1)).toBe(true)
    expect(t.hasIn(2)).toBe(true)
    expect(t.hasIn(3)).toBe(false)
    t.reportDraft(1, null)
    t.close(2)
    expect(t.hasIn(1)).toBe(false)
    expect(t.hasIn(2)).toBe(false)
  })

  it('同じ窓に 2 回報告したら後の値で上書きする', () => {
    const t = new DraftConflictTracker()
    t.reportDraft(1, 'file:///a.txt')
    t.reportDraft(1, 'file:///b.txt')
    expect(t.conflictsAmong([1], 'file:///a.txt')).toEqual([])
    expect(t.conflictsAmong([1], 'file:///b.txt')).toEqual([1])
  })
})

describe('acceptDraftConflict (renderer 側の再確認、行き違いの防止)', () => {
  const command: Extract<ViewerCommand, { kind: 'draftConflict' }> = {
    kind: 'draftConflict',
    threadId: 't1',
    uri: 'file:///a.txt',
    toolName: 'Edit'
  }

  it('スレッドが一致し、下書きがあり、URI も一致すれば受け入れる', () => {
    expect(
      acceptDraftConflict(command, { activeThreadId: 't1', selectedUri: 'file:///a.txt', dirty: true })
    ).toEqual({ uri: 'file:///a.txt', toolName: 'Edit' })
  })

  it('別のスレッドを見ている間に届いた (行き違い) は無視する', () => {
    expect(
      acceptDraftConflict(command, { activeThreadId: 't2', selectedUri: 'file:///a.txt', dirty: true })
    ).toBeNull()
  })

  it('届く間に下書きが消えた (保存 / 破棄) は無視する', () => {
    expect(
      acceptDraftConflict(command, { activeThreadId: 't1', selectedUri: 'file:///a.txt', dirty: false })
    ).toBeNull()
  })

  it('届く間に別のファイルへ切り替えた場合は無視する', () => {
    expect(
      acceptDraftConflict(command, { activeThreadId: 't1', selectedUri: 'file:///b.txt', dirty: true })
    ).toBeNull()
  })
})
