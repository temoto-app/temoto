/**
 * Skill badges at the head of an answer turn (TODO 1100, ARCHITECTURE.md 5.1.9).
 *
 * - Which badges to show in which turn is decided by the pure function `skillBadgesByTurn` (`thread/skills.ts`). This only draws.
 * - **Pressing one opens the skill's main file in the ViewerPane** (owner decision 2026-11-03). The location of the main file is looked up by name in the same
 *   list as the settings "Skills" (`skills.list`, where main's adapter walks the locations, constraint 6), and what opens is the same
 *   `select(uri)` as the settings "Open" (main's viewer choke point re-validates the read). **If it cannot be looked up, it is only a badge** (not pressable; e.g. a skill bundled with the CLI).
 * - The list is reused for a short time per working folder (`LISTING_TTL_MS`). However many badge rows there are, the locations are
 *   not walked again on every re-open.
 */
import { useEffect, useState } from 'react'
import type { SkillEntry } from '@shared/skills.js'
import { useT } from '../i18n/index.js'
import { useStore } from '../store.js'
import { findSkillEntry, type SkillBadge } from '../thread/skills.js'

/** How long the list is reused. Even if a skill is added mid-conversation, it is picked up again on a render after this. */
const LISTING_TTL_MS = 15_000

const listings = new Map<string, { readonly at: number; readonly promise: Promise<readonly SkillEntry[]> }>()

function loadSkillEntries(cwdUri: string | null): Promise<readonly SkillEntry[]> {
  const key = cwdUri ?? ''
  const now = Date.now()
  const cached = listings.get(key)
  if (cached !== undefined && now - cached.at < LISTING_TTL_MS) return cached.promise
  const promise = window.aios.skills
    .list(cwdUri)
    .then((listing) => listing.skills)
    .catch(() => {
      // A failure is not reused (review): leaving an empty list for the TTL would make every badge in the meantime unpressable. It is re-fetched on the next render.
      // If another query has been put in later, that one is not removed.
      if (listings.get(key)?.promise === promise) listings.delete(key)
      return [] as readonly SkillEntry[]
    })
  listings.set(key, { at: now, promise })
  return promise
}

/** For tests: discards the reused list. */
export function resetSkillListingCache(): void {
  listings.clear()
}

export function SkillBadges({
  badges,
  cwdUri
}: {
  /** Badges. `uri` is the main file that the backend reported in that turn's invocation (TODO 1105). It is used before the list. */
  badges: readonly SkillBadge[]
  /** The conversation's working folder (to look up project skills). If none, only user and plugin ones. */
  cwdUri: string | null
}): React.JSX.Element {
  const t = useT()
  const [entries, setEntries] = useState<readonly SkillEntry[] | null>(null)
  useEffect(() => {
    let alive = true
    void loadSkillEntries(cwdUri).then((next) => {
      if (alive) setEntries(next)
    })
    return () => {
      alive = false
    }
  }, [cwdUri])
  return (
    <div className="skill-badges">
      <span className="skill-badges-label">{t('timeline.skills.label')}</span>
      {badges.map(({ name, uri: reported = null }) => {
        const entry = entries === null ? null : findSkillEntry(entries, name)
        const uri = reported ?? entry?.uri ?? null
        if (uri === null) {
          return (
            <span key={name} className="skill-badge" title={entries === null ? name : t('timeline.skills.noFile', { name })}>
              {name}
            </span>
          )
        }
        return (
          <button
            key={name}
            type="button"
            className="skill-badge"
            title={t('timeline.skills.open', { name })}
            onClick={() => useStore.getState().select(uri)}
          >
            {name}
          </button>
        )
      })}
    </div>
  )
}
