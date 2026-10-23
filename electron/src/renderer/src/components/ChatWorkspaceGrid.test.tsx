import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { PublicServerProfile } from '@shared/types'
import type { ChatWorkspace } from '../lib/chat-panes'
import { useAppStore } from '../store/app-store'
import { ChatWorkspaceGrid } from './ChatWorkspaceGrid'

vi.mock('./ChatPane', () => ({ ChatPane: () => <div /> }))

const initialState = useAppStore.getState()
const profile = (id: string): PublicServerProfile => ({
  id, name: id, serverUrl: `http://${id}.test`, serverIdentity: `server-${id}`,
  hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0
})
const workspace = (id: string, columnRatio = 0.5): ChatWorkspace => ({
  id, panes: { primary: null, secondary: null }, focusedPane: 'primary', paneCount: 2,
  columnRatio, rowRatio: 0.5
})

describe('ChatWorkspaceGrid resize ownership', () => {
  let frames: Map<number, FrameRequestCallback>
  let setScoped: ReturnType<typeof vi.fn>

  beforeEach(() => {
    frames = new Map()
    let nextFrame = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      frames.set(++nextFrame, callback)
      return nextFrame
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
    setScoped = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
      preferences: { setScoped, set: vi.fn().mockResolvedValue(undefined) }
    } as unknown as AgentsDockAPI })
    useAppStore.setState({
      ...initialState, activeProfileId: 'a', profileGeneration: 1, profiles: [profile('a')],
      switchingProfileId: null, sessions: [], selectedSessionId: null,
      chatPanes: { primary: null, secondary: null }, focusedChatPane: 'primary', chatPaneCount: 2,
      activeChatWorkspaceId: 'workspace-main', chatWorkspaces: [workspace('workspace-main')]
    })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    document.body.classList.remove('chat-split-resizing')
    vi.restoreAllMocks()
  })

  const flushFrames = () => act(() => {
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach(callback => callback(0))
  })

  const startDrag = () => {
    const view = render(<ChatWorkspaceGrid sidebarVisible terminalOpen={false}
      onSidebarToggle={() => undefined} onTerminalToggle={() => undefined} sideChat={() => null} />)
    const grid = view.container.querySelector('.workspace-chat-grid')!
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, x: 0, y: 0, toJSON: () => ({})
    })
    flushFrames()
    const divider = screen.getByRole('separator', { name: 'Resize columns' })
    fireEvent(divider, new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    fireEvent(window, new MouseEvent('pointermove', { clientX: 640, clientY: 200 }))
    flushFrames()
    expect(divider).toHaveAttribute('aria-valuenow', '64')
    return view
  }

  it('persists a completed drag to its current profile and workspace', () => {
    startDrag()
    fireEvent(window, new MouseEvent('pointerup'))
    expect(useAppStore.getState().chatWorkspaces[0].columnRatio).toBe(0.64)
    expect(setScoped).toHaveBeenCalledWith(
      { profileId: 'a', profileGeneration: 1, serverIdentity: 'server-a' },
      'chatWorkspaces', expect.objectContaining({ activeWorkspaceId: 'workspace-main' })
    )
  })

  it('does not persist a departing profile drag into an identically named workspace', () => {
    const view = startDrag()
    act(() => {
      useAppStore.setState({ activeProfileId: 'b', profileGeneration: 2, profiles: [profile('b')],
        chatWorkspaces: [workspace('workspace-main', 0.35)] })
      view.unmount()
    })
    expect(useAppStore.getState().chatWorkspaces[0].columnRatio).toBe(0.35)
    expect(setScoped).not.toHaveBeenCalled()
    expect(document.body).not.toHaveClass('chat-split-resizing')
    fireEvent(window, new MouseEvent('pointerup'))
    expect(setScoped).not.toHaveBeenCalled()
  })

  it('ends a departing tab drag without resizing the newly selected tab', async () => {
    useAppStore.setState({ chatWorkspaces: [workspace('workspace-main'), workspace('other', 0.35)] })
    startDrag()
    await act(async () => useAppStore.getState().selectChatWorkspace('other'))
    expect(screen.getByRole('separator', { name: 'Resize columns' })).toHaveAttribute('aria-valuenow', '35')
    expect(useAppStore.getState().chatWorkspaces.find(tab => tab.id === 'other')?.columnRatio).toBe(0.35)
    expect(document.body).not.toHaveClass('chat-split-resizing')
    setScoped.mockClear()
    fireEvent(window, new MouseEvent('pointerup'))
    expect(setScoped).not.toHaveBeenCalled()
  })
})
