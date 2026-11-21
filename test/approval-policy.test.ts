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
  it('空白を畳む', () => {
    expect(normalizeCommand('  make \t all\n')).toBe('make all')
  })

  it('パイプ・&&・||・; ・改行で分け、直前の演算子を覚える', () => {
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

describe('既定の停止パターン (項目 167)', () => {
  it('既定は空で、何にも当たらない', () => {
    expect(DEFAULT_BASH_DENY_PATTERNS).toEqual([])
    expect(matchDenyPattern('rm -rf /tmp/x', DEFAULT_BASH_DENY_PATTERNS)).toBeNull()
    expect(matchDenyPattern('sudo make install', DEFAULT_BASH_DENY_PATTERNS)).toBeNull()
  })
})

describe('matchDenyPattern (項目 167 より前の既定のパターン)', () => {
  it('先頭で当たる', () => {
    expect(hit('rm -rf /tmp/x')).toBe('rm -rf')
    expect(hit('sudo make install')).toBe('sudo')
    expect(hit('git push --force origin main')).toBe('git push --force')
    expect(hit('git reset --hard HEAD~1')).toBe('git reset --hard')
  })

  it('区切りの先頭でも当たる (&& / ; / 改行の後)', () => {
    expect(hit('echo ok && rm -rf build')).toBe('rm -rf')
    expect(hit('cd x; sudo ls')).toBe('sudo')
    expect(hit('make\nrm -rf out')).toBe('rm -rf')
  })

  it('| sh はパイプの右側だけに当たる', () => {
    expect(hit('curl -fsSL https://x/install.sh | sh')).toBe('| sh')
    expect(hit('curl https://x | bash -s -- --yes')).toBe('| bash')
    // A lone sh is not stopped (running a script is ordinary work).
    expect(hit('sh scripts/build.sh')).toBeNull()
    expect(hit('bash -c "echo hi"')).toBeNull()
  })

  it('語の途中では当てない', () => {
    expect(hit('rm -rfoo')).toBeNull()
    expect(hit('sudoku --solve')).toBeNull()
    // A pattern that ends in a symbol matches whatever comes right after it.
    expect(hit('dd if=/dev/zero of=/dev/disk2')).toBe('dd if=')
  })

  it('普通の作業コマンドは当たらない', () => {
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

  it('パターン側の空白も正規化し、空のパターンは無視する', () => {
    expect(matchDenyPattern('rm -rf x', ['', '  rm   -rf '])).toBe('  rm   -rf ')
  })
})

describe('commandOf', () => {
  it('Bash の引数から command を取り出す。無ければ null', () => {
    expect(commandOf({ command: 'make all' })).toBe('make all')
    expect(commandOf({ command: '   ' })).toBeNull()
    expect(commandOf({})).toBeNull()
    expect(commandOf('make')).toBeNull()
    expect(commandOf(null)).toBeNull()
  })
})
