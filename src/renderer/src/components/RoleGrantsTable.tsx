/**
 * "What this job is allowed" in the scheduled-job editor (TODO 983 stage 2, item 7 of ARCHITECTURE 4.2.5).
 *
 * One row = tool, target, expiry, creation time, last use time and count, and a remove mark. The remove mark deletes without confirmation (it narrows the grant).
 * There is no entry point to add one (the source is "allow this role from now on" in the approval frame). Main sweeps expired rows before returning them.
 * The table is owned by main's `approvals.roleGrants`; this component does not keep one (it re-fetches when the approval list changes).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RoleGrantView } from '@shared/thread.js'
import { useT, type Translate } from '../i18n/index.js'
import { formatWhen } from '../thread/timeline.js'

const NO_GRANTS: readonly RoleGrantView[] = []

export function RoleGrantsTable({ jobId }: { jobId: string }): React.JSX.Element {
  const t = useT()
  const roleKey = `job:${jobId}`
  const [grants, setGrants] = useState<readonly RoleGrantView[]>(NO_GRANTS)
  // A mark per request. A reply that comes back after the job changed, or later than a request issued afterward, is discarded (so a mismatch never shows the previous job's table).
  const requestSeq = useRef(0)
  const load = useCallback((): void => {
    requestSeq.current += 1
    const seq = requestSeq.current
    void window.aios.approvals.roleGrants(roleKey).then((rows) => {
      if (seq === requestSeq.current) setGrants(rows)
    })
  }, [roleKey])
  useEffect(() => {
    setGrants(NO_GRANTS)
    load()
    return () => {
      requestSeq.current += 1
    }
  }, [load])
  // Re-fetch when a grant is added (a press in the approval frame) or used (a use record). A change in the approval list is the signal.
  useEffect(() => window.aios.approvals.onChanged(load), [load])

  return (
    <section className="approval-rules role-grants" aria-label={t('roleGrants.title')}>
      <h2 className="role-grants-title">{t('roleGrants.title')}</h2>
      {grants.length === 0 ? (
        <p className="hint">{t('roleGrants.empty')}</p>
      ) : (
        <ul>
          {grants.map((grant) => (
            <li key={grant.id}>
              <span className="approval-tool">{grant.toolName}</span>
              <span className="approval-summary" title={grantTarget(grant, t)}>
                {grantTarget(grant, t)}
              </span>
              <span className="approval-when">{grantScope(grant, t)}</span>
              <span className="approval-when" title={new Date(grant.createdAt).toLocaleString()}>
                {t('roleGrants.created', { when: formatWhen(grant.createdAt, t) })}
              </span>
              <span className="approval-when">
                {grant.lastUsedAt === null
                  ? t('roleGrants.neverUsed')
                  : t('roleGrants.used', { when: formatWhen(grant.lastUsedAt, t), count: grant.useCount })}
              </span>
              <button
                type="button"
                className="link"
                title={t('roleGrants.removeHint')}
                aria-label={t('roleGrants.remove')}
                onClick={() => void window.aios.approvals.removeRoleGrant(roleKey, grant.id).then(load)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function grantTarget(grant: RoleGrantView, t: Translate): string {
  if (grant.value === null) return t('roleGrants.target.tool')
  switch (grant.kind) {
    case 'command-prefix':
      return t('roleGrants.target.prefix', { value: grant.value })
    case 'path-prefix':
      return t(grant.access === 'write' ? 'roleGrants.target.pathWrite' : 'roleGrants.target.pathRead', { value: grant.value })
    default:
      return grant.value
  }
}

function grantScope(grant: RoleGrantView, t: Translate): string {
  // A "today only" row lasts until 0:00 of the day after it was pressed, and expired rows are not returned, so a visible row is always "until 23:59 today".
  if (grant.scope === 'today') return t('roleGrants.scope.today')
  if (grant.scope === 'thread') {
    return grant.threadTitle === null ? t('roleGrants.scope.thread') : t('roleGrants.scope.threadNamed', { title: grant.threadTitle })
  }
  return t('roleGrants.scope.forever')
}
