/**
 * Item 122 / 239: the pure functions for 'CLI conversations in this folder' in the create dialog (narrowing, 5 items + show more, when to show). No DOM. The removal of item 121's i18n keys is also checked here.
 *
 * Item 239 (2026-09-28): narrowing changed from an exact match of `cwdUri` to a match of `cwdMatchKey` (`cwdMatchKey` is a value that main has already run through `realpath` and folding (case and NFC); the computation itself is checked in `cwd-match.test.ts`, which uses the real file system of `src/main/session/cwd-match.ts`). Here only the narrowing rule is checked, by building the key values directly: 'if `cwdMatchKey` is the same, it is the same folder even when the spelling of `cwdUri` differs' (symlinks and letter case are both folded to the same key on the main side, so they are not distinguished here).
 */
import { describe, expect, it } from 'vitest'
import type { TranscriptSession } from '../src/shared/thread.js'
import {
  FOLDER_TRANSCRIPT_LIMIT,
  sessionsInFolder,
  transcriptEntryMode,
  visibleSessions
} from '../src/renderer/src/transcript-folder.js'
import { en } from '../src/renderer/src/i18n/en.js'
import { ja } from '../src/renderer/src/i18n/ja.js'

function session(id: string, cwdUri: string, cwdMatchKey: string, mtimeMs: number): TranscriptSession {
  return {
    sessionId: id,
    uri: `transcript://p/${id}.jsonl`,
    cwdUri,
    cwdMatchKey,
    cwdName: cwdUri.split('/').pop() ?? '',
    title: null,
    firstPrompt: id,
    mtimeMs,
    usable: true,
    reason: null,
    threadId: null
  }
}

const APP = 'file:///Users/me/git/app'
const APP_KEY = '/users/me/git/app'

describe('sessionsInFolder (item 122 / 239)', () => {
  const all = [
    session('old', APP, APP_KEY, 1),
    session('other', 'file:///Users/me/git/other', '/users/me/git/other', 50),
    session('new', APP, APP_KEY, 100),
    session('mid', APP, APP_KEY, 10)
  ]

  it('returns only conversations with the same cwdMatchKey, newest first', () => {
    expect(sessionsInFolder(all, APP_KEY).map((s) => s.sessionId)).toEqual(['new', 'mid', 'old'])
  })

  it('matches even for a cwdUri spelled via a symlink or differing in case if cwdMatchKey is the same (item 239)', () => {
    // As measured for item 233, the CLI's transcript records the real path (`/private/var/…`). Even if the folder chosen is `/var/…` (a symlink) or spelled with different case, main folds both to the same `cwdMatchKey`, so the narrowing on the renderer side only needs to check that the keys match.
    const viaSymlink = session('symlink', 'file:///var/folders/x', APP_KEY, 5)
    const viaCase = session('case', 'file:///Users/me/git/App', APP_KEY, 6)
    expect(sessionsInFolder([viaSymlink, viaCase], APP_KEY).map((s) => s.sessionId)).toEqual([
      'case',
      'symlink'
    ])
  })

  it('does not match when cwdMatchKey differs (prefix matches and differences only in a trailing separator are treated as different too)', () => {
    const tricky = [
      session('prefix', 'file:///Users/me/git/appx', '/users/me/git/appx', 1),
      session('child', `${APP}/sub`, `${APP_KEY}/sub`, 2)
    ]
    expect(sessionsInFolder(tricky, APP_KEY)).toEqual([])
  })

  it('no affiliation (null), an empty key, and transcripts with an unknown working folder do not match', () => {
    const unknown = [session('nocwd', '', '', 5)]
    expect(sessionsInFolder(all, null)).toEqual([])
    expect(sessionsInFolder(unknown, '')).toEqual([])
    expect(sessionsInFolder(unknown, APP_KEY)).toEqual([])
  })

  it('does not reorder the array it was given', () => {
    const before = all.map((s) => s.sessionId)
    sessionsInFolder(all, APP_KEY)
    expect(all.map((s) => s.sessionId)).toEqual(before)
  })
})

describe('visibleSessions (item 122)', () => {
  const seven = [1, 2, 3, 4, 5, 6, 7]

  it('the default is 5, and it returns the number remaining', () => {
    expect(FOLDER_TRANSCRIPT_LIMIT).toBe(5)
    expect(visibleSessions(seven, false)).toEqual({ shown: [1, 2, 3, 4, 5], hidden: 2 })
  })

  it('after 「もっと見る」 it is all', () => {
    expect(visibleSessions(seven, true)).toEqual({ shown: seven, hidden: 0 })
  })

  it('with 5 or fewer, 「もっと見る」 does not appear', () => {
    expect(visibleSessions([1, 2, 3, 4, 5], false)).toEqual({ shown: [1, 2, 3, 4, 5], hidden: 0 })
    expect(visibleSessions([], false)).toEqual({ shown: [], hidden: 0 })
  })

  it('with exactly 6, 1 is hidden', () => {
    expect(visibleSessions([1, 2, 3, 4, 5, 6], false).hidden).toBe(1)
  })
})

describe('transcriptEntryMode (item 122)', () => {
  it('when the folder has conversations, 「新規会話作成」 and a list, and the link is to other folders', () => {
    expect(transcriptEntryMode(false, 3)).toEqual({ mode: 'folder', link: 'otherFolders' })
  })

  it('a folder with no trace stays as before (keeps the link)', () => {
    expect(transcriptEntryMode(false, 0)).toEqual({ mode: 'plain', link: 'otherFolders' })
  })

  it('no affiliation (disposable) does not show a list', () => {
    expect(transcriptEntryMode(true, 0)).toEqual({ mode: 'plain', link: 'anyFolder' })
    // Even if a count is passed when there is no affiliation, nothing is shown (the caller passes 0, but just in case).
    expect(transcriptEntryMode(true, 4)).toEqual({ mode: 'plain', link: 'anyFolder' })
  })
})

describe('dictionary (item 121 / 122)', () => {
  it('the wording of the model / thinking section of the create dialog is gone from both EN / JA', () => {
    for (const dict of [en, ja] as Record<string, string>[]) {
      expect(dict['newThread.modelHeading']).toBeUndefined()
      expect(dict['newThread.defaultsHint']).toBeUndefined()
    }
  })

  it('「もっと見る」 inserts the number remaining', () => {
    for (const dict of [en, ja] as Record<string, string>[]) {
      expect(dict['newThread.transcript.more']).toContain('{count}')
    }
  })
})
