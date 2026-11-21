/**
 * The font of the body of a Gmail draft (TODO 1229).
 * - Saving: the default is default, a broken value falls back to default, and choosing again persists it
 * - Additional instructions: default adds nothing; monospace is a fixed sentence (htmlBody, monospace, and the user's own specification win)
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { GMAIL_DRAFT_FONT, agentSettingAccess } from '../src/common/settings-keys.js'
import { GmailDraftFontPreference } from '../src/main/gmail-draft-font.js'
import { DEFAULT_GMAIL_DRAFT_FONT, GMAIL_DRAFT_FONTS, isGmailDraftFont } from '../src/shared/gmail-draft-font.js'
import { gatewayInstructions, gmailDraftFontInstruction, loadCompatTable } from '../src/main/session/adapter/compat.js'

function open(): Db {
  const database = new Database(':memory:')
  runMigrations(database)
  return database
}

describe('Gmail draft font (TODO 1229)', () => {
  it('the set of values and the default', () => {
    expect(GMAIL_DRAFT_FONTS).toEqual(['default', 'monospace'])
    expect(DEFAULT_GMAIL_DRAFT_FONT).toBe('default')
    expect(isGmailDraftFont('monospace')).toBe(true)
    expect(isGmailDraftFont('serif')).toBe(false)
    expect(isGmailDraftFont(null)).toBe(false)
    expect(agentSettingAccess(GMAIL_DRAFT_FONT)).toBe('display')
  })

  it('saving: the default is default, re-selecting persists it, and a broken value falls back to default', () => {
    const db = open()
    const settings = new AppSettingsStore(db)
    const preference = new GmailDraftFontPreference(settings)
    expect(preference.get()).toBe('default')
    expect(preference.set('monospace')).toBe('monospace')
    expect(new GmailDraftFontPreference(settings).get()).toBe('monospace')
    settings.write(GMAIL_DRAFT_FONT.key, 'comic-sans')
    expect(preference.get()).toBe('default')
    db.close()
  })

  it('extra instruction: default / unspecified is null, monospace is a fixed sentence', () => {
    expect(gmailDraftFontInstruction(undefined)).toBeNull()
    expect(gmailDraftFontInstruction('default')).toBeNull()
    const text = gmailDraftFontInstruction('monospace')
    expect(text).not.toBeNull()
    expect(text).toContain('htmlBody')
    expect(text).toContain('font-family: monospace')
    expect(text).toContain('plain')
    expect(text).toMatch(/user asks for a different/)
    // Only fixed text (no time or path is inserted).
    expect(text).not.toMatch(/20\d\d-\d\d-\d\d/)
    expect(text).not.toMatch(/claude/i)
  })

  it('the gateway instruction does not change even for monospace (it stays as is for the default)', () => {
    const table = loadCompatTable()
    expect(gatewayInstructions(table)).not.toContain('htmlBody')
  })
})
