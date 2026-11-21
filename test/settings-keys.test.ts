/**
 * The key table of `app_settings` (TODO 85, `src/common/settings-keys.ts`).
 *
 * - All key strings are unique (a collision breeds the case where main reads a key that the index process writes).
 * - `parse(serialize(x))` round-trips (the reverse of: the key and value shapes are unchanged, so existing DB values are still read as they are).
 * - Broken or missing values fall back to the default (settings work with defaults even when missing; that is the policy throughout).
 *
 * Neither a model nor a DB is used.
 */
import { describe, expect, it } from 'vitest'
import {
  APPROVAL_AUTO_ALLOW_ALL,
  APPROVAL_AUTO_ALLOW_TOOLS,
  APPROVAL_BASH_DENY_PATTERNS,
  APPROVAL_RULES,
  CONVERSATION_HIGH_WATER,
  CONVERSATION_LAST_FULL,
  DEFAULT_SESSION_SETTINGS,
  EDITOR_ID,
  FS_ALLOWED_VOLUMES,
  MCP_LAST_GLOBAL_REPORT,
  NOTIFY_ENABLED,
  RAINBOW_TABLE,
  SCAN_DEEP_INTERVAL_MS,
  SCAN_INTERVAL_MS,
  SCAN_LAST_DEEP,
  SCAN_LAST_FULL,
  SCAN_OUTSIDE_HOME_INTERVAL_MS,
  SCAN_PRUNE,
  SCAN_RULES_VERSION,
  SESSION_SETTINGS,
  UI_LOCALE,
  UI_SHOW_HIDDEN_FILES,
  UI_THEME,
  WINDOW_BOUNDS,
  featureCacheKey,
  type SettingKey
} from '../src/common/settings-keys.js'
import { DEFAULT_BASH_DENY_PATTERNS, LEGACY_BASH_DENY_PATTERNS } from '../src/shared/thread.js'

// Lists all the table's keys with types ignored (only the key list and the owner check look at them). test/ allows any.
const ALL_KEYS: readonly SettingKey<any>[] = [
  SCAN_LAST_FULL,
  SCAN_RULES_VERSION,
  SCAN_INTERVAL_MS,
  SCAN_OUTSIDE_HOME_INTERVAL_MS,
  SCAN_LAST_DEEP,
  SCAN_DEEP_INTERVAL_MS,
  SCAN_PRUNE,
  FS_ALLOWED_VOLUMES,
  UI_LOCALE,
  UI_THEME,
  WINDOW_BOUNDS,
  SESSION_SETTINGS,
  APPROVAL_AUTO_ALLOW_ALL,
  APPROVAL_AUTO_ALLOW_TOOLS,
  APPROVAL_BASH_DENY_PATTERNS,
  APPROVAL_RULES,
  CONVERSATION_HIGH_WATER,
  CONVERSATION_LAST_FULL,
  RAINBOW_TABLE,
  EDITOR_ID,
  NOTIFY_ENABLED,
  MCP_LAST_GLOBAL_REPORT,
  UI_SHOW_HIDDEN_FILES,
  featureCacheKey('9.9.9')
]

describe('SettingKey の表', () => {
  it('鍵の文字列は全部一意', () => {
    const keys = ALL_KEYS.map((k) => k.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('owner は main か index のどちらか', () => {
    for (const def of ALL_KEYS) {
      expect(['main', 'index']).toContain(def.owner)
    }
  })
})

/** `parse(serialize(x))` returns `x`. Add one round-trip pair at a time. */
describe('parse(serialize(x)) の往復', () => {
  it('scan.lastFull', () => {
    const value = { finishedAt: 123, home: '/h', roots: ['/a', '/b'] }
    expect(SCAN_LAST_FULL.parse(SCAN_LAST_FULL.serialize(value))).toEqual(value)
    expect(SCAN_LAST_FULL.parse(SCAN_LAST_FULL.serialize(null))).toBeNull()
  })

  it('整数の鍵 (scan.rulesVersion など)', () => {
    for (const def of [
      SCAN_RULES_VERSION,
      SCAN_INTERVAL_MS,
      SCAN_OUTSIDE_HOME_INTERVAL_MS,
      SCAN_LAST_DEEP,
      SCAN_DEEP_INTERVAL_MS,
      SCAN_PRUNE,
      CONVERSATION_HIGH_WATER,
      CONVERSATION_LAST_FULL
    ]) {
      expect(def.parse(def.serialize(42))).toBe(42)
      expect(def.parse(def.serialize(0))).toBe(0)
    }
  })

  it('fs.allowedVolumes', () => {
    const value = [{ path: '/Volumes/x', label: 'x', volumeUuid: 'u1', addedAt: 1 }]
    expect(FS_ALLOWED_VOLUMES.parse(FS_ALLOWED_VOLUMES.serialize(value))).toEqual(value)
  })

  it('ui.locale / ui.theme', () => {
    expect(UI_LOCALE.parse(UI_LOCALE.serialize('ja'))).toBe('ja')
    expect(UI_THEME.parse(UI_THEME.serialize('dark'))).toBe('dark')
  })

  it('window.bounds', () => {
    const value = [{ x: 1, y: 2, width: 100, height: 200 }]
    expect(WINDOW_BOUNDS.parse(WINDOW_BOUNDS.serialize(value))).toEqual(value)
  })

  it('window.bounds (項目 36: 窓ごとの状態。旧形式も読める)', () => {
    const value = [
      { x: 1, y: 2, width: 100, height: 200, restore: true as const, threadId: 't1' },
      { x: 5, y: 6, width: 100, height: 200, restore: true as const },
      { x: 3, y: 4, width: 100, height: 200 }
    ]
    expect(WINDOW_BOUNDS.parse(WINDOW_BOUNDS.serialize(value))).toEqual(value)
    // The old format (bounds only) can still be read as the position of a closed window.
    expect(WINDOW_BOUNDS.parse('[{"x":1,"y":2,"width":100,"height":200}]')).toEqual([
      { x: 1, y: 2, width: 100, height: 200 }
    ])
    // If it is not an array, fall back to the default (empty).
    expect(WINDOW_BOUNDS.parse('{"restore":true}')).toEqual([])
  })

  it('session', () => {
    const value = { ...DEFAULT_SESSION_SETTINGS, maxConcurrent: 3, defaultModelId: 'sonnet' }
    expect(SESSION_SETTINGS.parse(SESSION_SETTINGS.serialize(value))).toEqual(value)
  })

  it('approval.* の 3 鍵', () => {
    expect(APPROVAL_AUTO_ALLOW_ALL.parse(APPROVAL_AUTO_ALLOW_ALL.serialize(false))).toBe(false)
    expect(
      APPROVAL_AUTO_ALLOW_TOOLS.parse(APPROVAL_AUTO_ALLOW_TOOLS.serialize(['Bash', 'WebFetch']))
    ).toEqual(['Bash', 'WebFetch'])
    expect(
      APPROVAL_BASH_DENY_PATTERNS.parse(APPROVAL_BASH_DENY_PATTERNS.serialize(['sudo']))
    ).toEqual(['sudo'])
  })

  it('approval.bashDenyPatterns: 旧い既定と完全に同じ保存値は新しい既定 (空) として読む (項目 167)', () => {
    expect(DEFAULT_BASH_DENY_PATTERNS).toEqual([])
    // No value -> default (empty).
    expect(APPROVAL_BASH_DENY_PATTERNS.parse(null)).toEqual([])
    // The old default written for 3 keys at once when one approval setting was touched -> empty.
    expect(APPROVAL_BASH_DENY_PATTERNS.parse(JSON.stringify(LEGACY_BASH_DENY_PATTERNS))).toEqual([])
    // What the user added or removed stays (1 added / 1 removed / reordered).
    const added = [...LEGACY_BASH_DENY_PATTERNS, 'terraform destroy']
    expect(APPROVAL_BASH_DENY_PATTERNS.parse(JSON.stringify(added))).toEqual(added)
    const removed = LEGACY_BASH_DENY_PATTERNS.filter((p) => p !== 'sudo')
    expect(APPROVAL_BASH_DENY_PATTERNS.parse(JSON.stringify(removed))).toEqual(removed)
    const reordered = [...LEGACY_BASH_DENY_PATTERNS].reverse()
    expect(APPROVAL_BASH_DENY_PATTERNS.parse(JSON.stringify(reordered))).toEqual(reordered)
    // Anything the user emptied stays empty.
    expect(APPROVAL_BASH_DENY_PATTERNS.parse('[]')).toEqual([])
  })

  it('approval.rules', () => {
    const value = [{ id: 'r1', toolName: 'Bash', command: 'make all', createdAt: 1 }]
    expect(APPROVAL_RULES.parse(APPROVAL_RULES.serialize(value))).toEqual(value)
  })

  it('features:<version>', () => {
    const def = featureCacheKey('2.1.207')
    expect(def.key).toBe('features:2.1.207')
    expect(def.parse(def.serialize('{"a":1}'))).toBe('{"a":1}')
  })

  it('thread.rainbowTable (項目 108)', () => {
    const value = { '/users/x/git/foo': 0, '/users/x/git/bar': 8 }
    expect(RAINBOW_TABLE.parse(RAINBOW_TABLE.serialize(value))).toEqual(value)
  })

  it('editor.id (項目 115)', () => {
    expect(EDITOR_ID.parse(EDITOR_ID.serialize('cursor'))).toBe('cursor')
  })

  it('notify.enabled (項目 72)', () => {
    expect(NOTIFY_ENABLED.parse(NOTIFY_ENABLED.serialize(false))).toBe(false)
    expect(NOTIFY_ENABLED.parse(NOTIFY_ENABLED.serialize(true))).toBe(true)
  })
})

describe('壊れた値・欠けた値は既定に倒れる', () => {
  it('無い (null) 場合', () => {
    expect(SCAN_LAST_FULL.parse(null)).toBeNull()
    expect(SCAN_RULES_VERSION.parse(null)).toBeNull()
    expect(FS_ALLOWED_VOLUMES.parse(null)).toEqual([])
    expect(UI_LOCALE.parse(null)).toBe('system')
    expect(UI_THEME.parse(null)).toBe('system')
    expect(WINDOW_BOUNDS.parse(null)).toEqual([])
    expect(SESSION_SETTINGS.parse(null)).toEqual(DEFAULT_SESSION_SETTINGS)
    expect(APPROVAL_AUTO_ALLOW_ALL.parse(null)).toBe(true)
    expect(APPROVAL_AUTO_ALLOW_TOOLS.parse(null)).toEqual(['Bash', 'WebFetch', 'WebSearch'])
    expect(APPROVAL_RULES.parse(null)).toEqual([])
    expect(RAINBOW_TABLE.parse(null)).toEqual({})
    expect(EDITOR_ID.parse(null)).toBe('vscode')
    expect(NOTIFY_ENABLED.parse(null)).toBe(true)
  })

  it('壊れた JSON', () => {
    expect(SCAN_LAST_FULL.parse('not json')).toBeNull()
    expect(FS_ALLOWED_VOLUMES.parse('not json')).toEqual([])
    expect(WINDOW_BOUNDS.parse('not json')).toEqual([])
    expect(SESSION_SETTINGS.parse('not json')).toEqual(DEFAULT_SESSION_SETTINGS)
    expect(APPROVAL_RULES.parse('not json')).toEqual([])
    expect(RAINBOW_TABLE.parse('not json')).toEqual({})
    expect(EDITOR_ID.parse('not json')).toBe('vscode')
    expect(NOTIFY_ENABLED.parse('not json')).toBe(true)
  })

  it('形の合わない要素は落とすだけで、他は残す (fs.allowedVolumes / approval.rules)', () => {
    const raw = JSON.stringify([
      { path: '/Volumes/ok', label: 'ok', volumeUuid: null, addedAt: 1 },
      { path: 123, label: 'bad' }
    ])
    expect(FS_ALLOWED_VOLUMES.parse(raw)).toEqual([
      { path: '/Volumes/ok', label: 'ok', volumeUuid: null, addedAt: 1 }
    ])

    const rulesRaw = JSON.stringify([
      { id: 'r1', toolName: 'Bash', command: null, createdAt: 1 },
      { id: '', toolName: 'Bash', command: null, createdAt: 1 }
    ])
    expect(APPROVAL_RULES.parse(rulesRaw)).toEqual([
      { id: 'r1', toolName: 'Bash', command: null, createdAt: 1 }
    ])

    // thread.rainbowTable (item 108): values out of range or not integers are discarded.
    const rainbowRaw = JSON.stringify({ ok: 3, negative: -1, tooBig: 16, notInt: 1.5, ok2: 0 })
    expect(RAINBOW_TABLE.parse(rainbowRaw)).toEqual({ ok: 3, ok2: 0 })
  })

  it('editor.id (項目 115): 未知の値は既定 (VS Code) に倒す', () => {
    expect(EDITOR_ID.parse(JSON.stringify('emacs'))).toBe('vscode')
  })

  it('範囲外・NaN の数は既定に戻す (session の maxConcurrent / idleTimeoutMs)', () => {
    const raw = JSON.stringify({ maxConcurrent: 999, idleTimeoutMs: null })
    const parsed = SESSION_SETTINGS.parse(raw)
    expect(parsed.maxConcurrent).toBe(DEFAULT_SESSION_SETTINGS.maxConcurrent)
    expect(parsed.idleTimeoutMs).toBe(DEFAULT_SESSION_SETTINGS.idleTimeoutMs)
  })

  it('整数の鍵に非数を置くと null', () => {
    expect(SCAN_PRUNE.parse('not-a-number')).toBeNull()
  })
})

describe('mcp.lastGlobalReport (項目 164、第 13 波 束 J)', () => {
  it('owner は main で、往復する', () => {
    expect(MCP_LAST_GLOBAL_REPORT.key).toBe('mcp.lastGlobalReport')
    expect(MCP_LAST_GLOBAL_REPORT.owner).toBe('main')
    const report = {
      at: 1_790_000_000_000,
      servers: [
        { name: 'Gmail', state: 'needs-auth' as const, source: 'claudeai' },
        { name: 'mine', state: 'connected' as const, source: 'user' },
        { name: 'odd', state: 'other' as const, source: null }
      ]
    }
    expect(MCP_LAST_GLOBAL_REPORT.parse(MCP_LAST_GLOBAL_REPORT.serialize(report))).toEqual(report)
  })

  it('無い・壊れた値は null (= まだ報告が無い)', () => {
    expect(MCP_LAST_GLOBAL_REPORT.parse(null)).toBeNull()
    expect(MCP_LAST_GLOBAL_REPORT.parse('{')).toBeNull()
    expect(MCP_LAST_GLOBAL_REPORT.parse('[]')).toBeNull()
    expect(MCP_LAST_GLOBAL_REPORT.parse(JSON.stringify({ at: 'x', servers: [] }))).toBeNull()
    expect(MCP_LAST_GLOBAL_REPORT.parse(JSON.stringify({ at: 1, servers: 'x' }))).toBeNull()
  })

  it('形の合わない要素 (名前が空・未知の状態・出所が数) は落とすだけで、他は残す', () => {
    const raw = JSON.stringify({
      at: 5,
      servers: [
        { name: '', state: 'connected', source: 'user' },
        { name: 'a', state: 'exploded', source: 'user' },
        { name: 'b', state: 'failed', source: 3 },
        null,
        { name: 'ok', state: 'failed', source: 'plugin' }
      ]
    })
    expect(MCP_LAST_GLOBAL_REPORT.parse(raw)).toEqual({
      at: 5,
      servers: [{ name: 'ok', state: 'failed', source: 'plugin' }]
    })
  })
})

describe('ui.showHiddenFiles (TODO 261)', () => {
  it('既定は偽 (隠す)、壊れた値も偽、往復する。owner は main', () => {
    expect(UI_SHOW_HIDDEN_FILES.owner).toBe('main')
    expect(UI_SHOW_HIDDEN_FILES.parse(null)).toBe(false)
    expect(UI_SHOW_HIDDEN_FILES.parse('not json')).toBe(false)
    expect(UI_SHOW_HIDDEN_FILES.parse('"true"')).toBe(false)
    expect(UI_SHOW_HIDDEN_FILES.parse(UI_SHOW_HIDDEN_FILES.serialize(true))).toBe(true)
    expect(UI_SHOW_HIDDEN_FILES.parse(UI_SHOW_HIDDEN_FILES.serialize(false))).toBe(false)
  })
})
