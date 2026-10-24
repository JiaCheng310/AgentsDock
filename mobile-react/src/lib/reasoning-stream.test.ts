import assert from 'node:assert/strict'
import test from 'node:test'
import { isReasoningSummaryStream, normalizedReasoningStream } from './reasoning-stream'

const item = {
  run_id: 'run', item_id: 'native-item', backend: 'codex', phase: 'summary',
  text: 'Provider summary', after_seq: 1, ts: '2026-10-24T08:00:00Z',
}
const packet = {
  type: 'reasoning_summary_stream', session_id: 'chat', instance_id: 'boot', revision: 0,
  items: [item],
}

await test('accepts native summary and exposed reasoning as independent channels', () => {
  const both = { ...packet, items: [item, { ...item, phase: 'reasoning', text: 'Provider-exposed text' }] }
  const before = JSON.stringify(both)
  assert.equal(isReasoningSummaryStream(both), true)
  assert.equal(JSON.stringify(both), before)
  assert.equal(isReasoningSummaryStream({ ...packet, items: [] }), true)
  assert.equal(isReasoningSummaryStream({ ...packet, items: [{ ...item, text: '' }] }), true)
})

await test('rejects duplicate channels but allows the same item identifier in different runs', () => {
  assert.equal(isReasoningSummaryStream({ ...packet, items: [item, { ...item }] }), false)
  assert.equal(isReasoningSummaryStream({ ...packet, items: [item, { ...item, run_id: 'next-run' }] }), true)
  // Delimiters inside an identity cannot collide with a different native tuple.
  assert.equal(isReasoningSummaryStream({ ...packet, items: [
    { ...item, run_id: 'a:b', item_id: 'c' }, { ...item, run_id: 'a', item_id: 'b:c' },
  ] }), true)
})

await test('does not invent Claude streaming or accept unsupported/encrypted native channels', () => {
  for (const backend of ['claude', 'gemini', 'cursor', '', null]) {
    assert.equal(isReasoningSummaryStream({ ...packet, items: [{ ...item, backend }] }), false)
  }
  for (const phase of ['assistant', 'commentary', 'encrypted', '', null]) {
    assert.equal(isReasoningSummaryStream({ ...packet, items: [{ ...item, phase }] }), false)
  }
})

await test('requires bounded nonempty safe identities for the session, server, run and item', () => {
  for (const invalid of ['', null, 7, 'x'.repeat(257), 'line\nfeed', 'nul\u0000byte', '\u007f']) {
    for (const field of ['session_id', 'instance_id']) {
      assert.equal(isReasoningSummaryStream({ ...packet, [field]: invalid }), false, field)
    }
    for (const field of ['run_id', 'item_id']) {
      assert.equal(isReasoningSummaryStream({ ...packet, items: [{ ...item, [field]: invalid }] }), false, field)
    }
  }
  assert.equal(isReasoningSummaryStream({ ...packet, session_id: 'x'.repeat(256) }), true)
})

await test('requires safe nonnegative integer revisions and presentation anchors', () => {
  for (const invalid of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    assert.equal(isReasoningSummaryStream({ ...packet, revision: invalid }), false)
    assert.equal(isReasoningSummaryStream({ ...packet, items: [{ ...item, after_seq: invalid }] }), false)
  }
  assert.equal(isReasoningSummaryStream({ ...packet, items: [{ ...item, after_seq: 0 }] }), true)
})

await test('rejects malformed packets/items/text/timestamps before rendering', () => {
  for (const invalid of [null, undefined, false, 'packet', [], { ...packet, type: 'reasoning_summary' }, { ...packet, items: null }]) {
    assert.equal(isReasoningSummaryStream(invalid), false)
  }
  for (const invalid of [null, false, [], 'item', { ...item, text: 7 }, { ...item, ts: '' }, { ...item, ts: 'not-a-date' }, { ...item, ts: 'x'.repeat(81) }]) {
    assert.equal(isReasoningSummaryStream({ ...packet, items: [invalid] }), false)
  }
})

await test('bounds snapshot item count and aggregate received text without silent truncation', () => {
  const items = Array.from({ length: 256 }, (_, index) => ({ ...item, item_id: String(index) }))
  assert.equal(isReasoningSummaryStream({ ...packet, items }), true)
  assert.equal(isReasoningSummaryStream({ ...packet, items: [...items, { ...item, item_id: 'overflow' }] }), false)
  const text = 'x'.repeat(4 * 1024 * 1024)
  const bounded = [{ ...item, text }, { ...item, item_id: 'second', text }]
  assert.equal(isReasoningSummaryStream({ ...packet, items: bounded }), true)
  assert.equal(isReasoningSummaryStream({ ...packet, items: [...bounded, { ...item, item_id: 'overflow', text: 'x' }] }), false)
})

await test('maps the actual server snapshot truncation flag without inventing the original text length', () => {
  // reasoning_summary_stream_snapshot uses a shared text budget and reports
  // only text_truncated=true, not the number of omitted/source characters.
  const received = { ...packet, items: [{ ...item, text_truncated: true, raw: { omit: true } },
    { ...item, item_id: 'plaintext', phase: 'reasoning', text: 'Complete plaintext' }] }
  const before = JSON.stringify(received)
  assert.ok(isReasoningSummaryStream(received))
  const normalized = normalizedReasoningStream(received)
  assert.deepEqual(normalized.items, [{ ...item, reasoning_text_truncated: true },
    { ...item, item_id: 'plaintext', phase: 'reasoning', text: 'Complete plaintext' }])
  assert.equal(normalized.items[0].reasoning_text_chars, undefined)
  assert.equal(JSON.stringify(received), before)
})

await test('normalizes only genuine truncation metadata and preserves supplied source lengths', () => {
  for (const text_truncated of [false, 'true', 1, null, undefined]) {
    const received = { ...packet, items: [{ ...item, text_truncated }] }
    assert.ok(isReasoningSummaryStream(received))
    assert.deepEqual(normalizedReasoningStream(received).items, [item])
  }
  for (const reasoning_text_chars of [undefined, -1, 1, NaN, Infinity, '1000']) {
    const received = { ...packet, items: [{ ...item, text_truncated: true, reasoning_text_chars }] }
    assert.ok(isReasoningSummaryStream(received))
    assert.deepEqual(normalizedReasoningStream(received).items, [{ ...item, reasoning_text_truncated: true }])
  }
  const received = { ...packet, items: [{ ...item, text_truncated: true, reasoning_text_chars: 1000 }] }
  assert.ok(isReasoningSummaryStream(received))
  assert.deepEqual(normalizedReasoningStream(received).items, [{ ...item,
    reasoning_text_truncated: true, reasoning_text_chars: 1000 }])
})
