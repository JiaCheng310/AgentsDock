import { create } from 'zustand'
import type { ReasoningSummaryStreamSnapshot } from '../types'

export interface SelectedReasoningStream {
  profileGeneration: number
  sessionId: string
  snapshot: ReasoningSummaryStreamSnapshot
}

interface ReasoningStreamState {
  selected: SelectedReasoningStream | null
  replace(value: SelectedReasoningStream): void
  clear(): void
  finishRun(sessionId: string, runId: string): void
}

/**
 * Selected-socket presentation only. This store has no persistence or network
 * effects and never changes the durable timeline, its cursor, or the sidebar.
 * Connection/selection leases are checked by the stream owner before publish.
 */
export const useReasoningStreamStore = create<ReasoningStreamState>((set, get) => ({
  selected: null,
  replace(value) {
    set({ selected: value })
  },
  clear() {
    if (get().selected) set({ selected: null })
  },
  finishRun(sessionId, runId) {
    const selected = get().selected
    if (!selected || selected.sessionId !== sessionId) return
    const items = selected.snapshot.items.filter(item => item.run_id !== runId)
    if (items.length === selected.snapshot.items.length) return
    set({ selected: items.length ? { ...selected, snapshot: { ...selected.snapshot, items } } : null })
  },
}))
