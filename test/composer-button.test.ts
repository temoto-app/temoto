/**
 * The button at the right end of the prompt field (items 154 / 156 / 161). Pure functions that depend on neither the DOM nor React.
 * Checks: state -> the role of the primary button (`composerButtonKind`), the judgment of whether it can be pressed (`composerButtonDisabled` /
 * `composerSideButtons` / `composerSendEmpty`), reservation and interrupt shown only while responding (`composerSideButtons`), and the cases for the placeholder
 * (`composerPlaceholderKind`).
 *
 * Item 161 (qlm's spec): the primary button serves as both send and stop, and **while responding, stop comes before anything else**. Stop can be pressed
 * at any time. Reservation is not piggybacked on the primary button; it is a separate button (this overrides "reservation is a clock shape" in item 154).
 */
import { describe, expect, it } from 'vitest'
import {
  composerButtonDisabled,
  composerButtonKind,
  composerButtonLabelKey,
  composerPlaceholderKey,
  composerPlaceholderKind,
  composerSendEmpty,
  composerSideButtons,
  composerStopLocked,
  composerSubmitAction,
  STOP_LOCK_MS,
  type ComposerButtonKind
} from '../src/renderer/src/composer-button.js'

describe('composerButtonKind (items 154 / 161)', () => {
  it('send normally', () => {
    expect(composerButtonKind({ sending: false, busy: false, shellDraft: false })).toBe('send')
  })
  it('`!` input is shellRun', () => {
    expect(composerButtonKind({ sending: false, busy: false, shellDraft: true })).toBe('shellRun')
  })
  it('stop while responding; takes priority over a `!` draft (does not remove the stop entry point)', () => {
    expect(composerButtonKind({ sending: false, busy: true, shellDraft: false })).toBe('stop')
    expect(composerButtonKind({ sending: false, busy: true, shellDraft: true })).toBe('stop')
  })
  it('stop even in the middle of sending (while handing over a queued item) while responding; takes priority over sending', () => {
    expect(composerButtonKind({ sending: true, busy: true, shellDraft: false })).toBe('stop')
    expect(composerButtonKind({ sending: true, busy: true, shellDraft: true })).toBe('stop')
  })
  it('a send in progress while not responding is sending / shellRunning', () => {
    expect(composerButtonKind({ sending: true, busy: false, shellDraft: false })).toBe('sending')
    expect(composerButtonKind({ sending: true, busy: false, shellDraft: true })).toBe('shellRunning')
  })

  it('each kind has a dictionary key (stop is composer.stop)', () => {
    expect(composerButtonLabelKey('send')).toBe('composer.send')
    expect(composerButtonLabelKey('stop')).toBe('composer.stop')
    expect(composerButtonLabelKey('shellRun')).toBe('composer.shellRun')
    expect(composerButtonLabelKey('sending')).toBe('composer.sending')
    expect(composerButtonLabelKey('shellRunning')).toBe('composer.shellRunning')
  })
})

describe('composerButtonDisabled (item 161: stop can always be pressed)', () => {
  it('stop can be pressed even with an empty input (qlm\'s "getting this wrong would make responses impossible to stop")', () => {
    expect(composerButtonDisabled('stop', true)).toBe(false)
    expect(composerButtonDisabled('stop', false)).toBe(false)
  })
  it('while responding, the primary button is a stop that can be pressed whether typing, empty or handing over a queued item', () => {
    for (const sending of [false, true]) {
      for (const shellDraft of [false, true]) {
        for (const empty of [false, true]) {
          const kind = composerButtonKind({ sending, busy: true, shellDraft })
          expect(kind).toBe('stop')
          expect(composerButtonDisabled(kind, empty)).toBe(false)
        }
      }
    }
  })
  it('send and `!` run cannot be pressed when there is nothing to send', () => {
    expect(composerButtonDisabled('send', true)).toBe(true)
    expect(composerButtonDisabled('send', false)).toBe(false)
    expect(composerButtonDisabled('shellRun', true)).toBe(true)
    expect(composerButtonDisabled('shellRun', false)).toBe(false)
  })
  it('prevents a double press while sending', () => {
    const kinds: ComposerButtonKind[] = ['sending', 'shellRunning']
    for (const kind of kinds) {
      expect(composerButtonDisabled(kind, false)).toBe(true)
      expect(composerButtonDisabled(kind, true)).toBe(true)
    }
  })
})

describe('composerSideButtons (item 161: queue and interrupt only while responding, left of stop)', () => {
  it('not shown when not responding', () => {
    expect(composerSideButtons({ busy: false, sending: false, empty: false }).visible).toBe(false)
  })
  it('shown while responding; can be pressed when there is something to send', () => {
    expect(composerSideButtons({ busy: true, sending: false, empty: false })).toEqual({
      visible: true,
      disabled: false
    })
  })
  it('cannot be pressed when there is nothing to send or while sending (stop is separate and stays pressable)', () => {
    expect(composerSideButtons({ busy: true, sending: false, empty: true }).disabled).toBe(true)
    expect(composerSideButtons({ busy: true, sending: true, empty: false }).disabled).toBe(true)
  })
})

describe('composerSendEmpty (item 154: when the draft is empty and cannot be pressed)', () => {
  it('empty when there is no body, attachment or selection', () => {
    expect(
      composerSendEmpty({ shellDraft: false, draft: '', hasAttachments: false, hasSelection: false })
    ).toBe(true)
    expect(
      composerSendEmpty({ shellDraft: false, draft: '   ', hasAttachments: false, hasSelection: false })
    ).toBe(true)
  })
  it('not empty when any of body, attachment or selection exists', () => {
    expect(
      composerSendEmpty({ shellDraft: false, draft: 'x', hasAttachments: false, hasSelection: false })
    ).toBe(false)
    expect(
      composerSendEmpty({ shellDraft: false, draft: '', hasAttachments: true, hasSelection: false })
    ).toBe(false)
    expect(
      composerSendEmpty({ shellDraft: false, draft: '', hasAttachments: false, hasSelection: true })
    ).toBe(false)
  })
  it('`!` input depends on whether a command exists (attachments and selections are not looked at)', () => {
    expect(
      composerSendEmpty({ shellDraft: true, draft: '!', hasAttachments: false, hasSelection: false })
    ).toBe(true)
    expect(
      composerSendEmpty({ shellDraft: true, draft: '!ls', hasAttachments: false, hasSelection: false })
    ).toBe(false)
  })
})

describe('composerPlaceholderKind (item 156)', () => {
  it('normal usually', () => {
    expect(composerPlaceholderKind({ busy: false, planMode: false })).toBe('normal')
  })
  it('plan when Plan mode is on', () => {
    expect(composerPlaceholderKind({ busy: false, planMode: true })).toBe('plan')
  })
  it('queue while responding (busy, including awaiting approval); takes priority over plan', () => {
    expect(composerPlaceholderKind({ busy: true, planMode: false })).toBe('queue')
    expect(composerPlaceholderKind({ busy: true, planMode: true })).toBe('queue')
  })
  // The placeholder for awaiting approval was removed in item 182 (the approval screen replaces the Composer, so there is no path where it is seen).

  it('each kind has a dictionary key', () => {
    expect(composerPlaceholderKey('normal')).toBe('composer.placeholder')
    expect(composerPlaceholderKey('queue')).toBe('composer.placeholderQueue')
    expect(composerPlaceholderKey('plan')).toBe('composer.placeholderPlan')
  })
})

describe('composerStopLocked (TODO 1156)', () => {
  it('does not accept stop within 300 ms of sending', () => {
    expect(STOP_LOCK_MS).toBe(300)
    expect(composerStopLocked(1000, 1000)).toBe(true)
    expect(composerStopLocked(1000, 1299)).toBe(true)
  })
  it('accepts after 300 ms / always accepts when nothing was sent', () => {
    expect(composerStopLocked(1000, 1300)).toBe(false)
    expect(composerStopLocked(1000, 5000)).toBe(false)
    expect(composerStopLocked(null, 1000)).toBe(false)
  })
})

describe('composerSubmitAction (TODO 1156 review X: do not take the stop lock when not sending)', () => {
  it('only `!` (no command) is skip; with a command it sends as shell', () => {
    expect(composerSubmitAction({ shellDraft: true, draft: '!', force: false, unknownSlash: null })).toEqual({ kind: 'skip' })
    expect(composerSubmitAction({ shellDraft: true, draft: '!  ', force: false, unknownSlash: null })).toEqual({ kind: 'skip' })
    expect(composerSubmitAction({ shellDraft: true, draft: '!ls', force: false, unknownSlash: null })).toEqual({
      kind: 'send',
      shell: true
    })
  })
  it('a `/name` not in the list is blocked, and sends if "send anyway" (force)', () => {
    expect(composerSubmitAction({ shellDraft: false, draft: '/nope', force: false, unknownSlash: 'nope' })).toEqual({
      kind: 'blocked',
      name: 'nope'
    })
    expect(composerSubmitAction({ shellDraft: false, draft: '/nope', force: true, unknownSlash: 'nope' })).toEqual({
      kind: 'send',
      shell: false
    })
    expect(composerSubmitAction({ shellDraft: false, draft: 'hello', force: false, unknownSlash: null })).toEqual({
      kind: 'send',
      shell: false
    })
  })
  it('the send time is stamped only for send: a ■ right after skip / blocked is immediate', () => {
    // The same steps as the Composer's submit(): sentAt is set only when the action is send.
    const press = (sentAt: number | null, now: number, action: ReturnType<typeof composerSubmitAction>): number | null =>
      action.kind === 'send' ? now : sentAt
    const skipped = press(null, 1000, composerSubmitAction({ shellDraft: true, draft: '!', force: false, unknownSlash: null }))
    expect(composerStopLocked(skipped, 1001)).toBe(false)
    const blocked = press(null, 1000, composerSubmitAction({ shellDraft: false, draft: '/x', force: false, unknownSlash: 'x' }))
    expect(composerStopLocked(blocked, 1001)).toBe(false)
    const sent = press(null, 1000, composerSubmitAction({ shellDraft: false, draft: 'hi', force: false, unknownSlash: null }))
    expect(composerStopLocked(sent, 1001)).toBe(true)
  })
})
