import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { Columns2, Grid2X2, PanelLeft, Plus, Square, X } from 'lucide-react'
import type { Session } from '@shared/types'
import { t, useLocale } from '../lib/i18n'
import { CHAT_PANE_IDS, type ChatPane as ChatPaneId } from '../lib/chat-panes'
import { notifyTimelineViewportLayout } from '../lib/workspace-layout'
import { useAppStore } from '../store/app-store'
import { ChatPane } from './ChatPane'
import './ChatWorkspaceGrid.css'

const boundRatio = (value: number) => Math.max(25, Math.min(75, value))

export function ChatWorkspaceGrid({ sidebarVisible, terminalOpen, onSidebarToggle, onTerminalToggle, sideChat }: {
  sidebarVisible: boolean
  terminalOpen: boolean
  onSidebarToggle: () => void
  onTerminalToggle: () => void
  sideChat: (session: Session) => ReactNode
}) {
  useLocale()
  const workspaces = useAppStore(state => state.chatWorkspaces)
  const activeId = useAppStore(state => state.activeChatWorkspaceId)
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const serverIdentity = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null)
  const panes = useAppStore(state => state.chatPanes)
  const count = useAppStore(state => state.chatPaneCount)
  const focused = useAppStore(state => state.focusedChatPane)
  const sessions = useAppStore(state => state.sessions)
  const active = workspaces.find(workspace => workspace.id === activeId)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [ratios, setRatios] = useState({ column: (active?.columnRatio ?? 0.5) * 100, row: (active?.rowRatio ?? 0.5) * 100 })
  const ratioRef = useRef(ratios)
  const gridRef = useRef<HTMLDivElement>(null)
  const finishResizeRef = useRef<(() => void) | null>(null)
  const title = (workspace: (typeof workspaces)[number]) => workspace.title
    || sessions.find(session => session.id === workspace.panes.primary)?.title
    || t('chatWorkspace.untitled')

  useEffect(() => {
    const next = { column: (active?.columnRatio ?? 0.5) * 100, row: (active?.rowRatio ?? 0.5) * 100 }
    ratioRef.current = next
    setRatios(next)
  }, [activeId, active?.columnRatio, active?.rowRatio])
  useEffect(() => () => finishResizeRef.current?.(), [activeId])
  useEffect(() => {
    notifyTimelineViewportLayout('begin')
    const frame = requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
    return () => cancelAnimationFrame(frame)
  }, [count, activeId])

  const commitRatio = useCallback((axis: 'column' | 'row', value: number) => {
    const next = { ...ratioRef.current, [axis]: boundRatio(value) }
    ratioRef.current = next
    setRatios(next)
    // A drag that outlives a tab change must not resize the newly selected tab.
    const state = useAppStore.getState()
    if (state.activeChatWorkspaceId !== activeId || state.activeProfileId !== profileId
      || state.profileGeneration !== profileGeneration
      || (state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null) !== serverIdentity) return
    state.setChatWorkspaceRatios(axis === 'column'
      ? { columnRatio: next.column / 100 } : { rowRatio: next.row / 100 })
  }, [activeId, profileId, profileGeneration, serverIdentity])

  const beginResize = (event: PointerEvent, axis: 'column' | 'row') => {
    if (event.button !== 0 || !gridRef.current) return
    event.preventDefault()
    ;(event.currentTarget as HTMLElement).focus({ preventScroll: true })
    finishResizeRef.current?.()
    notifyTimelineViewportLayout('begin')
    let frame: number | null = null
    let latest: globalThis.PointerEvent | null = null
    let finished = false
    const paint = () => {
      frame = null
      const rect = gridRef.current?.getBoundingClientRect()
      if (!latest || !rect) return
      const value = axis === 'column' ? (latest.clientX - rect.left) / rect.width : (latest.clientY - rect.top) / rect.height
      const next = { ...ratioRef.current, [axis]: boundRatio(value * 100) }
      ratioRef.current = next
      setRatios(next)
      notifyTimelineViewportLayout('update')
    }
    const move = (pointer: globalThis.PointerEvent) => {
      latest = pointer
      if (frame === null) frame = requestAnimationFrame(paint)
    }
    const finish = () => {
      if (finished) return
      finished = true
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      if (frame !== null) { cancelAnimationFrame(frame); paint() }
      commitRatio(axis, ratioRef.current[axis])
      document.body.classList.remove('chat-split-resizing')
      notifyTimelineViewportLayout('end')
      finishResizeRef.current = null
    }
    finishResizeRef.current = finish
    document.body.classList.add('chat-split-resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
  }

  const separator = (axis: 'column' | 'row') => <div
    className={`workspace-grid-divider ${axis}`}
    role="separator"
    aria-label={t(axis === 'column' ? 'chatWorkspace.resizeColumns' : 'chatWorkspace.resizeRows')}
    aria-orientation={axis === 'column' ? 'vertical' : 'horizontal'}
    aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(ratios[axis])}
    tabIndex={0}
    onPointerDown={event => beginResize(event, axis)}
    onDoubleClick={() => commitRatio(axis, 50)}
    onKeyDown={event => {
      const minus = axis === 'column' ? 'ArrowLeft' : 'ArrowUp'
      const plus = axis === 'column' ? 'ArrowRight' : 'ArrowDown'
      if (![minus, plus, 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      notifyTimelineViewportLayout('begin')
      commitRatio(axis, event.key === 'Home' ? 25 : event.key === 'End' ? 75 : ratios[axis] + (event.key === plus ? 5 : -5))
      requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
    }}
  />

  return <div className="chat-grid-workspace">
    <header className="workspace-tabs-bar">
      {!sidebarVisible && <button type="button" className="icon-button" onClick={onSidebarToggle} aria-label={t('chatWorkspace.showSidebar')}><PanelLeft size={16} /></button>}
      <div className="chat-workspace-tabs" role="tablist" aria-label={t('chatWorkspace.tabs')}>
        {workspaces.map(workspace => <div className={`chat-workspace-tab${workspace.id === activeId ? ' active' : ''}`} key={workspace.id}>
          {renaming === workspace.id
            ? <input autoFocus aria-label={t('chatWorkspace.name')} value={name} onChange={event => setName(event.target.value)}
              onBlur={() => { useAppStore.getState().renameChatWorkspace(workspace.id, name.trim()); setRenaming(null) }}
              onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.preventDefault(); setRenaming(null) } }} />
            : <button type="button" role="tab" aria-selected={workspace.id === activeId} title={title(workspace)}
              onClick={() => void useAppStore.getState().selectChatWorkspace(workspace.id)}
              onDoubleClick={() => { setName(title(workspace)); setRenaming(workspace.id) }}>
              <span>{title(workspace)}</span><small>{workspace.paneCount}</small>
            </button>}
          {workspaces.length > 1 && <button type="button" className="workspace-tab-close" aria-label={t('chatWorkspace.close', { name: title(workspace) })}
            onClick={() => void useAppStore.getState().closeChatWorkspace(workspace.id)}><X size={12} /></button>}
        </div>)}
      </div>
      <button type="button" className="icon-button workspace-add" aria-label={t('chatWorkspace.new')} title={t('chatWorkspace.new')}
        onClick={() => void useAppStore.getState().createChatWorkspace()}><Plus size={16} /></button>
      <div className="workspace-layout-picker" role="group" aria-label={t('chatWorkspace.layout')}>
        {([1, 2, 3, 4] as const).map(value => <button key={value} type="button" className="icon-button"
          aria-label={t('chatWorkspace.paneCount', { count: value })} title={t('chatWorkspace.paneCount', { count: value })}
          aria-pressed={count === value} onClick={() => useAppStore.getState().setChatPaneCount(value)}>
          {value === 1 ? <Square size={15} /> : value === 2 ? <Columns2 size={15} /> : value === 4 ? <Grid2X2 size={15} /> : <span className="three-pane-icon" aria-hidden="true"><span /><span /><span /></span>}
        </button>)}
      </div>
    </header>
    <div ref={gridRef} className={`workspace-chat-grid chat-split-view${count >= 3 ? ' short' : ''}`} data-pane-count={count}
      style={{ '--workspace-column': `${ratios.column}%`, '--workspace-row': `${ratios.row}%` } as CSSProperties}>
      {CHAT_PANE_IDS.slice(0, count).map(pane => {
        const session = sessions.find(candidate => candidate.id === panes[pane])
        return <div key={session?.id ?? `empty:${pane}`} className="workspace-pane-slot" data-pane={pane}>
          {session ? <ChatPane pane={pane} session={session} focused={focused === pane} split={count > 1}
            sidebarVisible={sidebarVisible} terminalOpen={focused === pane && terminalOpen}
            onSidebarToggle={onSidebarToggle} onTerminalToggle={onTerminalToggle} sideChat={sideChat(session)} />
            : <EmptyChatPane pane={pane} focused={focused === pane} />}
        </div>
      })}
      {count >= 2 && separator('column')}
      {count >= 3 && separator('row')}
    </div>
  </div>
}

function EmptyChatPane({ pane, focused }: { pane: ChatPaneId; focused: boolean }) {
  const sessions = useAppStore(state => state.sessions)
  const panes = useAppStore(state => state.chatPanes)
  const [query, setQuery] = useState('')
  const candidates = sessions.filter(session => !session.archived && !Object.values(panes).includes(session.id)
    && `${session.title} ${session.cwd}`.toLowerCase().includes(query.toLowerCase()))
  return <section className={`empty-chat-pane${focused ? ' focused' : ''}`} data-chat-pane={pane} tabIndex={-1}
    onPointerDownCapture={() => useAppStore.getState().focusChatPane(pane)} onFocusCapture={() => useAppStore.getState().focusChatPane(pane)}>
    <strong>{t('chatWorkspace.chooseChat')}</strong>
    <input type="search" aria-label={t('chatWorkspace.search')} placeholder={t('chatWorkspace.search')}
      value={query} onChange={event => setQuery(event.target.value)} />
    <div className="empty-pane-chat-list">
      {candidates.map(session => <button type="button" key={session.id} onClick={() => void useAppStore.getState().selectSessionInPane(session.id, pane)}>
        <span>{session.title}</span><small>{session.backend}</small>
      </button>)}
      {!candidates.length && <span>{t('chatWorkspace.noChats')}</span>}
    </div>
  </section>
}
