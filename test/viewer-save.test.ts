/**
 * Whether saving by key or menu is allowed (item 313). `ViewerPane` calls the same `doSave` as the 'Save' button in the heading only when `shouldSaveByKey` lets it through.
 * Nothing happens for read-only (item 254), with no draft, and while saving. The reverse-send table and the bridge side are in `test/viewer-shortcuts.test.ts`, the menu in `test/menu-model.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { shouldSaveByKey } from '../src/renderer/src/viewer-save.js'

describe('shouldSaveByKey (item 313)', () => {
  it('saves only when editable, a draft exists, not saving, and not in conflict', () => {
    expect(shouldSaveByKey({ editable: true, dirty: true, saving: false, conflict: false })).toBe(true)
  })

  it('does nothing in read-only mode (not editable)', () => {
    expect(shouldSaveByKey({ editable: false, dirty: true, saving: false, conflict: false })).toBe(false)
  })

  it('does nothing when there is no draft (not dirty)', () => {
    expect(shouldSaveByKey({ editable: true, dirty: false, saving: false, conflict: false })).toBe(false)
  })

  it('does not save twice while saving', () => {
    expect(shouldSaveByKey({ editable: true, dirty: true, saving: true, conflict: false })).toBe(false)
  })

  it('does not save with ⌘S / the save button while the draft conflict band is shown (a small observation of TODO 313)', () => {
    expect(shouldSaveByKey({ editable: true, dirty: true, saving: false, conflict: true })).toBe(false)
  })
})
