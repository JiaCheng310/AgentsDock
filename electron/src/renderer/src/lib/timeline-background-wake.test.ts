import { describe, expect, it } from 'vitest'
import type { Event } from '@shared/types'
import { projectTimeline, renderTimelineItems } from './timeline'
import { cachedTimelineProjection, clearTimelineProjectionCache } from './timeline-projection-cache'
import { updateActiveSessions } from '../store/app-store'

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  id: `wake-${seq}`, session_id: 'chat-wake', seq, type,
  ts: `2026-10-27T12:00:0${seq}Z`, run_id: 'native-wake', backend: 'claude', ...patch
})
const wake = (patch: Partial<Event> = {}): Event => event(1, 'turn_started', {
  purpose: 'provider_background_wake', prompt: '', provider_generated: true, metadata_only: true,
  parent_run_id: 'native-parent', parent_run_ids: ['native-parent'], provider_session_id: 'native-thread',
  provider_task_id: 'task-1', provider_task_ids: ['task-1'], provider_task_type: 'local_bash',
  provider_tool_use_id: 'tool-1', ...patch
})

describe('native background wake boundary', () => {
  it('keeps active work and its answer without an empty user bubble, cold and appended', () => {
    const records = [wake(), event(2, 'reasoning_summary', { text: 'Checking the background result.', phase: 'commentary' })]
    clearTimelineProjectionCache()
    const live = cachedTimelineProjection('background-wake', records, []).rendered
    expect(live.some(row => row.kind === 'message' && row.role === 'user')).toBe(false)
    expect(live.find(row => row.kind === 'progress')).toMatchObject({ active: true, events: [{ run_id: 'native-wake' }] })
    expect(updateActiveSessions(new Set(), records[0]).has('chat-wake')).toBe(true)
    records.push(event(3, 'turn_finished', { result_text: 'The background result is ready.' }))
    const cold = renderTimelineItems(projectTimeline(records, []))
    expect(cachedTimelineProjection('background-wake', records, []).rendered).toEqual(cold)
    expect(cold.filter(row => row.kind === 'message')).toMatchObject([{ role: 'assistant', event: { seq: 3 } }])
    expect(cold.find(row => row.kind === 'progress')).toMatchObject({ active: false })
  })

  it('keeps the native owner stoppable and retires its progress on Stop', () => {
    const records = [wake(), event(2, 'reasoning_summary', { text: 'Working.', phase: 'commentary' }), event(3, 'turn_stopped')]
    const rows = renderTimelineItems(projectTimeline(records, []))
    expect(rows.some(row => row.kind === 'message' && row.role === 'user')).toBe(false)
    expect(rows.find(row => row.kind === 'progress')).toMatchObject({ active: false, events: [{ run_id: 'native-wake' }] })
    expect(records.reduce(updateActiveSessions, new Set<string>()).has('chat-wake')).toBe(false)
  })

  it.each([
    { purpose: undefined }, { provider_generated: false }, { metadata_only: false },
    { parent_run_id: undefined }, { parent_run_id: 'native-wake' }, { provider_session_id: undefined },
    { provider_task_id: undefined }, { provider_task_ids: ['different-task'] },
    { provider_task_type: 'unknown' }, { provider_tool_use_id: undefined },
    { provider_user_authored: true }, { imported: true, run_id: 'import_wake' },
    { backend: 'codex' }, { prompt: 'A real user instruction.' }
  ] satisfies Partial<Event>[])('preserves unproven or user-authored input: %j', patch => {
    const rows = renderTimelineItems(projectTimeline([wake(patch)], []))
    expect(rows.filter(row => row.kind === 'message' && row.role === 'user')).toHaveLength(1)
  })
})
