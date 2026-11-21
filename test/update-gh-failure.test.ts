/**
 * TODO 1213: `ghFailure` splits a gh failure (exit code + stderr) into reason codes.
 * The stderr examples are from the real gh (`release not found`) and the standard gh / Go messages.
 */
import { describe, expect, it } from 'vitest'
import {
  execFailureResult,
  ghFailure,
  ghReleaseSource,
  type CommandResult,
  type CommandRunner
} from '../src/main/update/release-source.js'
import { parseReason } from '../src/shared/reason.js'
import { en } from '../src/renderer/src/i18n/en.js'
import { ja } from '../src/renderer/src/i18n/ja.js'

const code = (err: Error): string | undefined => parseReason(err.message)?.code
const fail = (stderr: string, extra: Partial<CommandResult> = {}): string | undefined =>
  code(ghFailure({ code: 1, stdout: '', stderr, ...extra }, 'update-check-failed'))

describe('ghFailure', () => {
  it.each([
    ['release not found\n', 'update-no-release'],
    ['gh: Resource not accessible\nHTTP 404: Not Found (https://api.github.com/x)', 'update-gh-auth'],
    ['HTTP 401: Bad credentials', 'update-gh-auth'],
    ['To get started with GitHub CLI, please run:  gh auth login', 'update-gh-auth'],
    ['HTTP 403: API rate limit exceeded for user ID 1.', 'update-rate-limited'],
    ['HTTP 429: Too Many Requests', 'update-rate-limited'],
    ['HTTP 403: You have exceeded a secondary rate limit', 'update-rate-limited'],
    ['error connecting to api.github.com\ndial tcp: lookup api.github.com: no such host', 'update-network'],
    ['Get "https://api.github.com/": could not resolve host', 'update-network'],
    ['tls: failed to verify certificate: x509: certificate signed by unknown authority', 'update-network'],
    ['proxyconnect tcp: dial tcp 127.0.0.1:1: connect: connection refused', 'update-network'],
    ['read tcp: connection reset by peer', 'update-network'],
    // code-review Y1: the regex `\\bEOF\\b` (a backslash followed by the letter b) did not match
    ['Get "https://api.github.com/repos/o/r/releases/latest": unexpected EOF', 'update-network'],
    ['EOF', 'update-network'],
    ['something unexpected', 'update-check-failed'],
    ['', 'update-check-failed']
  ])('%j -> %s', (stderr, expected) => {
    expect(fail(stderr)).toBe(expected)
  })

  it('終了コード 4 は auth、時間切れは timeout (stderr が空でも)', () => {
    expect(code(ghFailure({ code: 4, stdout: '', stderr: '' }, 'update-check-failed'))).toBe('update-gh-auth')
    expect(fail('', { timedOut: true })).toBe('update-timeout')
  })

  it('取得 (download) の既定は update-download-failed のまま', () => {
    expect(code(ghFailure({ code: 1, stdout: '', stderr: 'weird' }, 'update-download-failed'))).toBe('update-download-failed')
  })

  it('EOF は語として当てる (語の途中は網にしない)', () => {
    expect(fail('GEOFFREY')).toBe('update-check-failed')
  })

  it('取得の時間切れ・release not found は確認の文言 (timeout / no-release) にしない (code-review Y3)', () => {
    const dl = (stderr: string, extra: Partial<CommandResult> = {}): string | undefined =>
      code(ghFailure({ code: 1, stdout: '', stderr, ...extra }, 'update-download-failed'))
    expect(dl('', { timedOut: true })).toBe('update-download-failed')
    expect(dl('release not found')).toBe('update-download-failed')
    // Login, rate-limit, and network failures are classified the same way for fetches too
    expect(dl('HTTP 401: Bad credentials')).toBe('update-gh-auth')
    expect(dl('HTTP 429: Too Many Requests')).toBe('update-rate-limited')
    expect(dl('dial tcp: lookup api.github.com: no such host')).toBe('update-network')
    expect(code(ghFailure({ code: 4, stdout: '', stderr: '' }, 'update-download-failed'))).toBe('update-gh-auth')
  })

  it('download は時間切れを update-download-failed で投げる', async () => {
    const run: CommandRunner = async () => ({ code: 1, timedOut: true, stdout: '', stderr: '' })
    await expect(ghReleaseSource('o/r', run).download('v1.0.0', ['a'], '/tmp/x')).rejects.toSatisfy(
      (e: Error) => code(e) === 'update-download-failed'
    )
  })

  it('latestTag は release not found を update-no-release にする', async () => {
    const run: CommandRunner = async () => ({ code: 1, stdout: '', stderr: 'release not found' })
    await expect(ghReleaseSource('o/r', run).latestTag()).rejects.toSatisfy((e: Error) => code(e) === 'update-no-release')
  })

  it('update-no-release の文言は「まだ無い」と「repo が見えない」の両方と gh auth status を言う (code-review Y2)', () => {
    expect(en['reason.update-no-release']).toMatch(/released yet/)
    expect(en['reason.update-no-release']).toMatch(/cannot see the release repository/)
    expect(en['reason.update-no-release']).toContain('gh auth status')
    expect(ja['reason.update-no-release']).toMatch(/まだ版が出ていない/)
    expect(ja['reason.update-no-release']).toMatch(/repo が見えません/)
    expect(ja['reason.update-no-release']).toContain('gh auth status')
  })

  it('新しい理由コードは EN / JA の文言を持つ', () => {
    const messages = { en, ja } as Record<string, Record<string, string>>
    for (const lang of ['en', 'ja']) {
      for (const c of ['update-no-release', 'update-timeout', 'update-rate-limited', 'update-network']) {
        expect(messages[lang]?.[`reason.${c}`]).toBeTruthy()
      }
    }
  })
})

describe('execFailureResult (code-review Y3)', () => {
  it('execFile が時間切れで kill した (killed) は timedOut', () => {
    expect(execFailureResult({ code: null, killed: true }, '', '')).toEqual({ code: 1, stdout: '', stderr: '', timedOut: true })
  })

  it('出力の上限超え (ERR_CHILD_PROCESS_STDIO_MAXBUFFER) は killed が立っていても時間切れにしない', () => {
    const r = execFailureResult({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, 'x', '')
    expect(r.timedOut).toBeUndefined()
    expect(r.code).toBe(1)
    expect(code(ghFailure(r, 'update-check-failed'))).toBe('update-check-failed')
  })

  it('普通の非 0 終了は終了コードをそのまま', () => {
    expect(execFailureResult({ code: 4, killed: false }, '', 'e')).toEqual({ code: 4, stdout: '', stderr: 'e' })
  })
})
