import assert from 'node:assert/strict'
import test from 'node:test'
import type { Event } from '../types'
import { QueueReconciliationState } from './queue-reconciliation'

function event(seq: number, type = 'turn_queued', queuedId = 'first'): Event {
  return { id: `${type}-${seq}`, seq, type, session_id: 'queue-test', queued_id: queuedId, ts: '2026-10-20T00:00:00Z' }
}

await test('unrelated timeline sequence never hides a queued receipt', () => {
  const queue = new QueueReconciliationState()
  queue.commitSnapshot(10)
  const revision = queue.revision
  queue.observe(event(100, 'reasoning_summary'))
  assert.equal(queue.revision, revision)
  assert.equal(queue.observe(event(11)), true)
})

await test('covered or out-of-order queue packets require reconciliation rather than shelf replay', () => {
  const queue = new QueueReconciliationState()
  queue.commitSnapshot(10)
  assert.equal(queue.observe(event(10)), false)
  assert.equal(queue.observe(event(12, 'turn_unqueued')), true)
  assert.equal(queue.observe(event(11)), false)
  assert.equal(queue.observe(event(11, 'turn_queued', 'other-id')), false)
  assert.equal(queue.observe(event(13)), true)
})

await test('absent-ID removals and empty sparse snapshots invalidate in-flight queue reads', () => {
  const queue = new QueueReconciliationState()
  const initial = queue.revision
  queue.observe(event(1, 'turn_unqueued', 'absent'))
  assert.equal(queue.revision, initial + 1)
  queue.observe({ ...event(2, 'queue_snapshot'), positions: [], queued_id: undefined })
  assert.equal(queue.revision, initial + 2)
})

await test('malformed native goal metadata cannot advance the queue observation clock', () => {
  const queue = new QueueReconciliationState()
  queue.observe({ ...event(20, 'turn_steered'), native_goal_steer: true })
  assert.equal(queue.revision, 0)
  assert.equal(queue.observe(event(1)), true)
})

await test('unsequenced reads do not invent coverage and new server scopes start clean', () => {
  const old = new QueueReconciliationState()
  old.commitSnapshot(100)
  old.commitSnapshot()
  assert.equal(old.observe(event(101)), true)
  const replacement = new QueueReconciliationState()
  assert.equal(replacement.observe(event(1)), true)
})
