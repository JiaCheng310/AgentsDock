import assert from 'node:assert/strict'
import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

export function releaseConfig(config) {
  const app = config.expo
  assert.equal(app.ios.bundleIdentifier, 'com.zhengyiluo.ZenithDock')
  assert.match(app.version, /^\d+\.\d+\.\d+$/)
  assert.match(app.ios.buildNumber, /^[1-9]\d*$/)
  return { bundleId: app.ios.bundleIdentifier, version: app.version, build: app.ios.buildNumber }
}

export function assertUnusedBuild(config, builds, included) {
  assert.ok(builds.length > 0, 'Existing iOS build history is required')
  const versions = new Map(included.map(item => [item.id, item.attributes]))
  const latestVersion = versions.get(builds[0].relationships?.preReleaseVersion?.data?.id)
  assert.equal(latestVersion?.platform, 'IOS')
  assert.ok(compareVersions(config.version, latestVersion.version) >= 0, 'Do not upload an older TestFlight version')
  for (const item of builds) {
    const version = versions.get(item.relationships?.preReleaseVersion?.data?.id)
    assert.equal(version?.platform, 'IOS', 'Every build must have an iOS version relationship')
    // iOS build numbers are unique within a marketing version, not across older versions.
    if (version.version !== config.version) continue
    assert.match(item.attributes.version, /^[1-9]\d*$/, 'Review non-integer build numbering manually')
    assert.ok(BigInt(item.attributes.version) < BigInt(config.build), `Existing ${version.version} (${item.attributes.version}) requires build-number review`)
  }
}

function compareVersions(left, right) {
  assert.match(left, /^\d+\.\d+\.\d+$/)
  assert.match(right, /^\d+\.\d+\.\d+$/)
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

export function assertOpenVersion(config, versions) {
  const closed = new Set([
    'ACCEPTED', 'PENDING_APPLE_RELEASE', 'PENDING_DEVELOPER_RELEASE',
    'PROCESSING_FOR_APP_STORE', 'PROCESSING_FOR_DISTRIBUTION', 'READY_FOR_SALE',
    'READY_FOR_DISTRIBUTION', 'PREORDER_READY_FOR_SALE', 'PENDING_CONTRACT',
    'DEVELOPER_REMOVED_FROM_SALE', 'REMOVED_FROM_SALE', 'REPLACED_WITH_NEW_VERSION',
  ])
  for (const item of versions) {
    if (!closed.has(item.attributes.appStoreState)) continue
    const version = item.attributes.versionString
    assert.ok(compareVersions(config.version, version) > 0, `Apple has already approved ${version}; select a newer marketing version`)
  }
}

function bearer(env) {
  const { APPLE_API_KEY_P8_BASE64: encoded, APPLE_API_KEY_ID: kid, APPLE_API_ISSUER: iss } = env
  assert.ok(encoded && kid && iss, 'Missing Apple API credentials')
  const key = createPrivateKey(Buffer.from(encoded, 'base64'))
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const input = `${encode({ alg: 'ES256', kid, typ: 'JWT' })}.${encode({ iss, iat: now - 10, exp: now + 300, aud: 'appstoreconnect-v1' })}`
  return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

async function get(path, params = {}) {
  const url = new URL(path, 'https://api.appstoreconnect.apple.com')
  assert.equal(url.origin, 'https://api.appstoreconnect.apple.com')
  assert.equal(url.username, '')
  assert.equal(url.password, '')
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${bearer(process.env)}`, Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(60000),
  })
  if (!response.ok) throw new Error(`Apple metadata HTTP ${response.status}`)
  return response.json()
}

async function main(mode) {
  assert.ok(['check', 'wait'].includes(mode), 'Expected check or wait')
  const config = releaseConfig(JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')))
  const apps = await get('/v1/apps', { 'filter[bundleId]': config.bundleId, 'fields[apps]': 'bundleId', limit: '2' })
  assert.equal(apps.data.length, 1, 'Production iOS app is not accessible')
  const appId = apps.data[0].id
  const query = {
    'filter[app]': appId, 'filter[preReleaseVersion.platform]': 'IOS',
    include: 'preReleaseVersion', sort: '-uploadedDate', limit: '200',
    'fields[builds]': 'version,uploadedDate,processingState,preReleaseVersion',
    'fields[preReleaseVersions]': 'version,platform',
  }
  if (mode === 'check') {
    const storeVersions = await get(`/v1/apps/${encodeURIComponent(appId)}/appStoreVersions`, {
      'filter[platform]': 'IOS', 'fields[appStoreVersions]': 'versionString,appStoreState', limit: '200',
    })
    assert.ok(!storeVersions.links?.next, 'Review paginated App Store version history manually')
    assertOpenVersion(config, storeVersions.data)
    const builds = []
    const versions = []
    let page = await get('/v1/builds', query)
    for (let index = 0; index < 20; index += 1) {
      builds.push(...page.data)
      versions.push(...(page.included ?? []))
      if (!page.links?.next) {
        assertUnusedBuild(config, builds, versions)
        console.log(`TestFlight preflight passed: ${config.version} (${config.build}), app ${appId}; ${builds.length} existing iOS builds checked.`)
        return
      }
      page = await get(page.links.next)
    }
    throw new Error('Build history pagination exceeded safety bound')
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const page = await get('/v1/builds', { ...query, 'filter[version]': config.build, 'filter[preReleaseVersion.version]': config.version })
    assert.ok(page.data.length <= 1, 'Ambiguous uploaded build')
    const build = page.data[0]
    const state = build?.attributes.processingState ?? 'NOT_VISIBLE'
    console.log(`TestFlight ${config.version} (${config.build}): ${state}`)
    if (state === 'VALID') {
      const detail = await get(`/v1/builds/${encodeURIComponent(build.id)}/buildBetaDetail`)
      console.log(JSON.stringify({ appId, ...config, buildId: build.id, processingState: state, ...detail.data.attributes }, null, 2))
      return
    }
    assert.ok(!['INVALID', 'FAILED'].includes(state), 'Apple rejected build processing')
    await setTimeout(30000)
  }
  throw new Error('Upload may be accepted, but Apple processing is still pending; do not re-upload the same build')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(error => {
    // Apple response bodies and signing credentials must never reach release logs.
    const message = error instanceof assert.AssertionError || /^Apple metadata HTTP \d{3}$/.test(error.message)
      ? error.message.split('\n')[0]
      : 'TestFlight metadata check failed; inspect access or processing status before retrying.'
    console.error(`::error::${message}`)
    process.exitCode = 1
  })
}
