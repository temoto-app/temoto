/**
 * Slash commands in the prompt field (item 68, `src/renderer/src/composer-slash.ts`). Pure functions.
 *
 * The list is taken by **running the fixture (line 1 of `test/fixtures/stream-session.jsonl`, real output of CLI 2.1.207) through the Adapter's parseEvent**.
 * This shape checks that the renderer's judgment works only from what the backend reports, and that it does not hold command names of its own.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEvent } from '../src/main/session/adapter/parse.js'
import {
  NO_SUGGESTIONS,
  checkSlash,
  commandsFor,
  completeSlash,
  slashName,
  suggestSlash
} from '../src/renderer/src/composer-slash.js'

const fixture = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'stream-session.jsonl')
const initLine = readFileSync(fixture, 'utf8').split('\n')[0]!

function reportedCommands(): readonly string[] {
  const [event] = parseEvent(initLine, {
    sessionId: 's',
    threadId: 't',
    now: () => 0,
    newId: () => 'e'
  })
  if (event?.kind !== 'session_started' || !Array.isArray(event.payload.commands)) {
    throw new Error('fixture has no command list')
  }
  return event.payload.commands
}

const COMMANDS = reportedCommands()

describe('slashName', () => {
  it('先頭の `/名前` を取る (前の空白は無視、後ろは空白か終わり)', () => {
    expect(slashName('/compact')).toBe('compact')
    expect(slashName('  /compact 要約して')).toBe('compact')
    expect(slashName('/compact\n続き')).toBe('compact')
  })

  it('パスや普通の文はコマンドとみなさない', () => {
    expect(slashName('/Users/me/x を見て')).toBeNull()
    expect(slashName('/')).toBeNull()
    expect(slashName('/ 空白')).toBeNull()
    expect(slashName('ねえ /compact')).toBeNull()
    expect(slashName('')).toBeNull()
  })
})

describe('checkSlash', () => {
  it('実物の一覧にあるものは送る (known)', () => {
    expect(checkSlash('/compact', COMMANDS)).toEqual({ kind: 'known', name: 'compact' })
  })

  it('非対話で使えない `/btw` は一覧に無いので止める (unknown)', () => {
    // The origin of TODO 68. The stream-json list of CLI 2.1.207 does not have btw.
    expect(checkSlash('/btw ちょっと質問', COMMANDS)).toEqual({ kind: 'unknown', name: 'btw' })
  })

  it('一覧をまだ知らなければ止めない (unverified)', () => {
    expect(checkSlash('/btw', null)).toEqual({ kind: 'unverified', name: 'btw' })
  })

  it('コマンドの形でなければ何もしない', () => {
    expect(checkSlash('こんにちは', COMMANDS)).toEqual({ kind: 'none' })
    expect(checkSlash('/Users/me/a.txt', COMMANDS)).toEqual({ kind: 'none' })
  })

  it('大文字小文字は区別する (バックエンドの名前と完全一致)', () => {
    expect(checkSlash('/Compact', COMMANDS).kind).toBe('unknown')
  })
})

describe('suggestSlash', () => {
  it('`/` だけなら一覧の先頭から上限まで', () => {
    const got = suggestSlash('/', COMMANDS, 5)
    expect(got).toEqual(COMMANDS.slice(0, 5))
  })

  it('前方一致を先に、部分一致を後に (一覧の中の順は保つ)', () => {
    // Fixture list: config / context match by prefix; update-config / design-consent match partially.
    expect(suggestSlash('/con', COMMANDS, 20)).toEqual(['config', 'context', 'update-config', 'design-consent'])
    // Typing in uppercase still finds it.
    expect(suggestSlash('/CON', COMMANDS, 20)).toEqual(['config', 'context', 'update-config', 'design-consent'])
  })

  it('空白を打った後 (引数に入った後) は出さない', () => {
    expect(suggestSlash('/compact ', COMMANDS)).toBe(NO_SUGGESTIONS)
    expect(suggestSlash('ふつうの文', COMMANDS)).toBe(NO_SUGGESTIONS)
  })

  it('打ち終えた名前 1 つだけに一致するなら出さない', () => {
    expect(suggestSlash('/compact', ['compact', 'clear'])).toBe(NO_SUGGESTIONS)
    // Other candidates are shown too if there are any.
    expect(suggestSlash('/co', ['compact', 'config'])).toEqual(['compact', 'config'])
  })

  it('一覧が無ければ出さない (定数を返し、新しい配列を作らない)', () => {
    expect(suggestSlash('/', null)).toBe(NO_SUGGESTIONS)
    expect(suggestSlash('/zzzz', COMMANDS)).toBe(NO_SUGGESTIONS)
  })
})

describe('completeSlash / commandsFor', () => {
  it('候補を選ぶと `/名前 ` になる', () => {
    expect(completeSlash('compact')).toBe('/compact ')
  })

  it('スレッド自身の一覧が優先、無ければバックエンドの控え、どちらも無ければ null', () => {
    const own = ['a']
    const backend = ['b']
    expect(commandsFor(own, backend)).toBe(own)
    expect(commandsFor(undefined, backend)).toBe(backend)
    expect(commandsFor(undefined, null)).toBeNull()
    expect(commandsFor(undefined, undefined)).toBeNull()
  })
})
