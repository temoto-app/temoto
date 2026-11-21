/**
 * TODO 462 (wave 23 bundle B): order and limit of the working-folder history. The model is not called.
 *
 * - Sorted by count descending, and for equal counts by last used (`ORDER BY use_count DESC, last_used_at DESC`).
 * - Sorted before being cut at the limit (`CWD_HISTORY_LIMIT` = 100), so old folders with high counts are not dropped.
 */
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { CWD_HISTORY_LIMIT, ThreadStore } from '../src/main/session/store.js'

const HOME = '/Users/tester'
const opened: Db[] = []

afterEach(() => {
  for (const db of opened.splice(0)) db.close()
})

function store(): ThreadStore {
  const db = new Database(':memory:')
  opened.push(db)
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return new ThreadStore(db, HOME)
}

describe('cwdHistory の並び (TODO 462)', () => {
  it('回数の多い順、同数なら最後に使った順', () => {
    const s = store()
    s.touchCwd('/w/once-new', 50)
    s.touchCwd('/w/thrice', 1)
    s.touchCwd('/w/thrice', 2)
    s.touchCwd('/w/thrice', 3)
    s.touchCwd('/w/once-old', 10)
    s.touchCwd('/w/twice', 4)
    s.touchCwd('/w/twice', 5)
    expect(s.cwdHistory().map((row) => row.path)).toEqual([
      '/w/thrice',
      '/w/twice',
      '/w/once-new',
      '/w/once-old'
    ])
  })

  it('上限は 100 件で、切る前に回数で並べる (回数の多い古いフォルダが残る)', () => {
    expect(CWD_HISTORY_LIMIT).toBe(100)
    const s = store()
    // The oldest folder, which was used twice.
    s.touchCwd('/w/old-favourite', 1)
    s.touchCwd('/w/old-favourite', 2)
    for (let i = 0; i < 120; i += 1) s.touchCwd(`/w/n${i}`, 100 + i)
    const rows = s.cwdHistory()
    expect(rows).toHaveLength(100)
    expect(rows[0]?.path).toBe('/w/old-favourite')
    // The rest in newest-first order (once each).
    expect(rows[1]?.path).toBe('/w/n119')
    expect(rows.at(-1)?.path).toBe('/w/n21')
  })
})
