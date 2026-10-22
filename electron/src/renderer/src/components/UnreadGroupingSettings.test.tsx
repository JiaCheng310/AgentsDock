import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocale } from '@shared/i18n'
import type { AgentsDockAPI } from '@shared/ipc'
import { useAppStore } from '../store/app-store'
import { AppSettingsDialog } from './Dialogs'

beforeEach(() => {
  setLocale('en')
  Object.defineProperty(window, 'agentsDock', {
    configurable: true,
    value: {
      updates: { status: vi.fn().mockResolvedValue({ state: 'not-available', channel: 'direct', track: 'stable', currentVersion: '1.0.0' }) },
      events: { on: vi.fn().mockReturnValue(() => undefined) }
    } as unknown as AgentsDockAPI
  })
  useAppStore.setState({ ...useAppStore.getInitialState(),
    activeProfileId: 'server-a',
    modals: { ...useAppStore.getInitialState().modals, appSettings: true }
  }, true)
})

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
  setLocale('en')
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'agentsDock')
})

it('lets General settings toggle unread grouping and follows the current server preference and language', async () => {
  const user = userEvent.setup()
  const setGroupUnreadChats = vi.fn((groupUnreadChats: boolean) => useAppStore.setState({ groupUnreadChats }))
  useAppStore.setState({ groupUnreadChats: false, setGroupUnreadChats })
  render(<AppSettingsDialog />)
  await screen.findByText('Version 1.0.0')

  const toggle = screen.getByRole('switch', { name: 'Group unread chats at the top' })
  expect(toggle).not.toBeChecked()
  expect(toggle).toHaveAccessibleDescription('Show unread chats in a separate section above your folders.')
  toggle.focus()
  await user.keyboard('[Space]')
  expect(setGroupUnreadChats).toHaveBeenLastCalledWith(true)
  expect(toggle).toBeChecked()

  act(() => useAppStore.setState({ activeProfileId: 'server-b', groupUnreadChats: false }))
  expect(toggle).not.toBeChecked()
  expect(setGroupUnreadChats).toHaveBeenCalledOnce()
  act(() => setLocale('zh-CN'))
  expect(screen.getByRole('switch', { name: '在顶部集中显示未读会话' })).toBe(toggle)
  expect(toggle).toHaveAccessibleDescription('在文件夹上方单独显示未读会话分组。')
  await user.click(toggle)
  expect(setGroupUnreadChats).toHaveBeenLastCalledWith(true)
  await user.click(toggle)
  expect(setGroupUnreadChats).toHaveBeenLastCalledWith(false)
  expect(toggle).not.toBeChecked()
})
