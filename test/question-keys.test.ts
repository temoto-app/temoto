/**
 * Item 166 (wave 13 bundle L): key handling and row order of the question screen (pure functions for the renderer).
 *
 * The shape follows the question screen of CLI 2.1.280 (numbered options → "Other" → for multi-select, a "next / send" row;
 * ↑↓ / digits / Enter; Tab / ←→ move between questions; Esc declines to answer). **Keys during IME composition are not taken** (T16).
 */
import { describe, expect, it } from 'vitest'
import {
  moveQuestionCursor,
  questionKeyAction,
  questionRows,
  type QuestionKeyContext
} from '../src/renderer/src/question-keys.js'
import type { ComposerKey } from '../src/renderer/src/composer-keys.js'
import type { ApprovalQuestion } from '../src/shared/thread.js'

const key = (k: string, over: Partial<ComposerKey> = {}): ComposerKey => ({
  key: k,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  isComposing: false,
  keyCode: 0,
  ...over
})

const list: QuestionKeyContext = { numbered: 4, inText: false, caretAtStart: false, caretAtEnd: false }
const text: QuestionKeyContext = { ...list, inText: true }

const single: ApprovalQuestion = {
  question: 'どれ?',
  header: '',
  multiSelect: false,
  options: [
    { label: 'A', description: 'a の説明' },
    { label: 'B', description: '' },
    { label: 'C', description: '' }
  ]
}

describe('questionRows (項目 895)', () => {
  it('選択肢 + その他 だけ (複数選択でも「次へ」「話す」の行は無い)', () => {
    expect(questionRows(single)).toEqual({ options: 3, other: 3, count: 4, numbered: 4 })
    expect(questionRows({ ...single, multiSelect: true })).toEqual({ options: 3, other: 3, count: 4, numbered: 4 })
  })
})

describe('questionKeyAction (一覧)', () => {
  it('↑↓ で動き、Enter / Space で選ぶ、Esc で答えない', () => {
    expect(questionKeyAction(key('ArrowDown'), list)).toEqual({ kind: 'move', delta: 1 })
    expect(questionKeyAction(key('ArrowUp'), list)).toEqual({ kind: 'move', delta: -1 })
    expect(questionKeyAction(key('Enter'), list)).toEqual({ kind: 'activate' })
    expect(questionKeyAction(key(' '), list)).toEqual({ kind: 'activate' })
    expect(questionKeyAction(key('Escape'), list)).toEqual({ kind: 'cancel' })
  })

  it('数字キーは番号の行を選ぶ (その他まで)。範囲の外と 0 は何もしない', () => {
    expect(questionKeyAction(key('1'), list)).toEqual({ kind: 'choose', row: 0 })
    expect(questionKeyAction(key('4'), list)).toEqual({ kind: 'choose', row: 3 })
    expect(questionKeyAction(key('5'), list)).toEqual({ kind: 'none' })
    expect(questionKeyAction(key('0'), list)).toEqual({ kind: 'none' })
    // On a confirmation screen (no numbered rows), digits have no effect.
    expect(questionKeyAction(key('1'), { ...list, numbered: 0 })).toEqual({ kind: 'none' })
  })

  it('Tab / ←→ は取らない (フォーカス移動に任せる)', () => {
    for (const k of ['Tab', 'ArrowRight', 'ArrowLeft']) expect(questionKeyAction(key(k), list)).toEqual({ kind: 'none' })
  })

  it('⌘ / Ctrl + Enter は回答する (欄の中でも)', () => {
    expect(questionKeyAction(key('Enter', { metaKey: true }), list)).toEqual({ kind: 'submit' })
    expect(questionKeyAction(key('Enter', { ctrlKey: true }), text)).toEqual({ kind: 'submit' })
    expect(questionKeyAction(key('Enter', { metaKey: true, isComposing: true }), list)).toEqual({ kind: 'none' })
  })

  it('変換中 (IME) のキーは何も拾わない — Enter も Esc も数字も', () => {
    for (const k of ['Enter', 'Escape', '1', 'ArrowDown', ' ']) {
      expect(questionKeyAction(key(k, { isComposing: true }), list)).toEqual({ kind: 'none' })
      // A safeguard for an implementation that does not set isComposing (keyCode 229).
      expect(questionKeyAction(key(k, { keyCode: 229 }), list)).toEqual({ kind: 'none' })
    }
  })

  it('⌘ / Ctrl / ⌥ 付きは取らない (ショートカットに譲る)', () => {
    expect(questionKeyAction(key('1', { metaKey: true }), list)).toEqual({ kind: 'none' })
    expect(questionKeyAction(key('1', { ctrlKey: true }), list)).toEqual({ kind: 'none' })
    expect(questionKeyAction(key('ArrowDown', { altKey: true }), list)).toEqual({ kind: 'none' })
  })
})

describe('questionKeyAction (「その他」の欄の中)', () => {
  it('Enter は答えを決め、Shift+Enter は改行 (欄に任せる)', () => {
    expect(questionKeyAction(key('Enter'), text)).toEqual({ kind: 'commitText' })
    expect(questionKeyAction(key('Enter', { shiftKey: true }), text)).toEqual({ kind: 'none' })
  })

  it('Esc は答えずに閉じるのではなく一覧に戻る (書いたものを消さない)', () => {
    expect(questionKeyAction(key('Escape'), text)).toEqual({ kind: 'leaveText' })
  })

  it('数字と Space は文字として欄に入る', () => {
    expect(questionKeyAction(key('1'), text)).toEqual({ kind: 'none' })
    expect(questionKeyAction(key(' '), text)).toEqual({ kind: 'none' })
  })

  it('先頭の ↑ / 末尾の ↓ だけ一覧へ出る (途中は欄の中の移動)', () => {
    expect(questionKeyAction(key('ArrowUp'), text)).toEqual({ kind: 'none' })
    expect(questionKeyAction(key('ArrowUp'), { ...text, caretAtStart: true })).toEqual({ kind: 'move', delta: -1 })
    expect(questionKeyAction(key('ArrowDown'), text)).toEqual({ kind: 'none' })
    expect(questionKeyAction(key('ArrowDown'), { ...text, caretAtEnd: true })).toEqual({ kind: 'move', delta: 1 })
  })

  it('変換確定の Enter / 変換取り消しの Esc では何もしない', () => {
    expect(questionKeyAction(key('Enter', { isComposing: true }), text)).toEqual({ kind: 'none' })
    expect(questionKeyAction(key('Escape', { isComposing: true }), text)).toEqual({ kind: 'none' })
  })
})

describe('moveQuestionCursor (全問を通した縦のカーソル)', () => {
  const two = [single, { ...single, question: 'もう 1 つ', options: [single.options[0]!] }]
  it('問の境界をまたぎ、端で止まる', () => {
    expect(moveQuestionCursor({ q: 0, row: 3 }, 1, two)).toEqual({ q: 1, row: 0 })
    expect(moveQuestionCursor({ q: 1, row: 0 }, -1, two)).toEqual({ q: 0, row: 3 })
    expect(moveQuestionCursor({ q: 0, row: 0 }, -1, two)).toEqual({ q: 0, row: 0 })
    expect(moveQuestionCursor({ q: 1, row: 1 }, 1, two)).toEqual({ q: 1, row: 1 })
    expect(moveQuestionCursor({ q: 0, row: 1 }, 1, two)).toEqual({ q: 0, row: 2 })
    expect(moveQuestionCursor({ q: 0, row: 0 }, 1, [])).toEqual({ q: 0, row: 0 })
  })
})
