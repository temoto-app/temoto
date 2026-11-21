/**
 * The per-window temporary state of filtering the Threads list by project name (TODO 1012).
 * It is placed in a store so it does not disappear when the sidebar mode is switched (when the list is detached), but it is not saved
 * (not carried over to a restart or another window - owner decision).
 */
import { create } from 'zustand'

interface ThreadFilterState {
  /** Whether the field is open. */
  readonly open: boolean
  /** The applied text (what IME composition has confirmed). */
  readonly query: string
  setOpen(open: boolean): void
  setQuery(query: string): void
}

export const useThreadFilter = create<ThreadFilterState>((set) => ({
  open: false,
  query: '',
  setOpen: (open) => set(open ? { open } : { open, query: '' }),
  setQuery: (query) => set({ query })
}))
