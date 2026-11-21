/**
 * The pure part of 'an outside tool rewrote the file currently displayed' (TODO 673). Neither DOM nor store is needed.
 *
 * What it guarantees:
 * - main's `fileChanged` is sent per window only for the 'file being viewed now', but if the window moved to another file while it was in transit,
 *   the renderer side ignores it (`ignore`).
 * - without a draft (unsaved edit), it silently re-reads (`reload`); with one, the conflict band (`conflict`).
 */
import { describe, expect, it } from 'vitest'
import { planExternalChange } from '../src/renderer/src/viewer-external-change.js'
import type { ViewerCommand } from '../src/shared/thread.js'

function fileChanged(uri: string): Extract<ViewerCommand, { kind: 'fileChanged' }> {
  return { kind: 'fileChanged', uri }
}

describe('planExternalChange', () => {
  it('unrelated when it differs from the shown file (out of step)', () => {
    expect(planExternalChange(fileChanged('file:///a.ts'), { selectedUri: 'file:///b.ts', dirty: false })).toEqual({
      kind: 'ignore'
    })
    expect(planExternalChange(fileChanged('file:///a.ts'), { selectedUri: null, dirty: false })).toEqual({
      kind: 'ignore'
    })
  })

  it('silently reloads when there is no draft', () => {
    expect(planExternalChange(fileChanged('file:///a.ts'), { selectedUri: 'file:///a.ts', dirty: false })).toEqual({
      kind: 'reload',
      uri: 'file:///a.ts'
    })
  })

  it('shows the conflict band when there is a draft (does not replace)', () => {
    expect(planExternalChange(fileChanged('file:///a.ts'), { selectedUri: 'file:///a.ts', dirty: true })).toEqual({
      kind: 'conflict',
      uri: 'file:///a.ts'
    })
  })
})
