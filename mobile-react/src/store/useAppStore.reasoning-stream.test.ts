import assert from 'node:assert/strict'
import test from 'node:test'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppState as NativeAppState } from 'react-native'
import type { Event, ReasoningSummaryStreamSnapshot, Session, TimelinePage } from '../types'
import { client, useAppStore } from './useAppStore'
import { useReasoningStreamStore } from './useReasoningStreamStore'

// Real selection/stream ownership and store implementation; native transport,
// persistence and providers are mocked here. Native acceptance is separate.
const sessions: Session[] = ['a', 'b'].map(id => ({ id, backend: 'codex', title: id, latest_event_seq: 2 }))
const event = (id: string, seq: number, type = 'turn_started'): Event => ({
  id: `${id}-${seq}`, session_id: id, seq, type, run_id: `run-${id}`, ts: '2026-10-24T00:00:00Z',
})
const packet = (sessionId: string, revision = 1): ReasoningSummaryStreamSnapshot => ({
  type: 'reasoning_summary_stream', session_id: sessionId,
  instance_id: 'owned-instance', revision,
  items: [{ run_id: `run-${sessionId}`, item_id: 'item-1', phase: 'summary', backend: 'codex',
    text: `EPHEMERAL_REASONING_${revision}`, after_seq: 2, ts: '2026-10-24T00:00:00Z' }],
})
type Lease = {
  id: string
  receive: Parameters<typeof client.stream>[2]
  state: Parameters<typeof client.stream>[3]
  reasoning: NonNullable<Parameters<typeof client.stream>[5]>
  stopped: boolean
}
const leases: Lease[] = []
const original = { page: client.sessionPage, stream: client.stream, files: client.files, read: client.markRead, refresh: useAppStore.getState().refreshSessions }
let pageReads = 0
const appState = NativeAppState as typeof NativeAppState & { __emitAppState(value: string): void }

client.configure('http://127.0.0.1:1', '')
client.markValidated()
client.sessionPage = async id => {
  pageReads += 1
  return { session: sessions.find(session => session.id === id)!, events: [event(id, 2)],
    queued_turns: [], latest_seq: 2, total: 1, has_more: false } as TimelinePage
}
client.files = async () => ({ files: [], total: 0, offset: 0, limit: 60, has_more: false })
client.markRead = async id => sessions.find(session => session.id === id)!
client.stream = (id, _after, receive, state, _runtime, reasoning) => {
  assert.ok(reasoning, 'the real selected stream must subscribe to reasoning')
  const lease = { id, receive, state, reasoning, stopped: false }
  leases.push(lease)
  state(true)
  return () => { lease.stopped = true }
}

try {
  appState.__emitAppState('active')
  useAppStore.setState({ initialized: true, activeProfileId: 'uninitialized', profileGeneration: 0,
    serverConfigured: true, connected: true, connecting: false, workspaceAdopting: false,
    health: { ok: true, server_identity: 'uninitialized', api_contract_version: 9 }, sessions,
    snapshots: {}, selectedSessionId: null, liveConnected: false, refreshSessions: async () => {} })

  await test('reasoning bursts do not publish app-store updates, mutate durable state, read cursors or cache', async () => {
    await useAppStore.getState().selectSession('a')
    const lease = leases.at(-1)!
    const before = useAppStore.getState()
    const reads = pageReads
    let writes = 0
    const unsubscribe = useAppStore.subscribe(() => { writes += 1 })
    for (let revision = 1; revision <= 300; revision += 1) lease.reasoning(packet('a', revision))
    unsubscribe()
    assert.equal(writes, 0)
    assert.equal(useAppStore.getState(), before)
    assert.equal(useAppStore.getState().snapshots.a.latestSeq, 2)
    assert.equal(pageReads, reads)
    assert.equal(useReasoningStreamStore.getState().selected?.snapshot.revision, 300)
    const persisted = await AsyncStorage.multiGet(await AsyncStorage.getAllKeys())
    assert.ok(persisted.every(([, value]) => !value?.includes('EPHEMERAL_REASONING_')))
  })

  await test('disconnect clears transient text; changing chats rejects callbacks from the old lease', async () => {
    const a = leases.at(-1)!
    a.state(false)
    assert.equal(useReasoningStreamStore.getState().selected, null)
    a.state(true)
    a.reasoning(packet('a', 301))
    await useAppStore.getState().selectSession('b')
    assert.equal(a.stopped, true)
    assert.equal(useReasoningStreamStore.getState().selected, null)
    const b = leases.at(-1)!
    b.reasoning(packet('b'))
    const selected = useReasoningStreamStore.getState().selected
    a.reasoning(packet('a', 302))
    a.state(false)
    assert.equal(useReasoningStreamStore.getState().selected, selected)
    b.reasoning(packet('a', 303))
    assert.equal(useReasoningStreamStore.getState().selected, selected, 'foreign session packet rejected')
  })

  await test('terminal events reach durable state before their transient text is retired', async () => {
    const b = leases.at(-1)!
    b.reasoning(packet('b', 2))
    let sawDurableTerminal = false
    const unsubscribe = useReasoningStreamStore.subscribe(state => {
      if (state.selected == null) {
        sawDurableTerminal = useAppStore.getState().snapshots.b.events.some(value => value.type === 'turn_stopped')
      }
    })
    b.receive(event('b', 3, 'turn_stopped'))
    unsubscribe()
    assert.equal(sawDurableTerminal, true)
    assert.equal(useReasoningStreamStore.getState().selected, null)
    assert.equal(useAppStore.getState().snapshots.b.latestSeq, 3)
  })

  await test('resynchronization retires the old stream without accepting late reasoning', async () => {
    const old = leases.at(-1)!
    old.reasoning(packet('b', 3))
    await useAppStore.getState().syncSelectedSession('manual')
    assert.equal(old.stopped, true)
    assert.equal(useReasoningStreamStore.getState().selected, null)
    old.reasoning(packet('b', 4))
    assert.equal(useReasoningStreamStore.getState().selected, null)
    const current = leases.at(-1)!
    current.reasoning(packet('b'))
    assert.equal(useReasoningStreamStore.getState().selected?.snapshot.revision, 1)
  })
} finally {
  appState.__emitAppState('background')
  await useAppStore.getState().selectSession('a')
  useReasoningStreamStore.getState().clear()
  client.sessionPage = original.page
  client.stream = original.stream
  client.files = original.files
  client.markRead = original.read
  useAppStore.setState({ refreshSessions: original.refresh })
  client.dispose()
}
