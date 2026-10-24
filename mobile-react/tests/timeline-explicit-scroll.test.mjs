import assert from 'node:assert/strict'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { create } from 'zustand'
import { build } from 'esbuild'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const store = create(() => ({})), reasoning = create(() => ({ selected: null }))
const fixture = { store, reasoning, scrolls: [] }
globalThis.__timelineExplicitScroll = fixture
const frames = new Map()
let nextFrame = 0
const originalFrame = globalThis.requestAnimationFrame, originalCancel = globalThis.cancelAnimationFrame
globalThis.requestAnimationFrame = callback => { const id = ++nextFrame; frames.set(id, callback); return id }
globalThis.cancelAnimationFrame = id => frames.delete(id)
const mocks = {
  'react-native': `export const View='View',Pressable='Pressable';export const Platform={OS:'ios'},Keyboard={dismiss(){}},StyleSheet={create:x=>x};`,
  '@shopify/flash-list': `import {createElement,forwardRef,useImperativeHandle} from 'react';export const FlashList=forwardRef((props,ref)=>{useImperativeHandle(ref,()=>({scrollToEnd:value=>globalThis.__timelineExplicitScroll.scrolls.push(value),scrollToIndex(){},recomputeViewableItems(){}}),[]);return createElement('FlashList',props)});`,
  'lucide-react-native': `export const ArrowDown='ArrowDown',ArrowUp='ArrowUp',RefreshCw='RefreshCw';`,
  '../store/useAppStore': `export const useAppStore=globalThis.__timelineExplicitScroll.store;`,
  '../store/useReasoningStreamStore': `export const useReasoningStreamStore=globalThis.__timelineExplicitScroll.reasoning;`,
  '../theme': `export const radius={md:8,round:99};export const usePalette=()=>({text:'black',muted:'gray',raised:'white',border:'gray',surface:'white'});`,
  './AppText': `export const Text='Text';`,
  './ui': `export const Loading='Loading';`,
  './TimelineRows': `export const TimelineRowView='TimelineRowView';`,
}
const outfile = path.resolve('build/tmp', `timeline-explicit-scroll-${process.pid}.mjs`)
await mkdir(path.dirname(outfile), { recursive: true })
await build({ stdin: { contents: `export {Timeline} from './src/components/Timeline'`, resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', jsx: 'automatic', logLevel: 'silent', plugins: [{ name: 'timeline-scroll-native-hosts', setup(context) {
  context.onResolve({ filter: /.*/ }, args => args.path === 'react' ? { path: args.path, external: true } : mocks[args.path] ? { path: args.path, namespace: 'timeline-scroll-mock' } : undefined)
  context.onLoad({ filter: /.*/, namespace: 'timeline-scroll-mock' }, args => ({ contents: mocks[args.path], loader: 'js' }))
} }] })
after(async () => { await unlink(outfile); delete globalThis.__timelineExplicitScroll; globalThis.requestAnimationFrame = originalFrame; globalThis.cancelAnimationFrame = originalCancel })
const { Timeline } = await import(pathToFileURL(outfile).href)
const start = (id = 'chat') => ({ id: `${id}-start`, session_id: id, run_id: 'run', seq: 1, type: 'turn_started', prompt: 'A task', ts: '2026-10-24T00:00:00Z' })
const snapshot = (id = 'chat', events = [start(id)]) => ({ session: { id, backend: 'codex' }, events, files: [], queuedTurns: [], latestSeq: events.length ? 1 : 0, total: events.length, hasMore: false })
const stream = (revision = 1) => ({ profileGeneration: 1, sessionId: 'chat', snapshot: { type: 'reasoning_summary_stream', session_id: 'chat', instance_id: 'server', revision, items: [{ run_id: 'run', item_id: 'thought', phase: 'summary', backend: 'codex', text: `Provider supplied ${revision}`, after_seq: 1, ts: '2026-10-24T00:00:00Z' }] } })
const input = (patch = {}) => ({ sessionId: 'chat', scrollRequest: 0, keyboardVisible: false, keyboardSettleRequest: 0, bottomInset: 0, onReview() {}, ...patch })
const view = props => React.createElement(Timeline, props)
const list = tree => tree.root.findByType('FlashList')
const animatedScrolls = () => fixture.scrolls.filter(value => value.animated)
async function flushFrames() { await act(async () => { for (const [id, callback] of [...frames]) { if (frames.delete(id)) callback(0) } }) }
async function render(events) {
  frames.clear(); fixture.scrolls.length = 0
  reasoning.setState({ selected: null })
  store.setState({ profileGeneration: 1, selectedSessionId: 'chat', sessions: [], snapshots: { chat: snapshot('chat', events) }, historyWindow: null,
    loadingSessionId: null, loadingOlder: {}, loadOlder: async () => {}, exitHistory: () => store.setState({ historyWindow: null }),
    syncSessionId: 'chat', syncStatus: 'live', syncError: null, retryConnection() {}, fontScale: 1 }, true)
  let tree; await act(async () => { tree = TestRenderer.create(view(input())) })
  return tree
}
async function dragAway(tree) { await act(async () => {
  const event = { nativeEvent: { contentOffset: { y: 500 }, contentSize: { height: 4000 }, layoutMeasurement: { height: 800 }, velocity: { y: 0 } } }
  list(tree).props.onScrollBeginDrag(event); list(tree).props.onScroll(event)
}) }
const unmount = tree => act(async () => tree.unmount())

test('an explicit send scroll is consumed once even as the first stream-only row appears and reconnects', async () => {
  const tree = await render()
  try {
    await act(async () => tree.update(view(input({ scrollRequest: 1 }))))
    await flushFrames()
    assert.equal(animatedScrolls().length, 1)
    await dragAway(tree)
    await act(async () => reasoning.setState({ selected: stream() }))
    assert.ok(list(tree).props.data.some(row => row.kind === 'trace'), 'exercise the actual first overlay row')
    await flushFrames()
    await act(async () => reasoning.setState({ selected: null }))
    await flushFrames()
    await act(async () => reasoning.setState({ selected: stream(2) }))
    await flushFrames()
    assert.equal(animatedScrolls().length, 1, 'row insertion/removal must not replay an old send action')
  } finally { await unmount(tree) }
})

test('a drag cancels a scheduled explicit scroll before its frame runs', async () => {
  const tree = await render()
  try {
    await act(async () => tree.update(view(input({ scrollRequest: 1 }))))
    await dragAway(tree)
    await flushFrames()
    assert.equal(animatedScrolls().length, 0)
  } finally { await unmount(tree) }
})

test('history navigation cancels a scheduled send request and leaving history does not replay it', async () => {
  const tree = await render()
  try {
    await act(async () => tree.update(view(input({ scrollRequest: 1 }))))
    await act(async () => store.setState({ historyWindow: { sessionId: 'chat', profileGeneration: 1, snapshot: snapshot(), detached: true } }))
    await flushFrames()
    await act(async () => store.setState({ historyWindow: null }))
    await flushFrames()
    assert.equal(animatedScrolls().length, 0)
  } finally { await unmount(tree) }
})

for (const change of ['chat', 'profile']) test(`${change} selection cancels old frames and consumes the old request revision`, async () => {
  const tree = await render()
  try {
    await act(async () => tree.update(view(input({ scrollRequest: 1 }))))
    const sessionId = change === 'chat' ? 'other' : 'chat'
    await act(async () => {
      store.setState({ selectedSessionId: sessionId, profileGeneration: change === 'profile' ? 2 : 1, snapshots: { [sessionId]: snapshot(sessionId) } })
      tree.update(view(input({ sessionId, scrollRequest: 1 })))
    })
    await flushFrames()
    assert.equal(animatedScrolls().length, 0)
    await act(async () => tree.update(view(input({ sessionId, scrollRequest: 2 }))))
    await flushFrames()
    assert.equal(animatedScrolls().length, 1, 'a genuinely new request still works for the new owner')
  } finally { await unmount(tree) }
})

test('an explicit request waits for its first row but does not replay after that', async () => {
  const tree = await render([])
  try {
    await act(async () => tree.update(view(input({ scrollRequest: 1 }))))
    await flushFrames()
    assert.equal(animatedScrolls().length, 0)
    await act(async () => store.setState({ snapshots: { chat: snapshot() } }))
    await flushFrames()
    assert.equal(animatedScrolls().length, 1)
    await act(async () => reasoning.setState({ selected: stream() }))
    await flushFrames()
    assert.equal(animatedScrolls().length, 1)
  } finally { await unmount(tree) }
})

test('unmount cancels a pending explicit frame', async () => {
  const tree = await render()
  await act(async () => tree.update(view(input({ scrollRequest: 1 }))))
  await unmount(tree)
  assert.equal(frames.size, 0)
  await flushFrames()
  assert.equal(animatedScrolls().length, 0)
})
