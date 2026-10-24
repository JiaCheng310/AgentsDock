import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event, ReasoningSummaryStreamItem } from '../types'
import { projectTimeline, traceEventsWithinRow, type TraceRow } from './timeline'
import { overlayReasoningStream, reasoningEventSequence, reasoningItemKey, type ReasoningProjectionOwner } from './timeline-reasoning-stream'

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `event-${seq}`, seq, type, session_id: 'chat', run_id: 'run', ts: '2026-10-24T00:00:00Z', ...patch,
})
const live = (patch: Partial<ReasoningSummaryStreamItem> = {}): ReasoningSummaryStreamItem => ({
  run_id: 'run', item_id: 'thought', backend: 'codex', phase: 'summary', text: 'Live reasoning',
  after_seq: 1, partial: true, ts: '2026-10-24T00:00:01Z', ...patch,
})
function projection(events: Event[]) {
  const owners: ReasoningProjectionOwner[] = []
  return { rows: projectTimeline(events, [], owners), owners }
}
const start = event(1, 'turn_started', { prompt: 'Task' })
const traces = (rows: ReturnType<typeof projectTimeline>) => rows.filter((row): row is TraceRow => row.kind === 'trace')

await test('a known run with no durable trace yet gains a stable overlay without touching ledger rows', () => {
  const source = [start]
  const { rows, owners } = projection(source)
  assert.equal(traces(rows).length, 0)
  assert.equal(owners.length, 1)
  const result = overlayReasoningStream(rows, owners, [live()], 'chat')
  assert.equal(result[0], rows[0])
  assert.equal(traces(result)[0].key, 'turn:run:trace')
  assert.equal(traces(result)[0].runActive, true)
  assert.equal(traces(result)[0].events[0].seq, 1.5)
  assert.equal(source.length, 1)
  assert.equal(traces(rows).length, 0)
  const settled = projection([start, event(9, 'reasoning_summary', { item_id: 'thought', phase: 'summary', text: 'Durable reasoning', reasoning_after_seq: 1 })])
  assert.equal(traces(settled.rows)[0].key, traces(result)[0].key)
  assert.equal(traces(settled.rows)[0].seq, traces(result)[0].seq)
  assert.equal(reasoningItemKey(traces(settled.rows)[0].events[0]), reasoningItemKey(traces(result)[0].events[0]))
})

await test('summary and plaintext lanes retain separate identities and durable completion wins', () => {
  const durable = event(3, 'reasoning_summary', { item_id: 'thought', phase: 'summary', text: 'Final summary', reasoning_after_seq: 1 })
  const { rows, owners } = projection([start, durable])
  const result = overlayReasoningStream(rows, owners, [live(), live({ phase: 'reasoning', text: 'Provider plaintext' })], 'chat')
  assert.deepEqual(traces(result)[0].events.map(value => value.text), ['Final summary', 'Provider plaintext'])
  assert.equal(traces(result)[0].events[0], durable)
  assert.equal(overlayReasoningStream(rows, owners, [live()], 'chat'), rows)
  const plaintext = event(4, 'reasoning_text', { item_id: 'thought', text: 'Final plaintext', reasoning_after_seq: 1 })
  const settled = projection([start, durable, plaintext])
  assert.equal(overlayReasoningStream(settled.rows, settled.owners, [live({ phase: 'reasoning' })], 'chat'), settled.rows)
  assert.notEqual(reasoningItemKey(durable), reasoningItemKey(plaintext), 'legacy plaintext may omit the redundant phase')
})

await test('unknown run, wrong chat, before-start, empty and duplicate snapshots cannot create ghost rows', () => {
  const { rows, owners } = projection([start])
  for (const item of [live({ run_id: 'unknown' }), live({ after_seq: 0 }), live({ text: '  ' })]) {
    assert.equal(overlayReasoningStream(rows, owners, [item], 'chat'), rows)
  }
  assert.equal(overlayReasoningStream(rows, owners, [live()], 'other'), rows)
  assert.equal(traces(overlayReasoningStream(rows, owners, [live(), live()], 'chat'))[0].events.length, 1)
})

await test('assistant text does not finish an actual run, but terminal packets do', () => {
  const liveSource = [start, event(2, 'assistant_text', { text: 'Still working' })]
  const ongoing = projection(liveSource)
  const row = traces(overlayReasoningStream(ongoing.rows, ongoing.owners, [live({ after_seq: 2 })], 'chat'))[0]
  assert.equal(row.active, false)
  assert.equal(row.runActive, true)
  for (const type of ['turn_finished', 'turn_stopped', 'error']) {
    const terminal = projection([...liveSource, event(3, type)])
    assert.equal(overlayReasoningStream(terminal.rows, terminal.owners, [live({ after_seq: 2 })], 'chat'), terminal.rows, type)
  }
})

await test('retained reasoning is ordered in its original goal slice rather than its durable receipt position', () => {
  const ack = event(5, 'turn_steered', { backend: 'codex', native_goal_steer: true, native_steer: true,
    provider_user_authored: true, purpose: 'codex_goal_resume', prompt: 'Follow up' })
  const oldThought = event(10, 'reasoning_text', { item_id: 'before', phase: 'reasoning', text: 'Before input', reasoning_after_seq: 4 })
  const currentThought = event(11, 'reasoning_summary', { item_id: 'after', phase: 'summary', text: 'After input', reasoning_after_seq: 5 })
  const source = [start, ack, oldThought, currentThought]
  const before = JSON.stringify(source)
  const { rows, owners } = projection(source)
  assert.deepEqual(traces(rows).map(row => row.events.map(value => value.text)), [['Before input'], ['After input']])
  assert.deepEqual(traces(rows).map(row => traceEventsWithinRow(row, [oldThought, currentThought]).map(value => value.text)), [['Before input'], ['After input']])
  assert.equal(overlayReasoningStream(rows, owners, [live({ after_seq: 4, item_id: 'stale' })], 'chat'), rows)
  const overlaid = overlayReasoningStream(rows, owners, [live({ after_seq: 6, item_id: 'current' })], 'chat')
  assert.equal(traces(overlaid)[0], traces(rows)[0])
  assert.equal(traces(overlaid)[1].events.at(-1)?.item_id, 'current')
  assert.equal(JSON.stringify(source), before)
})

await test('scheduled transient reasoning stays in its known job card and cannot revive terminal work', () => {
  const job = event(10, 'job_summary', { run_id: null, job_id: 'job', job_status: 'running', job_latest_run_id: 'run' })
  const { rows, owners } = projection([job])
  const result = overlayReasoningStream(rows, owners, [live({ after_seq: 5 })], 'chat')
  assert.equal(result.length, 1)
  assert.equal(result[0].kind, 'job')
  assert.equal(result[0].kind === 'job' && result[0].events.find(value => value.type === 'reasoning_summary')?.text, 'Live reasoning')
  const terminal = projection([job, event(12, 'turn_finished')])
  assert.equal(overlayReasoningStream(terminal.rows, terminal.owners, [live({ after_seq: 11 })], 'chat'), terminal.rows)
})

await test('latest scheduled attempt owns reused run IDs and late old snapshots remain excluded', () => {
  const source = [event(1, 'turn_started', { job_id: 'job' }), event(2, 'turn_finished'),
    event(5, 'turn_started', { job_id: 'job' })]
  const { rows, owners } = projection(source)
  assert.equal(overlayReasoningStream(rows, owners, [live({ after_seq: 1 })], 'chat'), rows)
  const result = overlayReasoningStream(rows, owners, [live({ after_seq: 5 })], 'chat')
  assert.equal(result[0].kind === 'job' && result[0].events.at(-1)?.type, 'reasoning_summary')
})

await test('terminal-free job metadata cannot absorb a later human input on the same native run', () => {
  const source = [event(1, 'job_summary', { job_id: 'job', job_status: 'running' }),
    event(5, 'turn_steered', { backend: 'codex', native_goal_steer: true, native_steer: true,
      provider_user_authored: true, purpose: 'codex_goal_resume', prompt: 'Human input' })]
  const { rows, owners } = projection(source)
  assert.equal(overlayReasoningStream(rows, owners, [live({ after_seq: 2 })], 'chat'), rows)
  const result = overlayReasoningStream(rows, owners, [live({ after_seq: 5 })], 'chat')
  assert.equal(result.find(row => row.kind === 'job'), rows.find(row => row.kind === 'job'))
  assert.equal(traces(result)[0].key, 'turn:run:start-5:trace')
})

await test('invalid retained anchors keep durable placement and public commentary is not reclassified', () => {
  for (const anchor of [-1, NaN, Infinity, 20]) assert.equal(reasoningEventSequence(event(10, 'reasoning_text', { reasoning_after_seq: anchor })), 10)
  assert.equal(reasoningEventSequence(event(10, 'reasoning_summary', { phase: 'commentary', reasoning_after_seq: 1 })), 10)
})

await test('synthetic imported transcripts without terminal events never acquire live reasoning', () => {
  for (const patch of [{ run_id: 'import_shared' }, { imported: true }]) {
    const { rows, owners } = projection([event(1, 'turn_started', patch),
      event(2, 'reasoning_text', { ...patch, text: 'Historical reasoning' })])
    assert.equal(traces(rows)[0].runActive, false)
    assert.equal(overlayReasoningStream(rows, owners, [live({ run_id: patch.run_id ?? 'run' })], 'chat'), rows)
  }
})

await test('repeated snapshots replace only projected trace content and do not carry unrelated payloads', () => {
  const { rows, owners } = projection([start, event(2, 'assistant_text', { text: 'Working' })])
  const first = overlayReasoningStream(rows, owners, [live()], 'chat')
  const second = overlayReasoningStream(rows, owners, [live({ text: 'More reasoning',
    prompt: 'Never copy arbitrary transport extras', raw: { secret: 'not a trace field' } })], 'chat')
  assert.equal(traces(first)[0].key, traces(second)[0].key)
  assert.equal(traces(first)[0].events[0].text, 'Live reasoning')
  assert.equal(traces(second)[0].events.length, 1)
  assert.equal(traces(second)[0].events[0].text, 'More reasoning')
  assert.equal(traces(second)[0].events[0].prompt, undefined)
  assert.equal(traces(second)[0].events[0].raw, undefined)
  for (const row of rows) assert.equal(second.find(candidate => candidate.key === row.key), row)
})
