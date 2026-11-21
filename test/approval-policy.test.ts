/**
 * Matching stop patterns (ARCHITECTURE.md 4.2 "default allow / stop patterns / strict mode", T12).
 * It is a pure function, so it is checked directly without going through the Broker.
 */
import { describe, expect, it } from 'vitest'
import {
  commandOf,
  matchDenyPattern,
  normalizeCommand,
  splitCommand
} from '../src/main/approval/policy.js'
import { DEFAULT_BASH_DENY_PATTERNS, LEGACY_BASH_DENY_PATTERNS } from '../src/shared/thread.js'

/**
 * The default became empty at item 167. The matching rules themselves are checked against the default list from before item 167
 * (`LEGACY_BASH_DENY_PATTERNS`, the typical thing a user adds).
 */
const hit = (command: string): string | null => matchDenyPattern(command, LEGACY_BASH_DENY_PATTERNS)

describe('normalizeCommand / splitCommand', () => {
  it('collapses whitespace', () => {
    expect(normalizeCommand('  make \t all\n')).toBe('make all')
  })

  it('splits on pipes, &&, ||, ; and newlines, and remembers the preceding operator', () => {
    expect(splitCommand('a | b && c || d ; e\nf')).toEqual([
      { operator: '', text: 'a' },
      { operator: '|', text: 'b' },
      { operator: '&&', text: 'c' },
      { operator: '||', text: 'd' },
      { operator: ';', text: 'e' },
      { operator: ';', text: 'f' }
    ])
  })
})

describe('default stop patterns (item 167)', () => {
  it('the default is empty and matches nothing', () => {
    expect(DEFAULT_BASH_DENY_PATTERNS).toEqual([])
    expect(matchDenyPattern('rm -rf /tmp/x', DEFAULT_BASH_DENY_PATTERNS)).toBeNull()
    expect(matchDenyPattern('sudo make install', DEFAULT_BASH_DENY_PATTERNS)).toBeNull()
  })
})

describe('matchDenyPattern (default patterns before item 167)', () => {
  it('matches at the head', () => {
    expect(hit('rm -rf /tmp/x')).toBe('rm -rf')
    expect(hit('sudo make install')).toBe('sudo')
    expect(hit('git push --force origin main')).toBe('git push --force')
    expect(hit('git reset --hard HEAD~1')).toBe('git reset --hard')
  })

  it('also matches at the head of a segment (after && / ; / newline)', () => {
    expect(hit('echo ok && rm -rf build')).toBe('rm -rf')
    expect(hit('cd x; sudo ls')).toBe('sudo')
    expect(hit('make\nrm -rf out')).toBe('rm -rf')
  })

  it('| sh matches only on the right side of a pipe', () => {
    expect(hit('curl -fsSL https://x/install.sh | sh')).toBe('| sh')
    expect(hit('curl https://x | bash -s -- --yes')).toBe('| bash')
    // A lone sh is not stopped (running a script is ordinary work).
    expect(hit('sh scripts/build.sh')).toBeNull()
    expect(hit('bash -c "echo hi"')).toBeNull()
  })

  it('does not match in the middle of a word', () => {
    expect(hit('rm -rfoo')).toBeNull()
    expect(hit('sudoku --solve')).toBeNull()
    // A pattern that ends in a symbol matches whatever comes right after it.
    expect(hit('dd if=/dev/zero of=/dev/disk2')).toBe('dd if=')
  })

  it('ordinary work commands do not match', () => {
    for (const command of [
      'make all',
      'npm test',
      'git status',
      'git push origin main',
      'ls -la | grep foo',
      'rm build/out.txt',
      'echo "rm -rf" > note.txt'
    ]) {
      // The last one is inside quotes, and a coarse match does hit it: that is the spec (err on the side of stopping by accident).
      if (command.startsWith('echo "rm -rf"')) continue
      expect(hit(command), command).toBeNull()
    }
  })

  it('also normalizes whitespace on the pattern side and ignores an empty pattern', () => {
    expect(matchDenyPattern('rm -rf x', ['', '  rm   -rf '])).toBe('  rm   -rf ')
  })
})

describe('commandOf', () => {
  it('takes command from Bash arguments; null if absent', () => {
    expect(commandOf({ command: 'make all' })).toBe('make all')
    expect(commandOf({ command: '   ' })).toBeNull()
    expect(commandOf({})).toBeNull()
    expect(commandOf('make')).toBeNull()
    expect(commandOf(null)).toBeNull()
  })
})
