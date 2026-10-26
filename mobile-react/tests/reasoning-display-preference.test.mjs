import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { create } from 'zustand'

const { outputText } = ts.transpileModule(fs.readFileSync('src/store/useReasoningDisplayStore.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
})
function fixture(storage = {}) {
  const writes = [], exports = {}
  vm.runInNewContext(outputText, { exports, require(name) {
    if (name === 'zustand') return { create }
    assert.equal(name, '@react-native-async-storage/async-storage', 'preference has no network/native-provider dependency')
    return { __esModule: true, default: { getItem: async () => null, setItem: async (key, value) => writes.push([key, value]), ...storage } }
  } })
  return { store: exports.useReasoningDisplayStore, writes }
}

test('reasoning defaults to compact, restores expanded once, and normalizes obsolete values', async () => {
  for (const saved of [null, 'compact', 'expanded', 'obsolete']) {
    let reads = 0
    const { store } = fixture({ getItem: async () => { reads++; return saved } })
    assert.equal(store.getState().preference, 'compact')
    await Promise.all([store.getState().hydrate(), store.getState().hydrate()])
    await store.getState().hydrate()
    assert.equal(store.getState().preference, saved === 'expanded' ? 'expanded' : 'compact')
    assert.equal(store.getState().hydrated, true)
    assert.equal(reads, 1)
  }
})

test('rapid local taps persist in visible order, independently of server profiles', async () => {
  const { store, writes } = fixture()
  const first = store.getState().setPreference('expanded')
  assert.equal(store.getState().preference, 'expanded')
  await Promise.all([first, store.getState().setPreference('compact'), store.getState().setPreference('expanded')])
  assert.deepEqual(writes.map(([, value]) => value), ['expanded', 'compact', 'expanded'])
  assert.ok(writes.every(([key]) => key === 'agentsdock.react.reasoningDisplay'))
})

test('late hydration cannot overwrite a newer reasoning preference', async () => {
  let finish
  const { store } = fixture({ getItem: () => new Promise(resolve => { finish = resolve }) })
  const hydration = store.getState().hydrate()
  await store.getState().setPreference('expanded')
  finish('compact')
  await hydration
  assert.equal(store.getState().preference, 'expanded')
})

test('storage failures preserve usable local selection and offer an explicit retry', async () => {
  let fail = true
  const { store } = fixture({
    getItem: async () => { throw new Error('unavailable') },
    setItem: async () => { if (fail) throw new Error('unavailable') },
  })
  await store.getState().hydrate()
  assert.match(store.getState().error, /load/)
  await store.getState().setPreference('expanded')
  assert.equal(store.getState().preference, 'expanded')
  assert.match(store.getState().error, /save/)
  fail = false
  await store.getState().setPreference('expanded')
  assert.equal(store.getState().error, null)
})

test('app startup hydrates and Appearance exposes the actual native switch', () => {
  assert.match(fs.readFileSync('App.tsx', 'utf8'), /useReasoningDisplayStore\.getState\(\)\.hydrate\(\)/)
  const settings = fs.readFileSync('src/components/Dialogs.tsx', 'utf8')
  assert.match(settings, /testID="settings-reasoning-display"/)
  assert.match(settings, /onValueChange=\{expanded => void setReasoningDisplay\(expanded \? 'expanded' : 'compact'\)\}/)
})
