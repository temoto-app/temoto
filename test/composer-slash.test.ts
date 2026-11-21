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
  it('takes the leading `/name` (leading whitespace ignored, followed by whitespace or the end)', () => {
    expect(slashName('/compact')).toBe('compact')
    expect(slashName('  /compact 要約して')).toBe('compact')
    expect(slashName('/compact\n続き')).toBe('compact')
  })

  it('does not treat a path or a normal sentence as a command', () => {
    expect(slashName('/Users/me/x を見て')).toBeNull()
    expect(slashName('/')).toBeNull()
    expect(slashName('/ 空白')).toBeNull()
    expect(slashName('ねえ /compact')).toBeNull()
    expect(slashName('')).toBeNull()
  })
})

describe('checkSlash', () => {
  it('sends one that is in the real list (known)', () => {
    expect(checkSlash('/compact', COMMANDS)).toEqual({ kind: 'known', name: 'compact' })
  })

  it('stops `/btw`, which is not usable non-interactively and is not in the list (unknown)', () => {
    // The origin of TODO 68. The stream-json list of CLI 2.1.207 does not have btw.
    expect(checkSlash('/btw ちょっと質問', COMMANDS)).toEqual({ kind: 'unknown', name: 'btw' })
  })

  it('does not stop when the list is not yet known (unverified)', () => {
    expect(checkSlash('/btw', null)).toEqual({ kind: 'unverified', name: 'btw' })
  })

  it('does nothing when it is not in command form', () => {
    expect(checkSlash('こんにちは', COMMANDS)).toEqual({ kind: 'none' })
    expect(checkSlash('/Users/me/a.txt', COMMANDS)).toEqual({ kind: 'none' })
  })

  it('distinguishes case (exact match with the backend name)', () => {
    expect(checkSlash('/Compact', COMMANDS).kind).toBe('unknown')
  })
})

describe('suggestSlash', () => {
  it('for `/` alone, from the head of the list up to the limit', () => {
    const got = suggestSlash('/', COMMANDS, 5)
    expect(got).toEqual(COMMANDS.slice(0, 5))
  })

  it('prefix matches first, partial matches after (keeps the order within the list)', () => {
    // Fixture list: config / context match by prefix; update-config / design-consent match partially.
    expect(suggestSlash('/con', COMMANDS, 20)).toEqual(['config', 'context', 'update-config', 'design-consent'])
    // Typing in uppercase still finds it.
    expect(suggestSlash('/CON', COMMANDS, 20)).toEqual(['config', 'context', 'update-config', 'design-consent'])
  })

  it('does not show after typing whitespace (once in the arguments)', () => {
    expect(suggestSlash('/compact ', COMMANDS)).toBe(NO_SUGGESTIONS)
    expect(suggestSlash('ふつうの文', COMMANDS)).toBe(NO_SUGGESTIONS)
  })

  it('does not show when it matches only the one name that has been typed in full', () => {
    expect(suggestSlash('/compact', ['compact', 'clear'])).toBe(NO_SUGGESTIONS)
    // Other candidates are shown too if there are any.
    expect(suggestSlash('/co', ['compact', 'config'])).toEqual(['compact', 'config'])
  })

  it('does not show when there is no list (returns a constant, does not make a new array)', () => {
    expect(suggestSlash('/', null)).toBe(NO_SUGGESTIONS)
    expect(suggestSlash('/zzzz', COMMANDS)).toBe(NO_SUGGESTIONS)
  })
})

describe('completeSlash / commandsFor', () => {
  it('choosing a candidate gives `/name `', () => {
    expect(completeSlash('compact')).toBe('/compact ')
  })

  it("the thread's own list wins, then the backend's copy, and null when neither exists", () => {
    const own = ['a']
    const backend = ['b']
    expect(commandsFor(own, backend)).toBe(own)
    expect(commandsFor(undefined, backend)).toBe(backend)
    expect(commandsFor(undefined, null)).toBeNull()
    expect(commandsFor(undefined, undefined)).toBeNull()
  })
})
