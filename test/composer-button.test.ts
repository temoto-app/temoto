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

describe('composerButtonKind (項目 154 / 161)', () => {
  it('普段は send', () => {
    expect(composerButtonKind({ sending: false, busy: false, shellDraft: false })).toBe('send')
  })
  it('`!` の入力は shellRun', () => {
    expect(composerButtonKind({ sending: false, busy: false, shellDraft: true })).toBe('shellRun')
  })
  it('応答中は stop — `!` の下書きより優先 (止める口を消さない)', () => {
    expect(composerButtonKind({ sending: false, busy: true, shellDraft: false })).toBe('stop')
    expect(composerButtonKind({ sending: false, busy: true, shellDraft: true })).toBe('stop')
  })
  it('応答中は送信の途中 (予約を渡している間) でも stop — sending より優先', () => {
    expect(composerButtonKind({ sending: true, busy: true, shellDraft: false })).toBe('stop')
    expect(composerButtonKind({ sending: true, busy: true, shellDraft: true })).toBe('stop')
  })
  it('応答していない送信の途中は sending / shellRunning', () => {
    expect(composerButtonKind({ sending: true, busy: false, shellDraft: false })).toBe('sending')
    expect(composerButtonKind({ sending: true, busy: false, shellDraft: true })).toBe('shellRunning')
  })

  it('種別ごとに辞書の鍵がある (停止は composer.stop)', () => {
    expect(composerButtonLabelKey('send')).toBe('composer.send')
    expect(composerButtonLabelKey('stop')).toBe('composer.stop')
    expect(composerButtonLabelKey('shellRun')).toBe('composer.shellRun')
    expect(composerButtonLabelKey('sending')).toBe('composer.sending')
    expect(composerButtonLabelKey('shellRunning')).toBe('composer.shellRunning')
  })
})

describe('composerButtonDisabled (項目 161: 停止はいつでも押せる)', () => {
  it('停止は入力欄が空でも押せる (qlm の「ここを取り違えると応答を止められなくなる」)', () => {
    expect(composerButtonDisabled('stop', true)).toBe(false)
    expect(composerButtonDisabled('stop', false)).toBe(false)
  })
  it('応答中なら、打鍵中・空欄・予約を渡している途中のどれでも主ボタンは押せる停止', () => {
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
  it('送信と `!` の実行は、送るものが無ければ押せない', () => {
    expect(composerButtonDisabled('send', true)).toBe(true)
    expect(composerButtonDisabled('send', false)).toBe(false)
    expect(composerButtonDisabled('shellRun', true)).toBe(true)
    expect(composerButtonDisabled('shellRun', false)).toBe(false)
  })
  it('送信の途中は二度押しを防ぐ', () => {
    const kinds: ComposerButtonKind[] = ['sending', 'shellRunning']
    for (const kind of kinds) {
      expect(composerButtonDisabled(kind, false)).toBe(true)
      expect(composerButtonDisabled(kind, true)).toBe(true)
    }
  })
})

describe('composerSideButtons (項目 161: 予約と割り込みは応答中だけ、停止の左)', () => {
  it('応答していなければ出さない', () => {
    expect(composerSideButtons({ busy: false, sending: false, empty: false }).visible).toBe(false)
  })
  it('応答中は出す。送るものがあれば押せる', () => {
    expect(composerSideButtons({ busy: true, sending: false, empty: false })).toEqual({
      visible: true,
      disabled: false
    })
  })
  it('送るものが無い・送信の途中は押せない (停止は別で、押せるまま)', () => {
    expect(composerSideButtons({ busy: true, sending: false, empty: true }).disabled).toBe(true)
    expect(composerSideButtons({ busy: true, sending: true, empty: false }).disabled).toBe(true)
  })
})

describe('composerSendEmpty (項目 154: 下書きが空で押せないとき)', () => {
  it('本文も添付も選択範囲も無いと空', () => {
    expect(
      composerSendEmpty({ shellDraft: false, draft: '', hasAttachments: false, hasSelection: false })
    ).toBe(true)
    expect(
      composerSendEmpty({ shellDraft: false, draft: '   ', hasAttachments: false, hasSelection: false })
    ).toBe(true)
  })
  it('本文・添付・選択範囲のどれかがあれば空ではない', () => {
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
  it('`!` の入力はコマンドの有無で決まる (添付・選択範囲は見ない)', () => {
    expect(
      composerSendEmpty({ shellDraft: true, draft: '!', hasAttachments: false, hasSelection: false })
    ).toBe(true)
    expect(
      composerSendEmpty({ shellDraft: true, draft: '!ls', hasAttachments: false, hasSelection: false })
    ).toBe(false)
  })
})

describe('composerPlaceholderKind (項目 156)', () => {
  it('普段は normal', () => {
    expect(composerPlaceholderKind({ busy: false, planMode: false })).toBe('normal')
  })
  it('Plan モードが点いていれば plan', () => {
    expect(composerPlaceholderKind({ busy: false, planMode: true })).toBe('plan')
  })
  it('応答中 (busy、承認待ちも含む) は queue — plan より優先', () => {
    expect(composerPlaceholderKind({ busy: true, planMode: false })).toBe('queue')
    expect(composerPlaceholderKind({ busy: true, planMode: true })).toBe('queue')
  })
  // The placeholder for awaiting approval was removed in item 182 (the approval screen replaces the Composer, so there is no path where it is seen).

  it('種別ごとに辞書の鍵がある', () => {
    expect(composerPlaceholderKey('normal')).toBe('composer.placeholder')
    expect(composerPlaceholderKey('queue')).toBe('composer.placeholderQueue')
    expect(composerPlaceholderKey('plan')).toBe('composer.placeholderPlan')
  })
})

describe('composerStopLocked (TODO 1156)', () => {
  it('送信から 300 ms 以内は停止を受け付けない', () => {
    expect(STOP_LOCK_MS).toBe(300)
    expect(composerStopLocked(1000, 1000)).toBe(true)
    expect(composerStopLocked(1000, 1299)).toBe(true)
  })
  it('300 ms を過ぎれば受け付ける / 送信していなければ常に受け付ける', () => {
    expect(composerStopLocked(1000, 1300)).toBe(false)
    expect(composerStopLocked(1000, 5000)).toBe(false)
    expect(composerStopLocked(null, 1000)).toBe(false)
  })
})

describe('composerSubmitAction (TODO 1156 の review X: 送らないときは停止のロックを掛けない)', () => {
  it('`!` だけ (コマンドが無い) は skip、コマンドがあれば shell で送る', () => {
    expect(composerSubmitAction({ shellDraft: true, draft: '!', force: false, unknownSlash: null })).toEqual({ kind: 'skip' })
    expect(composerSubmitAction({ shellDraft: true, draft: '!  ', force: false, unknownSlash: null })).toEqual({ kind: 'skip' })
    expect(composerSubmitAction({ shellDraft: true, draft: '!ls', force: false, unknownSlash: null })).toEqual({
      kind: 'send',
      shell: true
    })
  })
  it('一覧に無い `/名前` は blocked、「それでも送る」(force) なら送る', () => {
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
  it('送信の時刻は send のときだけ打つ: skip / blocked の直後の ■ は即時', () => {
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
