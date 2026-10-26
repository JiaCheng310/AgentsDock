import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentCrossChatRoute, AgentCrossChatRoutesSnapshot, ChatReference } from '../types'
import { agentRouteCapacityError, routeCapacityReached } from './agent-route-policy'

function route(target: string): AgentCrossChatRoute {
  return {
    route_id: `route-${target}`, revision: 'revision-1', alias: target,
    target_session_id: target, actions: ['instruction'],
    created_at: '2026-10-23T00:00:00Z', updated_at: '2026-10-23T00:00:00Z',
    target: { title: target, folder: null, backend: 'codex', available: true, unavailable_reason: null },
  }
}

function reference(target: string, patch: Partial<ChatReference> = {}): ChatReference {
  return {
    session_id: target, display_title_snapshot: target,
    source_text_start: 0, source_text_end: target.length + 1,
    action: 'route', grant_intent: true, ...patch,
  }
}

const routes = Array.from({ length: 17 }, (_, index) => route(`target-${index}`))
const newGrant = reference('new-target')

await test('unlimited route metadata never invents the legacy 16-route limit', () => {
  const snapshot: AgentCrossChatRoutesSnapshot = { routes, max_routes: null }
  assert.equal(agentRouteCapacityError(snapshot, []), null)
  assert.equal(agentRouteCapacityError(snapshot, [newGrant]), null)
  assert.equal(routeCapacityReached(routes, null, []), false)
  assert.equal(routeCapacityReached(routes, null, [newGrant], 'another-target'), false)
})

await test('missing or malformed capacity metadata does not invent a client-side cap', () => {
  assert.equal(agentRouteCapacityError(undefined, [newGrant]), null)
  for (const malformed of [undefined, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '16', false, {}]) {
    const maximum = malformed as number | null
    const snapshot: AgentCrossChatRoutesSnapshot = { routes, max_routes: maximum }
    assert.equal(agentRouteCapacityError(snapshot, [newGrant]), null, String(malformed))
    assert.equal(routeCapacityReached(routes, maximum, [newGrant], 'another-target'), false, String(malformed))
  }
})

await test('ordinary messages remain sendable when existing grants exceed a legacy finite cap', () => {
  assert.equal(agentRouteCapacityError({ routes, max_routes: 16 }, []), null)
  assert.equal(agentRouteCapacityError({ routes, max_routes: 0 }, []), null)
  assert.equal(routeCapacityReached(routes, 16, []), true, 'only adding a new grant is unavailable')
})

await test('finite limits reject only a newly added explicit local grant', () => {
  const granted = [route('existing')]
  assert.equal(agentRouteCapacityError({ routes: granted, max_routes: 2 }, [newGrant]), null)
  assert.match(agentRouteCapacityError({ routes: granted, max_routes: 1 }, [newGrant]) ?? '', /limit \(1 route maximum\)/u)
  assert.equal(routeCapacityReached(granted, 2, [], 'new-target'), false)
  assert.equal(routeCapacityReached(granted, 1, [], 'new-target'), true)
})

await test('a genuine zero limit blocks new grants without blocking ordinary messages', () => {
  const snapshot: AgentCrossChatRoutesSnapshot = { routes: [], max_routes: 0 }
  assert.equal(agentRouteCapacityError(snapshot, []), null)
  assert.match(agentRouteCapacityError(snapshot, [newGrant]) ?? '', /0 routes maximum/u)
  assert.equal(routeCapacityReached([], 0, [], 'new-target'), true)
})

await test('existing targets remain usable even when the legacy snapshot is already over capacity', () => {
  const existing = reference(routes[0].target_session_id)
  assert.equal(agentRouteCapacityError({ routes, max_routes: 16 }, [existing]), null)
  assert.equal(routeCapacityReached(routes, 16, [], existing.session_id), false)
  assert.equal(routeCapacityReached(routes, 0, [existing], existing.session_id), false)
})

await test('repeated pending mentions consume one slot and remain selectable', () => {
  const granted = [route('existing')]
  const pending = [newGrant, { ...newGrant, source_text_start: 20, source_text_end: 31 }]
  assert.equal(agentRouteCapacityError({ routes: granted, max_routes: 2 }, pending), null)
  assert.equal(routeCapacityReached(granted, 2, pending), true)
  assert.equal(routeCapacityReached(granted, 2, pending, newGrant.session_id), false)
  assert.equal(routeCapacityReached(granted, 2, pending, 'third-target'), true)
  assert.match(agentRouteCapacityError({ routes: granted, max_routes: 2 }, [...pending, reference('third-target')]) ?? '', /limit/u)
})

await test('secure peers and non-grant actions never consume local route capacity', () => {
  const references: ChatReference[] = [
    reference('secure-peer', { target_kind: 'secure_peer' }),
    reference('instruction-target', { action: 'instruction', grant_intent: undefined }),
    reference('no-authority', { grant_intent: undefined }),
    reference('reply-target', { action: 'request_reply', grant_intent: undefined }),
  ]
  assert.equal(agentRouteCapacityError({ routes, max_routes: 16 }, references), null)
  assert.equal(routeCapacityReached([], 1, references, 'new-target'), false)
})

await test('a pending secure-peer identifier cannot masquerade as an already granted local target', () => {
  const peer = reference('same-id', { target_kind: 'secure_peer' })
  assert.equal(routeCapacityReached([], 0, [peer], 'same-id'), true)
})
