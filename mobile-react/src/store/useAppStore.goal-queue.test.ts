import assert from 'node:assert/strict'
import test from 'node:test'
import { projectTimeline } from '../lib/timeline'
import { AgentServerRequestTimeoutError } from '../api/AgentServerClient'
import type { Event, Health, QueuedTurn, Session, TimelinePage } from '../types'
import { client, useAppStore } from './useAppStore'

// Store + production HTTP encoder + stream callback regressions. Transport and
// native persistence are synthetic; these are not live-provider acceptance.
const session: Session = {
  id: 'goal-queue-regression', title: 'Goal queue regression', backend: 'codex',
  model: 'test-model', effort: 'high',
  codex_goal: { threadId: 'goal-thread', objective: 'Synthetic objective', status: 'active',
    tokensUsed: 1, timeUsedSeconds: 1, createdAt: 1, updatedAt: 1 },
}
const health: Health = {
  ok: true, server_identity: 'goal-queue-server', api_contract_version: 8,
  active: [session.id], active_runs: [{ session_id: session.id, run_id: 'goal-owner' }],
  capabilities: { codex_controls: { available: true, version: 2, interactive_client_capability: 'codex_interactive_v1' } },
}
const first: QueuedTurn = { queued_id: 'first-followup', session_id: session.id, prompt: 'First follow-up', file_ids: [], position: 1 }
const second: QueuedTurn = { queued_id: 'second-followup', session_id: session.id, prompt: 'Second follow-up', file_ids: [], position: 2 }
const original = {
  fetch: globalThis.fetch, page: client.sessionPage, queue: client.queue, stream: client.stream,
  sync: useAppStore.getState().syncSelectedSession, markRead: useAppStore.getState().markRead,
  refreshSessions: useAppStore.getState().refreshSessions, refreshFiles: useAppStore.getState().refreshFiles,
}
type Request = { path: string; method: string; body: Record<string, unknown> }
type GoalEvent = Event & { native_goal_steer?: boolean; provider_user_authored?: boolean }
let emit!: (event: Event) => void
let seq = 100
let boot = 0
let publicQueue: QueuedTurn[] = []
const requests: Request[] = []
let respond: (request: Request) => Promise<Response>
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}
function event(type: string, patch: Partial<GoalEvent> = {}): GoalEvent {
  seq += 1
  return { id: `goal-event-${seq}`, seq, session_id: session.id, run_id: 'goal-owner',
    ts: '2026-10-19T12:00:00Z', type, ...patch }
}
function acceptedGoalInput(turn = first): GoalEvent {
  return event('turn_steered', { queued_id: turn.queued_id, prompt: turn.prompt,
    native_goal_steer: true, native_steer: true, backend: 'codex',
    purpose: 'codex_goal_resume', provider_user_authored: true })
}
function page(turns = publicQueue): TimelinePage {
  return { session, events: [], queued_turns: turns, latest_seq: seq, total: 0, before: null, has_more: false }
}
function queuedIds() {
  return useAppStore.getState().snapshots[session.id].queuedTurns.map(turn => turn.queued_id)
}
async function flush() { for (let index = 0; index < 30; index += 1) await Promise.resolve() }
async function reset(turns: QueuedTurn[] = [], draft = 'Next follow-up') {
  client.markValidated()
  seq += 100
  boot += 1
  requests.length = 0
  publicQueue = turns
  client.sessionPage = async () => page()
  client.queue = async () => publicQueue
  respond = async request => { throw new Error(`Unexpected test request: ${request.method} ${request.path}`) }
  useAppStore.setState({
    initialized: true, serverConfigured: true, activeProfileId: 'uninitialized', profileGeneration: 0,
    connected: true, connecting: false, switchingProfileId: null, workspaceAdopting: false,
    health: { ...health, server_instance_id: `goal-boot-${boot}` }, runtime: null,
    sessions: [session], selectedSessionId: session.id, activeSessionIds: new Set([session.id]),
    drafts: { [session.id]: draft }, chatReferencesBySession: {}, teamReferencesBySession: {},
    uploads: {}, uploadPending: {}, uploadFailed: {}, sendingSessionIds: new Set(), turnAdmissionTokens: {},
    queuedRunStatus: {}, pendingQueuedRunIds: new Set(), stoppingSessionIds: new Set(),
    error: null, syncError: null, historyWindow: null, liveConnected: false,
    snapshots: { [session.id]: { session, events: [], queuedTurns: turns, files: [], filesTotal: 0,
      latestSeq: seq, hasMore: false, cachedAt: Date.now() } },
    markRead: async () => {}, refreshSessions: async () => {}, refreshFiles: async () => {},
    syncSelectedSession: original.sync,
  })
  await original.sync('manual')
  useAppStore.setState({ syncSelectedSession: async () => {} })
}
const send = () => useAppStore.getState().sendPrompt(false, 0, session.id)

try {
  globalThis.fetch = async (input, init) => {
    const request = { path: new URL(String(input)).pathname, method: init?.method ?? 'GET',
      body: JSON.parse(String(init?.body ?? '{}')) }
    requests.push(request)
    return respond(request)
  }
  client.stream = (_id, _after, onEvent, onState) => { emit = onEvent; onState(true); return () => {} }

  await test('Queue during a goal is one ordinary send, with no Stop or goal mutation', async () => {
    await reset([], first.prompt)
    respond = async request => {
      assert.equal(request.path, `/api/sessions/${session.id}/turns`)
      assert.equal(request.method, 'POST')
      assert.equal(request.body.prompt, first.prompt)
      assert.ok((request.body.client_capabilities as string[]).includes('codex_interactive_v1'))
      publicQueue = [first]
      return json({ session, queued: true, queued_id: first.queued_id,
        event: event('turn_queued', { queued_id: first.queued_id, prompt: first.prompt }) })
    }
    assert.equal(await send(), true)
    assert.deepEqual(queuedIds(), [first.queued_id])
    assert.equal(useAppStore.getState().drafts[session.id], '')
    assert.equal(useAppStore.getState().activeSessionIds.has(session.id), true)
    assert.deepEqual(useAppStore.getState().sessions[0].codex_goal, session.codex_goal)
    assert.equal(requests.length, 1)
  })

  await test('a stale HTTP page cannot erase a follow-up queued by the live stream', async () => {
    await reset()
    const stale = page([])
    const pendingPage = deferred<TimelinePage>()
    client.sessionPage = () => pendingPage.promise
    const pending = original.sync('recovery')
    publicQueue = [first]
    emit(event('turn_queued', { queued_id: first.queued_id, prompt: first.prompt }))
    assert.deepEqual(queuedIds(), [first.queued_id])
    pendingPage.resolve(stale)
    await pending
    await flush()
    assert.deepEqual(queuedIds(), [first.queued_id])
  })

  await test('a stale HTTP page cannot resurrect a follow-up consumed by native steering', async () => {
    await reset([first, second])
    const stale = page([first, second])
    const pendingPage = deferred<TimelinePage>()
    client.sessionPage = () => pendingPage.promise
    const pending = original.sync('recovery')
    publicQueue = [second]
    emit(event('turn_queue_run_now', { queued_id: first.queued_id, native_steer: true, native_goal_steer: true }))
    assert.deepEqual(queuedIds(), [second.queued_id])
    pendingPage.resolve(stale)
    await pending
    await flush()
    assert.deepEqual(queuedIds(), [second.queued_id])
  })

  await test('an overtaken HTTP page cannot lose additional unseen queued entries covered by its boundary', async () => {
    await reset()
    const pendingPage = deferred<TimelinePage>()
    client.sessionPage = () => pendingPage.promise
    const pending = original.sync('recovery')
    emit(event('turn_queued', { queued_id: first.queued_id, prompt: first.prompt }))
    // The server read covers the observed enqueue and a second enqueue that
    // this client has not received. Keeping only its local queue would lose
    // the second message when the stream resumes after this page's boundary.
    publicQueue = [first, second]
    pendingPage.resolve({ ...page(publicQueue), latest_seq: seq + 1 })
    await pending
    await flush()
    assert.deepEqual(queuedIds(), [first.queued_id, second.queued_id])
  })

  await test('a queued HTTP receipt is not discarded behind newer unrelated stream activity', async () => {
    await reset([], first.prompt)
    const receipt = event('turn_queued', { queued_id: first.queued_id, prompt: first.prompt })
    const pendingResponse = deferred<Response>()
    respond = () => pendingResponse.promise
    const pending = send()
    emit(event('reasoning_summary', { text: 'Goal is still running' }))
    publicQueue = [first]
    pendingResponse.resolve(json({ session, queued: true, queued_id: first.queued_id, event: receipt }))
    assert.equal(await pending, true)
    assert.deepEqual(queuedIds(), [first.queued_id])
  })

  await test('a late ordinary turn-start receipt cannot revive a run already finished by the stream', async () => {
    await reset([], first.prompt)
    const receipt = event('turn_started', { prompt: first.prompt })
    const pendingResponse = deferred<Response>()
    respond = () => pendingResponse.promise
    const pending = send()
    const finished = event('turn_finished')
    emit(finished)
    pendingResponse.resolve(json({ session, event: receipt }))
    assert.equal(await pending, true)
    assert.equal(useAppStore.getState().activeSessionIds.has(session.id), false)
    assert.equal(useAppStore.getState().sessions[0].latest_event_type, 'turn_finished')
  })

  await test('a delayed queued HTTP receipt cannot resurrect input already delivered in the live stream', async () => {
    await reset([], first.prompt)
    const receipt = event('turn_queued', { queued_id: first.queued_id, prompt: first.prompt })
    const pendingResponse = deferred<Response>()
    respond = () => pendingResponse.promise
    const pending = send()
    publicQueue = []
    emit(acceptedGoalInput())
    pendingResponse.resolve(json({ session, queued: true, queued_id: first.queued_id, event: receipt }))
    assert.equal(await pending, true)
    await flush()
    assert.deepEqual(queuedIds(), [])
    const rows = projectTimeline(useAppStore.getState().snapshots[session.id].events, [])
    assert.equal(rows.filter(row => row.kind === 'message' && row.role === 'user'
      && row.events.some(value => value.queued_id === first.queued_id)).length, 1)
  })

  await test('an older queued receipt for a different ID is recovered by authoritative queue refresh', async () => {
    await reset([], first.prompt)
    const receipt = event('turn_queued', { queued_id: first.queued_id, prompt: first.prompt })
    const pendingResponse = deferred<Response>()
    respond = () => pendingResponse.promise
    const pending = send()
    emit(event('turn_queued', { queued_id: second.queued_id, prompt: second.prompt }))
    publicQueue = [first, second]
    pendingResponse.resolve(json({ session, queued: true, queued_id: first.queued_id, event: receipt }))
    assert.equal(await pending, true)
    await flush()
    assert.deepEqual(queuedIds(), [first.queued_id, second.queued_id])
  })

  await test('exact native goal acknowledgement removes only its queue row and retains a user bubble', async () => {
    await reset([first, second])
    publicQueue = [second]
    emit(acceptedGoalInput())
    assert.deepEqual(queuedIds(), [second.queued_id])
    const rows = projectTimeline(useAppStore.getState().snapshots[session.id].events, [])
    assert.equal(rows.filter(row => row.kind === 'message' && row.role === 'user'
      && row.events.some(value => value.queued_id === first.queued_id)).length, 1)
    assert.equal(useAppStore.getState().activeSessionIds.has(session.id), true)
    assert.deepEqual(useAppStore.getState().sessions[0].codex_goal, session.codex_goal)
  })

  await test('run-now HTTP rejection cannot become success just because a detached row is absent', async () => {
    await reset([first])
    publicQueue = []
    respond = async request => {
      assert.equal(request.path, `/api/sessions/${session.id}/queue/${first.queued_id}/run-now`)
      return json({ detail: 'Native handoff was rejected; delivery is not confirmed' }, 502)
    }
    assert.equal(await useAppStore.getState().runQueuedNow(session.id, first.queued_id, 0), false)
    assert.match(useAppStore.getState().queuedRunStatus[session.id]?.message ?? '', /rejected|not confirm/i)
    assert.equal(requests.length, 1)
    assert.equal(useAppStore.getState().pendingQueuedRunIds.size, 0)
    assert.deepEqual(useAppStore.getState().sessions[0].codex_goal, session.codex_goal)
  })

  await test('exact streamed acceptance survives a run-now timeout and failed queue refresh', async () => {
    await reset([first])
    client.queue = async () => { throw new Error('Queue refresh unavailable') }
    respond = async () => {
      emit(acceptedGoalInput())
      emit(event('turn_finished'))
      throw new AgentServerRequestTimeoutError()
    }
    assert.equal(await useAppStore.getState().runQueuedNow(session.id, first.queued_id, 0), true)
    assert.deepEqual(queuedIds(), [])
    assert.equal(useAppStore.getState().queuedRunStatus[session.id], undefined)
    assert.equal(useAppStore.getState().activeSessionIds.has(session.id), false, 'acceptance must not revive an already completed run')
    assert.equal(useAppStore.getState().pendingQueuedRunIds.size, 0)
    assert.equal(requests.length, 1)
  })

  await test('successful run-now acknowledgement does not revive completed work when its queue refresh fails', async () => {
    await reset([first])
    client.queue = async () => { throw new Error('Queue refresh unavailable') }
    respond = async () => {
      emit(acceptedGoalInput())
      emit(event('turn_finished'))
      return json({ ok: true, queued_id: first.queued_id, native_steer: true })
    }
    assert.equal(await useAppStore.getState().runQueuedNow(session.id, first.queued_id, 0), true)
    assert.equal(useAppStore.getState().queuedRunStatus[session.id], undefined)
    assert.equal(useAppStore.getState().activeSessionIds.has(session.id), false)
    assert.equal(useAppStore.getState().pendingQueuedRunIds.size, 0)
    assert.equal(requests.length, 1)
  })

  await test('success headers followed by invalid JSON do not restore an already accepted message', async () => {
    await reset([], first.prompt)
    const pendingResponse = deferred<Response>()
    respond = () => pendingResponse.promise
    const pending = send()
    assert.equal(useAppStore.getState().drafts[session.id], '')
    useAppStore.getState().setSessionDraft(session.id, 'My newer unsent draft', 0)
    pendingResponse.resolve(new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    assert.equal(await pending, false)
    assert.equal(useAppStore.getState().drafts[session.id], 'My newer unsent draft')
    assert.match(useAppStore.getState().error ?? '', /accepted|refresh.*before/i)
    assert.equal(requests.length, 1, 'uncertain reconciliation must never replay the POST')
  })

  await test('a definitive send rejection restores the first draft without losing newer typing', async () => {
    await reset([], first.prompt)
    const pendingResponse = deferred<Response>()
    respond = () => pendingResponse.promise
    const pending = send()
    useAppStore.getState().setSessionDraft(session.id, 'My newer unsent draft', 0)
    pendingResponse.resolve(json({ detail: 'Admission refused' }, 409))
    assert.equal(await pending, false)
    assert.equal(useAppStore.getState().drafts[session.id], `${first.prompt}\n\nMy newer unsent draft`)
    assert.deepEqual(queuedIds(), [])
    assert.equal(requests.length, 1)
  })

  await test('a late accepted receipt stays with its original chat after navigation', async () => {
    await reset([], first.prompt)
    const other: Session = { ...session, id: 'another-goal-chat', title: 'Another chat' }
    const pendingResponse = deferred<Response>()
    respond = () => pendingResponse.promise
    const pending = send()
    useAppStore.setState({
      sessions: [session, other], selectedSessionId: other.id,
      drafts: { [session.id]: 'New draft in the original chat', [other.id]: 'Draft in the other chat' },
    })
    publicQueue = [first]
    pendingResponse.resolve(json({ session, queued: true, queued_id: first.queued_id,
      event: event('turn_queued', { queued_id: first.queued_id, prompt: first.prompt }) }))
    assert.equal(await pending, true)
    assert.deepEqual(queuedIds(), [first.queued_id])
    assert.equal(useAppStore.getState().selectedSessionId, other.id)
    assert.equal(useAppStore.getState().drafts[session.id], 'New draft in the original chat')
    assert.equal(useAppStore.getState().drafts[other.id], 'Draft in the other chat')
    assert.equal(requests.length, 1)
  })

  await test('accepted response decoding failure after navigation does not restore input or overwrite the other chat', async () => {
    await reset([], first.prompt)
    const other: Session = { ...session, id: 'another-goal-chat', title: 'Another chat' }
    const pendingResponse = deferred<Response>()
    respond = () => pendingResponse.promise
    const pending = send()
    useAppStore.setState({
      sessions: [session, other], selectedSessionId: other.id,
      drafts: { [session.id]: 'New draft in the original chat', [other.id]: 'Draft in the other chat' },
      error: 'Existing notice in the other chat',
    })
    pendingResponse.resolve(new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    assert.equal(await pending, false)
    assert.equal(useAppStore.getState().drafts[session.id], 'New draft in the original chat')
    assert.equal(useAppStore.getState().drafts[other.id], 'Draft in the other chat')
    assert.equal(useAppStore.getState().error, 'Existing notice in the other chat')
    assert.equal(useAppStore.getState().sendingSessionIds.has(session.id), false)
    assert.equal(useAppStore.getState().turnAdmissionTokens[session.id], undefined)
    assert.equal(requests.length, 1)
  })

  await test('a late rejection from a retired server instance cannot restore stale input', async () => {
    await reset([], first.prompt)
    const pendingResponse = deferred<Response>()
    respond = () => pendingResponse.promise
    const pending = send()
    client.revokeValidation()
    client.markValidated()
    useAppStore.setState({
      health: { ...health, server_instance_id: `replacement-${boot}` },
      drafts: { [session.id]: 'Draft on the revalidated server' },
      error: 'Existing notice on the revalidated server',
    })
    pendingResponse.resolve(json({ detail: 'Old server admission refused' }, 409))
    assert.equal(await pending, false)
    assert.equal(useAppStore.getState().drafts[session.id], 'Draft on the revalidated server')
    assert.equal(useAppStore.getState().error, 'Existing notice on the revalidated server')
    assert.equal(useAppStore.getState().sendingSessionIds.has(session.id), false)
    assert.equal(useAppStore.getState().turnAdmissionTokens[session.id], undefined)
    assert.equal(requests.length, 1)
  })

  await test('a reply from the previous validated server instance cannot overwrite the new queue or draft', async () => {
    await reset([], first.prompt)
    const pendingResponse = deferred<Response>()
    respond = () => pendingResponse.promise
    const pending = send()
    client.revokeValidation()
    client.markValidated()
    useAppStore.setState({
      health: { ...health, server_instance_id: `replacement-${boot}` },
      drafts: { [session.id]: 'Draft on the revalidated server' },
    })
    pendingResponse.resolve(json({ session, queued: true, queued_id: first.queued_id,
      event: event('turn_queued', { queued_id: first.queued_id, prompt: first.prompt }) }))
    await pending
    assert.deepEqual(queuedIds(), [])
    assert.equal(useAppStore.getState().drafts[session.id], 'Draft on the revalidated server')
    assert.equal(requests.length, 1)
  })

  await test('reconnecting retires old stream callbacks without consuming a current queued message', async () => {
    await reset([first])
    const retiredEmit = emit
    await original.sync('manual')
    retiredEmit(acceptedGoalInput())
    assert.deepEqual(queuedIds(), [first.queued_id])
    assert.equal(useAppStore.getState().snapshots[session.id].events.length, 0)
    assert.equal(useAppStore.getState().activeSessionIds.has(session.id), true)
  })
} finally {
  client.sessionPage = original.page
  client.queue = original.queue
  client.stream = original.stream
  globalThis.fetch = original.fetch
  useAppStore.setState({ syncSelectedSession: original.sync, markRead: original.markRead,
    refreshSessions: original.refreshSessions, refreshFiles: original.refreshFiles, connected: false })
}
