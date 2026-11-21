/**
 * Item 284 (wave 16 bundle B): in a narrow pane the four choices of Model / Thinking do not get cut off on the left.
 * Item 309-1 (wave 16 bundle I): in a 280px-wide pane the four Model choices (257px with versions) do not get cut off on the right. When narrow, a short name without the version is shown,
 * and if that still does not fit, the group wraps inside.
 *
 * Reads the CSS to check the shape of the rules; the switching between short names is checked with the pure function (`segmentLabels`) and
 * the adapter's `buildModelChoices` (`label` in the compat table = without version). Real widths are for the owner to confirm.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { segmentLabels } from '../src/renderer/src/composer-choice.js'
import { buildModelChoices, modelLabel } from '../src/main/session/adapter/models.js'
import { loadCompatTable } from '../src/main/session/adapter/compat.js'

const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

/** All blocks of `@container composer (max-width: Npx) { … }`. */
function narrowBlocks(): { readonly width: number; readonly body: string }[] {
  const re = /@container composer \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g
  return [...css.matchAll(re)].map((b) => ({ width: Number(b[1]), body: b[2] ?? '' }))
}

describe('項目 284: 狭い Composer の下段', () => {
  it('.composer-settings は折り返せて、枠より広がらない', () => {
    const rules = [...css.matchAll(/\n\.composer-settings \{([^}]*)\}/g)].map((m) => m[1]).join('\n')
    expect(rules).toContain('flex-wrap: wrap')
    expect(rules).toContain('min-width: 0')
    expect(rules).toContain('max-width: 100%')
  })

  it('composer コンテナが狭いとき選択肢の余白を詰める', () => {
    const blocks = narrowBlocks().filter((b) => /\.segmented button \{ padding:/.test(b.body))
    expect(blocks.length).toBe(1)
    expect(blocks[0]?.width).toBeLessThan(640)
  })
})

describe('項目 309-1: 狭い Composer では版を落とし、それでも入らなければ群の中を折り返す', () => {
  it('短い名前は既定で隠れ、狭いコンテナでだけ出る (広いペインの見え方は変えない)', () => {
    // Outside the container query: no short name is shown.
    const outside = css.replace(/@container[^{]*\{[\s\S]*?\n\}/g, '')
    expect(outside).toMatch(/\n\.seg-short \{ display: none; \}/)
    expect(outside).not.toMatch(/\.seg-full \{[^}]*display: none/)
    // Inside a narrow container (≤ 400px): hide the normal name and show the short name.
    const block = narrowBlocks().find((b) => b.body.includes('.seg-short'))
    expect(block).toBeDefined()
    expect(block?.width).toBeLessThanOrEqual(400)
    expect(block?.body).toMatch(/\.seg-full \{ display: none; \}/)
    expect(block?.body).toMatch(/\.seg-short \{ display: inline; \}/)
  })

  it('狭いコンテナでは .segmented が折り返せて、枠より広がらない', () => {
    const block = narrowBlocks().find((b) => b.body.includes('.seg-short'))
    const segmented = /\.segmented \{([^}]*)\}/.exec(block?.body ?? '')?.[1] ?? ''
    expect(segmented).toContain('flex-wrap: wrap')
    expect(segmented).toContain('max-width: 100%')
    // While on one line, do not change the height (keep the alignment of item 156).
    expect(segmented).toContain('min-height: var(--composer-control-height)')
  })

  it('segmentLabels: 短い名前があって違うときだけ 2 つ描く', () => {
    expect(segmentLabels('Opus 4.8', 'Opus')).toEqual({ full: 'Opus 4.8', short: 'Opus' })
    // Version unknown (name only) / no short name / empty -> just one (the same at any width).
    expect(segmentLabels('Opus', 'Opus')).toEqual({ full: 'Opus', short: null })
    expect(segmentLabels('Opus', undefined)).toEqual({ full: 'Opus', short: null })
    expect(segmentLabels('Opus 4.8', '  ')).toEqual({ full: 'Opus 4.8', short: null })
    // The Thinking choices have no short name.
    expect(segmentLabels('Medium', undefined).short).toBeNull()
  })

  it('adapter の選択肢: label は版つき、shortLabel は compat の表の名前だけ', () => {
    const table = loadCompatTable()
    const learned = new Map(
      table.models.list.map((entry) => [
        entry.id,
        { resolved: entry.reportedAs?.[entry.reportedAs.length - 1] ?? entry.id, supportsEffort: true, effortLevels: null }
      ])
    )
    const choices = buildModelChoices(table, learned)
    expect(choices.map((c) => c.shortLabel)).toEqual(table.models.list.map((e) => e.label))
    for (const [index, choice] of choices.entries()) {
      const entry = table.models.list[index]
      if (entry === undefined) throw new Error('entry')
      expect(choice.label).toBe(modelLabel(table, entry, learned.get(entry.id)))
      // When the version is known, the label is long, and the short name does not include the version.
      expect(choice.label.startsWith(`${choice.shortLabel ?? ''} `)).toBe(true)
      expect(segmentLabels(choice.label, choice.shortLabel).short).toBe(entry.label)
    }
    // While the version is unknown, it is the same as the label = no switching.
    for (const choice of buildModelChoices(table, new Map())) {
      expect(segmentLabels(choice.label, choice.shortLabel).short).toBeNull()
    }
  })
})
