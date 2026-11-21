/**
 * Item 320 (wave 17 bundle I): a button that has only an icon (`icon-button` / `activity-item` /
 * `menu-button`) uses the shared bubble (`components/Tooltip.tsx`), not the OS `title`.
 * Buttons with text, and the full text of abbreviated strings (such as `title={row.entry.name}`), may keep the OS `title` (the same split as VS Code; a study note in TODO 320).
 *
 * This is a mechanical check in the same style as `theme-tokens.test.ts` (it checks the source as text).
 * It fails if a `<button>` / `<span>` / `<a>` element that has one of the classes `icon-button` / `activity-item` / `menu-button` has `title=` written in it.
 *
 * **A miss closed in item 354 (wave 19 bundle B):** the old `TAG_RE` (`[\s\S]*?>`) closed a tag at the first `>`, but an arrow function (`=>`) inside an attribute such as `ref={(el) => {...}}` or `onClick={() => {...}}` also contains a `>`, so it closed early and looked at a fragment cut before the real closing `>` (sometimes a fragment in which `class=` or `title=` had not yet appeared, which was the cause of the miss). It was fixed by changing it to `(?<!=)>` (a `>` not directly preceded by `=`). This fix newly found the reload button in `ContextUsageDialog.tsx` (a short tag with no `ref`, which the old regex should have caught, but it had not been found), so it was fixed here. The `.thread-new` in `ThreadList.tsx` (an old exception) was also fixed under item 354, and removed from the exceptions. The options with `icon` in `SegmentedControl.tsx` have no `icon-button`-type class, so they are outside this mechanical check; they were fixed separately, and their regression is held in `test/segmented-control-tooltip.test.ts`.
 *
 * **Item 373 (wave 20 bundle F) widened the target classes.** The bottom right of the Composer (attach, voice, reserve, interrupt, and the main button), and the ✎ / × on the rows of the reservation list, were icon-only buttons made with their own classes that have none of `icon-button` / `activity-item` / `menu-button` (`composer-attach` / `composer-voice` / `composer-reserve` / `composer-interrupt` / `composer-send` / `reservation-action`), so they were outside the mechanical check (the same kind of omission as in 354). It was closed by widening the list of classes. A general check that a button whose content is only an SVG is caught without looking at its class was considered, but the buttons are of mixed kinds: a button with `Spinner` as a child (`composer-send` and the like, where the spinner does not show progress), and buttons whose child is a text emoji (✎ / ×, `reservation-action`), so "SVG only" could not draw the line.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const COMPONENTS_DIR = 'src/renderer/src/components'

/** A file that bundle G (item 321) was touching at the same time (to be reviewed in the next wave). */
const EXEMPT_FILES = new Set(['SubtaskList.tsx', 'ThreadPane.tsx'])

const ICON_ONLY_CLASS =
  /\b(icon-button|activity-item|menu-button|composer-attach|composer-voice|composer-reserve|composer-interrupt|composer-send|reservation-action)\b/
// The body of an opening tag `<button ...>` / `<span ...>` / `<a ...>`. It does not close at the `>` of an arrow function (`=>`)
// (item 354: a negative lookbehind that excludes a `>` directly preceded by `=`).
const TAG_RE = /<(button|span|a)\b[\s\S]*?(?<!=)>/g

interface Violation {
  readonly file: string
  readonly line: number
  readonly snippet: string
}

function findViolations(): Violation[] {
  const dir = join(repoRoot, COMPONENTS_DIR)
  const files = readdirSync(dir).filter((f) => f.endsWith('.tsx') && !EXEMPT_FILES.has(f))
  const violations: Violation[] = []
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8')
    let match: RegExpExecArray | null
    TAG_RE.lastIndex = 0
    while ((match = TAG_RE.exec(text)) !== null) {
      const tag = match[0]
      if (ICON_ONLY_CLASS.test(tag) && /\btitle=/.test(tag)) {
        const line = text.slice(0, match.index).split('\n').length
        violations.push({ file, line, snippet: tag.slice(0, 160).replace(/\s+/g, ' ') })
      }
    }
  }
  return violations
}

describe('an icon-only button uses a Tooltip, not title (item 320)', () => {
  it('an element with icon-button / activity-item / menu-button does not write title=', () => {
    const violations = findViolations()
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([])
  })
})
