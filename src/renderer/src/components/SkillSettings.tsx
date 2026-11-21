/**
 * The "Skills" section of the settings screen (TODO 773, ARCHITECTURE.md 4.5.3). The control of one item of the settings editor
 * (the title and description are drawn by the frame in `Settings.tsx`, the same form as `McpSettings`).
 *
 * - The list is provided by main (only main's adapter knows where the locations are, constraint 6). It is divided by headings per scope (user / project /
 *   plugin). A project skill is one of **the working folder of the conversation currently shown**.
 *   If there is no conversation, only user and plugin ones.
 * - Open = open the main file in the ViewerPane (Markdown, read-only). Delete = move to the trash (no confirmation dialog
 *   is shown, since it can be undone; the policy of TODO 167). A strip tells the user right after deleting. A plugin's skill is read-only and cannot be deleted.
 * - New = put the same template as the Composer's "Create a new skill..." (TODO 564) into the current conversation's input field (not sent).
 *   If the input field has a draft, it is appended after it. aios does not write the shape of a skill file.
 * - TODO 1099: below, "Installed CLI plugins" and "Install a CLI plugin (official Marketplace)" (`PluginCatalog`). Installing and removing are done by the
 *   CLI, and when finished the skill list is re-read.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SkillEntry, SkillListing, SkillScope } from '@shared/skills.js'
import { useT } from '../i18n/index.js'
import { selectActiveCwd } from '../active-cwd.js'
import { useStore } from '../store.js'
import { useThreads } from '../threadStore.js'
import { useSettingsEditor } from '../settingsEditorStore.js'
import { beginNewChat, endNewChat, newChatKey, sharedNewChatLedger } from '../new-chat-guard.js'
import { PluginCatalog } from './PluginCatalog.js'

const SCOPES: readonly SkillScope[] = ['user', 'project', 'plugin']
/** How long the strip stays shown. */
const NOTICE_MS = 6000

export function SkillSettings(): React.JSX.Element {
  const t = useT()
  const cwdUri = useThreads(selectActiveCwd)
  const activeThreadId = useThreads((state) => state.activeThreadId)
  const [listing, setListing] = useState<SkillListing | null>(null)
  const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null)
  const timer = useRef<number | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    setListing(await window.aios.skills.list(cwdUri))
  }, [cwdUri])

  useEffect(() => {
    let alive = true
    void window.aios.skills.list(cwdUri).then((next) => {
      if (alive) setListing(next)
    })
    return () => {
      alive = false
    }
  }, [cwdUri])

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )

  const announce = (text: string, failed: boolean): void => {
    setNotice({ text, failed })
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setNotice(null), NOTICE_MS)
  }

  const trash = async (skill: SkillEntry): Promise<void> => {
    if (skill.scope === 'plugin') return
    const result = await window.aios.skills.trash({ scope: skill.scope, dirName: skill.dirName, cwdUri })
    announce(t(result.ok ? 'settings.skills.trashed' : 'settings.skills.trashFailed', { name: skill.name }), !result.ok)
    await reload()
  }

  // TODO 824: if no conversation is selected (nothing is auto-selected right after launch, item 80), create a new conversation without a dialog
  // and then put in the template. A state that cannot be pressed is not created.
  const startNew = async (): Promise<void> => {
    let state = useThreads.getState()
    if (state.activeThreadId === null) {
      // To avoid two being created by a double press, go through the same guard as NewChatButton (item 280-3).
      const key = newChatKey(cwdUri)
      if (!beginNewChat(sharedNewChatLedger, key, Date.now())) return
      let ok = false
      try {
        ok = await state.createThreadInFolder(cwdUri)
      } finally {
        endNewChat(sharedNewChatLedger, key, Date.now(), ok)
      }
      if (!ok) return
      state = useThreads.getState()
    }
    const threadId = state.activeThreadId
    if (threadId === null) return
    const template = t('composer.slashCreateSkillPrompt')
    const current = state.drafts[threadId] ?? ''
    state.setDraft(threadId, current.trim() === '' ? template : `${current}\n\n${template}`)
    // If the settings screen keeps covering the input field, the template goes in but cannot be seen, so it looks like "nothing happens". Close it to show the input field.
    useSettingsEditor.getState().close()
    useThreads.setState({ composerFocus: threadId })
  }

  return (
    <div className="skill-settings">
      <div className="settings-actions">
        <button type="button" onClick={() => void startNew()}>
          {t('settings.skills.new')}
        </button>
      </div>
      {activeThreadId === null ? <p className="hint">{t('settings.skills.newNeedsThread')}</p> : null}
      {notice === null ? null : (
        <p className={notice.failed ? 'skill-notice denied' : 'skill-notice'} role="status">
          {notice.text}
        </p>
      )}
      {listing === null ? null : (
        <>
          {listing.projectChecked ? null : <p className="hint">{t('settings.skills.projectHint')}</p>}
          {listing.skills.length === 0 ? <p className="hint">{t('settings.skills.none')}</p> : null}
          {SCOPES.map((scope) => {
            const rows = listing.skills.filter((skill) => skill.scope === scope)
            if (rows.length === 0) return null
            return (
              <div className="skill-settings-group" key={scope}>
                <h4 className="skill-settings-scope">{t(`settings.skills.scope.${scope}`)}</h4>
                <ul className="skill-settings-list" role="list">
                  {rows.map((skill) => (
                    <li key={`${skill.scope}:${skill.pluginName ?? ''}:${skill.dirName}`}>
                      <div className="skill-settings-main">
                        <span className="skill-settings-name">{skill.name}</span>
                        {skill.pluginName === null ? null : <span className="skill-settings-tag">{skill.pluginName}</span>}
                        {skill.linked ? <span className="skill-settings-tag">{t('settings.skills.linked')}</span> : null}
                        {skill.readOnly ? <span className="skill-settings-tag">{t('settings.skills.readOnly')}</span> : null}
                        <span className="skill-settings-buttons">
                          <button type="button" onClick={() => useStore.getState().select(skill.uri)}>
                            {t('settings.skills.open')}
                          </button>
                          {skill.readOnly ? null : (
                            <button type="button" className="danger" onClick={() => void trash(skill)}>
                              {t('settings.skills.delete')}
                            </button>
                          )}
                        </span>
                      </div>
                      <div className="hint skill-settings-description">
                        {skill.description === '' ? t('settings.skills.noDescription') : skill.description}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </>
      )}
      <PluginCatalog onChanged={() => void reload()} />
    </div>
  )
}
