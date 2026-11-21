/**
 * TODO 316: checks that the version embedded at build time (`__AIOS_BUILD__`) is **actually in the build output**.
 *
 * A `define` value only gets in when it passes through `electron.vite.config.ts`. The source test (`build-info.test.ts`) checks the format and how git is read,
 * but "a typo in the config so that define has no effect, and at runtime it is always `unknown`" can only be seen by looking at the output.
 * Like `test/index-bundle.test.ts`, it checks the strings in `out/main/*.js`.
 *
 * It is skipped if not built, or if the output is older than `src/main/build-info.ts` (a build from before TODO 316). It does not run in plain `npm test`.
 * It runs in `npm run test:bundle`, at the end of `npm run build`.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const outMain = new URL('../out/main/', import.meta.url).pathname
const mainBundle = join(outMain, 'index.js')
/** The source that reads the version. If the output is older than this, it is a build from before TODO 316, so skip
 *  (so that a plain `npm test` right after a merge does not fail on the previous day's `out/`). */
const stampSource = new URL('../src/main/build-info.ts', import.meta.url).pathname
const built =
  existsSync(mainBundle) &&
  existsSync(stampSource) &&
  statSync(mainBundle).mtimeMs >= statSync(stampSource).mtimeMs

/** Returns the contents of `out/main/index.js` together with the chunks it imports. */
function mainGraph(): string {
  const entry = readFileSync(mainBundle, 'utf8')
  let text = entry
  for (const match of entry.matchAll(/chunks\/[A-Za-z0-9_.-]+\.js/g)) {
    const chunk = join(outMain, match[0])
    if (existsSync(chunk)) text += readFileSync(chunk, 'utf8')
  }
  return text
}

/** The shape esbuild rewrote the define JSON into (`{ version: "…", commit: "…", dirty: …, date: "…" }`). */
const STAMP =
  /\{\s*"?version"?:\s*"([^"]+)",\s*"?commit"?:\s*"([0-9a-f]{40,64}|unknown)",\s*"?dirty"?:\s*(true|false|!0|!1),\s*"?date"?:\s*"([^"]+)"\s*\}/

describe.skipIf(!built)('TODO 316: main のバンドルにビルドの版が埋まっている', () => {
  it('__AIOS_BUILD__ の識別子が残っておらず、値 (version / commit / dirty / date) が入っている', () => {
    const text = mainGraph()
    expect(text).not.toContain('__AIOS_BUILD__')
    const match = STAMP.exec(text)
    expect(match).not.toBeNull()
    const [, version, commit, , date] = match ?? []
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    expect(version).toBe(pkg.version)
    expect(commit).toMatch(/^([0-9a-f]{40,64}|unknown)$/)
    expect(Number.isNaN(new Date(date ?? '').getTime())).toBe(false)
  })
})
