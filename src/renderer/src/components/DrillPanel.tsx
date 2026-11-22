/**
 * TODO 982 / 1292 item 2: the drill band above the Composer of a drill conversation (ARCHITECTURE 4.2.5 "drill"). Before the run it says
 * what a drill does; during and after the run it lists what was stopped (tool, target, subject, body length - never the body) and the calls
 * the backend ran without asking aios. After the run each op that the Teammate's table can express has a checkbox, and "Allow the selected
 * from now on" sends **only the ids** - main re-reads the rows it decided itself and adds them to the Teammate's table (`role:<id>`).
 * An op of a kind the table never lifts (sending out 959, persistence, secrets, side effects, aios's own tools) has no checkbox and says why.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DrillGrantRefusal, DrillOp, DrillReport, DrillState } from '@shared/drill.js'
import { describeReason, useT, type MessageKey, type Translate } from '../i18n/index.js'
import { roleSubjectLabel } from './ApprovalPrompt.js'
import { redactText } from '@shared/redact.js'
import { useThreads } from '../threadStore.js'

const REFUSAL_KEYS: Readonly<Record<DrillGrantRefusal, MessageKey>> = {
  outbound: 'drill.refusal.outbound',
  persistence: 'drill.refusal.persistence',
  'side-effect': 'drill.refusal.sideEffect',
  'secret-read': 'drill.refusal.secretRead',
  'deny-pattern': 'drill.refusal.denyPattern',
  'no-command': 'drill.refusal.noCommand',
  question: 'drill.refusal.other',
  plan: 'drill.refusal.other',
  unattended: 'drill.refusal.gateway',
  gateway: 'drill.refusal.gateway',
  'no-subject': 'drill.refusal.noSubject',
  secret: 'drill.refusal.secret',
  covered: 'drill.refusal.covered',
  unasked: 'drill.refusal.unasked'
}

export function DrillPanel({ threadId, state, running }: { threadId: string; state: DrillState; running: boolean }): React.JSX.Element {
  const t = useT()
  const [report, setReport] = useState<DrillReport | null>(null)
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const load = useCallback(() => {
    const mine = ++seq.current
    void window.aios.drills.report(threadId).then(
      (next) => {
        if (mine === seq.current) setReport(next)
      },
      () => undefined
    )
  }, [threadId])

  useEffect(() => {
    setReport(null)
    setChecked(new Set())
    setError(null)
    load()
    return () => {
      seq.current += 1
    }
  }, [load])
  // A stop recorded in main, and the end of the run (the calls that never reached aios are found from the saved tool calls).
  useEffect(() => window.aios.drills.onChanged((id) => (id === threadId ? load() : undefined)), [threadId, load])
  useEffect(() => {
    if (!running) load()
  }, [running, state, load])

  const ops = report?.ops ?? []
  const grantable = ops.filter((op) => op.grant !== null)
  const selected = grantable.filter((op) => checked.has(op.id))
  const finished = state === 'ran' && !running

  const toggle = (id: string, on: boolean): void => {
    const next = new Set(checked)
    if (on) next.add(id)
    else next.delete(id)
    setChecked(next)
  }

  const grant = async (): Promise<void> => {
    if (selected.length === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      setReport(await window.aios.drills.grant(threadId, selected.map((op) => op.id)))
      setChecked(new Set())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const stopped = ops.filter((op) => op.origin === 'stopped').length
  const headline =
    state === 'ready' ? t('drill.ready') : running ? t('drill.running', { count: stopped }) : t('drill.done', { count: stopped })

  return (
    <div className="drill-panel" role="region" aria-label={t('drill.title')}>
      <p className="drill-headline">
        <span className="drill-badge">{t('drill.title')}</span> {headline}
      </p>
      {ops.length === 0 ? null : (
        <ul className="drill-ops">
          {ops.map((op) => (
            <DrillRow key={op.id} op={op} t={t} checked={checked.has(op.id)} enabled={finished && !busy} onToggle={toggle} />
          ))}
        </ul>
      )}
      {finished && grantable.length > 0 && report?.roleName != null ? (
        <div className="drill-actions">
          <button type="button" disabled={busy || selected.length === 0} onClick={() => void grant()}>
            {t('drill.grant', { name: report.roleName })}
          </button>
          <span className="hint">{t('drill.grantHint')}</span>
        </div>
      ) : null}
      {finished && report !== null && report.roleId === null && stopped > 0 ? <p className="hint">{t('drill.roleGone')}</p> : null}
      {error === null ? null : <p className="denied">{describeReason(t, error)}</p>}
    </div>
  )
}

function DrillRow({
  op,
  t,
  checked,
  enabled,
  onToggle
}: {
  op: DrillOp
  t: Translate
  checked: boolean
  enabled: boolean
  onToggle: (id: string, on: boolean) => void
}): React.JSX.Element {
  // Values were masked in main; masked again for display (item 286).
  const target = op.target === null ? null : redactText(op.target.value).text
  const subject = op.subject === null ? null : redactText(op.subject).text
  const grantLabel = op.grant === null ? null : op.grant.map((subjectRow) => roleSubjectLabel(subjectRow, t)).join(', ')
  return (
    <li className={op.origin === 'unasked' ? 'drill-op unasked' : 'drill-op'}>
      {op.grant !== null ? (
        <input
          type="checkbox"
          checked={checked}
          disabled={!enabled}
          aria-label={t('drill.select', { value: grantLabel ?? op.toolName })}
          onChange={(event) => onToggle(op.id, event.target.checked)}
        />
      ) : (
        <span className="drill-op-mark" aria-hidden="true" />
      )}
      <span className="approval-tool">{op.toolName}</span>
      {target === null ? null : (
        <span className="drill-op-target" title={target}>
          {target}
        </span>
      )}
      {subject === null ? null : <span className="drill-op-meta">{t('drill.subject', { value: subject })}</span>}
      {op.size === null ? null : <span className="drill-op-meta">{t('drill.size', { count: op.size })}</span>}
      <span className="drill-op-note">
        {op.granted
          ? t('drill.granted')
          : op.origin === 'unasked'
            ? t('drill.unasked')
            : grantLabel !== null
              ? t('drill.wouldAllow', { value: grantLabel })
              : op.grantRefusal === null
                ? null
                : t(REFUSAL_KEYS[op.grantRefusal])}
      </span>
    </li>
  )
}

/**
 * TODO 982: the "Drill" button (the Teammate editor; a prompt job's summary when the job belongs to a Teammate). No confirmation dialog
 * (owner decision: few dialogs); the hint next to it says the run uses the real model. With a job, main sends the job's own prompt; without
 * one, the new conversation waits for the one message the person types.
 */
export function DrillButton({ roleId, jobId, disabled }: { roleId: string; jobId: string | null; disabled?: boolean }): React.JSX.Element {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const id = await window.aios.drills.start(roleId, jobId)
      await useThreads.getState().selectThread(id)
      if (jobId === null) useThreads.setState({ composerFocus: id })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button type="button" disabled={busy || disabled === true} title={t('drill.startHint')} onClick={() => void start()}>
        {t('drill.start')}
      </button>
      {error === null ? null : <span className="denied">{describeReason(t, error)}</span>}
    </>
  )
}
