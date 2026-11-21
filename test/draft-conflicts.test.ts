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

describe('writeToolTargetPath (compat toolKinds, second half of item 97)', () => {
  it('Edit / Write / NotebookEdit are write kinds; the path argument keys are the same as PATH_KEYS in progress.ts', () => {
    expect(writeToolTargetPath(table, 'Edit', { file_path: '/a/b.txt' })).toBe('/a/b.txt')
    expect(writeToolTargetPath(table, 'Write', { file_path: '/a/b.txt' })).toBe('/a/b.txt')
    expect(writeToolTargetPath(table, 'NotebookEdit', { notebook_path: '/a/b.ipynb' })).toBe(
      '/a/b.ipynb'
    )
  })

  it('a read-only tool (Read) has no write, so null', () => {
    expect(writeToolTargetPath(table, 'Read', { file_path: '/a/b.txt' })).toBeNull()
  })

  it('null for a tool not in the table, an empty string, no arguments, and non-object input', () => {
    expect(writeToolTargetPath(table, 'NoSuchTool', { file_path: '/a' })).toBeNull()
    expect(writeToolTargetPath(table, 'Edit', { file_path: '  ' })).toBeNull()
    expect(writeToolTargetPath(table, 'Edit', {})).toBeNull()
    expect(writeToolTargetPath(table, 'Edit', 'not an object')).toBeNull()
    expect(writeToolTargetPath(table, 'Edit', null)).toBeNull()
  })
})

describe('DraftConflictTracker (per-window draft memory and matching)', () => {
  it("returns only windows matching the draft's URI; also folds case and normalization differences to match", () => {
    const t = new DraftConflictTracker()
    t.reportDraft(1, 'file:///Users/x/A.txt')
    t.reportDraft(2, 'file:///Users/x/b.txt')
    t.reportDraft(3, null)
    expect(t.conflictsAmong([1, 2, 3], 'file:///users/x/a.txt')).toEqual([1])
    expect(t.conflictsAmong([1, 2, 3], 'file:///Users/x/b.txt')).toEqual([2])
    expect(t.conflictsAmong([1, 2, 3], 'file:///Users/x/c.txt')).toEqual([])
  })

  it('windows not in viewIds are out of scope (assumes the caller narrows first with ThreadViews.viewsOf)', () => {
    const t = new DraftConflictTracker()
    t.reportDraft(1, 'file:///a.txt')
    expect(t.conflictsAmong([2], 'file:///a.txt')).toEqual([])
  })

  it('drops out of scope when the draft disappears (a null re-report)', () => {
    const t = new DraftConflictTracker()
    t.reportDraft(1, 'file:///a.txt')
    expect(t.conflictsAmong([1], 'file:///a.txt')).toEqual([1])
    t.reportDraft(1, null)
    expect(t.conflictsAmong([1], 'file:///a.txt')).toEqual([])
  })

  it('the memory disappears when the window closes (close)', () => {
    const t = new DraftConflictTracker()
    t.reportDraft(1, 'file:///a.txt')
    t.close(1)
    expect(t.conflictsAmong([1], 'file:///a.txt')).toEqual([])
  })

  it('TODO 103 (code-review): the count of the draft table (for distant files) also goes into hasAny; forgotten on 0 and close', () => {
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

  it('TODO 606: hasIn is per window (a draft of the file now viewed, or the count in the table)', () => {
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

  it('reporting twice to the same window overwrites with the later value', () => {
    const t = new DraftConflictTracker()
    t.reportDraft(1, 'file:///a.txt')
    t.reportDraft(1, 'file:///b.txt')
    expect(t.conflictsAmong([1], 'file:///a.txt')).toEqual([])
    expect(t.conflictsAmong([1], 'file:///b.txt')).toEqual([1])
  })
})

describe('acceptDraftConflict (renderer-side recheck, preventing crossed messages)', () => {
  const command: Extract<ViewerCommand, { kind: 'draftConflict' }> = {
    kind: 'draftConflict',
    threadId: 't1',
    uri: 'file:///a.txt',
    toolName: 'Edit'
  }

  it('accepts when the thread matches, a draft exists and the URI matches', () => {
    expect(
      acceptDraftConflict(command, { activeThreadId: 't1', selectedUri: 'file:///a.txt', dirty: true })
    ).toEqual({ uri: 'file:///a.txt', toolName: 'Edit' })
  })

  it('ignores one that arrived while viewing another thread (crossed)', () => {
    expect(
      acceptDraftConflict(command, { activeThreadId: 't2', selectedUri: 'file:///a.txt', dirty: true })
    ).toBeNull()
  })

  it('ignores one for which the draft disappeared in transit (saved / discarded)', () => {
    expect(
      acceptDraftConflict(command, { activeThreadId: 't1', selectedUri: 'file:///a.txt', dirty: false })
    ).toBeNull()
  })

  it('ignores one when switched to another file in transit', () => {
    expect(
      acceptDraftConflict(command, { activeThreadId: 't1', selectedUri: 'file:///b.txt', dirty: true })
    ).toBeNull()
  })
})
