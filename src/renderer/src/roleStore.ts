/**
 * The role list (shown as "Teammates", TODO 972, ARCHITECTURE 4.3.4). The thread list (role headings), the "Teammates" section of the
 * scheduled-run view and the editors look at the same list, so the list fetched from main is held only once, here.
 * One subscription per window (`initRoles`, called by the Sidebar at startup). Opening and closing the editor lives in `scheduleStore.ts`
 * `editing.role` (the same place and exclusivity as editing a scheduled run).
 *
 * Also here: which role headings are folded in this window (`localStorage`, like the sidebar's collapse state - "how this window is used",
 * not a setting).
 */
import { create } from 'zustand'
import type { Role } from '@shared/role.js'
import { readString, safeStorage, writeString, type PrefStorage } from './uiPrefs.js'

/** The `localStorage` key: the ids of the folded role headings (a JSON array). */
export const ROLE_COLLAPSED_KEY = 'aios.roleCollapsed'

interface RoleState {
  /** undefined = not fetched from main yet. */
  readonly roles: readonly Role[] | undefined
  /** The ids of folded role headings in the thread list. */
  readonly collapsed: ReadonlySet<string>
  setRoles(roles: readonly Role[]): void
  toggleCollapsed(roleId: string): void
}

function isIdList(raw: string): boolean {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
  } catch {
    return false
  }
}

export function loadCollapsedRoles(storage: PrefStorage | undefined = safeStorage()): ReadonlySet<string> {
  const raw = readString(storage, ROLE_COLLAPSED_KEY, isIdList)
  return raw === undefined ? new Set() : new Set(JSON.parse(raw) as string[])
}

export const useRoles = create<RoleState>((set, get) => ({
  roles: undefined,
  collapsed: loadCollapsedRoles(),
  setRoles: (roles) => {
    // Forget folded ids of roles that no longer exist (keeps the stored list small).
    const known = new Set(roles.map((role) => role.id))
    const collapsed = get().collapsed
    const kept = [...collapsed].filter((id) => known.has(id))
    if (kept.length !== collapsed.size) {
      writeString(safeStorage(), ROLE_COLLAPSED_KEY, JSON.stringify(kept))
      set({ roles, collapsed: new Set(kept) })
    } else set({ roles })
  },
  toggleCollapsed: (roleId) => {
    const next = new Set(get().collapsed)
    if (next.has(roleId)) next.delete(roleId)
    else next.add(roleId)
    writeString(safeStorage(), ROLE_COLLAPSED_KEY, JSON.stringify([...next]))
    set({ collapsed: next })
  }
}))

let initialized = false

/** Fetches main's list and subscribes to pushes (once per window). */
export function initRoles(): void {
  if (initialized) return
  initialized = true
  let pushed = false
  window.aios.roles.onChanged((next) => {
    pushed = true
    useRoles.getState().setRoles(next)
  })
  void window.aios.roles.list().then((next) => {
    if (!pushed) useRoles.getState().setRoles(next)
  })
}

/** For tests: resets the subscription marker and the state. */
export function resetRolesForTest(): void {
  initialized = false
  useRoles.setState({ roles: undefined, collapsed: new Set() })
}

/** Looks up a role (null if absent or not fetched yet). */
export function findRole(roles: readonly Role[] | undefined, id: string | undefined): Role | null {
  if (id === undefined) return null
  return roles?.find((role) => role.id === id) ?? null
}
