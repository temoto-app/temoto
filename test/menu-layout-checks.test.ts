/**
 * Review of TODO 1327: the View menu's "Sidebar" / "Viewer" check items.
 *
 * - The checks say what the window the commands go to shows now (`layoutCheckState`); with no window the two are disabled
 *   (VS Code enables its menu commands only while a window is open).
 * - Electron flips a checkbox before `click` runs. The click puts back what the window shows now, so a click no renderer answers
 *   (every window closed, a window still on its boot entry) does not leave the check flipped.
 *
 * electron is faked; nothing is shown.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: {}, Menu: {} }))
vi.mock('../src/main/os/electron.js', () => ({ setDockMenu: () => undefined }))

const { viewItem } = await import('../src/main/menu.js')
const { layoutCheckState, viewMenuEntries } = await import('../src/main/menu-model.js')
type LayoutChecks = import('../src/shared/window-layout.js').LayoutChecks
type CommandMenuItem = import('../src/main/menu-model.js').CommandMenuItem
type MenuCommand = import('../src/shared/ipc.js').MenuCommand

function entryFor(command: MenuCommand): CommandMenuItem {
  const entry = viewMenuEntries('darwin').find((candidate) => candidate !== 'separator' && candidate.command === command)
  if (entry === undefined || entry === 'separator') throw new Error(command)
  return entry
}

describe('layoutCheckState', () => {
  it('checks what the window in front shows; with no window both are disabled and unchecked', () => {
    const checks: LayoutChecks = { sidebar: true, viewer: false }
    expect(layoutCheckState('toggleSidebar', checks)).toEqual({ enabled: true, checked: true })
    expect(layoutCheckState('toggleViewer', checks)).toEqual({ enabled: true, checked: false })
    expect(layoutCheckState('toggleSidebar', null)).toEqual({ enabled: false, checked: false })
    expect(layoutCheckState('toggleViewer', null)).toEqual({ enabled: false, checked: false })
  })
})

describe('View > Sidebar / Viewer (menu.ts viewItem)', () => {
  it('is built from what the window in front shows, and disabled with no window', () => {
    let current: LayoutChecks | null = { sidebar: true, viewer: false }
    const actions = { openWindow: vi.fn(), sendCommand: vi.fn(), layoutChecks: () => current }
    expect(viewItem('en', actions, entryFor('toggleViewer'))).toMatchObject({ type: 'checkbox', checked: false, enabled: true })
    current = null
    expect(viewItem('en', actions, entryFor('toggleSidebar'))).toMatchObject({ type: 'checkbox', checked: false, enabled: false })
  })

  it('a click puts the check Electron flipped back to what the window shows, after sending the command', () => {
    const current: LayoutChecks = { sidebar: true, viewer: true }
    const sent: MenuCommand[] = []
    const actions = { openWindow: vi.fn(), sendCommand: (command: MenuCommand) => sent.push(command), layoutChecks: () => current }
    const item = viewItem('en', actions, entryFor('toggleViewer'))
    // Electron has already flipped it when `click` runs; no renderer answers (a window still on its boot entry).
    const menuItem = { checked: false, enabled: true }
    item.click?.(menuItem as never, undefined, {} as never)
    expect(sent).toEqual(['toggleViewer'])
    expect(menuItem).toEqual({ checked: true, enabled: true })
  })

  it('other View items stay plain items', () => {
    const actions = { openWindow: vi.fn(), sendCommand: vi.fn(), layoutChecks: () => null }
    const item = viewItem('en', actions, entryFor('showFiles'))
    expect(item.type).toBeUndefined()
    expect(item.enabled).toBeUndefined()
  })
})
