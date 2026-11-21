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

describe('vitest config (TODO 1263 code-review)', () => {
  it('the normal config and the contract config have the same setupFiles (which decide the data names)', () => {
    const normal = setupFiles(read('vitest.config.ts'))
    expect(normal).toContain('test/setup/app-identity.ts')
    expect(setupFiles(read('vitest.contract.config.ts'))).toEqual(normal)
  })
})
