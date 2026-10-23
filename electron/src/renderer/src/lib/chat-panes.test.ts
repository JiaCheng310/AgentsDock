import { describe, expect, it } from 'vitest'
import {
  closeChatPane, focusedChatSessionId, reconcileChatPaneLayout, selectChatInPane, swapChatPanes,
  visibleChatSessionIds, parseChatWorkspaces, visibleWorkspaceLayout, workspaceWithLayout,
  type ChatPaneLayout, type ChatWorkspace
} from './chat-panes'

const split: ChatPaneLayout = {
  panes: { primary: 'chat-a', secondary: 'chat-b' },
  focusedPane: 'secondary'
}

describe('chat pane layout', () => {
  it('keeps session IDs distinct and focuses an already visible chat', () => {
    expect(selectChatInPane(split, 'chat-a', 'secondary')).toEqual({
      panes: split.panes,
      focusedPane: 'primary'
    })
    expect(visibleChatSessionIds({ primary: 'chat-a', secondary: 'chat-a' })).toEqual(['chat-a'])
  })

  it('promotes the secondary chat when the primary pane closes', () => {
    const closed = closeChatPane(split, 'primary')
    expect(closed).toEqual({ panes: { primary: 'chat-b', secondary: null }, focusedPane: 'primary' })
    expect(focusedChatSessionId(closed)).toBe('chat-b')
  })

  it('normalizes a secondary-only layout into the primary pane', () => {
    expect(reconcileChatPaneLayout(
      { panes: { primary: null, secondary: 'chat-b' }, focusedPane: 'secondary' },
      new Set(['chat-b'])
    )).toEqual({ panes: { primary: 'chat-b', secondary: null }, focusedPane: 'primary' })
  })

  it('preserves the focused session while swapping panes', () => {
    const swapped = swapChatPanes(split)
    expect(swapped).toEqual({
      panes: { primary: 'chat-b', secondary: 'chat-a' },
      focusedPane: 'primary'
    })
    expect(focusedChatSessionId(swapped)).toBe('chat-b')
  })

  it('reconciles removed chats but keeps any archived chat the caller considers valid', () => {
    expect(reconcileChatPaneLayout(split, new Set(['chat-b']), 'chat-c')).toEqual({
      panes: { primary: 'chat-b', secondary: null },
      focusedPane: 'primary'
    })
    expect(reconcileChatPaneLayout(split, new Set(['chat-c']), 'chat-c')).toEqual({
      panes: { primary: 'chat-c', secondary: null },
      focusedPane: 'primary'
    })
  })

  it('keeps four panes distinct and preserves focused chat after a different pane closes', () => {
    const grid: ChatPaneLayout = {
      panes: { primary: 'a', secondary: 'b', tertiary: 'c', quaternary: 'd' },
      focusedPane: 'quaternary', paneCount: 4
    }
    expect(visibleChatSessionIds(grid.panes)).toEqual(['a', 'b', 'c', 'd'])
    expect(selectChatInPane(grid, 'c', 'primary').focusedPane).toBe('tertiary')
    expect(closeChatPane(grid, 'secondary')).toEqual({
      panes: { primary: 'a', secondary: 'c', tertiary: 'd' }, focusedPane: 'tertiary', paneCount: 3
    })
  })

  it('retains hidden assignments while editing a smaller visible grid', () => {
    const workspace: ChatWorkspace = {
      id: 'one', panes: { primary: 'a', secondary: 'b', tertiary: 'c', quaternary: 'd' },
      paneCount: 1, focusedPane: 'primary', columnRatio: 0.6, rowRatio: 0.4
    }
    const visible = visibleWorkspaceLayout(workspace)
    expect(visible.panes).toEqual({ primary: 'a', secondary: null })
    const changed = workspaceWithLayout(workspace, selectChatInPane(visible, 'c', 'primary'))
    expect(changed.panes).toEqual({ primary: 'c', secondary: 'b', tertiary: null, quaternary: 'd' })
    expect(visibleWorkspaceLayout({ ...changed, paneCount: 4 }).panes).toEqual(changed.panes)
  })

  it('validates saved workspaces without replacing intentional empty slots', () => {
    const restored = parseChatWorkspaces({
      activeWorkspaceId: 'two', workspaces: [
        { id: 'one', panes: { primary: 'a', secondary: 'a', tertiary: 'deleted', quaternary: 'd' }, paneCount: 2, focusedPane: 'quaternary', columnRatio: 4 },
        { id: 'two', panes: { primary: null, secondary: 'b' }, paneCount: 4, focusedPane: 'tertiary', rowRatio: 0.3 },
        { id: 'one', panes: { primary: 'd' } }
      ]
    }, new Set(['a', 'b', 'd']))!
    expect(restored.workspaces).toHaveLength(2)
    expect(restored.activeWorkspaceId).toBe('two')
    expect(restored.workspaces[0]).toMatchObject({
      panes: { primary: 'a', secondary: null, tertiary: null, quaternary: 'd' }, focusedPane: 'primary', columnRatio: 0.8, rowRatio: 0.5
    })
    expect(visibleWorkspaceLayout(restored.workspaces[1])).toEqual({
      panes: { primary: null, secondary: 'b', tertiary: null, quaternary: null }, paneCount: 4, focusedPane: 'tertiary'
    })
  })
})
