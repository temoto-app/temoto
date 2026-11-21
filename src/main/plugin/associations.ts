/**
 * The per-extension viewer default (TODO 907, wave 48 bundle D, ARCHITECTURE 7.1). VS Code's `workbench.editorAssociations`.
 *
 * Stored as one key in `app_settings` (`VIEWER_ASSOCIATIONS`, owned by main - TODO 85). **main only holds the table** -
 * which viewers are candidates (= which values may be accepted) is known by `PluginHost`, so the IPC handler re-validates the (extension, id)
 * from the renderer with `PluginHost.viewerChoices` before calling here. Independent of electron.
 */
import type { AppSettingsStore } from '../../common/settings.js'
import { VIEWER_ASSOCIATIONS } from '../../common/settings-keys.js'
import { isAssociationExt, type ViewerChoices } from '@shared/plugin.js'

export class ViewerAssociations {
  private current: Readonly<Record<string, string>>

  constructor(private readonly settings: Pick<AppSettingsStore, 'readTyped' | 'writeTyped' | 'removeTyped'>) {
    this.current = settings.readTyped(VIEWER_ASSOCIATIONS)
  }

  /** The current table (extension -> plugin id). */
  all(): Readonly<Record<string, string>> {
    return this.current
  }

  get(ext: string): string | null {
    return Object.hasOwn(this.current, ext) ? (this.current[ext] ?? null) : null
  }

  /** If `pluginId` is null, removes that extension's default (back to the normal way of choosing). */
  set(ext: string, pluginId: string | null): void {
    if (!isAssociationExt(ext)) return
    if (this.get(ext) === pluginId) return
    const next: Record<string, string> = { ...this.current }
    if (pluginId === null) delete next[ext]
    else next[ext] = pluginId
    this.save(next)
  }

  /** Resets everything to the default (Settings "Reset all to default"). */
  clear(): void {
    if (Object.keys(this.current).length === 0) return
    this.save({})
  }

  private save(next: Record<string, string>): void {
    this.current = next
    if (Object.keys(next).length === 0) this.settings.removeTyped(VIEWER_ASSOCIATIONS)
    else this.settings.writeTyped(VIEWER_ASSOCIATIONS, next)
  }
}

/** The side that knows the candidates (`PluginHost`). Tests pass a fake. */
export interface ViewerChoiceSource {
  viewerChoices(uri: string): ViewerChoices
}

/**
 * Makes the viewer chosen in "Open with another viewer" the default for that extension (TODO 907). **The renderer's values are not trusted**:
 * main re-checks that it is a string, that the extension exists, and that the viewer is among that URI's candidates; if not, it does nothing and returns false.
 * If the one chosen is number 1 of the normal selection (`builtinDefault`), it is removed from the table (= back to default) - no "same as default" row is left in the table.
 */
export function applyViewerChoice(
  source: ViewerChoiceSource,
  associations: Pick<ViewerAssociations, 'set'>,
  uri: unknown,
  pluginId: unknown
): boolean {
  if (typeof uri !== 'string' || typeof pluginId !== 'string') return false
  const { ext, choices } = source.viewerChoices(uri)
  if (!isAssociationExt(ext)) return false
  const choice = choices.find((candidate) => candidate.pluginId === pluginId)
  if (choice === undefined) return false
  associations.set(ext, choice.builtinDefault ? null : choice.pluginId)
  return true
}

/** Settings "Reset to default" (TODO 907). If `ext` is null, everything; otherwise only that extension. A broken value does nothing. */
export function resetViewerAssociation(associations: Pick<ViewerAssociations, 'set' | 'clear'>, ext: unknown): void {
  if (ext === null) associations.clear()
  else if (isAssociationExt(ext)) associations.set(ext, null)
}
