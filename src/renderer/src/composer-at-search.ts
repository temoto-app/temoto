/**
 * Look up the candidates for `@` in the prompt box (item 114, ARCHITECTURE.md 4.5.8). The decision and the ordering live in the pure
 * functions of `composer-at.ts`; this file is only the IPC (`fs.searchFiles`, the same entry point as T8 / item 100) and throttling.
 *
 * - **Its state is separate from the sidebar file-name search (`searchStore`).** It never
 *   rewrites that search's input or results. Only the "index is busy" display (item 87) goes to the same status bar.
 * - No lookup per keystroke: wait `DEBOUNCE_MS` after typing stops. Responses are matched by request number;
 *   overtaken responses and `cancelled` ones (generation expired on the index process side) are dropped.
 * - No lookup when the query is empty (only `@`, or up to `@src/`).
 */
import { useEffect, useRef, useState } from 'react'
import type { FileSearchResult } from '@shared/types.js'
import {
  NO_AT_CANDIDATES,
  atDirectoryPart,
  atSearchKey,
  atSearchTerm,
  mergeAtCandidates,
  recentAtCandidates,
  type AtCandidate
} from './composer-at.js'
import { useSearch } from './searchStore.js'
import { recentBridge } from './recent-files.js'

/** Delay from the last keystroke to the lookup. */
const DEBOUNCE_MS = 120
/** Number of results requested from the index. More than the number shown, to allow for those dropped by filtering (`src/…`). */
const FETCH_LIMIT = 40
/** Number shown in the popup. */
const SHOW_LIMIT = 8

/**
 * How to treat a search response (wave 49 review). An overtaken response is dropped (`ignore`). If the response to the
 * current request is `cancelled` (generation expired on the index side), the candidates of the previous query would stay up while stale,
 * and Enter would send instead of picking the visible candidate, so the candidates are cleared and the query is settled (`clear`).
 * VS Code completion likewise does not keep old candidates for a query whose results could not be fetched.
 */
export function atAnswerOutcome(cancelled: boolean, isCurrent: boolean): 'ignore' | 'clear' | 'apply' {
  if (!isCurrent) return 'ignore'
  return cancelled ? 'clear' : 'apply'
}

/**
 * Candidates for `query` (the string after `@`; null means no completion). Entries inside the cwd come first (item 100).
 * While a lookup is in flight the previous candidates stay visible (the popup does not flicker).
 */
export function useAtCandidates(
  query: string | null,
  cwdUri: string | null
): { readonly candidates: readonly AtCandidate[]; readonly stale: boolean } {
  const [candidates, setCandidates] = useState<readonly AtCandidate[]>(NO_AT_CANDIDATES)
  // Which query the current candidates belong to (TODO 942). After the query changes (between the debounce and the IPC round trip) they are stale.
  const [settledKey, setSettledKey] = useState<string | null>(null)
  const request = useRef(0)
  const term = query === null ? '' : atSearchTerm(query)
  const dirPart = query === null ? '' : atDirectoryPart(query)
  const key = atSearchKey(term, dirPart, cwdUri)
  // TODO 999: only `@` was typed (no query, no folder).
  const bare = query === ''

  useEffect(() => {
    request.current += 1
    const mine = request.current
    if (term.trim() === '') {
      setCandidates(NO_AT_CANDIDATES)
      setSettledKey(key)
      // TODO 999: with only `@` (no query, no folder), show recent files, newest first. Unlike attachments, what gets inserted is the text `@<path>`.
      const listRecent = bare ? recentBridge()?.list : undefined
      if (listRecent === undefined) return
      void listRecent({ limit: SHOW_LIMIT })
        .then((files) => {
          if (mine !== request.current) return
          setCandidates(recentAtCandidates(files, cwdUri, SHOW_LIMIT))
        })
        .catch(() => undefined)
      return
    }
    const timer = setTimeout(() => {
      // The `@` completion does not use smart case (TODO 291 covers only the three search windows). To list candidates
      // case-insensitively like the CLI's `@`, the query is lowercased before the lookup.
      void window.aios.fs
        .searchFiles(term.toLowerCase(), FETCH_LIMIT, cwdUri)
        .then((result: FileSearchResult) => {
          useSearch.getState().noteIndexAnswered()
          const outcome = atAnswerOutcome(result.cancelled === true, mine === request.current)
          if (outcome === 'ignore') return
          setCandidates(
            outcome === 'clear'
              ? NO_AT_CANDIDATES
              : mergeAtCandidates(result.cwd?.entries ?? [], result.entries, cwdUri, dirPart, SHOW_LIMIT)
          )
          setSettledKey(key)
        })
        .catch((err: unknown) => {
          // The index is busy / down (item 87). No candidates are shown; the reason goes to the status bar.
          if (mine === request.current) {
            setCandidates(NO_AT_CANDIDATES)
            setSettledKey(key)
          }
          useSearch.getState().noteIndexError(err)
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [term, dirPart, cwdUri, key, bare])

  if (query === null) return { candidates: NO_AT_CANDIDATES, stale: false }
  return { candidates, stale: settledKey !== key }
}
