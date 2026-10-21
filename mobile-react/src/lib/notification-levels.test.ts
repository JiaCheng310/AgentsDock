import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event, Session } from '../types'
import { notificationForEvent, notificationForSessionUpdate, sessionAttentionLevel } from './notification-levels'

const session = (patch: Partial<Session> = {}): Session => ({ id: 'chat', title: 'QA chat', backend: 'codex', ...patch })
const event = (type: string, patch: Partial<Event> = {}): Event => ({ id: `event-${type}`, seq: 4, session_id: 'chat', type, ts: '2026-10-20T12:00:00Z', run_id: 'run-a', ...patch })

test('unread levels keep emergencies and pending input visible until resolved', () => {
  assert.equal(sessionAttentionLevel(session()), null)
  assert.equal(sessionAttentionLevel(session({ manual_unread: true })), 'normal')
  assert.equal(sessionAttentionLevel(session({ latest_agent_event_seq: 5, last_read_agent_event_seq: 2 })), 'normal')
  assert.equal(sessionAttentionLevel(session({ latest_agent_event_seq: 5, last_read_agent_event_seq: 2, latest_agent_event_type: 'job_finished' })), 'important')
  assert.equal(sessionAttentionLevel(session({ latest_agent_event_seq: 5, last_read_agent_event_seq: 2, codex_goal: { status: 'complete', updatedAt: 1_792_548_756 } as Session['codex_goal'] })), 'important')
  assert.equal(sessionAttentionLevel(session({ latest_agent_event_seq: 5, last_read_agent_event_seq: 2, codex_goal_status: 'complete', codex_goal_updated_at: 1_792_548_756 })), 'important')
  assert.equal(sessionAttentionLevel(session({ latest_agent_event_seq: 5, last_read_agent_event_seq: 2, codex_goal: { status: 'complete', updatedAt: 1_792_548_756 } as Session['codex_goal'], codex_goal_status: 'active' })), 'normal')
  assert.equal(sessionAttentionLevel(session({ latest_agent_event_seq: 6, last_read_agent_event_seq: 5, last_read_agent_event_at: '2026-10-21T02:13:00Z', codex_goal: { status: 'complete', updatedAt: 1_792_548_756 } as Session['codex_goal'] })), 'normal')
  assert.equal(sessionAttentionLevel(session({ codex_needs_user_action: true })), 'important')
  assert.equal(sessionAttentionLevel(session({ emergency_alert: { id: 'alert', status: 'active', severity: 'critical', message: 'Test incident', raised_at: '2026-10-20T12:00:00Z' } })), 'emergency')
  assert.equal(sessionAttentionLevel(session({ emergency_alert: { id: 'alert', status: 'acknowledged', severity: 'critical', message: 'Test incident', raised_at: '2026-10-20T12:00:00Z' } })), null)
})

test('system notifications have distinct copy and stable per-action keys', () => {
  assert.deepEqual(notificationForEvent(event('assistant_text'), session()), { level: 'normal', title: 'QA chat', body: 'You got a new message.', key: 'run:run-a' })
  assert.equal(notificationForEvent(event('turn_finished'), session()), null)
  assert.equal(notificationForEvent(event('codex_goal_updated', { goal: { status: 'complete' } as Event['goal'] }), session())?.level, 'important')
  assert.equal(notificationForEvent(event('codex_goal_updated', { goal: { status: 'active' } as Event['goal'] }), session()), null)
  assert.deepEqual(notificationForEvent(event('codex_interaction_requested', { interaction_id: 'request-a' }), session()), { level: 'important', title: 'Action needed · QA chat', body: 'The agent needs your input.', key: 'interaction:request-a' })
  assert.equal(notificationForEvent(event('job_finished'), session())?.level, 'important')
  assert.equal(notificationForEvent(event('job_error'), session())?.level, 'important')
  assert.equal(notificationForEvent(event('emergency_alert_raised', { emergency_alert_id: 'alert-a', message: 'Test incident' }), session())?.level, 'emergency')
  assert.equal(notificationForEvent(event('turn_started'), session()), null)
})

test('list refresh notices only newly arrived messages and newly urgent states', () => {
  const before = session({ latest_agent_event_seq: 3, last_read_agent_event_seq: 3 })
  assert.equal(notificationForSessionUpdate(undefined, before), null)
  assert.equal(notificationForSessionUpdate(before, before), null)
  assert.equal(notificationForSessionUpdate(before, { ...before, latest_agent_event_seq: 4 })?.level, 'normal')
  assert.equal(notificationForSessionUpdate(before, { ...before, latest_agent_event_seq: 4, latest_agent_event_type: 'job_finished' })?.level, 'important')
  const completedGoal = { status: 'complete', updatedAt: 1_792_548_756 } as Session['codex_goal']
  assert.equal(notificationForSessionUpdate(before, { ...before, latest_agent_event_seq: 4, codex_goal: completedGoal })?.level, 'important')
  assert.equal(notificationForSessionUpdate({ ...before, codex_goal: completedGoal }, { ...before, latest_agent_event_seq: 4, codex_goal: completedGoal, last_read_agent_event_at: '2026-10-21T02:13:00Z' })?.level, 'normal')
  assert.equal(notificationForSessionUpdate(before, { ...before, codex_needs_user_action: true })?.level, 'important')
  assert.equal(notificationForSessionUpdate(before, { ...before, emergency_alert: { id: 'alert', status: 'active', severity: 'critical', message: 'Test incident', raised_at: '2026-10-20T12:00:00Z' } })?.level, 'emergency')
  assert.equal(notificationForSessionUpdate({ ...before, codex_needs_user_action: true }, { ...before, codex_needs_user_action: true }), null)
})
