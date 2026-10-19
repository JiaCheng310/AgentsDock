import assert from 'node:assert/strict'
import test from 'node:test'
import { assertUnusedBuild, assertOpenVersion, releaseConfig } from '../scripts/ios-testflight-metadata.mjs'

const app = { expo: { version: '0.1.2', ios: { bundleIdentifier: 'com.zhengyiluo.ZenithDock', buildNumber: '189' } } }
const config = releaseConfig(app)
const versions = [{ id: 'v1', attributes: { version: '0.1.2', platform: 'IOS' } }]
const build = version => ({ attributes: { version }, relationships: { preReleaseVersion: { data: { id: 'v1' } } } })

test('production metadata excludes the development app and invalid versions', () => {
  assert.deepEqual(config, { bundleId: 'com.zhengyiluo.ZenithDock', version: '0.1.2', build: '189' })
  assert.throws(() => releaseConfig({ expo: { ...app.expo, ios: { ...app.expo.ios, bundleIdentifier: 'com.zhengyiluo.ZenithDock.dev' } } }))
  assert.throws(() => releaseConfig({ expo: { ...app.expo, version: '0.1.2-dev' } }))
})

test('new build follows Apple history, not the stale source number', () => {
  assert.doesNotThrow(() => assertUnusedBuild(config, [build('188'), build('187')], versions))
  assert.throws(() => assertUnusedBuild({ ...config, build: '172' }, [build('188')], versions))
  assert.throws(() => assertUnusedBuild(config, [build('189')], versions))
  assert.throws(() => assertUnusedBuild(config, [build('188'), build('190')], versions))
})

test('unexpected version lines, platforms and numbering fail closed', () => {
  assert.throws(() => assertUnusedBuild({ ...config, version: '0.1.1' }, [build('188')], versions))
  assert.throws(() => assertUnusedBuild(config, [build('188')], [{ id: 'v1', attributes: { version: '0.1.2', platform: 'MAC_OS' } }]))
  assert.throws(() => assertUnusedBuild(config, [build('188.1')], versions))
  assert.throws(() => assertUnusedBuild(config, [], versions))
})

test('older iOS marketing versions may use independent timestamp build numbers', () => {
  const older = { ...build('202605151902'), relationships: { preReleaseVersion: { data: { id: 'old' } } } }
  assert.doesNotThrow(() => assertUnusedBuild(config, [build('188'), older], [
    ...versions, { id: 'old', attributes: { version: '0.1.0', platform: 'IOS' } },
  ]))
  assert.throws(() => assertUnusedBuild(config, [build('188'), older], versions))
})

test('a closed App Store version requires a new marketing version before compiling', () => {
  const approved = [{ attributes: { versionString: '0.1.2', appStoreState: 'READY_FOR_SALE' } }]
  assert.throws(() => assertOpenVersion(config, approved))
  assert.doesNotThrow(() => assertOpenVersion({ ...config, version: '0.1.3' }, approved))
  assert.doesNotThrow(() => assertUnusedBuild({ ...config, version: '0.1.3' }, [build('188')], versions))
  assert.throws(() => assertOpenVersion(config, [{ attributes: { versionString: '0.1.2', appStoreState: 'PENDING_DEVELOPER_RELEASE' } }]))
  assert.doesNotThrow(() => assertOpenVersion(config, [{ attributes: { versionString: '0.1.2', appStoreState: 'PREPARE_FOR_SUBMISSION' } }]))
})
