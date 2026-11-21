// TODO 1263 code-review: `appIdentity()` throws until the data name is fixed, and the adapter's spawn reads it (the gateway
// instructions name `~/<name>/help`). `npm run test:contract` runs under its own config, so the setup that fixes the name has to be
// there too (it is not run here: it calls the model). Read both configs as text (they are outside the test project).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

function setupFiles(source: string): string[] {
  const list = /setupFiles:\s*\[([^\]]*)\]/.exec(source)?.[1] ?? ''
  return [...list.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '')
}

describe('vitest の設定 (TODO 1263 code-review)', () => {
  it('通常の設定と契約の設定が同じ setupFiles (データの名前を決める) を持つ', () => {
    const normal = setupFiles(read('vitest.config.ts'))
    expect(normal).toContain('test/setup/app-identity.ts')
    expect(setupFiles(read('vitest.contract.config.ts'))).toEqual(normal)
  })
})
