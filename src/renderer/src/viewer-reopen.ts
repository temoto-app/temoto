/**
 * "Open with another viewer" (TODO 907, VS Code's Reopen Editor With...) pure functions. Independent of React and electron.
 *
 * - The entry point is one icon in ViewerPane's heading. Pressing it shows a menu of the viewers that offer to handle that file
 *   (a check mark on the current viewer, "(default)" on the first in the normal selection order).
 * - Choosing one makes main set it as the default for that extension (`viewer.choose`; main re-checks that it is among the candidates), and ViewerPane re-opens the same URI
 *   (the `reopen` number of TODO 471). The unsaved draft stays in the table (`viewerDrafts`), so it is passed to the re-opened
 *   viewer by the restore in 1).
 * - **Do not switch to a viewer that cannot edit while there is an unsaved draft** (`blocked`). Switching would hide the draft and make saving
 *   impossible (it stays in the table but looks gone to the user). The reason is shown on a band.
 */
import { isAssociationExt, type ViewerChoices } from '@shared/plugin.js'

/**
 * Whether to show the entry point. Not shown for an extension whose default cannot be remembered (none, or not matching `isAssociationExt` - Japanese, `~`, 33 characters or more, etc.;
 * main's `applyViewerChoice` refuses by the same rule), or when there is one candidate or fewer.
 */
export function showReopenWith(choices: ViewerChoices | null): boolean {
  return choices !== null && isAssociationExt(choices.ext) && choices.choices.length >= 2
}

export type ReopenDecision = 'none' | 'blocked' | 'reopen'

export function reopenDecision(input: {
  readonly currentPluginId: string | null
  readonly targetPluginId: string
  readonly targetEditable: boolean
  readonly dirty: boolean
}): ReopenDecision {
  if (input.currentPluginId === input.targetPluginId) return 'none'
  if (input.dirty && !input.targetEditable) return 'blocked'
  return 'reopen'
}

/** The material for one menu line's text. A `builtinDefault` line gets "(default)" added to its name (same as VS Code). */
export interface ReopenMenuEntry {
  readonly pluginId: string
  readonly name: string
  readonly builtinDefault: boolean
  readonly checked: boolean
  readonly editable: boolean
}

export function reopenMenuEntries(choices: ViewerChoices, currentPluginId: string | null): readonly ReopenMenuEntry[] {
  return choices.choices.map((choice) => ({
    pluginId: choice.pluginId,
    name: choice.name,
    builtinDefault: choice.builtinDefault,
    checked: choice.pluginId === currentPluginId,
    editable: choice.editable
  }))
}
