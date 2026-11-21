/**
 * Sidebar for a plugin's own list (TODO 1039, ARCHITECTURE.md 7.5). Modeled on VS Code's Tree View, and
 * **the host (this component) does the drawing**. The plugin only passes row data through the Broker and never touches the DOM.
 *
 * - Arrow keys / Enter / expand-collapse use `treeKey` in `pluginView.ts` (the same as VS Code's Tree View).
 * - Selecting a row with a `uri` opens it in the plugin's own viewer (main has already limited the scheme to the plugin viewer's).
 * - The collapsed state is remembered only inside this component (kept even if the plugin replaces the rows, as long as the id is the same).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../i18n/index.js'
import { useStore } from '../store.js'
import { requestPluginRefresh, treeKey, usePluginSurfaces, visibleRows } from '../pluginView.js'

export function PluginViewMode(): React.JSX.Element {
  const t = useT()
  const snapshot = usePluginSurfaces((state) => state.snapshot)
  const selectedPluginId = usePluginSurfaces((state) => state.selectedPluginId)
  const view = snapshot.sidebar.find((entry) => entry.pluginId === selectedPluginId) ?? snapshot.sidebar[0] ?? null
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [active, setActive] = useState(0)
  const select = useStore((state) => state.select)
  const listRef = useRef<HTMLDivElement>(null)
  const items = useMemo(() => visibleRows(view?.rows ?? [], collapsed), [view, collapsed])
  // TODO 1264: a list opened before the plugin has passed any rows asks for one run now (once per window, `requestPluginRefresh`).
  const hasOwnRows = selectedPluginId !== null && snapshot.sidebar.some((entry) => entry.pluginId === selectedPluginId)
  useEffect(() => {
    if (selectedPluginId !== null && !hasOwnRows) void requestPluginRefresh(selectedPluginId)
  }, [selectedPluginId, hasOwnRows])

  // TODO 1280: while this list is on screen, tell main so that its idle tasks keep refreshing it during a conversation (main re-checks the id and keeps the floor).
  const watchedPluginId = view?.pluginId ?? selectedPluginId
  useEffect(() => {
    if (watchedPluginId === null) return
    void window.aios.schedule.setPluginListOpen(watchedPluginId).catch(() => undefined)
    return () => {
      void window.aios.schedule.setPluginListOpen(null).catch(() => undefined)
    }
  }, [watchedPluginId])

  const toggle = (id: string, expand: boolean): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (expand) next.delete(id)
      else next.add(id)
      return next
    })

  const activate = (index: number): void => {
    const item = items[index]
    if (item === undefined) return
    setActive(index)
    if (item.row.uri !== undefined) select(item.row.uri)
    else if (item.hasChildren) toggle(item.row.id, !item.expanded)
  }

  const focusRow = (index: number): void => {
    setActive(index)
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus()
  }

  return (
    <>
      <div className="sidebar-header plugin-view-header">
        <span className="plugin-view-title">{view?.title ?? t('pluginView.title')}</span>
      </div>
      {items.length === 0 ? (
        <p className="extensions-empty">{t('pluginView.empty')}</p>
      ) : (
        <div
          ref={listRef}
          className="sidebar-list plugin-view-list"
          role="tree"
          aria-label={view?.title ?? t('pluginView.title')}
        >
          {items.map((item, index) => (
            <div
              key={item.row.id}
              role="treeitem"
              aria-level={item.depth + 1}
              aria-expanded={item.hasChildren ? item.expanded : undefined}
              data-index={index}
              tabIndex={index === Math.min(active, items.length - 1) ? 0 : -1}
              className={`plugin-view-row${item.row.uri === undefined ? ' group' : ''}`}
              style={{ paddingLeft: 8 + item.depth * 14 }}
              onClick={() => activate(index)}
              onKeyDown={(event) => {
                const result = treeKey(items, index, event.key)
                if (result === null) return
                event.preventDefault()
                if (result.kind === 'move') focusRow(result.index)
                else if (result.kind === 'toggle') toggle(result.id, result.expand)
                else activate(index)
              }}
            >
              <span className="plugin-view-twisty" aria-hidden="true">
                {item.hasChildren ? (item.expanded ? '▾' : '▸') : ''}
              </span>
              <span className="plugin-view-label">{item.row.label}</span>
              {item.row.description === undefined ? null : (
                <span className="plugin-view-description">{item.row.description}</span>
              )}
              {item.row.badge === undefined || item.row.badge === 0 ? null : (
                <span className="plugin-view-badge">{item.row.badge.toLocaleString()}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
