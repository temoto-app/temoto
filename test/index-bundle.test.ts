/**
 * **Checks the completion condition of P1 by the build output, not by the source**
 * (3 of docs/OPTIMIZATION_BRIEF.md 3.8).
 *
 * The boundary lint (`test/index-boundaries.test.ts`) looks at the direction of imports, but "even with the right direction, the index's SQL ended up in main's bundle" can only be seen by looking at the output. This checks the **strings** of `out/main/*.js`.
 *
 * It checks `out/main/index.js` and all of `out/main/chunks/*.js` that it imports. electron-vite splits shared code into chunks, so looking at index.js alone would miss "it is in a chunk and just not visible".
 *
 * **The DDL of migrations is out of scope.** `CREATE TABLE documents` / `chunk_fts` are run by main (the index process only checks `user_version`, 3.3), so a statement whose subject is `CREATE` is correctly in main's bundle. What is forbidden is **queries and writes** (`FROM` / `INSERT INTO`), and dependencies that only the index uses (`kuromoji` / `@parcel/watcher`).
 *
 * It is skipped if not built (it does not run under `npm test` alone). It runs as `npm run test:bundle` at the end of `npm run build`.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const outMain = new URL('../out/main/', import.meta.url).pathname
const mainBundle = join(outMain, 'index.js')
const hostBundle = join(outMain, 'index-host.js')
const built = existsSync(mainBundle) && existsSync(hostBundle)

/** Returns the contents of `out/main/index.js` and of the chunks it imports, together. */
function mainGraph(): string {
  const entry = readFileSync(mainBundle, 'utf8')
  let text = entry
  for (const match of entry.matchAll(/chunks\/[A-Za-z0-9_.-]+\.js/g)) {
    const chunk = join(outMain, match[0])
    if (existsSync(chunk)) text += readFileSync(chunk, 'utf8')
  }
  return text
}

/** Queries and writes to the index tables, and the dependencies that only the index uses. */
const FORBIDDEN_IN_MAIN = [
  'kuromoji',
  '@parcel/watcher',
  'INSERT INTO documents',
  'FROM documents',
  'INSERT INTO chunks',
  'FROM chunks',
  'INSERT INTO chunk_fts',
  'FROM chunk_fts'
]

describe.skipIf(!built)('完了条件: main のバンドルに索引が入っていない', () => {
  it('out/main/index.js (と chunk) に索引の SQL と依存が 1 つも無い', () => {
    const text = mainGraph()
    const found = FORBIDDEN_IN_MAIN.filter((term) => text.includes(term))
    expect(found).toEqual([])
  })

  it('索引プロセスのバンドルには、その全部が入っている (検査が空振りしていない)', () => {
    const host = readFileSync(hostBundle, 'utf8')
    const missing = FORBIDDEN_IN_MAIN.filter((term) => !host.includes(term))
    expect(missing).toEqual([])
  })

  it('out/main/index-host.js は electron を import しない', () => {
    const host = readFileSync(hostBundle, 'utf8')
    expect(host).not.toMatch(/from\s*["']electron["']/)
    expect(host).not.toMatch(/require\(\s*["']electron["']\s*\)/)
  })
})
