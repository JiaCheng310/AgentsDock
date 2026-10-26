import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { AgentServerClient } from './AgentServerClient'

// Production client protocol contracts with a fake socket, not native/provider
// acceptance. Never use a transient frame's seq as a durable replay cursor.
class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) { FakeWebSocket.instances.push(this) }
  emit(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }) }
  emitClose(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason: '' })
  }
  close(): void {
    if (this.readyState !== FakeWebSocket.CLOSED) this.emitClose(1000)
  }
}

const item = {
  run_id: 'run', item_id: 'native-item', backend: 'codex', phase: 'summary',
  text: 'Received native summary', after_seq: 5, ts: '2026-10-24T08:00:00Z',
}
const snapshot = {
  type: 'reasoning_summary_stream', session_id: 'chat', instance_id: 'boot-a', revision: 3,
  items: [item],
}
const durable = { id: 'e6', session_id: 'chat', seq: 6, type: 'reasoning_summary', text: 'Durable summary', ts: item.ts }

async function withClient(t: TestContext, run: (client: AgentServerClient) => void | Promise<void>): Promise<void> {
  const original = globalThis.WebSocket
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  FakeWebSocket.instances = []
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const client = new AgentServerClient('https://reasoning.example.invalid', 'test-only-token')
  try { await run(client) }
  finally { client.dispose(); globalThis.WebSocket = original; t.mock.timers.reset() }
}

await test('reasoning opts into both native channels without changing the provider callback slot', t => withClient(t, client => {
  const runtime: unknown[] = [], streams: unknown[] = [], events: unknown[] = []
  client.stream('chat', 5, value => events.push(value), () => undefined,
    value => runtime.push(value), value => streams.push(value))
  const socket = FakeWebSocket.instances[0]
  const url = new URL(socket.url)
  assert.equal(url.searchParams.get('reasoning_stream'), 'true')
  assert.equal(url.searchParams.get('reasoning_text'), 'true')
  assert.equal(url.searchParams.get('visible'), 'true')
  assert.equal(url.searchParams.get('after'), '5')
  const notice = { type: 'provider_runtime_changed', session_id: 'chat', backend: 'claude', runtime: 'context_usage', ephemeral: true, usage_generation: 7 }
  socket.emit(notice)
  socket.emit(snapshot)
  assert.deepEqual(runtime, [notice])
  assert.deepEqual(streams, [snapshot])
  assert.deepEqual(events, [])
}))

await test('older callers do not opt in and malformed reasoning frames cannot enter their durable lane', t => withClient(t, client => {
  const events: unknown[] = []
  client.stream('chat', 5, value => events.push(value), () => undefined)
  const socket = FakeWebSocket.instances[0]
  const url = new URL(socket.url)
  assert.equal(url.searchParams.has('reasoning_stream'), false)
  assert.equal(url.searchParams.has('reasoning_text'), false)
  socket.emit({ type: 'reasoning_summary_stream', session_id: 'chat', seq: 10000 })
  socket.emit(durable)
  socket.emitClose()
  t.mock.timers.tick(500)
  assert.deepEqual(events, [durable])
  assert.equal(new URL(FakeWebSocket.instances[1].url).searchParams.get('after'), '6')
}))

await test('snapshots are session, instance and strictly increasing revision scoped, including empty completion', t => withClient(t, client => {
  const streams: unknown[] = []
  client.stream('chat', 5, () => undefined, () => undefined, undefined, value => streams.push(value))
  const socket = FakeWebSocket.instances[0]
  socket.emit(snapshot)
  socket.emit(snapshot)
  socket.emit({ ...snapshot, revision: 2 })
  socket.emit({ ...snapshot, session_id: 'other-chat', revision: 99 })
  socket.emit({ ...snapshot, instance_id: 'other-boot', revision: 99 })
  const cleared = { ...snapshot, revision: 4, items: [] }
  socket.emit(cleared)
  assert.deepEqual(streams, [snapshot, cleared])
}))

await test('invalid control frames cannot poison either the revision or durable reconnect cursor', t => withClient(t, client => {
  const streams: unknown[] = [], events: unknown[] = []
  client.stream('chat', 5, value => events.push(value), () => undefined, undefined, value => streams.push(value))
  const socket = FakeWebSocket.instances[0]
  for (const patch of [
    { revision: -1 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { instance_id: '' }, { items: null },
    { items: [{ ...item, text: 7 }] }, { items: [{ ...item, backend: 'claude' }] },
  ]) socket.emit({ ...snapshot, revision: 99, ...patch, seq: 10000 })
  socket.onmessage?.({ data: '{not json' })
  socket.emit(null)
  socket.emit(snapshot)
  socket.emit({ ...durable, session_id: 'other-chat', seq: 10000 })
  socket.emit(durable)
  socket.emitClose()
  t.mock.timers.tick(500)
  assert.deepEqual(streams, [snapshot])
  assert.deepEqual(events, [durable])
  assert.equal(new URL(FakeWebSocket.instances[1].url).searchParams.get('after'), '6')
}))

await test('reconnect accepts a fresh instance/revision and ignores all callbacks from the retired socket', t => withClient(t, client => {
  const streams: unknown[] = [], states: boolean[] = []
  client.stream('chat', 5, () => undefined, connected => states.push(connected), undefined, value => streams.push(value))
  const first = FakeWebSocket.instances[0]
  first.emit(snapshot)
  first.emit(durable)
  first.emitClose()
  t.mock.timers.tick(500)
  const second = FakeWebSocket.instances[1]
  assert.equal(new URL(second.url).searchParams.get('after'), '6')
  const restarted = { ...snapshot, instance_id: 'boot-b', revision: 0 }
  second.emit(restarted)
  second.readyState = FakeWebSocket.OPEN
  second.onopen?.()
  const statesBeforeStale = [...states]
  first.emit({ ...snapshot, revision: 100 })
  first.emit({ ...durable, seq: 9000 })
  first.onerror?.()
  first.onclose?.({ code: 4401, reason: 'stale auth failure' })
  assert.deepEqual(states, statesBeforeStale)
  assert.deepEqual(streams, [snapshot, restarted])
  t.mock.timers.tick(1000)
  assert.equal(FakeWebSocket.instances.length, 2)
}))

await test('stop, dispose and fatal authentication rejection fence subsequent transient deliveries', t => withClient(t, client => {
  const streams: unknown[] = []
  const stop = client.stream('chat', 5, () => undefined, () => undefined, undefined, value => streams.push(value))
  const first = FakeWebSocket.instances[0]
  stop()
  first.emit(snapshot)
  const secondStop = client.stream('chat', 5, () => undefined, () => undefined, undefined, value => streams.push(value))
  const second = FakeWebSocket.instances[1]
  second.emitClose(4401)
  second.emit(snapshot)
  secondStop()
  t.mock.timers.tick(1000)
  assert.deepEqual(streams, [])
  assert.equal(FakeWebSocket.instances.length, 2)
  client.stream('chat', 5, () => undefined, () => undefined, undefined, value => streams.push(value))
  const third = FakeWebSocket.instances[2]
  client.dispose()
  third.emit(snapshot)
  t.mock.timers.tick(1000)
  assert.deepEqual(streams, [])
  assert.equal(FakeWebSocket.instances.length, 3)
}))

await test('independent summary and exposed reasoning channels are delivered without rewriting either', t => withClient(t, client => {
  const streams: unknown[] = []
  client.stream('chat', 5, () => undefined, () => undefined, undefined, value => streams.push(value))
  const both = { ...snapshot, items: [item, { ...item, phase: 'reasoning', text: 'Actual provider-exposed text' }] }
  FakeWebSocket.instances[0].emit(both)
  assert.deepEqual(streams, [both])
}))

await test('transient retention excludes arbitrary payloads and preserves only valid presentation metadata', t => withClient(t, client => {
  const streams: unknown[] = []
  client.stream('chat', 5, () => undefined, () => undefined, undefined, value => streams.push(value))
  FakeWebSocket.instances[0].emit({ ...snapshot, raw: { private: 'not presentation' }, seq: 9000,
    items: [{ ...item, partial: true, reasoning_text_truncated: true, reasoning_text_chars: 1000,
      prompt: 'never reasoning', raw: { huge: 'discard' }, tool: { input: 'discard' } }] })
  assert.deepEqual(streams, [{ ...snapshot, items: [{ ...item, partial: true,
    reasoning_text_truncated: true, reasoning_text_chars: 1000 }] }])
}))

await test('native server snapshot truncation survives the actual socket normalization boundary', t => withClient(t, client => {
  const streams: unknown[] = [], events: unknown[] = []
  client.stream('chat', 5, value => events.push(value), () => undefined, undefined, value => streams.push(value))
  FakeWebSocket.instances[0].emit({ ...snapshot, items: [{ ...item, text_truncated: true }] })
  assert.deepEqual(streams, [{ ...snapshot, items: [{ ...item, reasoning_text_truncated: true }] }])
  assert.deepEqual(events, [])
}))
