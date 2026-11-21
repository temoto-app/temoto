// TODO 930 (wave 49 bundle E): the failure of npm ci in promote-stable.sh. Does not run the shell; reads the text.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (p: string): string => readFileSync(new URL(`../scripts/${p}`, import.meta.url), 'utf8')
const promote = read('promote-stable.sh')

describe('promote-stable.sh (TODO 930)', () => {
  it('moves node_modules aside before npm ci, and on failure restores it and stops', () => {
    expect(promote).toMatch(/mv node_modules node_modules\.old/)
    expect(promote).toMatch(/if npm ci; then/)
    expect(promote).toMatch(/mv node_modules\.old node_modules/)
    expect(promote).not.toMatch(/^\s*npm ci\s*$/m)
  })
})
