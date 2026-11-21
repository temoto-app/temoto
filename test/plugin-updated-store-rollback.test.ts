/**
 * Review of wave 73 (TODO 1144 stage 2): when `UpdatedPluginStore.install` places the same version again and either the rename of the new contents or the write of the record fails, the verified old copy is restored. (If the old copy were deleted first, only the record would remain and the copy would be gone.)
 *
 * A rename failure is hard to produce on a real FS, so only `renameSync` from `node:fs` is replaced (the rest is real).
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdatedPluginRecord } from '../src/common/settings-keys.js'
import { parseReason } from '../src/shared/reason.js'

const failRename = vi.hoisted(() => ({ when: null as null | ((from: string, to: string) => boolean) }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (failRename.when?.(from, to) === true) throw Object.assign(new Error('EXDEV: simulated'), { code: 'EXDEV' })
      actual.renameSync(from, to)
    }
  }
})

const { UpdatedPluginStore, treeDigest } = await import('../src/main/plugin/updated-store.js')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-plugin-rollback-'))
  failRename.when = null
})

afterEach(() => {
  failRename.when = null
  rmSync(dir, { recursive: true, force: true })
})

function writePlugin(at: string, body: string): void {
  mkdirSync(join(at, 'viewer'), { recursive: true })
  writeFileSync(join(at, 'manifest.json'), JSON.stringify({ id: 'aios.text', name: 'aios.text', version: '1.2.0' }))
  writeFileSync(join(at, 'viewer', 'index.html'), body)
}

function setup() {
  const records = {
    value: {} as Record<string, UpdatedPluginRecord>,
    read: () => records.value,
    write: (next: Readonly<Record<string, UpdatedPluginRecord>>) => {
      records.value = { ...next }
    }
  }
  const store = new UpdatedPluginStore(join(dir, 'updates'), records)
  const staged = (body: string): string => {
    const bundle = join(store.createStaging(), 'bundle')
    writePlugin(bundle, body)
    return bundle
  }
  const placed = store.install('aios.text', '1.2.0', staged('old'))
  const before = { ...records.value }
  return { store, records, staged, placed, before }
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
    return undefined
  } catch (err) {
    return parseReason(err instanceof Error ? err.message : String(err))?.code
  }
}

describe('UpdatedPluginStore.install の置き直しの失敗', () => {
  it('新しい中身の rename が失敗したら旧を戻し、記録も旧のまま (読める)', () => {
    const { store, records, staged, placed, before } = setup()
    const next = staged('new')
    failRename.when = (from) => from === next
    expect(codeOf(() => store.install('aios.text', '1.2.0', next))).toBe('update-install-failed')
    expect(readFileSync(join(placed, 'viewer', 'index.html'), 'utf8')).toBe('old')
    expect(records.value).toEqual(before)
    expect(records.value['aios.text']?.digest).toBe(treeDigest(placed))
    expect(store.resolve('aios.text', '1.0.0')).toEqual({ dir: placed, version: '1.2.0' })
  })

  it('記録の書き込みが失敗したら新しい中身を消して旧を戻す', () => {
    const { store, records, staged, placed, before } = setup()
    records.write = () => {
      throw new Error('db closed')
    }
    expect(codeOf(() => store.install('aios.text', '1.2.0', staged('new')))).toBe('update-install-failed')
    expect(readFileSync(join(placed, 'viewer', 'index.html'), 'utf8')).toBe('old')
    expect(records.value).toEqual(before)
    expect(store.resolve('aios.text', '1.0.0')).toEqual({ dir: placed, version: '1.2.0' })
  })

  it('旧を脇へよける rename が失敗したら何も変えない', () => {
    const { store, records, staged, placed, before } = setup()
    failRename.when = (from) => from === placed
    const next = staged('new')
    expect(codeOf(() => store.install('aios.text', '1.2.0', next))).toBe('update-install-failed')
    expect(readFileSync(join(placed, 'viewer', 'index.html'), 'utf8')).toBe('old')
    expect(records.value).toEqual(before)
    expect(readdirSync(join(dir, 'updates', 'aios.text'))).toEqual(['1.2.0'])
  })

  it('成功したら脇へよけた旧は残らない', () => {
    const { store, records, staged, placed } = setup()
    store.install('aios.text', '1.2.0', staged('new'))
    expect(readFileSync(join(placed, 'viewer', 'index.html'), 'utf8')).toBe('new')
    expect(records.value['aios.text']?.digest).toBe(treeDigest(placed))
    const leftovers = readdirSync(join(dir, 'updates'), { recursive: true }).map(String).filter((name) => name.endsWith('.replaced'))
    expect(leftovers).toEqual([])
  })
})
