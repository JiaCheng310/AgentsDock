import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentFile, Event } from '../types'
import { projectTimeline, type MessageRow } from './timeline'
import { updateQueuedTurns } from './queue'
import { messageText } from './format'
import { isNativeGoalSteerEvent } from './native-goal-steering'
import { historicalTimelineEvents, sanitizeTimelineEvent } from './timeline-memory'

// Exact server acknowledgement packets, not prompt-text guesses. These pure
// projection checks intentionally do not claim provider/runtime acceptance.
type GoalEvent = Event & { native_goal_steer?: boolean; provider_user_authored?: boolean }
function event(seq: number, type: string, patch: Partial<GoalEvent> = {}): GoalEvent {
  return { id: `goal-${seq}`, seq, session_id: 'goal-chat', run_id: 'goal-owner',
    ts: `2026-10-19T12:00:${String(seq).padStart(2, '0')}Z`, type, ...patch }
}
function acknowledgement(seq = 5, patch: Partial<GoalEvent> = {}): GoalEvent {
  return event(seq, 'turn_steered', { backend: 'codex', purpose: 'codex_goal_resume',
    native_steer: true, native_goal_steer: true, provider_user_authored: true,
    queued_id: `queued-${seq}`, prompt: 'Use this additional context', ...patch })
}
function users(events: Event[], files: AgentFile[] = []): MessageRow[] {
  return projectTimeline(events, files).filter((row): row is MessageRow => row.kind === 'message' && row.role === 'user')
}

await test('goal follow-up appears once between pre- and post-steer output, within the same run', () => {
  const ack = acknowledgement()
  const rows = projectTimeline([
    event(1, 'turn_started', { prompt: 'Original task' }),
    event(2, 'assistant_text', { text: 'Output before follow-up' }),
    ack,
    event(6, 'assistant_text', { text: 'Output after follow-up' }),
    event(7, 'turn_finished'),
  ], [])
  const messages = rows.filter((row): row is MessageRow => row.kind === 'message')
  assert.deepEqual(messages.map(row => [row.role, row.events.map(value => value.prompt ?? value.text)]), [
    ['user', ['Original task']],
    ['assistant', ['Output before follow-up']],
    ['user', ['Use this additional context']],
    ['assistant', ['Output after follow-up']],
  ])
  assert.ok(messages.every(row => row.events.every(value => value.run_id === 'goal-owner')))
  assert.equal(rows.some(row => row.kind === 'system' && row.event.type === 'turn_stopped'), false)
})

await test('the same HTTP/live acknowledgement is deduplicated but repeated distinct input is retained', () => {
  const first = acknowledgement()
  const repeatedText = acknowledgement(8)
  const rows = users([first, { ...first }, repeatedText])
  assert.deepEqual(rows.map(row => row.events[0].id), [first.id, repeatedText.id])
  assert.equal(new Set(rows.map(row => row.key)).size, 2)
})

await test('native goal acknowledgement removes only its exact queued ID', () => {
  const first = { queued_id: 'queued-5', session_id: 'goal-chat', prompt: 'Use this additional context', file_ids: [] }
  const sameText = { ...first, queued_id: 'queued-8' }
  assert.deepEqual(updateQueuedTurns([first, sameText], acknowledgement()), [sameText])
})

await test('attachment-only native goal input remains visible once with its same-chat file', () => {
  const file: AgentFile = { id: 'context-file', session_id: 'goal-chat', filename: 'context.txt' }
  const rows = users([acknowledgement(5, { prompt: '', file_ids: [file.id] })], [file])
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].files.map(value => value.id), [file.id])
})

await test('different sessions cannot supply attachments for a native goal follow-up', () => {
  const foreign: AgentFile = { id: 'same-file-id', session_id: 'different-chat', filename: 'foreign.txt' }
  const rows = users([acknowledgement(5, { file_ids: [foreign.id] })], [foreign])
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].files, [])
})

await test('goal user input respects public display text and strips only generated authority suffixes', () => {
  const suffix = '\n\n[AgentsDock provider authority]\n'
    + 'authority-file=/synthetic/cross_chat_authority/run_test.json chat-id=sess_abc123\n'
    + 'actions=team_read\nusage: see AgentsDock instructions\n[End AgentsDock provider authority]'
  const ack = acknowledgement(5, {
    prompt: `Original provider input${suffix}`,
    display_prompt: `Visible human follow-up${suffix}`,
  })
  assert.equal(messageText(ack), 'Visible human follow-up')
  assert.equal(messageText(acknowledgement(6, { prompt: 'A literal [AgentsDock provider authority] example' })),
    'A literal [AgentsDock provider authority] example')
})

await test('goal slice order follows durable sequence even when preserved timestamps move backward', () => {
  const first = acknowledgement(5, { ts: '2026-10-19T12:30:00Z' })
  const second = acknowledgement(8, { ts: '2026-10-19T12:00:00Z' })
  assert.deepEqual(users([first, second]).map(row => row.seq), [5, 8])
})

await test('ordinary, forged, or incomplete steering metadata cannot impersonate accepted goal input', () => {
  const queued = { queued_id: 'queued-5', session_id: 'goal-chat', prompt: 'Pending', file_ids: [] }
  for (const patch of [
    { native_goal_steer: false }, { native_steer: false }, { provider_user_authored: false },
    { native_goal_steer: undefined }, { native_steer: undefined }, { provider_user_authored: undefined },
    { backend: 'claude' as const }, { purpose: 'scheduled_job' }, { run_id: '' }, { run_id: ' ' },
    { run_id: null }, { type: 'turn_steer_requested' },
  ]) {
    const malformed = acknowledgement(5, patch)
    assert.equal(isNativeGoalSteerEvent(malformed), false, JSON.stringify(patch))
    assert.equal(users([malformed]).length, 0, JSON.stringify(patch))
    assert.deepEqual(updateQueuedTurns([queued], malformed), [queued], JSON.stringify(patch))
  }
})

await test('acknowledgement-only history retains stable user identity and public content after sanitizing', () => {
  const ack = acknowledgement()
  const full = [event(1, 'turn_started', { prompt: 'Original task' }), ack,
    event(6, 'assistant_text', { text: 'Follow-up output' })]
  const expected = users(full)[1]
  for (const source of [[ack], historicalTimelineEvents([sanitizeTimelineEvent(ack)]), [ack, { ...ack }]]) {
    const rows = users(source)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].key, expected.key)
    assert.equal(messageText(rows[0].events[0]), 'Use this additional context')
  }
})

await test('authoritative acknowledgement attachments never resurrect an earlier queued selection', () => {
  const file: AgentFile = { id: 'old-file', session_id: 'goal-chat', filename: 'old.txt' }
  const queued = event(1, 'turn_queued', { queued_id: 'queued-5', prompt: 'Earlier draft', file_ids: [file.id] })
  const ack = acknowledgement(5, { file_ids: [] })
  assert.deepEqual(users([queued, ack], [file])[0].files, [])
  assert.equal(users([queued, { ...ack, prompt: '' }], [file]).length, 0)
})

await test('late attachment receipts require the acknowledged chat and explicit file identity', () => {
  const owned: AgentFile = { id: 'owned', session_id: 'goal-chat', filename: 'owned.txt' }
  const foreign: AgentFile = { id: 'foreign', session_id: 'other-chat', filename: 'foreign.txt' }
  const legacy: AgentFile = { id: 'legacy', filename: 'legacy.txt' }
  const ack = acknowledgement(5, { prompt: '', file_ids: ['owned', 'foreign', 'legacy'] })
  const rows = users([ack, event(6, 'file_uploaded', { file: foreign }),
    event(7, 'file_uploaded', { file: legacy, session_id: 'other-chat' }),
    event(8, 'file_uploaded', { file: owned })])
  assert.deepEqual(rows[0].files.map(file => file.id), ['owned'])
})

await test('accepted queue removal is scoped to the exact chat even when IDs and text match', () => {
  const own = { queued_id: 'queued-5', session_id: 'goal-chat', prompt: 'Same', file_ids: [] }
  const foreign = { ...own, session_id: 'other-chat' }
  assert.deepEqual(updateQueuedTurns([own, foreign], acknowledgement()), [foreign])
})

await test('explicit empty public display text is not replaced by private provider input', () => {
  const ack = acknowledgement(5, { prompt: 'Private provider input', display_prompt: '' })
  assert.equal(messageText(ack), '')
  assert.equal(users([ack]).length, 0)
})

await test('equal assistant output on distinct accepted goal inputs is retained in its own slice', () => {
  const rows = projectTimeline([acknowledgement(), event(6, 'assistant_text', { text: 'Same result' }),
    acknowledgement(8), event(9, 'turn_finished', { result_text: 'Same result' })], [])
  assert.deepEqual(rows.filter((row): row is MessageRow => row.kind === 'message')
    .map(row => [row.role, row.events.map(messageText).join('')]), [
    ['user', 'Use this additional context'], ['assistant', 'Same result'],
    ['user', 'Use this additional context'], ['assistant', 'Same result'],
  ])
})

await test('a verified human goal input escapes old scheduled-job metadata on the same native run', () => {
  const rows = projectTimeline([
    event(1, 'turn_started', { backend: 'codex', purpose: 'codex_goal_resume', job_id: 'earlier-job', prompt: 'Goal wake' }),
    event(2, 'assistant_text', { purpose: 'codex_goal_resume', text: 'Earlier scheduled output' }),
    acknowledgement(),
    event(6, 'assistant_text', { purpose: 'codex_goal_resume', text: 'Human follow-up output' }),
    event(7, 'turn_finished', { purpose: 'codex_goal_resume', result_text: 'Human follow-up output' }),
  ], [])
  assert.deepEqual(rows.map(row => row.kind === 'message'
    ? [row.kind, row.role, row.events.map(messageText).join('')]
    : [row.kind]), [
    ['job'], ['message', 'user', 'Use this additional context'],
    ['message', 'assistant', 'Human follow-up output'],
  ])
  assert.ok(rows.filter((row): row is MessageRow => row.kind === 'message')
    .every(row => row.events.every(event => event.run_id === 'goal-owner')))
})
