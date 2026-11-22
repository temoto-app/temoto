/**
 * TODO 982 (ARCHITECTURE 4.2.5 "drill"): a drill is one run of a Teammate with every outward or irreversible operation stopped and
 * recorded. Types that cross the main / renderer boundary. Every value here is decided by main; the renderer only displays them and sends
 * back the ids of the ops a person ticked (TODO 1292 item 2).
 */
import type { RoleGrantOffer } from './thread.js'

/** `ready` = created, nothing sent yet (one send is accepted). `ran` = the one run has been sent; no more sends. */
export type DrillState = 'ready' | 'ran'

/** What the target of a stopped operation is (display only). */
export type DrillTargetKind = 'path' | 'command' | 'url' | 'to' | 'setting' | 'tool'

/**
 * Why a stopped operation has no checkbox (no row of the Teammate's table can express it, or it would not help):
 *  - `outbound` / `persistence` / `side-effect` / `secret-read` / `deny-pattern` / `no-command` / `question` / `plan` / `unattended`
 *    = a stage 0 line or a line the table never lifts (4.2.5 "4." / 959 / 1042 / 1043 / 847 / stop patterns);
 *  - `gateway` = aios's own tools (no "always allow" for them);
 *  - `no-subject` = no row can be built for it (a tool that may write or read, a path that does not resolve, a too broad parent);
 *  - `secret` = the value holds a secret (no row keeps it);
 *  - `covered` = the table (or the quiet standard commands) already lets it through;
 *  - `unasked` = it never reached aios (the backend ran it itself), so there is nothing to allow.
 */
export type DrillGrantRefusal =
  | 'outbound'
  | 'persistence'
  | 'side-effect'
  | 'secret-read'
  | 'deny-pattern'
  | 'no-command'
  | 'question'
  | 'plan'
  | 'unattended'
  | 'gateway'
  | 'no-subject'
  | 'secret'
  | 'covered'
  | 'unasked'

export interface DrillOp {
  readonly id: string
  readonly at: number
  /** The tool name as the backend named it (shown as is, like the approval frame). */
  readonly toolName: string
  /** `stopped` = aios stopped and recorded it. `unasked` = the backend ran it without asking aios (its own settings let it through). */
  readonly origin: 'stopped' | 'unasked'
  /** The smallest thing that says what it tried: a path, a command (masked), a URL, a recipient, a setting name. */
  readonly target: { readonly kind: DrillTargetKind; readonly value: string } | null
  /** A message's subject (masked), when the operation sends one. */
  readonly subject: string | null
  /** The length of the body it would have written or sent (characters). The body itself is never kept. */
  readonly size: number | null
  /** What "allow from now on" would add for this op (display form). null = no checkbox (`grantRefusal` says why). */
  readonly grant: RoleGrantOffer['subjects'] | null
  readonly grantRefusal: DrillGrantRefusal | null
  /** Whether a person already allowed it from this list. */
  readonly granted: boolean
}

export interface DrillReport {
  readonly threadId: string
  readonly state: DrillState
  /** The Teammate the rows would be added to. null when the Teammate is gone (no checkbox then). */
  readonly roleId: string | null
  readonly roleName: string | null
  readonly ops: readonly DrillOp[]
}

/** The most ops kept per drill (a runaway loop must not fill the DB). Further stops are still stopped, only not listed. */
export const MAX_DRILL_OPS = 200
