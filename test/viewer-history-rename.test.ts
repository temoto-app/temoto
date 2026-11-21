// @vitest-environment jsdom
/**
 * TODO 1149: the old URI of a renamed file or folder does not remain in the viewer's ← → history.
 * Both the renderer (`store.noteRenamed`) and the saved history in main (`ViewerHistoryService.renameUris`).
 * Recent files (999) are re-read by main each time they are opened, so nothing is carried over and they are out of scope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import { ViewerHistoryService } from '../src/main/session/viewer-history.js'
import { renameHistoryUris } from '../src/shared/viewer-history.js'
import { useStore } from '../src/renderer/src/store.js'
import { fromSnapshot, toSnapshot } from '../src/renderer/src/viewer-history.js'

const W = 'file:///Users/tester/work'
const step = (uri: string): { uri: string; highlight: string | null } => ({ uri, highlight: null })

describe('renameHistoryUris', () => {
  it('ファイル 1 つ: 一致する歩だけ差し替え、同じ名前の接頭辞の兄弟は触らない', () => {
    const entries = [step(`${W}/a.md`), step(`${W}/a.md.bak`), step(`${W}/b.md`)]
    expect(renameHistoryUris(entries, `${W}/a.md`, `${W}/c.md`).map((e) => e.uri)).toEqual([
      `${W}/c.md`,
      `${W}/a.md.bak`,
      `${W}/b.md`
    ])
  })
  it('フォルダ: 配下の URI を接頭辞で差し替える', () => {
    const out = renameHistoryUris([step(`${W}/old/x/y.ts`), step(`${W}/older/z`)], `${W}/old`, `${W}/new`)
    expect(out.map((e) => e.uri)).toEqual([`${W}/new/x/y.ts`, `${W}/older/z`])
  })
  it('変わる歩が無ければ同じ配列を返す', () => {
    const entries = [step(`${W}/b`)]
    expect(renameHistoryUris(entries, `${W}/a`, `${W}/c`)).toBe(entries)
  })
})

describe('store.noteRenamed の履歴 (renderer)', () => {
  beforeEach(() => {
    ;(window as unknown as { aios: unknown }).aios = {
      fs: { listDirectory: vi.fn(async (uri: string) => ({ uri, entries: [], live: true, reason: null })) }
    }
    useStore.setState({
      expanded: new Set(),
      children: {},
      loading: new Set(),
      viewerDrafts: {},
      viewerHistories: {
        t1: fromSnapshot({ entries: [step(`${W}/old/a.md`), step(`${W}/keep.md`)], index: 0 }),
        t2: fromSnapshot({ entries: [step(`${W}/other.md`)], index: 0 })
      }
    })
  })

  it('全会話の履歴の旧 URI を差し替え、index は保つ。変わらない会話の参照は同じ', async () => {
    const before = useStore.getState().viewerHistories.t2
    await useStore.getState().noteRenamed(`${W}/old`, `${W}/new`)
    const histories = useStore.getState().viewerHistories
    expect(toSnapshot(histories.t1!)).toEqual({ entries: [step(`${W}/new/a.md`), step(`${W}/keep.md`)], index: 0 })
    expect(histories.t2).toBe(before)
  })
})

describe('ViewerHistoryService.renameUris (main)', () => {
  let db: Db
  let store: ThreadStore
  let service: ViewerHistoryService
  const fs = { isReferenceable: () => true, isViewable: () => true }

  const put = (id: string, entries: unknown[]): void => {
    store.createThread({
      id,
      title: '',
      titleAuto: true,
      cwd: '/Users/tester/work',
      allowedDirs: ['/Users/tester/work'],
      retention: 'forever',
      backend: 'fake',
      modelId: null,
      thinking: null
    })
    store.setViewerHistoryJson(id, JSON.stringify({ entries, index: 0 }))
  }

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    store = new ThreadStore(db, '/Users/tester')
    service = new ViewerHistoryService({ store, fs })
  })
  afterEach(() => db.close())

  it('全会話の保存済みの履歴で、ファイルもフォルダ配下も付け替える', () => {
    put('t1', [step(`${W}/old/a.md`), step('https://example.com/')])
    put('t2', [step(`${W}/x.md`)])
    service.renameUris(`${W}/old`, `${W}/new`)
    expect(service.get('t1')?.entries.map((e) => e.uri)).toEqual([`${W}/new/a.md`, 'https://example.com/'])
    expect(service.get('t2')?.entries.map((e) => e.uri)).toEqual([`${W}/x.md`])
    service.renameUris(`${W}/x.md`, `${W}/y.md`)
    expect(service.get('t2')?.entries.map((e) => e.uri)).toEqual([`${W}/y.md`])
  })

  it('壊れた行は黙って飛ばす', () => {
    put('t1', [step(`${W}/a`)])
    db.prepare('UPDATE thread_viewer_history SET history = ? WHERE thread_id = ?').run('{broken', 't1')
    expect(() => service.renameUris(`${W}/a`, `${W}/b`)).not.toThrow()
  })
})
