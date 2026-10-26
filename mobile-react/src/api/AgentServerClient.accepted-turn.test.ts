import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentServerClient, AgentServerTurnAcceptedError, ServerError } from './AgentServerClient'

const originalFetch = globalThis.fetch
const client = new AgentServerClient('http://accepted-turn.test', '')
try {
  await test('successful headers remain accepted when JSON decoding fails', async () => {
    globalThis.fetch = async () => new Response('{', { status: 200 })
    await assert.rejects(client.sendTurn('chat', 'Input', []), AgentServerTurnAcceptedError)
  })
  await test('successful headers remain accepted when validation changes during body decoding', async () => {
    const scoped = new AgentServerClient('http://accepted-turn.test', '', { requireValidation: true })
    scoped.markValidated()
    globalThis.fetch = async () => {
      const response = new Response('{}', { status: 200 })
      response.json = async () => { scoped.revokeValidation(); return {} }
      return response
    }
    await assert.rejects(scoped.sendTurn('chat', 'Input', []), AgentServerTurnAcceptedError)
    scoped.dispose()
  })
  await test('a rejected status is never classified as accepted input', async () => {
    globalThis.fetch = async () => new Response('{"detail":"Rejected"}', { status: 409 })
    await assert.rejects(client.sendTurn('chat', 'Input', []), error => error instanceof ServerError && error.status === 409)
  })
} finally {
  globalThis.fetch = originalFetch
  client.dispose()
}
