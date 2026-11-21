/**
 * Showing / hiding the heading of the cwd-order group (item 193) and the "New" button beside it (item 194).
 * Only pure functions that depend on neither React nor the store (`test/thread-list-heading.test.ts`).
 *
 * The form follows VS Code's Open Editors "GROUP 1" heading: uppercase, letter-spacing, small bold, pale color,
 * **no count**. In cwd order the cwd name at the head of a row (`thread-row-cwd`) is not shown (it would duplicate the heading).
 */
import type { BackendChoice, CreateThreadInput, SessionSettings } from '@shared/thread.js'
import type { ThinkingLevel } from '@shared/agent.js'
import type { Translate } from './i18n/index.js'
import type { ThreadListItem, ThreadSortKey } from './thread-sort.js'
import { resolveModelChoice, resolveThinkingChoice } from './composer-choice.js'

type FolderItem = Extract<ThreadListItem, { kind: 'folder' }>

/** What the heading shows. It has no count (VS Code has none, item 193). */
export interface FolderHeadingView {
  /** The heading text. For the no-folder group (the scratch area) it is the name from the dictionary. Uppercasing is done by CSS (it only affects Latin letters). */
  readonly name: string
  /** The full path shown on mouse hover (item 55). The name when there is no folder or the path is unknown. */
  readonly title: string
  /** `title` / `aria-label` of the "New" button (item 194). */
  readonly createLabel: string
}

export function folderHeadingView(
  item: Pick<FolderItem, 'name' | 'uri'>,
  t: Translate,
  pathOf: (uri: string) => string | null
): FolderHeadingView {
  const scratch = item.name === '' || item.uri === null
  const name = item.name === '' ? t('threads.sort.noFolder') : item.name
  const path = item.uri === null ? null : pathOf(item.uri)
  return {
    name,
    title: path ?? name,
    createLabel: scratch ? t('threads.newScratchHere') : t('threads.newInFolder', { name: item.name })
  }
}

/** Whether to show the cwd name at the head of a row. It duplicates the heading in cwd order, so it is not shown (item 193). */
export function showsRowCwd(sortKey: ThreadSortKey, cwdName: string): boolean {
  return sortKey !== 'cwd' && cwdName !== ''
}

/**
 * Whether to put "new chat in this folder" (`NewChatButton`) right after the cwd name of a row (TODO 488, wave 25 bundle C).
 * **Shown in recent order and unread order** (unread order was aligned in TODO 867): in cwd order the group heading already has the same button
 * (`thread-folder-new`, item 194), so it is not shown. Not placed when the row shows no cwd name (scratch area, old rows without a cwd).
 * It is visible only on hover and on the selected row (same way as `has-new-chat` in the Files tree), which CSS decides.
 */
export function showsRowNewChat(
  sortKey: ThreadSortKey,
  thread: { readonly cwdName: string; readonly cwdUri: string }
): boolean {
  return sortKey !== 'cwd' && showsRowCwd(sortKey, thread.cwdName) && thread.cwdUri !== ''
}

/**
 * The tooltip for the subagent count (a small observation in TODO 322, wave 17 bundle J): fixes the EN singular
 * (`1 subagents running`). The dictionary has no convention for plurals (the "no plurals needed" in `i18n/index.ts` is about
 * fixed wording; this is the only place where the sentence changes with a count), so the key is split into `.one` / `.other`
 * and the caller (here) picks by count. JA uses the same wording for both (it never had a singular problem).
 */
export function subtasksTooltip(count: number, t: Translate): string {
  return t(count === 1 ? 'threadList.subtasks.tooltip.one' : 'threadList.subtasks.tooltip.other', { count })
}

/**
 * The input of the thread created by the heading's "New" (item 194). The no-folder group gets a new scratch area (T19),
 * the others get that group's cwd. The model and thinking are sent as **concrete values** (lesson of item 121: if omitted,
 * main creates with null = "let the backend decide", and the Composer display and the actual model diverge).
 * Strict mode is not sent (item 150, omitted = OFF).
 */
export function folderCreateInput(
  uri: string | null,
  backend: BackendChoice,
  settings: Pick<SessionSettings, 'defaultModelId' | 'defaultThinking'> | null
): CreateThreadInput {
  return {
    ...(uri === null ? { scratch: true } : { cwdUri: uri }),
    backend: backend.id,
    modelId: backend.modelSelect
      ? resolveModelChoice(null, settings?.defaultModelId ?? null, backend.models)
      : null,
    thinking: backend.thinkingLevel ? resolveThinkingChoice(null, settings?.defaultThinking ?? null) : null
  }
}

/**
 * TODO 972: the input of "New conversation" of a role (Teammate). The working folder is not sent - main takes it from the role (a
 * scratch area when the role has none). Model / Thinking are sent as **concrete values** for the same reason as `folderCreateInput`
 * (item 121): the role's choice first, then the settings' default, then the head of the list.
 * Code-review (wave 96 fix Y): a role's Model that is no longer in the backend's list is treated as unset (the settings' default), so the
 * Teammate's "New conversation" does not fail with `model-not-selectable` every time. An empty list (not loaded yet) keeps the role's choice
 * and main falls back the same way.
 */
export function roleCreateInput(
  role: { readonly id: string; readonly modelId: string | null; readonly thinking: ThinkingLevel | null },
  backend: BackendChoice,
  settings: Pick<SessionSettings, 'defaultModelId' | 'defaultThinking'> | null
): CreateThreadInput {
  const roleModel =
    role.modelId !== null && backend.models.length > 0 && !backend.models.some((m) => m.id === role.modelId)
      ? null
      : role.modelId
  return {
    roleId: role.id,
    backend: backend.id,
    modelId: backend.modelSelect
      ? resolveModelChoice(roleModel, settings?.defaultModelId ?? null, backend.models)
      : null,
    thinking: backend.thinkingLevel ? resolveThinkingChoice(role.thinking, settings?.defaultThinking ?? null) : null
  }
}
