/**
 * TODO 972 (ARCHITECTURE 4.3.4): the "Teammates" section of the scheduled-run view (a role is the extension of a job's settings, so it
 * lives next to the jobs and triggers). One row = name + how many conversations and scheduled runs it has. Pressing a row opens the
 * editor on the main side (`TeammateEditor`, the same place as the job editor); + adds one.
 */
import { useShallow } from 'zustand/react/shallow'
import type { Role } from '@shared/role.js'
import { useRoles } from '../roleStore.js'
import { useSchedule } from '../scheduleStore.js'
import { useThreads } from '../threadStore.js'
import { useT } from '../i18n/index.js'
import { Tooltip } from './Tooltip.js'
import { TeammateIcon } from '../icons/TeammateIcon.js'
import { ScheduleAddIcon } from '../icons/ScheduleAddIcon.js'

const NO_ROLES: readonly Role[] = []

export function TeammateSection(): React.JSX.Element {
  const t = useT()
  const roles = useRoles((state) => state.roles) ?? NO_ROLES
  const editing = useSchedule((state) => state.editing)
  const openRole = useSchedule((state) => state.openRole)
  const overview = useSchedule((state) => state.overview)
  // The number of conversations per role (an array of numbers, so `useShallow` keeps it while only a row's runtime moves).
  const counts = useThreads(
    useShallow((state) =>
      roles.map((role) => state.threadOrder.filter((id) => state.threadsById[id]?.thread.roleId === role.id).length)
    )
  )
  const jobCount = (roleId: string): number =>
    overview?.jobs.filter((job) => job.action.kind === 'prompt' && job.action.roleId === roleId).length ?? 0
  const adding = editing?.role !== undefined && editing.role.id === null
  return (
    <section className="teammate-section" aria-label={t('roles.section')}>
      <div className="schedule-panel-header trigger-section-header">
        <span className="schedule-panel-title trigger-section-title">
          <TeammateIcon size={12} />
          {t('roles.section')}
        </span>
        <Tooltip content={t('roles.add')}>
          <button
            type="button"
            className="icon-button teammate-add"
            aria-label={t('roles.add')}
            aria-pressed={adding}
            onClick={() => openRole(null)}
          >
            <ScheduleAddIcon />
          </button>
        </Tooltip>
      </div>
      {roles.length === 0 ? (
        <p className="schedule-panel-hint">{t('roles.empty')}</p>
      ) : (
        <ul className="schedule-items trigger-items" aria-label={t('roles.section')}>
          {roles.map((role, i) => {
            const selected = editing?.role?.id === role.id
            const jobs = jobCount(role.id)
            return (
              <li key={role.id} className={`schedule-item${selected ? ' selected' : ''}`} data-role={role.id}>
                <button
                  type="button"
                  className="schedule-item-main"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => openRole(role.id)}
                >
                  <span className="schedule-item-name">{role.name}</span>
                  <span className="schedule-item-meta">{t((counts[i] ?? 0) === 1 ? 'roles.conversations.one' : 'roles.conversations.other', { count: counts[i] ?? 0 })}</span>
                  {jobs === 0 ? null : <span className="schedule-item-meta">{t(jobs === 1 ? 'roles.jobs.one' : 'roles.jobs.other', { count: jobs })}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
