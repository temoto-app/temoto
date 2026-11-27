import { describe, expect, it } from 'vitest'
import { sanitizeWorkspaceCopyFailure } from '../src/shared/workspace-copy-log.js'

describe('sanitizeWorkspaceCopyFailure (TODO 1337 (11))', () => {
  it('keeps only known kind names and a plain thread id', () => {
    expect(sanitizeWorkspaceCopyFailure('t-1', ['viewerHistory', 'viewerHistory', '/etc/passwd', 5])).toEqual({
      threadId: 't-1',
      kinds: ['viewerHistory']
    })
  })
  it('refuses a bad id, a non-array and an empty result', () => {
    expect(sanitizeWorkspaceCopyFailure('../x', ['viewerMemory'])).toBeNull()
    expect(sanitizeWorkspaceCopyFailure('t', 'viewerMemory')).toBeNull()
    expect(sanitizeWorkspaceCopyFailure('t', ['nope'])).toBeNull()
  })
})
