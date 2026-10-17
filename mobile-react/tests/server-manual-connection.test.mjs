import assert from 'node:assert/strict'
import { build } from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import ts from 'typescript'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const mocks = {
  'react-native': `export const ActivityIndicator='Spinner',Modal='Modal',Pressable='Button',ScrollView='Scroll',Switch='Switch',View='View'; export const Alert={alert(){}}; export const Platform={OS:'ios'}; export const StyleSheet={create:x=>x,hairlineWidth:1};`,
  '@expo/ui/community/menu': `export const MenuView='Menu';`,
  'react-native-safe-area-context': `export const SafeAreaView='SafeArea';`,
  'lucide-react-native': `export const Check='Check',ChevronDown='ChevronDown',MoreHorizontal='MoreHorizontal',Pencil='Pencil',Plus='Plus',Server='Server',Wifi='Wifi',X='X';`,
  '../theme': `export const usePalette=()=>({text:'#111',muted:'#666',border:'#ccc',surface:'#fff',raised:'#eee',blue:'#28f',green:'#080',orange:'#f80'});`,
  './AppText': `export const Text='Text',TextInput='Input';`,
  './ui': `export const IconButton='IconButton',SheetCloseButton='SheetCloseButton';`,
}
const outfile = path.resolve('build/tmp', `server-manual-connection-${process.pid}.mjs`)
await fs.mkdir(path.dirname(outfile), { recursive: true })
await build({
  entryPoints: ['src/components/ServerProfiles.tsx'], outfile, bundle: true, format: 'esm',
  platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent',
  plugins: [{ name: 'native-hosts', setup(context) {
    context.onResolve({ filter: /.*/ }, args => mocks[args.path] ? { path: args.path, namespace: 'fixture' } : undefined)
    context.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }))
  } }],
})
after(() => fs.unlink(outfile))
const { ServerProfilesManager } = await import(pathToFileURL(outfile).href)
const button = (tree, label) => tree.root.findAllByType('Button').find(node => node.props.accessibilityLabel === label)
const input = (tree, id) => tree.root.findByProps({ testID: id })
const profile = { id: 'saved', name: 'Saved server', serverUrl: 'http://127.0.0.1:7850',
  serverIdentity: 'saved-identity', hasAccessToken: true, serverSetupComplete: true,
  connectionState: 'connected', cachedUnreadCount: 0 }
const noActions = { onSwitchProfile: async () => true, onTestConnection: async () => ({ ok: true, server_identity: 'test-identity' }),
  onCreateProfile: async () => 'created', onUpdateProfile: async () => {}, onReorderProfiles: async () => {}, onRemoveProfile: async () => {} }

test('manage, add and edit expose manual controls without scan or QR-image import', async () => {
  for (const initialMode of ['manage', 'add', 'edit-active']) {
    let tree
    await act(async () => { tree = TestRenderer.create(React.createElement(ServerProfilesManager, {
      profiles: [profile], activeProfileId: profile.id, initialMode, ...noActions,
    })) })
    try {
      assert.doesNotMatch(JSON.stringify(tree.toJSON()), /Scan connection QR|Choose QR image|Allow camera|Connect and save|CameraView/)
      assert.ok(button(tree, 'Add server'))
      if (initialMode !== 'manage') {
        assert.ok(input(tree, 'server-profile-url'))
        assert.equal(input(tree, 'server-profile-token').props.secureTextEntry, true)
        assert.ok(button(tree, 'Test connection'))
      }
    } finally { await act(async () => tree.unmount()) }
  }
})

test('manual add still authenticates the typed connection before saving and switching', async () => {
  let tree
  const calls = []
  await act(async () => { tree = TestRenderer.create(React.createElement(ServerProfilesManager, {
    profiles: [], activeProfileId: null, initialMode: 'add', ...noActions,
    onTestConnection: async value => { calls.push(['test', value]); return { ok: true, server_identity: 'test-identity' } },
    onCreateProfile: async value => { calls.push(['create', value]); return 'created' },
    onSwitchProfile: async id => { calls.push(['switch', id]); return true },
  })) })
  try {
    assert.equal(button(tree, 'Add & switch').props.disabled, true)
    await act(async () => input(tree, 'server-profile-url').props.onChangeText('http://127.0.0.1:7866'))
    await act(async () => input(tree, 'server-profile-token').props.onChangeText('synthetic-test-token'))
    assert.deepEqual(calls, [], 'typing must not probe or save a server')
    await act(async () => button(tree, 'Test connection').props.onPress())
    assert.equal(button(tree, 'Add & switch').props.disabled, false)
    await act(async () => button(tree, 'Add & switch').props.onPress())
    assert.deepEqual(calls.map(([action]) => action), ['test', 'create', 'switch'])
    assert.equal(calls[0][1].serverUrl, 'http://127.0.0.1:7866')
    assert.equal(calls[0][1].accessToken, 'synthetic-test-token')
    assert.equal(calls[1][1].serverIdentity, 'test-identity')
    assert.equal(calls[2][1], 'created')
  } finally { await act(async () => tree.unmount()) }
})

test('changing the connection invalidates its test; a rejected test cannot save', async () => {
  let tree, reject = false, saved = 0
  await act(async () => { tree = TestRenderer.create(React.createElement(ServerProfilesManager, {
    profiles: [], activeProfileId: null, initialMode: 'add', ...noActions,
    onTestConnection: async () => { if (reject) throw new Error('Connection rejected'); return { ok: true, server_identity: 'test-identity' } },
    onCreateProfile: async () => { saved++; return 'created' },
  })) })
  try {
    await act(async () => input(tree, 'server-profile-url').props.onChangeText('http://127.0.0.1:7866'))
    await act(async () => button(tree, 'Test connection').props.onPress())
    assert.equal(button(tree, 'Add & switch').props.disabled, false)
    await act(async () => input(tree, 'server-profile-token').props.onChangeText('changed-token'))
    assert.equal(button(tree, 'Add & switch').props.disabled, true)
    reject = true
    await act(async () => button(tree, 'Test connection').props.onPress())
    assert.match(JSON.stringify(tree.toJSON()), /Connection rejected/)
    assert.equal(button(tree, 'Add & switch').props.disabled, true)
    assert.equal(saved, 0)
  } finally { await act(async () => tree.unmount()) }
})

test('connection QR handlers, native camera registration and setup prompts are removed', async () => {
  const app = JSON.parse(await fs.readFile('app.json', 'utf8')).expo
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'))
  assert.equal(pkg.dependencies['expo-camera'], undefined)
  assert.equal(app.plugins.some(plugin => (Array.isArray(plugin) ? plugin[0] : plugin) === 'expo-camera'), false)
  assert.equal(app.plugins.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-image-picker')[1].cameraPermission, false)
  assert.equal(app.scheme, 'com.zhengyiluo.ZenithDock')
  const shell = await fs.readFile('src/components/AppShell.tsx', 'utf8')
  assert.doesNotMatch(shell, /pairing|agentsdock:\\?\//i)
  assert.ok(shell.includes("openInspectorAction('terminal')"), 'existing terminal links remain handled')
  assert.doesNotMatch(await fs.readFile('src/components/Dialogs.tsx', 'utf8'), /Scan a QR|agentsdock pair/)
  for (const file of ['src/components/ServerPairing.tsx', 'src/lib/server-pairing.ts', 'src/lib/server-connection-link.ts']) {
    await assert.rejects(fs.access(file), { code: 'ENOENT' })
  }
})

test('discarded connection links cannot open a terminal through their embedded payload', async () => {
  const source = ts.createSourceFile('AppShell.tsx', await fs.readFile('src/components/AppShell.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let handler
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'openDeepLink') handler = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(handler)
  const js = ts.transpileModule(`const onURL = ${handler.getText(source)}`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText
  const calls = []
  const onURL = new Function('openInspectorAction', `${js}; return onURL`)(kind => calls.push(kind))
  for (const url of ['agentsdock://connect#url=http://terminal', 'com.zhengyiluo.ZenithDock://connect#url=http://terminal', 'https://example.com/?next=com.zhengyiluo.ZenithDock://terminal']) onURL({ url })
  assert.deepEqual(calls, [])
  onURL({ url: 'com.zhengyiluo.ZenithDock://terminal?session=fixture' })
  assert.deepEqual(calls, ['terminal'])
})
