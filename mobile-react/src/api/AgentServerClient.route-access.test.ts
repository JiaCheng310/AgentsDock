import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentServerClient, ServerError } from './AgentServerClient'
import type { AgentCrossChatRoutesSnapshot } from '../types'

// Exercise the shipping client's URL encoder and JSON decoder. Fetch is mocked;
// these checks are not native UI, server authorization, or provider acceptance.
const originalFetch = globalThis.fetch
const client = new AgentServerClient('https://routes.example.invalid', 'test-only-token')

try {
  await test('route reads explicitly negotiate unlimited access and preserve an opaque chat identifier', async () => {
    let calls = 0
    globalThis.fetch = async (input, init) => {
      calls += 1
      const url = new URL(String(input))
      assert.equal(url.pathname, '/api/sessions/chat%20%2F%3F%26%23/agent-handoff-routes')
      assert.equal(url.search, '?unlimited_routes=true')
      assert.equal(init?.method ?? 'GET', 'GET')
      assert.equal(init?.body, undefined)
      assert.equal(new Headers(init?.headers).get('X-ZenithDock-Token'), 'test-only-token')
      const snapshot: AgentCrossChatRoutesSnapshot = { routes: [], max_routes: null }
      return new Response(JSON.stringify(snapshot), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    assert.deepEqual(await client.agentHandoffRoutes('chat /?&#'), { routes: [], max_routes: null })
    assert.equal(calls, 1, 'route negotiation must not introduce extra reads')
  })

  await test('a finite limit from an older server is preserved instead of coerced to unlimited', async () => {
    for (const maximum of [0, 1, 16]) {
      globalThis.fetch = async input => {
        assert.equal(new URL(String(input)).searchParams.get('unlimited_routes'), 'true')
        return new Response(JSON.stringify({ routes: [], max_routes: maximum }), { status: 200 })
      }
      const snapshot = await client.agentHandoffRoutes('chat')
      assert.equal(snapshot.max_routes, maximum)
      assert.deepEqual(snapshot.routes, [])
    }
  })

  await test('route read authorization failures remain errors and are never retried as a legacy request', async () => {
    let calls = 0
    globalThis.fetch = async input => {
      calls += 1
      assert.equal(new URL(String(input)).searchParams.get('unlimited_routes'), 'true')
      return new Response(JSON.stringify({ detail: 'Access denied' }), { status: 403 })
    }
    await assert.rejects(client.agentHandoffRoutes('chat'), error => error instanceof ServerError && error.status === 403)
    assert.equal(calls, 1)
  })
} finally {
  globalThis.fetch = originalFetch
  client.dispose()
}
