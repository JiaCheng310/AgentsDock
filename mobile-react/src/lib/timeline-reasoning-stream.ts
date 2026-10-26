import type { Event, ReasoningSummaryStreamItem } from '../types'
import type { TimelineRow, TraceRow } from './timeline'

/** Presentation identity shared by a transient item and its durable completion. */
export function reasoningItemKey(event: Pick<Event, 'run_id' | 'item_id' | 'id' | 'phase'> & Partial<Pick<Event, 'type'>>): string {
  return event.run_id && event.item_id
    ? `reasoning:${JSON.stringify([event.run_id, event.item_id, event.phase === 'reasoning' || event.type === 'reasoning_text' ? 'reasoning' : 'summary'])}`
    : event.id
}

/** Retained provider reasoning belongs where it began, not where it was persisted. */
export function reasoningEventSequence(event: Pick<Event, 'type' | 'phase' | 'reasoning_after_seq' | 'seq'>): number {
  const anchor = event.reasoning_after_seq
  return (event.type === 'reasoning_summary' || event.type === 'reasoning_text')
    && event.phase !== 'commentary' && Number.isSafeInteger(anchor) && anchor! >= 0 && anchor! < event.seq
    ? anchor! + 0.5 : event.seq
}

export interface ReasoningProjectionOwner {
  kind: 'turn' | 'job'
  sessionId: string
  runId: string
  key: string
  traceKey: string
  seq: number
  runActive: boolean
  traceActive: boolean
  afterSeq?: number
  throughSeq?: number
  promotedCommentaryIds: string[]
  durableReasoningKeys: ReadonlySet<string>
}

export function reasoningWithinBounds(sequence: number, owner: { afterSeq?: number; throughSeq?: number }): boolean {
  // Durable bounds are integer ledger positions. A transient anchored after
  // the last included position still precedes the next goal-input boundary.
  return (owner.afterSeq === undefined || sequence > owner.afterSeq)
    && (owner.throughSeq === undefined || sequence < owner.throughSeq + 1)
}

/** Overlay only; never mutate the ledger, advance cursors, or re-project history. */
export function overlayReasoningStream(
  rows: TimelineRow[],
  owners: readonly ReasoningProjectionOwner[],
  items: readonly ReasoningSummaryStreamItem[] | undefined,
  sessionId: string,
): TimelineRow[] {
  if (!items?.length || !owners.length) return rows
  const ownersByRun = new Map<string, ReasoningProjectionOwner[]>()
  for (const owner of owners) {
    if (owner.sessionId !== sessionId) continue
    const list = ownersByRun.get(owner.runId) ?? []
    list.push(owner)
    ownersByRun.set(owner.runId, list)
  }
  const pending = new Map<ReasoningProjectionOwner, Event[]>()
  const seen = new Set<string>()
  for (const item of items) {
    if (item.backend !== 'codex' || !['summary', 'reasoning'].includes(item.phase)
      || !item.text.trim() || !Number.isSafeInteger(item.after_seq) || item.after_seq < 0) continue
    const sequence = item.after_seq + 0.5
    const owner = ownersByRun.get(item.run_id)?.findLast(value =>
      (sequence >= value.seq || value.kind === 'job' && value.afterSeq === undefined)
      && reasoningWithinBounds(sequence, value))
    if (!owner?.runActive) continue
    const event: Event = { id: '', session_id: sessionId,
      run_id: item.run_id, item_id: item.item_id, backend: 'codex', phase: item.phase,
      text: item.text, ts: item.ts, partial: item.partial === true,
      ...(item.reasoning_text_truncated === true ? { reasoning_text_truncated: true } : {}),
      ...(Number.isSafeInteger(item.reasoning_text_chars) && item.reasoning_text_chars! >= item.text.length
        ? { reasoning_text_chars: item.reasoning_text_chars } : {}),
      type: item.phase === 'reasoning' ? 'reasoning_text' : 'reasoning_summary',
      seq: sequence, reasoning_after_seq: item.after_seq }
    const identity = reasoningItemKey(event)
    if (seen.has(identity) || owner.durableReasoningKeys.has(identity)) continue
    seen.add(identity)
    event.id = `stream:${identity}`
    const additions = pending.get(owner) ?? []
    additions.push(event)
    pending.set(owner, additions)
  }
  if (!pending.size) return rows
  const byKey = new Map(rows.map((row, index) => [row.key, index]))
  const result = [...rows]
  const inserted: TraceRow[] = []
  for (const [owner, additions] of pending) {
    const key = owner.kind === 'job' ? owner.key : owner.traceKey
    const index = byKey.get(key)
    const row = index === undefined ? undefined : result[index]
    if (row?.kind === 'job' || row?.kind === 'trace') {
      result[index!] = { ...row, events: [...row.events, ...additions].sort((a, b) => reasoningEventSequence(a) - reasoningEventSequence(b)) }
    } else if (owner.kind === 'turn') {
      inserted.push({ kind: 'trace', key: owner.traceKey, seq: Math.min(...additions.map(reasoningEventSequence)),
        events: additions.sort((a, b) => reasoningEventSequence(a) - reasoningEventSequence(b)),
        promotedCommentaryIds: owner.promotedCommentaryIds, runId: owner.runId,
        active: owner.traceActive, runActive: owner.runActive,
        afterSeq: owner.afterSeq, throughSeq: owner.throughSeq })
    }
  }
  // New trace rows join their chronological edge, retaining all existing row
  // references and the projector's intentional final-answer/media placement.
  for (const row of inserted.sort((a, b) => a.seq - b.seq)) {
    const index = result.findIndex(value => value.seq > row.seq)
    result.splice(index < 0 ? result.length : index, 0, row)
  }
  return result
}
