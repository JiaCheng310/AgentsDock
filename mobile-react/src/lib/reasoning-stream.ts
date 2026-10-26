import type { ReasoningSummaryStreamSnapshot } from '../types'

/** Retain only the bounded presentation contract, never arbitrary packet extras. */
export function normalizedReasoningStream(packet: ReasoningSummaryStreamSnapshot): ReasoningSummaryStreamSnapshot {
  return {
    type: 'reasoning_summary_stream', session_id: packet.session_id,
    instance_id: packet.instance_id, revision: packet.revision,
    items: packet.items.map(item => ({
      run_id: item.run_id, item_id: item.item_id, backend: item.backend,
      phase: item.phase, text: item.text, ts: item.ts, after_seq: item.after_seq,
      ...(typeof item.partial === 'boolean' ? { partial: item.partial } : {}),
      // The server's shared snapshot budget reports only text_truncated;
      // preserve that disclosure without guessing an unavailable source size.
      ...(item.reasoning_text_truncated === true || 'text_truncated' in item && item.text_truncated === true
        ? { reasoning_text_truncated: true } : {}),
      ...(Number.isSafeInteger(item.reasoning_text_chars) && item.reasoning_text_chars! >= item.text.length
        ? { reasoning_text_chars: item.reasoning_text_chars } : {}),
    })),
  }
}

/** Validate the transient lane separately so it cannot advance a durable cursor. */
export function isReasoningSummaryStream(value: unknown): value is ReasoningSummaryStreamSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const packet = value as Record<string, unknown>
  if (packet.type !== 'reasoning_summary_stream'
    || !identity(packet.session_id) || !identity(packet.instance_id)
    || !Number.isSafeInteger(packet.revision) || Number(packet.revision) < 0
    || !Array.isArray(packet.items) || packet.items.length > 256) return false
  const identities = new Set<string>()
  let textSize = 0
  for (const value of packet.items) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const item = value as Record<string, unknown>
    if (!identity(item.run_id) || !identity(item.item_id)
      || item.backend !== 'codex'
      || (item.phase !== 'summary' && item.phase !== 'reasoning')
      || typeof item.text !== 'string'
      || !Number.isSafeInteger(item.after_seq) || Number(item.after_seq) < 0
      || typeof item.ts !== 'string' || item.ts.length > 80 || !Number.isFinite(Date.parse(item.ts))) return false
    const key = JSON.stringify([item.run_id, item.item_id, item.phase])
    if (identities.has(key)) return false
    identities.add(key)
    textSize += item.text.length
    if (textSize > 8 * 1024 * 1024) return false
  }
  return true
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value)
}
