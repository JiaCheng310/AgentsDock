import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentCrossChatRoute, AgentCrossChatRoutesSnapshot, ChatReference, Health, Session } from '../types'
import { client, useAppStore } from './useAppStore'

// Real store admission and AgentServerClient encoding, with native persistence
// and fetch mocked. Native UI/server/provider acceptance is verified separately.
const session: Session = { id: 'route-capacity-source', title: 'Source', backend: 'codex' }
const target: Session = { id: 'new-target', title: 'New', backend: 'codex' }
const routes: AgentCrossChatRoute[] = Array.from({ length: 17 }, (_, index) => ({
  route_id: `route-${index}`, revision: 'revision-1', alias: `Target ${index}`,
  target_session_id: `target-${index}`, actions: ['instruction'],
  created_at: '2026-10-23T00:00:00Z', updated_at: '2026-10-23T00:00:00Z',
  target: { title: `Target ${index}`, folder: null, backend: 'codex', available: true, unavailable_reason: null },
}))
const health: Health = {
  ok: true, server_identity: 'route-test-server', server_instance_id: 'route-test-instance',
  capabilities: {
    cross_chat_handoffs_v1: {
      available: true, version: 10, actions: ['route', 'instruction'], supported_target_backends: ['codex'],
      features: { durable_route_grants: true, agent_cross_chat_routes: true, agent_ambient_local_handoffs: false, async_route_v1: true },
      agent_routes: {
        policy: 'default_deny', client_capability: 'agent_cross_chat_routes_v2',
        async_route_v1: { available: true, client_capability: 'chat_conversation_async_route_v1', mode: 'async_route_v1' },
      },
    },
  },
}
const newGrant: ChatReference = {
  session_id: target.id, display_title_snapshot: target.title!,
  source_text_start: 4, source_text_end: 8, action: 'route', grant_intent: true,
}
const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = []
const originalFetch = globalThis.fetch
const originalSync = useAppStore.getState().syncSelectedSession
let snapshot: AgentCrossChatRoutesSnapshot = { routes, max_routes: 16 }
let sendStatus = 200

globalThis.fetch = async (input, init) => {
  const url = String(input)
  const method = init?.method ?? 'GET'
  requests.push({ url, method, body: JSON.parse(String(init?.body ?? '{}')) })
  if (method === 'GET' && new URL(url).pathname.endsWith('/agent-handoff-routes')) {
    return new Response(JSON.stringify(snapshot), { status: 200 })
  }
  assert.equal(method, 'POST')
  assert.match(new URL(url).pathname, /\/route-capacity-source\/turns$/u)
  return new Response(JSON.stringify(sendStatus === 200 ? { session } : { detail: 'Route access rejected by server' }), { status: sendStatus })
}

function reset(maximum: number | null, draft = 'Ordinary message', references: ChatReference[] = []): void {
  client.markValidated()
  requests.length = 0
  sendStatus = 200
  snapshot = { routes, max_routes: maximum }
  useAppStore.setState({
    initialized: true, activeProfileId: 'uninitialized', profileGeneration: 0,
    connected: true, connecting: false, switchingProfileId: null, workspaceAdopting: false,
    selectedSessionId: session.id, health, runtime: null, sessions: [session, target],
    drafts: { [session.id]: draft }, chatReferencesBySession: { [session.id]: references }, teamReferencesBySession: {},
    uploads: {}, uploadPending: {}, uploadFailed: {}, snapshots: {}, historyWindow: null,
    agentRoutesBySession: { [session.id]: snapshot }, agentRouteErrorsBySession: {},
    agentRouteLoadingSessionIds: new Set(), revokingAgentRouteIds: new Set(),
    turnAdmissionTokens: {}, sendingSessionIds: new Set(), error: null,
    syncSelectedSession: async () => {},
  })
}

const send = () => useAppStore.getState().sendPrompt(false, 0, session.id)

try {
  await test('an ordinary message crosses the send boundary once despite 17 grants and legacy maximum 16', async () => {
    reset(16)
    assert.equal(await send(), true)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].body.prompt, 'Ordinary message')
    assert.equal(Object.hasOwn(requests[0].body, 'chat_references'), false)
    assert.equal(useAppStore.getState().drafts[session.id], '')
    assert.equal(useAppStore.getState().error, null)
  })

  await test('a finite-cap rejection leaves the draft, explicit reference, and upload available to edit', async () => {
    const draft = 'Ask @New for help.'
    const upload = { id: 'attached-file', filename: 'notes.txt' }
    reset(16, draft, [newGrant])
    useAppStore.setState({ uploads: { [session.id]: [upload] } })
    assert.equal(await send(), false)
    assert.equal(requests.length, 0)
    assert.equal(useAppStore.getState().drafts[session.id], draft)
    assert.deepEqual(useAppStore.getState().chatReferencesBySession[session.id], [newGrant])
    assert.deepEqual(useAppStore.getState().uploads[session.id], [upload])
    assert.equal(useAppStore.getState().sendingSessionIds.size, 0)
    assert.deepEqual(useAppStore.getState().turnAdmissionTokens, {})
    assert.match(useAppStore.getState().error ?? '', /route access limit/u)
  })

  await test('nullable unlimited metadata admits a new grant and refreshes with the same negotiated contract', async () => {
    reset(null, 'Ask @New for help.', [newGrant])
    assert.equal(await send(), true)
    await new Promise(resolve => setTimeout(resolve, 0))
    const sends = requests.filter(request => request.method === 'POST')
    const reads = requests.filter(request => request.method === 'GET')
    assert.equal(sends.length, 1)
    assert.deepEqual(sends[0].body.chat_references, [newGrant])
    assert.equal(reads.length, 1)
    assert.equal(new URL(reads[0].url).searchParams.get('unlimited_routes'), 'true')
    assert.equal(useAppStore.getState().agentRoutesBySession[session.id].max_routes, null)
    assert.equal(useAppStore.getState().drafts[session.id], '')
    assert.deepEqual(useAppStore.getState().chatReferencesBySession[session.id], [])
  })

  await test('an unlimited client snapshot never bypasses a server rejection or discards its draft', async () => {
    const draft = 'Ask @New for help.'
    reset(null, draft, [newGrant])
    sendStatus = 403
    assert.equal(await send(), false)
    assert.equal(requests.length, 1, 'the rejected mutation must not be replayed')
    assert.equal(useAppStore.getState().drafts[session.id], draft)
    assert.deepEqual(useAppStore.getState().chatReferencesBySession[session.id], [newGrant])
    assert.match(useAppStore.getState().error ?? '', /Route access rejected by server/u)
  })
} finally {
  globalThis.fetch = originalFetch
  useAppStore.setState({ syncSelectedSession: originalSync })
}
