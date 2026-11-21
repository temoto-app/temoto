/**
 * Normalization and matching of "connection targets that are not asked about" (TODO 1029, the targets of ARCHITECTURE 4.2.1 "standard commands that are not asked about").
 *
 * If the destination of `ssh` / `scp` / `sftp` / `rsync` is in the list, that connection is let through as a standard command that is not asked about (even in strict mode,
 * and even when it hits the outbound-operation judgment 959). The list is `approval.sshAllowedHosts` in `app_settings` (`src/common/settings-keys.ts`,
 * owned by main). What was decided (`docs/notes/wave56.md`):
 *
 * - The form is `host` or `user@host`. host is lowercased (name resolution is case-insensitive). user keeps its case.
 * - **Compared by the name as written in the command** - Host aliases of `~/.ssh/config` are not resolved (put the alias in the list and it passes by that alias).
 * - A `host` in the list matches a connection to that host by any user. `user@host` matches only connections by that user (a connection that does not write a user
 *   = the default user, cannot tell which user it is, so it matches only the `host` row).
 * - Anything containing whitespace, control characters, `/` or `:` (except the `[…]` of IPv6), or that is too long (over 255 characters), gives null.
 */

/** Upper limit of the list (entries). It is added to from the settings screen and the approval frame, so a small one is fine. */
export const MAX_SSH_HOSTS = 200
const MAX_HOST_LENGTH = 255

const HOST = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*|\[[0-9A-Fa-f:.]+\])$/
const USER = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/

/** Makes `host` / `user@host` comparable. null for an unreadable form. */
export function normalizeSshHost(raw: string): string | null {
  const text = raw.trim()
  if (text === '' || text.length > MAX_HOST_LENGTH) return null
  const at = text.lastIndexOf('@')
  const user = at >= 0 ? text.slice(0, at) : null
  const host = at >= 0 ? text.slice(at + 1) : text
  if (!HOST.test(host)) return null
  if (user !== null && !USER.test(user)) return null
  return user === null ? host.toLowerCase() : `${user}@${host.toLowerCase()}`
}

/** Re-validates a saved value / a value from the renderer (normalize, deduplicate, limit). Unreadable elements are dropped. */
export function sanitizeSshHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const host = normalizeSshHost(entry)
    if (host === null || out.includes(host)) continue
    out.push(host)
    if (out.length >= MAX_SSH_HOSTS) break
  }
  return out
}

/** Whether a connection target (`host` / `user@host`, normalized) matches the list. */
export function sshHostAllowed(target: string, allowed: readonly string[]): boolean {
  if (allowed.includes(target)) return true
  const at = target.lastIndexOf('@')
  return at >= 0 && allowed.includes(target.slice(at + 1))
}

/** The field of the approval-default diff concerning the connection targets that are not asked about (the part of `ApprovalPolicyPatch`). */
export interface SshHostsPatch {
  readonly sshAllowedHosts?: readonly string[]
  readonly sshAllowedHostsAdd?: readonly string[]
  readonly sshAllowedHostsRemove?: readonly string[]
}

/** Applies the diff to the current list (the same form as 1013's push destination: if there is a whole value, use it as the base, then remove -> add). */
export function applySshHostsPatch(current: readonly string[], patch: SshHostsPatch): string[] {
  const base = sanitizeSshHosts(patch.sshAllowedHosts ?? current)
  const remove = new Set(sanitizeSshHosts(patch.sshAllowedHostsRemove ?? []))
  return sanitizeSshHosts([...base.filter((host) => !remove.has(host)), ...(patch.sshAllowedHostsAdd ?? [])])
}
