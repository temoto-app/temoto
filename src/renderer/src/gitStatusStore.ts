/**
 * The BottomBar's git info (ARCHITECTURE.md 5.6, TODO 51).
 *
 * The basis is the active thread's `cwdUri`. There are three triggers for updates:
 * switching threads (`setCwd`), window focus (`refresh`), and polling every 15 seconds
 * while visible (`POLL_MS`). It does not piggyback on the watcher (the remainder of TODO 51).
 *
 * main only returns `null` when it cannot produce a value and **does not throw**, so there is no exception path here either.
 * Stale responses are dropped by query number (even if the previous cwd's answer arrives
 * late right after the cwd is switched, it does not overwrite).
 */
import { create } from 'zustand'
import type { GitStatus } from '@shared/git.js'
import type { Translate } from './i18n/index.js'

/** Polling interval while visible. */
export const POLL_MS = 15_000

interface GitStatusState {
  cwdUri: string | null
  status: GitStatus | null
  /** Switch the basis cwd. Read once right away and re-arm the polling. Null stops it. */
  setCwd(cwdUri: string | null): void
  /** Reread now (on focus, polling). Not read in a hidden window. */
  refresh(): Promise<void>
  /**
   * The signal "it may have just changed" (item 277, `vcs_state_changed`). However many arrive in a short time, they are coalesced into one
   * and put on `refresh` (so git calls do not increase). `refresh`'s handling of hidden windows and stale responses stays as is.
   */
  poke(): void
  /** On unmount. Stops the timer. */
  stop(): void
}

let timer: ReturnType<typeof setInterval> | null = null
let seq = 0
let pokeTimer: ReturnType<typeof setTimeout> | null = null

/** The interval over which signals are coalesced (right after a push they can arrive in quick succession). */
export const POKE_DEBOUNCE_MS = 400

export const useGitStatus = create<GitStatusState>((set, get) => ({
  cwdUri: null,
  status: null,

  setCwd(cwdUri): void {
    if (get().cwdUri === cwdUri) return
    // At the moment of switching, clear the previous thread's info (so another cwd's values do not linger for an instant).
    set({ cwdUri, status: null })
    get().stop()
    if (cwdUri === null) return
    void get().refresh()
    timer = setInterval(() => void get().refresh(), POLL_MS)
  },

  async refresh(): Promise<void> {
    const cwdUri = get().cwdUri
    if (cwdUri === null) return
    // Do not wake git every 15 seconds for a window that is not visible. It is read on the next focus.
    if (typeof document !== 'undefined' && document.hidden) return
    const mine = ++seq
    const status = await window.aios.git.status(cwdUri)
    if (mine !== seq || get().cwdUri !== cwdUri) return
    set({ status })
  },

  poke(): void {
    if (get().cwdUri === null || pokeTimer !== null) return
    pokeTimer = setTimeout(() => {
      pokeTimer = null
      void get().refresh()
    }, POKE_DEBOUNCE_MS)
  },

  stop(): void {
    if (timer !== null) clearInterval(timer)
    timer = null
    if (pokeTimer !== null) clearTimeout(pokeTimer)
    pokeTimer = null
  }
}))

/**
 * A VSCode-style one-liner (pure function, tested): `⎇ main ↑1 ↓2 ✚3`.
 * With no changes, only the branch name. ahead / behind are shown only when there is an upstream.
 * `text` is only symbols, so it is language-independent. Only `title` (the detail on hover) is worded via `t`
 * (TODO 66; main does not know the language).
 */
export function describeGitStatus(
  status: GitStatus,
  t: Translate
): {
  readonly text: string
  readonly title: string
} {
  const parts = [`⎇ ${status.branch}`]
  if (status.hasUpstream) {
    if (status.ahead > 0) parts.push(`↑${status.ahead}`)
    if (status.behind > 0) parts.push(`↓${status.behind}`)
  }
  const total = status.changed + status.untracked
  if (total > 0) parts.push(`✚${total}`)
  const detail = [
    status.detached
      ? t('git.detached', { branch: status.branch })
      : t('git.branch', { branch: status.branch }),
    status.hasUpstream
      ? t('git.upstream', { ahead: status.ahead, behind: status.behind })
      : t('git.noUpstream'),
    t('git.changes', { changed: status.changed, untracked: status.untracked })
  ]
  return { text: parts.join(' '), title: detail.join('\n') }
}
