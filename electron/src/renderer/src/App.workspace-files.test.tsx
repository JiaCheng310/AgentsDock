import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Session, WorkspaceFile } from '@shared/types'
import { App } from './App'
import { resetWorkspaceEditorMemoryForTests } from './components/WorkspaceEditor'
import { WorkspaceFilesHost, workspaceFilesKey } from './components/WorkspaceFilesContext'
import { handleMenuCommand, useAppStore } from './store/app-store'
import { requestOpenWorkspaceReference } from './lib/workspace-file-links'

vi.mock('./components/Sidebar', () => ({ Sidebar: () => null }))
vi.mock('./components/ChatHeader', () => ({ ChatHeader: () => null }))
vi.mock('./components/Timeline', () => ({ Timeline: ({ sessionId }: { sessionId?: string }) => {
  const selectedSessionId = useAppStore(state => state.selectedSessionId)
  const owner = sessionId ?? selectedSessionId!
  return <><p>Timeline {owner}</p>{['previous.ts', 'example.ts'].map(path => <a key={path} href={`agentsdock-workspace:${path}`} onClick={event => {
    event.preventDefault()
    requestOpenWorkspaceReference(owner, { path })
  }}>Open {path} from {owner}</a>)}</>
} }))
vi.mock('./components/Composer', () => ({ Composer: ({ sessionId }: { sessionId: string }) => <textarea aria-label={`Draft ${sessionId}`} defaultValue={`Draft for ${sessionId}`} /> }))
vi.mock('./components/Dialogs', () => ({ Dialogs: () => null }))
vi.mock('./components/InspectorDock', () => ({ InspectorDock: ({ content }: any) => content }))
vi.mock('./components/InspectorWorkspace', () => ({ InspectorWorkspace: ({ session, scope, tab }: any) => tab === 'files'
  ? <WorkspaceFilesHost owner={workspaceFilesKey(scope, session.id, session.cwd)} /> : null }))
vi.mock('./components/SideChatPopover', () => ({ SideChatPopover: () => null }))
vi.mock('./components/TerminalDock', () => ({ TerminalDock: () => null }))
vi.mock('./components/WorkspaceResizeHandles', async importOriginal => ({ ...await importOriginal<typeof import('./components/WorkspaceResizeHandles')>(), WorkspaceResizeHandles: () => null }))
vi.mock('./lib/renderer-stall-monitor', () => ({ installRendererStallMonitor: () => () => undefined }))
vi.mock('./components/CodeMirrorEditor', () => ({ CodeMirrorEditor: ({ value, ariaLabel, readOnly, onChange }: any) => <textarea aria-label={ariaLabel} value={value} readOnly={readOnly} onChange={event => onChange(event.target.value, 1)} /> }))

const sessions: Session[] = [
  { id: 'chat-a', title: 'Chat A', backend: 'codex', cwd: '/work/alpha' },
  { id: 'chat-b', title: 'Chat B', backend: 'claude', cwd: '/work/beta' }
]

describe('App split workspace files', () => {
  beforeEach(() => {
    localStorage.clear()
    resetWorkspaceEditorMemoryForTests()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        events: { on: vi.fn().mockReturnValue(() => undefined) },
        updates: { status: vi.fn().mockResolvedValue(null) },
        native: { log: vi.fn().mockResolvedValue(undefined), readyForNotifications: vi.fn().mockResolvedValue(true), readyForSecurePeerInvite: vi.fn().mockResolvedValue(true) },
        preferences: {
          get: vi.fn((_key, fallback) => Promise.resolve(fallback)), set: vi.fn().mockResolvedValue(undefined),
          getScoped: vi.fn((_scope, _key, fallback) => Promise.resolve(fallback)), setScoped: vi.fn().mockResolvedValue(undefined)
        },
        workspace: {
          entries: vi.fn((sessionId: string) => Promise.resolve({ root: sessions.find(session => session.id === sessionId)!.cwd, path: '', entries: [{ name: 'example.ts', path: 'example.ts', kind: 'file' }], has_more: false })),
          search: vi.fn().mockResolvedValue({ root: '/work/alpha', query: '', entries: [{ name: 'example.ts', path: 'example.ts', kind: 'file' }], scanned: 1, truncated: false, limit: 100 }),
          read: vi.fn((sessionId: string, path: string) => Promise.resolve({ root: sessions.find(session => session.id === sessionId)!.cwd, path, name: path, content: `Content from ${sessionId}`, revision: 'rev-1', size: 19, mtime_ns: 1, writable: true })),
          mediaURL: vi.fn((_profileId, _generation, sessionId, path) => `agentsdock-media://workspace/profile-a/4/${sessionId}/${path}`)
        },
        files: {
          cancelReadText: vi.fn().mockResolvedValue(true),
          mediaURL: vi.fn((_profileId, _generation, sessionId, id) => `agentsdock-media://file/profile-a/4/${sessionId}/${id}`)
        }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      initialized: true, initialize: vi.fn().mockResolvedValue(undefined),
      profiles: [{ id: 'profile-a', name: 'Alpha', serverUrl: 'https://alpha.example:7850', serverIdentity: 'server-a', hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0 }],
      activeProfileId: 'profile-a', profileGeneration: 4, switchingProfileId: null, sessions,
      selectedSessionId: 'chat-a', chatPanes: { primary: 'chat-a', secondary: 'chat-b' }, focusedChatPane: 'primary',
      inspectorVisible: false, health: { ok: true, capabilities: { workspace_files: { available: true, version: 6, required: false, message: '', action: null } } },
      error: null, storageFull: false, uploadsBySession: {}, uploadPathsBySession: {}
    })
  })

  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('opens a targeted file through the real editor and returns to the same split chats', async () => {
    const view = render(<StrictMode><App /></StrictMode>)
    const primary = view.container.querySelector('[data-chat-pane="primary"]')
    const secondary = view.container.querySelector('[data-chat-pane="secondary"]')
    fireEvent.change(screen.getByRole('textbox', { name: 'Draft chat-a' }), { target: { value: 'Keep primary draft' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Draft chat-b' }), { target: { value: 'Keep secondary draft' } })

    act(() => window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', { detail: { sessionId: 'chat-b', path: 'example.ts' } })))

    expect(await screen.findByRole('textbox', { name: 'Contents of example.ts' })).toHaveValue('Content from chat-b')
    expect(window.agentsDock.workspace.read).toHaveBeenCalledWith('chat-b', 'example.ts')
    expect(useAppStore.getState().focusedChatPane).toBe('secondary')
    expect(screen.queryByText('Your split chats are still open')).not.toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Return to split chats' }))
    await waitFor(() => expect(document.activeElement).toBe(secondary))
    expect(view.container.querySelector('[data-chat-pane="primary"]')).toBe(primary)
    expect(view.container.querySelector('[data-chat-pane="secondary"]')).toBe(secondary)
    expect(screen.getByRole('textbox', { name: 'Draft chat-a' })).toHaveValue('Keep primary draft')
    expect(screen.getByRole('textbox', { name: 'Draft chat-b' })).toHaveValue('Keep secondary draft')

    fireEvent.click(screen.getByRole('button', { name: 'Open example.ts' }))
    expect(await screen.findByRole('textbox', { name: 'Contents of example.ts' })).toHaveValue('Content from chat-b')
    fireEvent.click(screen.getByRole('button', { name: 'Return to split chats' }))
    fireEvent.pointerDown(primary!)
    fireEvent.click(await screen.findByRole('button', { name: 'Open example.ts' }))
    expect(await screen.findByRole('textbox', { name: 'Contents of example.ts' })).toHaveValue('Content from chat-a')
    expect(useAppStore.getState().chatPanes).toEqual({ primary: 'chat-a', secondary: 'chat-b' })
  })

  it('keeps a newly requested file active when saved tabs restore before its read completes', async () => {
    vi.mocked(window.agentsDock.preferences.getScoped).mockImplementation((_scope, key, fallback) => Promise.resolve(key === 'workspace-editor:chat-b'
      ? { version: 1, cwd: '/work/beta', activePath: 'previous.ts', tabs: [{ path: 'previous.ts' }] }
      : fallback))
    let finishRead!: (file: WorkspaceFile) => void
    const pendingRead = new Promise<WorkspaceFile>(resolve => { finishRead = resolve })
    const read = window.agentsDock.workspace.read
    const ordinaryRead = vi.mocked(read).getMockImplementation()!
    vi.mocked(read).mockImplementation((sessionId, path) => path === 'example.ts' ? pendingRead : ordinaryRead(sessionId, path))
    render(<App />)

    act(() => window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', { detail: { sessionId: 'chat-b', path: 'example.ts' } })))
    await waitFor(() => expect(read).toHaveBeenCalledWith('chat-b', 'example.ts'))
    expect(await screen.findByRole('tab', { name: 'previous.ts' })).toBeInTheDocument()
    await act(async () => finishRead(await ordinaryRead('chat-b', 'example.ts')))

    expect(await screen.findByRole('textbox', { name: 'Contents of example.ts' })).toHaveValue('Content from chat-b')
    expect(screen.getByRole('tab', { name: 'example.ts' })).toHaveAttribute('aria-selected', 'true')
  })

  it('opens the clicked reference after a single chat file was retained into split view', async () => {
    useAppStore.setState({ chatPanes: { primary: 'chat-a', secondary: null } })
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: 'Open previous.ts from chat-a' }))
    expect(await screen.findByRole('textbox', { name: 'Contents of previous.ts' })).toHaveValue('Content from chat-a')
    act(() => useAppStore.setState({ chatPanes: { primary: 'chat-a', secondary: 'chat-b' }, selectedSessionId: 'chat-b', focusedChatPane: 'secondary' }))
    const link = screen.getByRole('link', { name: 'Open example.ts from chat-a' })
    fireEvent.pointerDown(link)
    fireEvent.click(link)
    expect(await screen.findByRole('textbox', { name: 'Contents of example.ts' })).toHaveValue('Content from chat-a')
  })

  it('opens the file picker with keyboard focus and cancels back to the focused split chat', async () => {
    const view = render(<StrictMode><App /></StrictMode>)
    act(() => handleMenuCommand('open-workspace-file', useAppStore.getState, value => useAppStore.setState(value)))
    const search = await screen.findByRole('combobox', { name: 'Find a workspace file' })
    expect(search).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Close file picker' }))
    await waitFor(() => expect(document.activeElement).toBe(view.container.querySelector('[data-chat-pane="primary"]')))
    expect(view.container.querySelector('.split-workspace-overlay')).toBeNull()
    expect(window.agentsDock.workspace.read).not.toHaveBeenCalled()
  })

  it('opens workspace and attachment image previews without discarding either chat', async () => {
    render(<StrictMode><App /></StrictMode>)
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', { detail: { sessionId: 'chat-b', path: 'image.png' } })))
    expect(await screen.findByRole('img', { name: 'image.png' })).toHaveAttribute('src', 'agentsdock-media://workspace/profile-a/4/chat-b/image.png')
    fireEvent.click(screen.getByRole('button', { name: 'Return to split chats' }))
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:open-agent-file', { detail: { sessionId: 'chat-a', file: { id: 'artifact', session_id: 'chat-a', filename: 'attachment.png', content_type: 'image/png' } } })))
    expect(await screen.findByRole('img', { name: 'attachment.png' })).toHaveAttribute('src', 'agentsdock-media://file/profile-a/4/chat-a/artifact')
    expect(useAppStore.getState().focusedChatPane).toBe('primary')
    expect(useAppStore.getState().chatPanes).toEqual({ primary: 'chat-a', secondary: 'chat-b' })
  })

  it('discards the queued open when the focused chat changes before restoration finishes', async () => {
    let restore!: (value: null) => void
    const pendingRestore = new Promise<null>(resolve => { restore = resolve })
    vi.mocked(window.agentsDock.preferences.getScoped).mockImplementation((_scope, key, fallback) => key === 'workspace-editor:chat-b' ? pendingRestore : Promise.resolve(fallback))
    const view = render(<StrictMode><App /></StrictMode>)
    act(() => window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', { detail: { sessionId: 'chat-b', path: 'example.ts' } })))
    act(() => useAppStore.getState().focusChatPane('primary'))
    await act(async () => restore(null))
    expect(window.agentsDock.workspace.read).not.toHaveBeenCalled()
    expect(view.container.querySelector('.split-workspace-overlay')).toBeNull()
    expect(useAppStore.getState().selectedSessionId).toBe('chat-a')
  })
})
