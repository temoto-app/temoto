/**
 * The skill badge at the head of a turn (TODO 1100, ARCHITECTURE.md 5.1.9).
 *
 * Like `foldTimeline` these are **pure functions**, unit-tested without a DOM (`test/skill-badges.test.ts`).
 *
 * - **The only input is the parent's tool call (`ToolItem.skill`)**. The adapter converts the skill name into a neutral field of `tool_use`
 *   and passes it (tool names do not reach the renderer - constraint 6). It is on the `tool_use` side, so it is saved and the same badge appears after reopening.
 *   The "list of available skills" (`session_started.skills`) is not looked at (those are not the ones used).
 * - **A turn is split at the user's message (`user`)**. The badge is shown as one line at the head of the turn's **first answer row** (message, tool, plan, approval).
 *   The same skill is folded into one, in the order first used. If none is used, nothing is shown.
 * - Skills used inside a subagent are not shown in stage 1 (a child's tool calls are not in the top-level list).
 */
import type { SkillEntry } from '@shared/skills.js'
import type { TimelineItem } from './timeline.js'

/** The kinds of rows to attach a badge to (rows of the answer's contents). Not attached to note rows such as `session`. */
const ANCHOR_KINDS: ReadonlySet<TimelineItem['kind']> = new Set(['assistant', 'tool', 'plan', 'approval'])

/**
 * The skills used per turn. The key is the id of the row where the badge is drawn (the turn's first answer row). Turns that did not use a skill
 * are not listed.
 */
export interface SkillBadge {
  readonly name: string
  /** The URI of the skill file the backend reported (TODO 1105). It is for that turn's call. If absent, looked up from the list. */
  readonly uri?: string
}

export function skillBadgesByTurn(items: readonly TimelineItem[]): ReadonlyMap<string, readonly SkillBadge[]> {
  const out = new Map<string, readonly SkillBadge[]>()
  let anchor: string | null = null
  let names: SkillBadge[] = []
  const flush = (): void => {
    if (anchor !== null && names.length > 0) out.set(anchor, names)
    anchor = null
    names = []
  }
  for (const item of items) {
    if (item.kind === 'user') {
      flush()
      continue
    }
    if (anchor === null && ANCHOR_KINDS.has(item.kind)) anchor = item.id
    if (item.kind === 'tool' && item.skill !== undefined && item.skill !== '') {
      const at = names.findIndex((badge) => badge.name === item.skill)
      if (at < 0) names.push({ name: item.skill, ...(item.skillUri === undefined ? {} : { uri: item.skillUri }) })
      else if (names[at]!.uri === undefined && item.skillUri !== undefined) names[at] = { name: item.skill, uri: item.skillUri }
    }
  }
  flush()
  return out
}

/**
 * Badge name -> the skill file (one row of the skill list). null if not found (only the badge is shown).
 *
 * - `<plugin>:<skill>` is a plugin skill (the one whose plugin name matches and whose skill name or directory name matches).
 * - Otherwise user / project skills come first, then plugin skills (only when the name is unique).
 *   If the same name exists in both the project and the user, the project is chosen (closer to the working folder).
 */
export function findSkillEntry(entries: readonly SkillEntry[], name: string): SkillEntry | null {
  const matches = (entry: SkillEntry, wanted: string): boolean => entry.name === wanted || entry.dirName === wanted
  const colon = name.indexOf(':')
  if (colon > 0) {
    const plugin = name.slice(0, colon)
    const skill = name.slice(colon + 1)
    const hit = entries.find((entry) => entry.scope === 'plugin' && entry.pluginName === plugin && matches(entry, skill))
    if (hit !== undefined) return hit
  }
  const own =
    entries.find((entry) => entry.scope === 'project' && matches(entry, name)) ??
    entries.find((entry) => entry.scope === 'user' && matches(entry, name))
  if (own !== undefined) return own
  const plugins = entries.filter((entry) => entry.scope === 'plugin' && matches(entry, name))
  return plugins.length === 1 ? plugins[0]! : null
}
