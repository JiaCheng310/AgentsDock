import type { Event } from '../types'
import { crossChatQueueRefreshSessionId } from './queue'
import { isNativeGoalSteerEvent } from './native-goal-steering'

/** One queue's observations within one validated server instance. */
export class QueueReconciliationState {
  private currentRevision = 0
  private coveredSeq = 0
  private observedSeq = 0

  get revision(): number { return this.currentRevision }

  /** False suppresses shelf replay, never transcript ingestion or a confirming read. */
  observe(event: Event): boolean {
    if (!queueObservation(event)) return true
    // Even a removal for an absent ID invalidates an in-flight HTTP queue read.
    this.currentRevision += 1
    if (!Number.isSafeInteger(event.seq) || event.seq <= 0) return true
    const previous = Math.max(this.coveredSeq, this.observedSeq)
    this.observedSeq = Math.max(this.observedSeq, event.seq)
    // An older receipt can follow a delivery. A fresh read recovers other IDs
    // too; a global timeline cursor must never decide whether input was queued.
    return event.seq > previous
  }

  commitSnapshot(latestSeq?: number | null): void {
    this.currentRevision += 1
    if (typeof latestSeq === 'number' && Number.isSafeInteger(latestSeq) && latestSeq >= 0) {
      this.coveredSeq = Math.max(this.coveredSeq, latestSeq)
    }
  }
}

function queueObservation(event: Event): boolean {
  if (event.type === 'queue_snapshot' && Array.isArray(event.positions)) return true
  if (event.positions?.length || crossChatQueueRefreshSessionId(event)) return true
  if (event.type === 'turn_queue_paused') return Boolean(event.queued_id || event.queued_ids?.length)
  if (!event.queued_id) return false
  return event.type === 'turn_queued'
    || event.type === 'turn_queue_delivery_fenced'
    || event.type === 'turn_unqueued'
    || event.type === 'turn_started'
    || isNativeGoalSteerEvent(event)
    || event.type === 'turn_queue_run_now'
    || event.type === 'turn_queue_updated'
}
