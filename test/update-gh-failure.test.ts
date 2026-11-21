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

  it('exit code 4 is auth, and a timeout is timeout (even when stderr is empty)', () => {
    expect(code(ghFailure({ code: 4, stdout: '', stderr: '' }, 'update-check-failed'))).toBe('update-gh-auth')
    expect(fail('', { timedOut: true })).toBe('update-timeout')
  })

  it('the default for fetching (download) stays update-download-failed', () => {
    expect(code(ghFailure({ code: 1, stdout: '', stderr: 'weird' }, 'update-download-failed'))).toBe('update-download-failed')
  })

  it('EOF is matched as a word (a word fragment is not caught)', () => {
    expect(fail('GEOFFREY')).toBe('update-check-failed')
  })

  it('a fetch timeout and release not found do not use the check wording (timeout / no-release) (code-review Y3)', () => {
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

  it('download throws a timeout as update-download-failed', async () => {
    const run: CommandRunner = async () => ({ code: 1, timedOut: true, stdout: '', stderr: '' })
    await expect(ghReleaseSource('o/r', run).download('v1.0.0', ['a'], '/tmp/x')).rejects.toSatisfy(
      (e: Error) => code(e) === 'update-download-failed'
    )
  })

  it('latestTag turns release not found into update-no-release', async () => {
    const run: CommandRunner = async () => ({ code: 1, stdout: '', stderr: 'release not found' })
    await expect(ghReleaseSource('o/r', run).latestTag()).rejects.toSatisfy((e: Error) => code(e) === 'update-no-release')
  })

  it('the wording of update-no-release says both "not yet" and "repo not visible" and gh auth status (code-review Y2)', () => {
    expect(en['reason.update-no-release']).toMatch(/released yet/)
    expect(en['reason.update-no-release']).toMatch(/cannot see the release repository/)
    expect(en['reason.update-no-release']).toContain('gh auth status')
    expect(ja['reason.update-no-release']).toMatch(/まだ版が出ていない/)
    expect(ja['reason.update-no-release']).toMatch(/repo が見えません/)
    expect(ja['reason.update-no-release']).toContain('gh auth status')
  })

  it('the new reason codes have EN / JA wording', () => {
    const messages = { en, ja } as Record<string, Record<string, string>>
    for (const lang of ['en', 'ja']) {
      for (const c of ['update-no-release', 'update-timeout', 'update-rate-limited', 'update-network']) {
        expect(messages[lang]?.[`reason.${c}`]).toBeTruthy()
      }
    }
  })
})

describe('execFailureResult (code-review Y3)', () => {
  it('execFile killed it on a timeout (killed) is timedOut', () => {
    expect(execFailureResult({ code: null, killed: true }, '', '')).toEqual({ code: 1, stdout: '', stderr: '', timedOut: true })
  })

  it('exceeding the output limit (ERR_CHILD_PROCESS_STDIO_MAXBUFFER) is not a timeout even when killed is set', () => {
    const r = execFailureResult({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, 'x', '')
    expect(r.timedOut).toBeUndefined()
    expect(r.code).toBe(1)
    expect(code(ghFailure(r, 'update-check-failed'))).toBe('update-check-failed')
  })

  it('an ordinary non-zero exit keeps the exit code as is', () => {
    expect(execFailureResult({ code: 4, killed: false }, '', 'e')).toEqual({ code: 4, stdout: '', stderr: 'e' })
  })
})
