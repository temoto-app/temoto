/**
 * Whether saving by key or menu is allowed (item 313). `ViewerPane` calls the same `doSave` as the 'Save' button in the heading only when `shouldSaveByKey` lets it through.
 * Nothing happens for read-only (item 254), with no draft, and while saving. The reverse-send table and the bridge side are in `test/viewer-shortcuts.test.ts`, the menu in `test/menu-model.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { shouldSaveByKey } from '../src/renderer/src/viewer-save.js'

describe('shouldSaveByKey (項目 313)', () => {
  it('編集できて、下書きがあり、保存中でなく、衝突中でもないときだけ保存する', () => {
    expect(shouldSaveByKey({ editable: true, dirty: true, saving: false, conflict: false })).toBe(true)
  })

  it('読み取り専用 (editable でない) では何もしない', () => {
    expect(shouldSaveByKey({ editable: false, dirty: true, saving: false, conflict: false })).toBe(false)
  })

  it('下書きが無い (dirty でない) ときは何もしない', () => {
    expect(shouldSaveByKey({ editable: true, dirty: false, saving: false, conflict: false })).toBe(false)
  })

  it('保存の最中は二重に保存しない', () => {
    expect(shouldSaveByKey({ editable: true, dirty: true, saving: true, conflict: false })).toBe(false)
  })

  it('下書きの衝突の帯が出ている間は、⌘S / 保存ボタンでは保存しない (TODO 313 の小さな観察)', () => {
    expect(shouldSaveByKey({ editable: true, dirty: true, saving: false, conflict: true })).toBe(false)
  })
})
