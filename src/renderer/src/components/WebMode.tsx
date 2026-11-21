/**
 * The sidebar's web mode (TODO 522, ARCHITECTURE 5.2.1). Three vertically stacked panes like VS Code's Explorer:
 * from the top **History / Favorite / Open tabs**. They collapse from the heading, and dragging the boundary changes the height (allocation is in `web-sections.ts`).
 * Main remembers collapsing and heights in `app_settings` (`ui.webSections`).
 *
 * - Clicking a row: History / Favorite open in the current tab, and Cmd (Ctrl) + click in a new tab (same as Chrome). A tab switches to it.
 * - The page itself is shown in ViewerPane (not in ThreadPane). The URL field and the star are in ViewerPane's heading.
 * - The writer is main: main writes the history on every load, and this only asks to delete / reorder.
 */
import { useEffect, useRef, useState } from 'react'
import { webTabLabel, type WebFavorite, type WebHistoryEntry, type WebSectionId, type WebTab } from '@shared/web-tabs.js'
import { useT, type MessageKey } from '../i18n/index.js'
import {
  chromeAppIconUrl,
  closeWebTab,
  initWeb,
  openBlankTab,
  openSavedWebUrl,
  openWebUrl,
  runChromeImport,
  setWebSections,
  showWebTab,
  useWeb
} from '../webStore.js'
import { useStore } from '../store.js'
import {
  SECTION_HEADER_PX,
  dragWebSections,
  favoriteDropIndex,
  historyTimeLabel,
  layoutWebSections,
  splitterActive,
  toggleWebSection,
  type SectionHeights,
  type SectionSplitter
} from '../web-sections.js'
import { Tooltip } from './Tooltip.js'
import { ContextMenu, useContextMenuState, type ContextMenuItem } from './ContextMenu.js'
import { CloseIcon } from '../icons/CloseIcon.js'
import { NewTabIcon } from '../icons/NewTabIcon.js'
import { ClearAllIcon } from '../icons/ClearAllIcon.js'
import { ImportIcon } from '../icons/ImportIcon.js'
import { WebIcon } from '../icons/WebIcon.js'
import { StarIcon } from '../icons/StarIcon.js'

/** The marker of a Favorite row drag (so it is not confused with other drags - file URIs). */
const FAVORITE_DRAG_TYPE = 'application/x-aios-web-favorite'

const SECTION_TITLES: Readonly<Record<WebSectionId, MessageKey>> = {
  history: 'web.section.history',
  favorites: 'web.section.favorites',
  tabs: 'web.section.tabs'
}

/** Whether it is a click with Cmd (mac) / Ctrl (other) held (opens in a new tab). */
function wantsNewTab(event: { readonly metaKey: boolean; readonly ctrlKey: boolean }): boolean {
  return event.metaKey || event.ctrlKey
}

export function WebMode(): React.JSX.Element {
  const t = useT()
  const sections = useWeb((state) => state.sections)
  const box = useRef<HTMLDivElement | null>(null)
  const [height, setHeight] = useState(0)
  /** Allocation only during a drag (written by main once released). */
  const [draft, setDraft] = useState<typeof sections | null>(null)
  const { point: menuPoint, items: menuItems, openMenu, closeMenu } = useContextMenuState()

  useEffect(() => {
    initWeb()
  }, [])

  useEffect(() => {
    const element = box.current
    if (element === null) return
    const measure = (): void => setHeight(element.clientHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const layout = draft ?? sections
  const heights = layoutWebSections(height, layout)

  const toggle = (id: WebSectionId): void => setWebSections(toggleWebSection(sections, id))
  const commit = (next: typeof sections): void => {
    setDraft(null)
    setWebSections(next)
  }

  return (
    <div className="web-mode" ref={box} data-testid="web-mode">
      <Section
        id="history"
        heights={heights}
        collapsed={layout.collapsed.history}
        onToggle={toggle}
        actions={
          <Tooltip content={t('web.history.clear')}>
            <button
              type="button"
              className="icon-button web-section-action"
              aria-label={t('web.history.clear')}
              onClick={() => void window.aios.web.clearHistory()}
            >
              <ClearAllIcon />
            </button>
          </Tooltip>
        }
      >
        <HistoryList openMenu={openMenu} />
      </Section>
      <Section
        id="favorites"
        heights={heights}
        collapsed={layout.collapsed.favorites}
        onToggle={toggle}
        splitter={
          <Splitter which="upper" layout={layout} heights={heights} onDraft={setDraft} onCommit={commit} />
        }
        actions={<ChromeImportButton openMenu={openMenu} />}
      >
        <FavoriteList openMenu={openMenu} />
      </Section>
      <Section
        id="tabs"
        heights={heights}
        collapsed={layout.collapsed.tabs}
        onToggle={toggle}
        splitter={
          <Splitter which="lower" layout={layout} heights={heights} onDraft={setDraft} onCommit={commit} />
        }
        actions={
          <Tooltip content={t('web.tabs.new')}>
            <button
              type="button"
              className="icon-button web-section-action"
              aria-label={t('web.tabs.new')}
              onClick={openBlankTab}
            >
              <NewTabIcon />
            </button>
          </Tooltip>
        }
      >
        <TabList openMenu={openMenu} />
      </Section>
      <ContextMenu point={menuPoint} items={menuItems} onClose={closeMenu} />
    </div>
  )
}

type OpenMenu = ReturnType<typeof useContextMenuState>['openMenu']

/** One pane: heading (collapse / expand, actions at the right end) and body. */
function Section({
  id,
  heights,
  collapsed,
  onToggle,
  actions,
  splitter,
  children
}: {
  readonly id: WebSectionId
  readonly heights: SectionHeights
  readonly collapsed: boolean
  readonly onToggle: (id: WebSectionId) => void
  readonly actions?: React.ReactNode
  readonly splitter?: React.ReactNode
  readonly children: React.ReactNode
}): React.JSX.Element {
  const t = useT()
  const title = t(SECTION_TITLES[id])
  return (
    <section className={`web-section web-section-${id}${collapsed ? ' collapsed' : ''}`} aria-label={title}>
      {splitter}
      <div className="web-section-header" style={{ height: SECTION_HEADER_PX }}>
        <button
          type="button"
          className="web-section-toggle"
          aria-expanded={!collapsed}
          onClick={() => onToggle(id)}
        >
          <span className="row-icon" aria-hidden="true">
            {collapsed ? '▸' : '▾'}
          </span>
          <span className="web-section-title">{title}</span>
        </button>
        {collapsed ? null : <span className="web-section-actions">{actions}</span>}
      </div>
      {collapsed ? null : (
        <div className="web-section-body" style={{ height: heights[id] }}>
          {children}
        </div>
      )}
    </section>
  )
}

/** Drag of a pane boundary (the bottom edge of the upper pane = the top edge of this pane's heading). Followed with pointer capture, like the splitter of T15. */
function Splitter({
  which,
  layout,
  heights,
  onDraft,
  onCommit
}: {
  readonly which: SectionSplitter
  readonly layout: Parameters<typeof dragWebSections>[0]
  readonly heights: SectionHeights
  readonly onDraft: (layout: Parameters<typeof dragWebSections>[0] | null) => void
  readonly onCommit: (layout: Parameters<typeof dragWebSections>[0]) => void
}): React.JSX.Element | null {
  const t = useT()
  const drag = useRef<{ readonly y: number; readonly start: SectionHeights; last: typeof layout } | null>(null)
  if (!splitterActive(which, layout)) return null
  return (
    <div
      className="web-section-splitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('web.section.resize')}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { y: event.clientY, start: heights, last: layout }
      }}
      onPointerMove={(event) => {
        const state = drag.current
        if (state === null) return
        state.last = dragWebSections(layout, state.start, which, event.clientY - state.y)
        onDraft(state.last)
      }}
      onPointerUp={(event) => {
        const state = drag.current
        drag.current = null
        if (state === null) return
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        onCommit(state.last)
      }}
      onPointerCancel={() => {
        drag.current = null
        onDraft(null)
      }}
    />
  )
}

function openItems(
  t: ReturnType<typeof useT>,
  url: string,
  extra: readonly ContextMenuItem[]
): readonly ContextMenuItem[] {
  return [
    { key: 'open', label: t('web.open'), onSelect: () => openSavedWebUrl(url, false) },
    { key: 'open-new-tab', label: t('web.openInNewTab'), onSelect: () => openWebUrl(url, true) },
    ...extra
  ]
}

function HistoryList({ openMenu }: { readonly openMenu: OpenMenu }): React.JSX.Element {
  const t = useT()
  const history = useWeb((state) => state.history)
  const favicons = useWeb((state) => state.favicons)
  const selectedUri = useStore((state) => state.selectedUri)
  if (history.length === 0) return <div className="web-section-empty">{t('web.history.empty')}</div>
  return (
    <ul className="web-list" role="list">
      {history.map((entry: WebHistoryEntry) => {
        const favicon = entry.host === null ? null : (favicons[entry.host] ?? null)
        return (
          <li
            key={entry.id}
            className={`web-row${entry.url === selectedUri ? ' selected' : ''}`}
            title={entry.url}
            onClick={(event) => openSavedWebUrl(entry.url, wantsNewTab(event))}
            onContextMenu={(event) =>
              openMenu(
                event,
                openItems(t, entry.url, [
                  {
                    key: 'remove',
                    label: t('web.history.remove'),
                    onSelect: () => void window.aios.web.removeHistory(entry.id)
                  },
                  { key: 'clear', label: t('web.history.clear'), onSelect: () => void window.aios.web.clearHistory() }
                ])
              )
            }
          >
            <span className="web-row-icon" aria-hidden="true">
              {favicon === null ? <WebIcon size={14} /> : <img src={favicon} alt="" width={14} height={14} />}
            </span>
            <span className="web-row-title">{webTabLabel(entry) || entry.url}</span>
            <span className="web-row-time">{historyTimeLabel(entry.visitedAt)}</span>
          </li>
        )
      })}
    </ul>
  )
}

/** TODO 676: "Import from Chrome" (a heading action). If there is only one, it runs directly; if several, a menu lets the user choose. */
function ChromeImportButton({ openMenu }: { readonly openMenu: OpenMenu }): React.JSX.Element {
  const t = useT()
  const label = t('web.favorites.chromeImport.button')
  const handleClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const point = { clientX: event.clientX, clientY: event.clientY }
    void runChromeImport(t, openMenu, point)
  }
  return (
    <Tooltip content={label}>
      <button type="button" className="icon-button web-section-action" aria-label={label} onClick={handleClick}>
        <ImportIcon size={12} />
      </button>
    </Tooltip>
  )
}

/**
 * TODO 723: the "Import from Chrome" button shown in the body when Favorite is empty (the shape of VS Code's empty-view
 * "Open Folder" button). It calls the same `runChromeImport` as the heading's `ChromeImportButton`.
 * The icon is read from the user's Chrome.app (the same mechanism as the `.app` icon of 562, not bundled) - if it cannot be read, the
 * generic `WebIcon`.
 */
function ChromeImportEmptyAction({ openMenu }: { readonly openMenu: OpenMenu }): React.JSX.Element {
  const t = useT()
  const [icon, setIcon] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void chromeAppIconUrl().then((url) => {
      if (active) setIcon(url)
    })
    return () => {
      active = false
    }
  }, [])
  const handleClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const point = { clientX: event.clientX, clientY: event.clientY }
    void runChromeImport(t, openMenu, point)
  }
  return (
    <button type="button" className="web-favorites-empty-action" onClick={handleClick}>
      {icon === null ? <WebIcon size={16} /> : <img src={icon} alt="" width={16} height={16} />}
      {t('web.favorites.chromeImport.button')}
    </button>
  )
}

function FavoriteList({ openMenu }: { readonly openMenu: OpenMenu }): React.JSX.Element {
  const t = useT()
  const favorites = useWeb((state) => state.favorites)
  const favicons = useWeb((state) => state.favicons)
  const message = useWeb((state) => state.chromeImportMessage)
  const selectedUri = useStore((state) => state.selectedUri)
  const [over, setOver] = useState<number | null>(null)
  const status = message === null ? null : <div className="web-section-status">{message}</div>
  if (favorites.length === 0) {
    return (
      <>
        {status}
        <div className="web-section-empty">
          <StarIcon size={12} /> {t('web.favorites.empty')}
        </div>
        <div className="web-favorites-empty-action-row">
          <ChromeImportEmptyAction openMenu={openMenu} />
        </div>
      </>
    )
  }
  return (
    <>
      {status}
      <ul className="web-list" role="list">
      {favorites.map((favorite: WebFavorite, index) => {
        const favicon = favorite.host === null ? null : (favicons[favorite.host] ?? null)
        return (
        <li
          key={favorite.id}
          className={`web-row${favorite.url === selectedUri ? ' selected' : ''}${over === index ? ' drop-target' : ''}`}
          title={favorite.url}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(FAVORITE_DRAG_TYPE, String(index))
            // Also attach the URL so a drop onto ThreadPane / the viewer can be accepted as a link (same shape as 366).
            event.dataTransfer.setData('text/uri-list', favorite.url)
            event.dataTransfer.effectAllowed = 'copyMove'
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(FAVORITE_DRAG_TYPE)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            if (over !== index) setOver(index)
          }}
          onDragLeave={() => setOver((current) => (current === index ? null : current))}
          onDrop={(event) => {
            setOver(null)
            const raw = event.dataTransfer.getData(FAVORITE_DRAG_TYPE)
            if (raw === '') return
            event.preventDefault()
            const from = Number(raw)
            const moved = favorites[from]
            const to = favoriteDropIndex(from, index, favorites.length)
            if (moved !== undefined && to !== null) void window.aios.web.moveFavorite(moved.id, to)
          }}
          onDragEnd={() => setOver(null)}
          onClick={(event) => openSavedWebUrl(favorite.url, wantsNewTab(event))}
          onContextMenu={(event) =>
            openMenu(
              event,
              openItems(t, favorite.url, [
                {
                  key: 'remove',
                  label: t('web.favorites.remove'),
                  onSelect: () => void window.aios.web.removeFavorite(favorite.id)
                }
              ])
            )
          }
        >
          <span className="web-row-icon" aria-hidden="true">
            {favicon === null ? <WebIcon size={14} /> : <img src={favicon} alt="" width={14} height={14} />}
          </span>
          <span className="web-row-title">{webTabLabel(favorite) || favorite.url}</span>
        </li>
        )
      })}
      </ul>
    </>
  )
}

function TabList({ openMenu }: { readonly openMenu: OpenMenu }): React.JSX.Element {
  const t = useT()
  const tabs = useWeb((state) => state.tabs)
  if (tabs.tabs.length === 0) return <div className="web-section-empty">{t('web.tabs.empty')}</div>
  return (
    <ul className="web-list" role="list">
      {tabs.tabs.map((tab: WebTab) => {
        const label = webTabLabel(tab) || t('web.tabs.blank')
        return (
          <li
            key={tab.id}
            className={`web-row web-tab-row${tab.id === tabs.activeId ? ' selected' : ''}`}
            title={tab.url}
            aria-current={tab.id === tabs.activeId ? 'true' : undefined}
            onClick={() => showWebTab(tab)}
            // Middle click closes (same as Chrome).
            onAuxClick={(event) => {
              if (event.button === 1) void closeWebTab(tab.id)
            }}
            onContextMenu={(event) =>
              openMenu(event, [{ key: 'close', label: t('web.tabs.close'), onSelect: () => void closeWebTab(tab.id) }])
            }
          >
            <span className="web-row-icon" aria-hidden="true">
              {tab.favicon === null ? <WebIcon size={14} /> : <img src={tab.favicon} alt="" width={14} height={14} />}
            </span>
            <span className="web-row-title">{label}</span>
            <Tooltip content={t('web.tabs.close')}>
              <button
                type="button"
                className="icon-button web-tab-close"
                aria-label={t('web.tabs.close')}
                onClick={(event) => {
                  event.stopPropagation()
                  void closeWebTab(tab.id)
                }}
              >
                <CloseIcon />
              </button>
            </Tooltip>
          </li>
        )
      })}
    </ul>
  )
}
