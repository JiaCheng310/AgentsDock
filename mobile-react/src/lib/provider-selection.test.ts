import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Health, RuntimeCatalog, Session } from '../types'
import { chatBackendChoice, chatBackendLabel, chatBackendSelection, customProviderAvailable, nativeProviderAvailable, providerRuntimeCatalog, providerSelectionError, selectableChatBackendChoices } from './provider-selection'
import { normalizeWorkspacePreferences } from './server-profiles'

const health: Health = { ok: true, capabilities: {
  codex_provider_v1: { per_chat: true, per_chat_models: true },
  provider_connections_v1: { per_chat: true, backends: ['claude', 'opencode'] },
} }
const custom = { configured: true, available: true, model: 'api-model', models: [{ value: 'api-model', label: 'API model' }], efforts: [] }
const runtime: RuntimeCatalog = { backends: {
  codex: { native_credentials_present: false, available: true, models: [{ value: 'native-model', label: 'Native model' }], efforts: [], custom_provider: custom },
  claude: { native_credentials_present: true, available: true, models: [], efforts: [], custom_provider: custom },
} }

test('API-only agents are not labeled native; both modes remain independent when configured', () => {
  assert.equal(nativeProviderAvailable(health, runtime, 'codex'), false)
  assert.equal(customProviderAvailable(health, runtime, 'codex'), true)
  assert.deepEqual(selectableChatBackendChoices(health, runtime), ['claude', 'claude-custom', 'codex-custom'])
  assert.equal(chatBackendLabel('codex-custom'), 'Codex - Custom API')
  assert.equal(chatBackendLabel('codex'), 'Codex')
  assert.equal(chatBackendLabel('claude'), 'Claude Code')
  assert.equal(chatBackendLabel('cursor'), 'Cursor')
  for (const choice of ['codex', 'codex-custom', 'claude', 'claude-custom', 'cursor', 'cursor-custom'] as const) {
    assert.equal(chatBackendChoice(chatBackendSelection(choice)), choice)
  }
})

test('old servers retain native choices but cannot admit a custom selection', () => {
  assert.deepEqual(selectableChatBackendChoices({ ok: true }, null), ['claude', 'codex'])
  assert.equal(customProviderAvailable({ ok: true }, runtime, 'claude'), false)
  assert.match(providerSelectionError({ ok: true }, runtime, chatBackendSelection('claude-custom'), true)!, /Update AgentsServer/)
  assert.equal(customProviderAvailable(health, runtime, 'cursor'), false)
})

test('Cursor-issued API credentials are selectable independently of native Cursor login', () => {
  const cursorHealth: Health = { ...health, capabilities: { ...health.capabilities, cursor_backend: { available: true, version: 2 } } }
  const cursorRuntime: RuntimeCatalog = { backends: { ...runtime.backends, cursor: { native_credentials_present: false, models: [], efforts: [], custom_provider: { ...custom, model: 'auto' } } } }
  assert.equal(nativeProviderAvailable(cursorHealth, cursorRuntime, 'cursor'), false)
  assert.equal(customProviderAvailable(cursorHealth, cursorRuntime, 'cursor'), true)
  assert.ok(selectableChatBackendChoices(cursorHealth, cursorRuntime).includes('cursor-custom'))
  assert.equal(selectableChatBackendChoices(cursorHealth, cursorRuntime).includes('cursor'), false)
  assert.equal(providerSelectionError(cursorHealth, cursorRuntime, chatBackendSelection('cursor-custom'), true), null)
})

test('custom model lists and immutable chat bindings never fall back to native or replacement API models', () => {
  const selection = chatBackendSelection('codex-custom')
  assert.deepEqual(providerRuntimeCatalog(runtime, selection)?.backends.codex.models, custom.models)
  const bound: Session = { ...selection, id: 'test', title: 'Test', backend_locked: true, codex_provider_catalog: { ...custom, models: [{ value: 'bound-model', label: 'Bound model' }] } }
  assert.equal(providerRuntimeCatalog(runtime, bound)?.backends.codex.models[0].value, 'bound-model')
  assert.deepEqual(providerRuntimeCatalog(runtime, { ...bound, codex_provider_catalog: undefined })?.backends.codex.models, [])
  assert.equal(providerRuntimeCatalog(runtime, chatBackendSelection('codex')), runtime)
})

test('existing API chats can ask the server to run after removal; new API choices cannot silently use native', () => {
  const removed: RuntimeCatalog = { backends: { codex: { ...runtime.backends.codex, custom_provider: { ...custom, configured: false, available: false } } } }
  const selection = { ...chatBackendSelection('codex-custom'), model: 'exact-api-model' }
  assert.match(providerSelectionError(health, removed, selection, true)!, /unavailable/)
  assert.equal(providerSelectionError(health, removed, selection), null)
  assert.equal(providerSelectionError(health, runtime, { ...selection, model: 'native-model' }), null, 'an exact API model ID is not constrained by the native catalog')
})

test('workspace preferences retain API selection without storing credentials or leaking modes across agents', () => {
  for (const choice of ['codex-custom', 'claude-custom', 'cursor-custom'] as const) {
    const saved = normalizeWorkspacePreferences({ chatDefaults: { ...chatBackendSelection(choice), model: 'api-model', api_key: 'not-a-real-key' } }).chatDefaults!
    assert.equal(chatBackendChoice(saved), choice)
    assert.equal(saved.model, 'api-model')
    assert.equal('api_key' in saved, false)
  }
  const native = normalizeWorkspacePreferences({ chatDefaults: { backend: 'cursor', codex_provider: 'custom', provider_connection: 'default' } }).chatDefaults!
  assert.equal(chatBackendChoice(native), 'cursor')
})
