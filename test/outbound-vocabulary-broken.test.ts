import { describe, expect, it, vi } from 'vitest'

// TODO 1020 (review): if compat/outbound.json is broken, throw saying which file it is (do not silently empty it).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: () => '{ not json' }
})

describe('loadOutboundVocabulary', () => {
  it('names the file when the JSON is broken', async () => {
    const { loadOutboundVocabulary } = await import('../src/main/approval/outbound-vocabulary.js')
    expect(() => loadOutboundVocabulary()).toThrow(/outbound\.json: /)
  })
})
