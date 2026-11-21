/**
 * Shows pending approvals **in the Composer's place** (item 182, wave 14 bundle C, ARCHITECTURE.md 4.2 / 5.4).
 *
 * Item 166 moved multiple-choice questions into the Composer's place. In the CLI and VS Code, permission requests and plan approval
 * also appear in the prompt box's place and replace the input, so this follows that: if the thread has pending approvals,
 * **only the oldest one** is shown (the CLI also goes one at a time) and the rest are shown only as a count. The Composer is hidden with `hidden`.
 * The former approval frame (`ApprovalInbox`, stacking all items right above the Composer) is gone.
 *
 * The shape was read from the CLI 2.1.280 binary and the VS Code extension 2.1.283 webview (`docs/notes/wave14.md`):
 *
 * - **Permission request**: under the heading asking whether to proceed (the CLI's `Do you want to proceed?`) are numbered rows:
 *   1 allow / `2. Always allow` / 3 deny (the CLI's `Yes` / `Yes, and don't ask again for …` /
 *   `No`). The deny row is itself an input (VS Code's `Tell … what to do instead`, the shape of the CLI's `No` input);
 *   writing text and pressing Enter declines with "do this instead", and choosing it while empty declines as "stop and wait".
 * - **Plan approval** (item 256; wave 15 bundle F made it the same three choices as the CLI): under the plan (Markdown) are
 *   `1. Yes, auto-accept edits` (the previous "go ahead", i.e. the default that raises almost no approvals) /
 *   `2. Yes, manually approve edits` (go ahead and **put that thread in strict mode**; main sees `allow-manual` and switches) /
 *   `3. No, keep planning` (+ the input `Tell … what to change`, the previous "fix this"). The wording is English copied from CLI 2.1.280
 *   (`docs/notes/wave15.md`). "keep planning" cannot be sent empty.
 * - **Esc and the stop button mean "deny + abort"**. In the CLI's permission screen, Esc denies and stops the turn (cancelAndAbort).
 *   In aios, stopping (`threads.interrupt`, items 96 / 161) first cancels the pending approval and then aborts,
 *   so we call that. The stop button is placed on the bottom row in place of the hidden Composer.
 * - "View diff" (item 97) and "Details" (the raw arguments) are placed inside the permission screen (the CLI shows the diff inside its permission screen).
 * - Multiple-choice questions use `QuestionPrompt` (same place, same frame shape).
 * - **Outbound operations** (TODO 959, `item.outbound`): the heading gets an "outbound" badge, and the body shows the destination, subject and body (the whole command for a shell)
 *   already expanded (so it cannot be pressed without reading what is being sent). `Always allow` is not shown (main makes no rule either).
 * - **Why we are asking** (TODO 994, `item.reason`): one line above the body (for example "this thread is in strict mode (turn off with the menu)").
 * - **Bash in strict mode** (TODO 994, `canAllowForThread`): after `Deny` (the 4th row) we add a row "do not ask about <target> in this conversation"
 *   (wave 91 983 stage 3: the target is what main decided: the head word of the Bash command, the path of a write, or the name of a read-only tool. The renderer only returns `allow-thread`)
 *   (as one row, not a dropdown. The numbers 1-3 are the same as in the other frames). For `Always allow` on a tool name alone in a strict-mode frame, the hint
 *   says "it has no effect in strict mode" (main does not look at rules on a tool name alone in strict mode).
 * - **Role conversations** (TODO 983, `canAllowForRole`, 5. of 4.2.5): in the frame of a scheduled job's conversation, instead of the 994 row, after `Deny` there is
 *   "allow this role (<job name>) from now on: <value>", with a small expiry selector to the right of that row (default "forever" / today only / this conversation only).
 *   The value was decided by main when it queued the item; only the expiry is sent (`allow-role`).
 * - **ssh / scp / sftp / rsync destinations** (TODO 1029, `canAllowHost`): when the only thing missing is the host in the "do not ask" connection targets, we put
 *   "do not ask about this host from now on (<host>)" at the **end**. Choosing it makes main add it to the "do not ask" connection targets in settings.
 *
 * - **Paths outside the working folder** (TODO 1020, `EXTERNAL_DIRECTORY_TOOL`): the heading becomes "outside the working folder" and the body
 *   "path outside the working folder: ...". The name is aios's neutral one; which backend's what it stands for is in the compat table.
 *
 * **The renderer does not look at backend tool names** (it branches on `item.plan` / `item.questions` / `item.diffable`).
 * The route that sends the decision (`window.aios.approvals.decide`) and the validation of the content (main's `asDecision` / Broker) are unchanged.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ROLE_GRANT_SCOPES,
  canAllowForRole,
  canAllowForThread,
  canAllowHost,
  asksEveryTime,
  canAlwaysAllow,
  isRoleGrantScope,
  type ApprovalDiffFailure,
  type ApprovalItem,
  type OutboundDetail,
  type RoleGrantOffer,
  type RoleGrantScope
} from '@shared/thread.js'
import { renderMarkdown } from '@shared/markdown/render.js'
import { useStore } from '../store.js'
import { useThreads } from '../threadStore.js'
import { formatHeld } from '../thread/timeline.js'
import { moveCursor, questionKeyAction } from '../question-keys.js'
import { useT, type Translate } from '../i18n/index.js'
import { approvalReasonMessage } from '../approval-reason.js'
import { useSchedule } from '../scheduleStore.js'
import { Composer } from './Composer.js'
import { QuestionPrompt } from './QuestionPrompt.js'
import { ToolInput } from './ToolInput.js'
import { redactText } from '@shared/redact.js'
import { EXTERNAL_DIRECTORY_TOOL, externalDirectoryPath } from '@shared/approval-tools.js'
import { PROMPT_STALE_MS, SubtaskLabel, useHeld, usePromptFrame } from './PromptParts.js'

/**
 * The Composer's place. If the thread has pending approvals (a question, a plan, or a permission request), shows the oldest one and
 * hides the Composer.
 *
 * The Composer is made `hidden` rather than removed. If it were removed, the Model / Thinking selection (the Composer's state) would
 * revert to the thread's values after answering. The draft, attachments and queued messages live in the store, so they survive either way.
 */
export function ApprovalOrComposer({ threadId }: { threadId: string }): React.JSX.Element {
  // Do not filter in the selector (it would be a new array every time and useSyncExternalStore would loop).
  const all = useThreads((state) => state.approvals)
  const mine = useMemo(() => all.filter((item) => item.threadId === threadId), [all, threadId])
  const first = mine[0] ?? null
  const waiting = mine.length - 1
  return (
    <>
      {first === null ? null : first.questions !== null ? (
        <QuestionPrompt item={first} waiting={waiting} />
      ) : (
        <ApprovalPrompt item={first} waiting={waiting} />
      )}
      <Composer threadId={threadId} hidden={first !== null} />
    </>
  )
}

/** The contents of a row. An `input` row is the input field itself (deny / "do this instead"). */
interface PromptRow {
  readonly key: 'allow' | 'always' | 'thread' | 'role' | 'host' | 'deny' | 'proceed' | 'manual' | 'revise'
  readonly label: string
  readonly title?: string
  readonly input?: { readonly placeholder: string; readonly aria: string }
}

export function ApprovalPrompt({
  item,
  waiting
}: {
  item: ApprovalItem
  /** The number of approvals waiting behind this one in this thread. */
  waiting: number
}): React.JSX.Element {
  // When the request changes, rebuild all state (the cursor and field belong to the previous request).
  return <PromptForm key={item.id} item={item} waiting={waiting} />
}

function PromptForm({ item, waiting }: { item: ApprovalItem; waiting: number }): React.JSX.Element {
  const t = useT()
  const decide = useThreads((state) => state.decide)
  const interrupt = useThreads((state) => state.interrupt)
  const [cursor, setCursor] = useState(0)
  const [text, setText] = useState('')
  const [sent, setSent] = useState(false)
  const [details, setDetails] = useState(false)
  // TODO 983: the expiry of "allow this role from now on". The default is "forever" (5. of 4.2.5).
  const [roleScope, setRoleScope] = useState<RoleGrantScope>('forever')
  const frameRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const held = useHeld(item.requestedAt)
  const plan = item.plan === undefined ? null : item.plan
  const outbound = item.outbound ?? null
  usePromptFrame(frameRef)

  const rows: readonly PromptRow[] = useMemo(() => {
    if (plan !== null) {
      return [
        { key: 'proceed', label: t('approval.planProceed'), title: t('approval.planProceedHint') },
        { key: 'manual', label: t('approval.planManual'), title: t('approval.planManualHint') },
        {
          key: 'revise',
          label: t('approval.planRevise'),
          title: t('approval.planReviseHint'),
          input: { placeholder: t('approval.planFeedbackPlaceholder'), aria: t('approval.planRevise') }
        }
      ]
    }
    const list: PromptRow[] = [{ key: 'allow', label: t('approval.allow') }]
    const strict = item.reason?.kind === 'strict'
    // Outbound operations (TODO 959) and lingering writes (TODO 1042) do not become rules: read them and press each time.
    if (canAlwaysAllow(item.toolName) && !asksEveryTime(item)) {
      list.push({
        key: 'always',
        label: t('approval.always'),
        // T40: a rule applies app-wide. Only Bash is per command. A rule on a tool name alone has no effect in strict mode (TODO 994).
        title:
          item.toolName === 'Bash'
            ? t('approval.alwaysCommandHint')
            : strict
              ? t('approval.alwaysToolStrictHint')
              : t('approval.alwaysToolHint')
      })
    }
    list.push({
      key: 'deny',
      label: t('approval.deny'),
      title: t('approval.denyHint'),
      input: { placeholder: t('approval.denyPlaceholder'), aria: t('approval.deny') }
    })
    // Only Bash in strict mode: do not ask about Bash for the rest of this conversation (TODO 994, not saved). Placed **after** deny —
    // so the numbers of allow / Always allow / deny (1 / 2 / 3) stay the same as in other frames (inserting it before would turn a "3 to deny" into a broad allow).
    if (canAllowForThread(item)) {
      list.push({
        key: 'thread',
        label: t('approval.allowThread', {
          subject: (item.threadGrant?.subjects ?? []).map((subject) => roleSubjectLabel(subject, t)).join(', ')
        }),
        title: t('approval.allowThreadHint')
      })
    }
    // TODO 983: in a role conversation (a Teammate's, or a scheduled job's), "allow this role from now on" replaces the 994 row (the value is what main decided). Placed after deny.
    // Stage 4: the wording follows whose row a press adds (one row only - a Teammate's job run offers the Teammate's row, not both).
    if (canAllowForRole(item) && item.roleGrant != null) {
      const teammate = item.roleGrant.roleKind === 'teammate'
      list.push({
        key: 'role',
        label: t(teammate ? 'approval.allowRoleTeammate' : 'approval.allowRole', {
          role: item.roleGrant.roleName,
          subject: item.roleGrant.subjects.map((subject) => roleSubjectLabel(subject, t)).join(', ')
        }),
        title: t(teammate ? 'approval.allowRoleTeammateHint' : 'approval.allowRoleHint')
      })
    }
    // TODO 1029: for ssh / scp / sftp / rsync where the only thing missing is the host in the "do not ask" connection targets. Placed at the **end** —
    // the numbers and order of the existing rows (1. allow / 2. deny) do not change (wave 52 review, same reason as 994).
    if (canAllowHost(item)) {
      list.push({
        key: 'host',
        label: t('approval.allowHost', { host: (item.quietHosts ?? []).join(', ') }),
        title: t('approval.allowHostHint')
      })
    }
    return list
  }, [plan, item, t])
  // TODO 1015: strictness in a thread started by a scheduled job comes from the job's setting. The frame can jump to editing the job.
  const scheduledJobId = useThreads((state) => state.threadsById[item.threadId]?.thread.scheduledJobId)
  const scheduledJob = useSchedule((state) =>
    scheduledJobId === undefined ? undefined : state.overview?.jobs.find((job) => job.id === scheduledJobId)
  )
  const openJobEditor = useSchedule((state) => state.openEditor)
  const jobRef = scheduledJob === undefined ? null : { id: scheduledJob.id, name: scheduledJob.name, approvalStrict: scheduledJob.action.kind === 'prompt' && scheduledJob.action.approvalStrict }
  const reason = plan === null ? approvalReasonMessage(item, jobRef) : null
  const inputRow = rows.findIndex((row) => row.input !== undefined)

  const send = (decision: Parameters<typeof decide>[1]): void => {
    if (sent) return
    setSent(true)
    // Restore it so it can be pressed again if it did not arrive (if it arrives, the request disappears and this component is removed).
    decide(item.id, decision).catch(() => setSent(false))
  }
  /** Esc / stop button: deny and abort (stopping first cancels the pending approval, items 96 / 161). */
  const stop = (): void => {
    if (sent) return
    setSent(true)
    interrupt(item.threadId).catch(() => setSent(false))
  }
  const commitText = (): void => {
    const body = text.trim()
    if (plan !== null) {
      // "Do this instead" needs an instruction (an empty denial would mean "discard the plan and stop").
      if (body !== '') send({ kind: 'deny', message: body })
      return
    }
    // Permission denial: if something is written, "do this instead"; if empty, "stop and wait" (the default text of item 183).
    send(body === '' ? { kind: 'deny' } : { kind: 'deny', message: body })
  }
  const chooseRow = (index: number): void => {
    const row = rows[index]
    if (row === undefined) return
    setCursor(index)
    switch (row.key) {
      case 'allow':
      case 'proceed':
        send({ kind: 'allow' })
        return
      case 'manual':
        // "Yes, manually approve edits" (item 256): passes the plan, and main puts that thread in strict mode.
        send({ kind: 'allow-manual' })
        return
      case 'always':
        send({ kind: 'allow-always' })
        return
      case 'thread':
        send({ kind: 'allow-thread' })
        return
      case 'role':
        send({ kind: 'allow-role', scope: roleScope })
        return
      case 'host':
        send({ kind: 'allow-host' })
        return
      case 'deny':
      case 'revise':
        // Enter the field (if the cursor is already on this row the effect does not run, so move here too).
        // A permission denial can be declined as is by choosing it with Enter / the number key while the field is empty.
        if (document.activeElement === textRef.current) commitText()
        else textRef.current?.focus()
        return
    }
  }

  // When the cursor lands on the field's row, enter the field; when it leaves, return to the list (same behavior as the question's "Other").
  const onInput = cursor === inputRow
  useLayoutEffect(() => {
    if (onInput) textRef.current?.focus({ preventScroll: false })
    else if (document.activeElement === textRef.current) frameRef.current?.focus({ preventScroll: true })
  }, [onInput])

  const hover = (index: number): void => {
    if (document.activeElement !== textRef.current) setCursor(index)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const textarea = textRef.current
    const inText = event.target === textarea && textarea !== null
    // Leave Enter / Space on a button to the button itself. Only Esc is caught.
    if (!inText && event.target !== frameRef.current && event.key !== 'Escape') return
    const action = questionKeyAction(event.nativeEvent, {
      numbered: rows.length,
      inText,
      caretAtStart: inText && textarea.selectionStart === 0 && textarea.selectionEnd === 0,
      caretAtEnd: inText && textarea.selectionStart === textarea.value.length
    })
    // 'submit' (⌘Enter) is an operation only for the question screen (895). Do nothing here.
    if (action.kind === 'none' || action.kind === 'submit') return
    event.preventDefault()
    event.stopPropagation()
    switch (action.kind) {
      case 'cancel':
        stop()
        return
      case 'leaveText':
        frameRef.current?.focus({ preventScroll: true })
        return
      case 'commitText':
        commitText()
        return
      case 'move':
        setCursor(moveCursor(cursor, action.delta, rows.length))
        return
      case 'choose':
        chooseRow(action.row)
        return
      case 'activate':
        chooseRow(cursor)
        return
    }
  }

  return (
    <div className="question-prompt approval-prompt" role="region" aria-label={t('approval.region')}>
      <div
        ref={frameRef}
        className={`question-frame${held > PROMPT_STALE_MS ? ' stale' : ''}`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        aria-activedescendant={`a-${item.id}-${cursor}`}
      >
        <SubtaskLabel item={item} />
        <div className="question-top">
          <span className="question-kind">
            {plan !== null
              ? t('approval.plan')
              : item.toolName === EXTERNAL_DIRECTORY_TOOL
                ? t('approval.externalDirectoryKind')
                : item.toolName}
          </span>
          {outbound === null ? null : (
            <span className="approval-outbound-badge" title={t('approval.outboundHint')}>
              {t('approval.outboundBadge')}
            </span>
          )}
          {waiting > 0 ? <span className="question-waiting">{t('approval.waiting', { count: waiting })}</span> : null}
          <span className="approval-held" title={t('approval.heldHint')}>
            {formatHeld(held, t)}
          </span>
        </div>

        <div className="question-body">
          {reason === null ? null : (
            <p className="approval-reason">
              {t(reason.key, reason.params)}
              {reason.key === 'approval.reason.strictScheduled' && jobRef !== null ? (
                <button type="button" className="link-button" onClick={() => openJobEditor(jobRef.id)}>
                  {t('approval.reason.editJob')}
                </button>
              ) : null}
            </p>
          )}
          {plan !== null ? (
            <>
              <p className="approval-plan-heading">{t('approval.planHeading')}</p>
              <PlanBody plan={plan} />
            </>
          ) : (
            <PermissionBody item={item} details={details} />
          )}
          <p className="question-text">
            {plan !== null
              ? t('approval.planProceedQuestion')
              : outbound !== null
                ? t('approval.outboundProceed')
                : t('approval.proceed')}
          </p>
          <div className="question-choices" role="listbox" aria-label={t('approval.region')}>
            {rows.map((row, index) => (
              <div
                key={row.key}
                id={`a-${item.id}-${index}`}
                role="option"
                aria-selected={false}
                title={row.title}
                className={`question-choice${cursor === index ? ' active' : ''}${row.input === undefined ? '' : ' other'}`}
                onMouseDown={row.input === undefined ? (event) => event.preventDefault() : undefined}
                onClick={row.input === undefined ? () => chooseRow(index) : () => setCursor(index)}
                onMouseEnter={() => hover(index)}
              >
                <span className="question-pointer" aria-hidden="true">
                  {cursor === index ? '›' : ''}
                </span>
                <span className="question-num">{index + 1}.</span>
                <span className="question-choice-body">
                  <span className="question-label">{row.label}</span>
                  {row.key === 'role' ? (
                    // The small expiry selector (5. of 4.2.5). Pressing it does not select the row (the rest of the row and the number key select the row).
                    <select
                      className="approval-role-scope"
                      value={roleScope}
                      aria-label={t('approval.roleScope')}
                      onClick={(event) => event.stopPropagation()}
                      onMouseDown={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                      onChange={(event) => {
                        const value = event.target.value
                        if (isRoleGrantScope(value)) setRoleScope(value)
                      }}
                    >
                      {ROLE_GRANT_SCOPES.map((scope) => (
                        <option key={scope} value={scope}>
                          {t(`approval.roleScope.${scope}`)}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  {row.input === undefined ? null : (
                    <textarea
                      ref={textRef}
                      className="question-other-input"
                      value={text}
                      placeholder={row.input.placeholder}
                      aria-label={row.input.aria}
                      rows={1}
                      onFocus={() => setCursor(index)}
                      onChange={(event) => setText(event.target.value)}
                    />
                  )}
                </span>
              </div>
            ))}
          </div>
          {plan === null ? (
            <div className="approval-links">
              {item.diffable === true ? <DiffButton item={item} /> : null}
              <button type="button" className="link" onClick={() => setDetails(!details)}>
                {details ? t('common.close') : t('approval.details')}
              </button>
            </div>
          ) : null}
        </div>

        <div className="question-actions">
          <span className="question-keys">{t('approval.keys')}</span>
          <button
            type="button"
            className="approval-stop"
            disabled={sent}
            onClick={stop}
            title={t('approval.stopHint')}
            aria-label={t('approval.stop')}
          >
            <span className="approval-stop-glyph" aria-hidden="true" /> {t('approval.stop')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Turns one of the targets of "allow this role from now on" into a sentence (TODO 983). The value already went through redaction in main. It also goes through it for display (item 286). */
function roleSubjectLabel(subject: RoleGrantOffer['subjects'][number], t: Translate): string {
  const value = redactText(subject.value).text
  switch (subject.kind) {
    case 'command-prefix':
      return t('approval.roleSubject.commandPrefix', { value })
    case 'path-prefix':
      return t(subject.access === 'write' ? 'approval.roleSubject.pathWrite' : 'approval.roleSubject.pathRead', { value })
    case 'host':
      return t('approval.roleSubject.host', { value })
    case 'command-exact':
    case 'tool':
      return value
  }
}

/** The body of a permission request: what it does (a summary) and, when opened, the arguments (in a readable form per item 286). */
function PermissionBody({ item, details }: { item: ApprovalItem; details: boolean }): React.JSX.Element {
  const t = useT()
  const outbound = item.outbound ?? null
  // Confirmation of a path outside the working folder (TODO 1020): instead of the summary, "path outside the working folder: ...".
  const outside = item.toolName === EXTERNAL_DIRECTORY_TOOL ? externalDirectoryPath(item.input) : null
  if (outside !== null) {
    return (
      <>
        <p className="approval-command" title={redactText(outside).text}>
          {t('approval.externalDirectory', { path: redactText(outside).text })}
        </p>
        {details ? <ToolInput input={item.input} className="approval-input" /> : null}
      </>
    )
  }
  return (
    <>
      {outbound === null ? null : <OutboundBody outbound={outbound} />}
      {/* Main sends the approval request without redaction (only the saving entry point applies it). It also goes through it for display (item 286). */}
      {item.summary === '' || outbound?.channel === 'shell' ? null : (
        <p className="approval-command" title={redactText(item.summary).text}>
          {redactText(item.summary).text}
        </p>
      )}
      {/* A readable form rather than raw JSON (item 286, the same formatting as the timeline's tool blocks). */}
      {details ? <ToolInput input={item.input} className="approval-input" /> : null}
    </>
  )
}

/**
 * The body of an outbound operation (TODO 959). For a shell, the whole command; for a tool, the destination, subject and body. Fields that could not be extracted are not shown,
 * and if there are none, a note says to look at "Details" (the raw arguments). Redaction also applies for display (same as item 286).
 */
function OutboundBody({ outbound }: { outbound: OutboundDetail }): React.JSX.Element {
  const t = useT()
  if (outbound.channel === 'shell') {
    return <pre className="approval-outbound-command">{redactText(outbound.command ?? '').text}</pre>
  }
  const rows: { key: string; label: string; value: string }[] = []
  if (outbound.to !== null) rows.push({ key: 'to', label: t('approval.outboundTo'), value: outbound.to })
  if (outbound.subject !== null) rows.push({ key: 'subject', label: t('approval.outboundSubject'), value: outbound.subject })
  if (outbound.body !== null) rows.push({ key: 'body', label: t('approval.outboundBody'), value: outbound.body })
  if (rows.length === 0) return <p className="approval-outbound-empty">{t('approval.outboundNoFields')}</p>
  return (
    <dl className="approval-outbound">
      {rows.map((row) => (
        <div key={row.key} className={`approval-outbound-row approval-outbound-${row.key}`}>
          <dt>{row.label}</dt>
          <dd>{redactText(row.value).text}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The plan (item 112 / 4.2.3). Drawn the same way as the body (markdown-it + DOMPurify); scrolls inside when long. */
function PlanBody({ plan }: { plan: string }): React.JSX.Element {
  const t = useT()
  const html = useMemo(() => renderMarkdown(plan).html, [plan])
  if (plan.trim() === '') return <p className="approval-plan-empty">{t('approval.planEmpty')}</p>
  return (
    <div
      className="markdown approval-plan"
      dangerouslySetInnerHTML={{ __html: html }}
      // So that the renderer does not navigate on a link in the plan (opening is the body side's job).
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('a') !== null) event.preventDefault()
      }}
    />
  )
}

/**
 * "View diff" (item 97 / 7.6.4). Has main build the before and after, and shows it in ViewerPane's temporary view (item 104).
 * When it could not be applied to the whole file (`fragment`) or could not be shown, a note is shown next to the button.
 */
function DiffButton({ item }: { item: ApprovalItem }): React.JSX.Element {
  const t = useT()
  const openDiff = useStore((state) => state.openDiff)
  const [note, setNote] = useState<'fragment' | ApprovalDiffFailure | null>(null)
  const [loading, setLoading] = useState(false)
  const open = (): void => {
    setLoading(true)
    void window.aios.approvals
      .diff(item.id)
      .then(
        (diff) => {
          if (!diff.ok) {
            setNote(diff.reason)
            return
          }
          setNote(diff.basis === 'fragment' ? 'fragment' : null)
          openDiff({ before: { name: diff.name, text: diff.before }, after: { name: diff.name, text: diff.after } })
        },
        () => setNote('gone')
      )
      .finally(() => setLoading(false))
  }
  return (
    <>
      <button type="button" className="link" disabled={loading} onClick={open}>
        {t('approval.diff')}
      </button>
      {note === null ? null : <span className="approval-diff-note">{t(`approval.diffNote.${note}`)}</span>}
    </>
  )
}
