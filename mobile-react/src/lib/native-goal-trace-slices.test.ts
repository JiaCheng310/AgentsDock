import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event } from '../types'
import { projectTimeline, traceEventsWithinRow, type TraceRow } from './timeline'
import { reuseStableTimelineRows, sameTimelineRow } from './timeline-row-reuse'

// These presentation contracts are intentionally independent of native/provider
// acceptance. Keep the same real run owner while dividing its displayed trace.
type GoalEvent = Event & { native_goal_steer?: boolean; provider_user_authored?: boolean }
type BoundedTraceRow = TraceRow & { afterSeq?: number; throughSeq?: number }
const event = (seq: number, type: string, patch: Partial<GoalEvent> = {}): GoalEvent => ({
  id: `goal-trace-${seq}`, seq, type, session_id: 'goal-chat', run_id: 'goal-owner',
  ts: `2026-10-20T12:00:${String(seq).padStart(2, '0')}Z`, ...patch,
})
const acknowledgement = (seq: number): GoalEvent => event(seq, 'turn_steered', {
  backend: 'codex', purpose: 'codex_goal_resume', native_steer: true,
  native_goal_steer: true, provider_user_authored: true,
  queued_id: `queued-${seq}`, prompt: `Follow-up ${seq}`,
})

await test('accepted goal inputs divide trace bounds without replacing the native run owner', () => {
  const source = [
    event(1, 'turn_started', { prompt: 'Original task' }),
    event(2, 'reasoning_summary', { phase: 'analysis', text: 'Before first follow-up' }),
    event(3, 'assistant_text', { text: 'First output' }),
    acknowledgement(5),
    event(6, 'reasoning_summary', { phase: 'analysis', text: 'After first follow-up' }),
    event(7, 'assistant_text', { text: 'Second output' }),
    acknowledgement(8),
    event(9, 'reasoning_summary', { phase: 'analysis', text: 'After second follow-up' }),
    event(10, 'turn_finished', { result_text: 'Final output' }),
  ]
  const before = JSON.stringify(source)
  const traces = projectTimeline(source, [])
    .filter((row): row is BoundedTraceRow => row.kind === 'trace')
  assert.deepEqual(traces.map(row => ({
    owner: row.runId, after: row.afterSeq, through: row.throughSeq,
    active: row.active, events: row.events.map(value => value.seq),
  })), [
    { owner: 'goal-owner', after: undefined, through: 4, active: false, events: [2] },
    { owner: 'goal-owner', after: 5, through: 7, active: false, events: [6] },
    { owner: 'goal-owner', after: 8, through: undefined, active: false, events: [9] },
  ])
  assert.equal(new Set(traces.map(row => row.key)).size, 3)
  assert.equal(JSON.stringify(source), before, 'projection must not rewrite authoritative packets')
})

await test('stable row reuse cannot discard changed lazy-trace boundaries on an already inactive slice', () => {
  const trace: BoundedTraceRow = {
    kind: 'trace', key: 'turn:goal-owner:trace', seq: 2, runId: 'goal-owner',
    active: false, events: [event(2, 'reasoning_summary', { text: 'Earlier reasoning' })],
    promotedCommentaryIds: [],
  }
  assert.equal(sameTimelineRow(trace, { ...trace }), true)
  for (const patch of [{ throughSeq: 4 }, { afterSeq: 5 }, { afterSeq: 5, throughSeq: 7 }]) {
    const bounded: BoundedTraceRow = { ...trace, ...patch }
    assert.equal(sameTimelineRow(trace, bounded), false, JSON.stringify(patch))
    const updated = reuseStableTimelineRows([trace], [bounded])
    assert.equal(updated[0], bounded, 'the rendered row must receive the new bounds')
    assert.equal(sameTimelineRow(bounded, { ...bounded }), true)
    assert.equal(sameTimelineRow(bounded, trace), false, 'removing a bound must also invalidate reuse')
  }
})

await test('lazy full-run trace detail stays within both complete and ack-only history slices', () => {
  const source = [event(1, 'turn_started', { prompt: 'Original' }),
    event(2, 'reasoning_summary', { text: 'Earlier reasoning' }), acknowledgement(5),
    event(6, 'reasoning_summary', { text: 'Middle reasoning' }), acknowledgement(8),
    event(9, 'reasoning_summary', { text: 'Current reasoning' })]
  const full = projectTimeline(source, []).filter((row): row is TraceRow => row.kind === 'trace')
  assert.deepEqual(full.map(row => traceEventsWithinRow(row, source).map(event => event.seq)), [[1, 2], [6], [9]])
  const partial = projectTimeline(source.slice(2), []).filter((row): row is TraceRow => row.kind === 'trace')
  assert.deepEqual(partial.map(row => row.key), full.slice(1).map(row => row.key))
  assert.deepEqual(partial.map(row => traceEventsWithinRow(row, source).map(event => event.seq)), [[6], [9]])
})

await test('retained reasoning at the predecessor edge never leaks into a later goal input', () => {
  const before = event(10, 'reasoning_text', { item_id: 'before', phase: 'reasoning', reasoning_after_seq: 4, text: 'Previous slice' })
  const after = event(11, 'reasoning_text', { item_id: 'after', phase: 'reasoning', reasoning_after_seq: 5, text: 'Current slice' })
  const rows = projectTimeline([event(1, 'turn_started', { prompt: 'Original' }), acknowledgement(5), before, after], [])
    .filter((row): row is TraceRow => row.kind === 'trace')
  assert.deepEqual(rows.map(row => row.events.map(value => value.id)), [[before.id], [after.id]])
  assert.deepEqual(rows.map(row => traceEventsWithinRow(row, [before, after]).map(value => value.id)), [[before.id], [after.id]])
  assert.deepEqual(rows.map(row => row.runActive), [false, true])
})
