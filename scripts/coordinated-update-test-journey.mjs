#!/usr/bin/env node
// A real packaged App -> authenticated Server -> native updater journey.
// This is scoped test evidence, not a provider-chat or publication acceptance.
import assert from 'node:assert/strict'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import { appVersion, connect, freePort, hashFile, openMigrationUpdateSettings,
  processesFor, stopOwned, until, verifyApp } from './verify_electron_migration.mjs'

const VERSION_A = '1.0.11-beta.2'
const VERSION_B = '1.0.11-beta.3'
const PROFILE = 'coordinated-update-replay'
const SERVICE = 'com.zhengyiluo.AgentsDock'
const ACCOUNT = `agent-access-token:${PROFILE}`
const candidateRoot = resolve(process.argv[2] ?? '')
assert(process.platform === 'darwin' && process.env.GITHUB_ACTIONS === 'true'
  && process.env.RUNNER_ENVIRONMENT === 'github-hosted'
  && process.env.GITHUB_REPOSITORY === 'ZhengyiLuo/AgentsDock'
  && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
  && process.env.GITHUB_WORKFLOW_REF?.includes('/.github/workflows/ci.yml@refs/heads/test/recoverable-update-replay-20261017'),
  'Native update replay runs only on the reviewed disposable CI runner.')
const runner = await realpath(process.env.RUNNER_TEMP ?? '/')
const root = await realpath(candidateRoot)
assert(relative(runner, root) && !relative(runner, root).startsWith('..'), 'Candidate input must be under RUNNER_TEMP.')
const work = join(runner, 'coordinated-update-native')
await mkdir(work, { mode: 0o700 })
const logs = createWriteStream(join(work, 'private-native.log'), { flags: 'wx', mode: 0o600 })
// launchd restarts use the runner account's real HOME. The entire hosted VM is
// disposable; redirecting HOME here would make the installer and service disagree.
const childEnv = { ...process.env, AGENTSDOCK_DISABLE_ANALYTICS: '1',
  npm_config_cache: join(work, 'npm-cache'), UV_CACHE_DIR: join(work, 'uv-cache') }
const report = { kind: 'unpublished-native-update-replay', from: VERSION_A, to: VERSION_B,
  sourceA: 'a5cadf72c125f1bd0a2c8c2ab2409ed4cfd5d8cd',
  sourceB: '9ef456a8613b019fd30b4bd5d2aee61b69538b73',
  testSurface: 'GitHub-hosted macOS native app and managed server',
  providerChat: 'not exercised', phases: [] }
const phase = name => { report.phases.push(name); process.stdout.write(`${name}\n`) }
const executePrivate = (command, args, options = {}) => {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: options.timeout ?? 600_000,
      maxBuffer: 2 * 1024 * 1024, env: options.env ?? childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    logs.write(`Private command ${command.split('/').at(-1)} failed (${error.status ?? 'launch'}).\n`)
    throw new Error(`${command.split('/').at(-1)} failed; private output was withheld`)
  }
}
const ownedApp = join(work, 'installation/AgentsDock.app')
let client = null
let launched = null
let keychainCreated = false
try {
  for (const [letter, version] of [['a', VERSION_A], ['b', VERSION_B]]) {
    const destination = join(work, letter === 'a' ? 'installation' : 'expected')
    await mkdir(destination)
    executePrivate('/usr/bin/ditto', ['-x', '-k', join(root, letter, `AgentsDock-${version}-mac-universal.zip`), destination])
    verifyApp(join(destination, 'AgentsDock.app'), version)
  }
  phase('signed-apps-verified')
  const expectedAsar = await hashFile(join(work, 'expected/AgentsDock.app/Contents/Resources/app.asar'))
  await mkdir(join(work, 'cli'))
  executePrivate('npm', ['install', '--prefix', join(work, 'cli'), '--ignore-scripts', '--no-audit', '--no-fund', '--offline',
    join(root, 'a', `server-${VERSION_A}.tgz`)])
  const cli = join(work, 'cli/node_modules/@agentsdock/server/npm/cli.cjs')
  const installerOutput = executePrivate('node', [cli, 'install', '--bind', '127.0.0.1', '--port', '7851', '--non-interactive'],
    { timeout: 1_200_000 })
  const resultLine = installerOutput.split(/\r?\n/).find(line => line.startsWith('AGENTSDOCK_SETUP_RESULT='))
  assert(resultLine, 'Installer did not return its bounded setup result.')
  const setup = JSON.parse(resultLine.slice('AGENTSDOCK_SETUP_RESULT='.length))
  assert(setup.server_url === 'http://127.0.0.1:7851' && setup.server_version === VERSION_A
    && /^[a-f0-9]{32,128}$/.test(setup.access_token), 'Fresh test service differs from candidate A.')
  const token = setup.access_token
  const api = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:7851${path}`, {
      method, headers: { 'X-AgentsDock-Token': token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000) })
    assert(response.ok, `Authenticated test Server ${method} failed (${response.status}).`)
    return response.json()
  }
  const health = async () => {
    const response = await fetch('http://127.0.0.1:7851/api/health', {
      headers: { 'X-AgentsDock-Token': token }, signal: AbortSignal.timeout(2_000) })
    assert(response.ok, 'Authenticated test server health failed.')
    return response.json()
  }
  const beforeHealth = await until('Candidate A server healthy', async () => {
    try {
      const value = await health()
      return value.ok && value.server_version === VERSION_A ? value : null
    } catch { return null }
  })
  assert(typeof beforeHealth.server_identity === 'string' && beforeHealth.server_identity.length >= 8)
  const saved = await api('POST', '/api/sessions', { backend: 'codex', cwd: work,
    title: 'Disposable update history', auto_title_enabled: false, import_history: false,
    provider_jobs_access: 'blocked' })
  const savedId = saved.session?.id
  assert(typeof savedId === 'string' && savedId.length >= 8, 'Test chat was not saved.')
  phase('candidate-a-managed-server-running')
  const profileDirectory = join(work, 'profile')
  await mkdir(profileDirectory, { mode: 0o700 })
  const settings = { schemaVersion: 2, activeProfileId: PROFILE, profiles: [{ id: PROFILE,
    name: 'Disposable update replay', serverUrl: setup.server_url, serverIdentity: beforeHealth.server_identity,
    keychainAccessToken: true, serverSetupComplete: true,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] }
  await writeFile(join(profileDirectory, 'settings.json'), JSON.stringify(settings), { flag: 'wx', mode: 0o600 })
  await writeFile(join(profileDirectory, 'update-track'), 'beta\n', { flag: 'wx', mode: 0o600 })
  await writeFile(join(profileDirectory, 'app-language.json'), '{"preference":"en"}\n', { flag: 'wx', mode: 0o600 })
  try {
    execFileSync('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT],
      { timeout: 5_000, stdio: 'ignore' })
    throw new Error('Test keychain account already exists; refusing to replace it.')
  } catch (error) {
    assert(error.status === 44, 'Cannot safely inspect the isolated keychain account.')
  }
  // Avoid passing the token in argv or uploading its private process output.
  execFileSync('/usr/bin/security', ['-i'], { input: `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${token}\n`,
    timeout: 5_000, stdio: ['pipe', 'ignore', 'pipe'] })
  keychainCreated = true
  const debugPort = await freePort()
  const launch = () => {
    const child = spawn(join(ownedApp, 'Contents/MacOS/AgentsDock'), [`--remote-debugging-port=${debugPort}`], {
      env: { ...childEnv, AGENTSDOCK_USER_DATA: profileDirectory }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => logs.write(chunk))
    child.stderr.on('data', chunk => logs.write(chunk))
    child.on('error', () => logs.write('Owned App launch failed.\n'))
    return child
  }
  launched = launch()
  client = await until('Candidate A renderer', () => connect(debugPort), 60_000)
  const connected = await until('App connected to managed candidate A', async () => {
    const bootstrap = await client.evaluate('window.agentsDock?.bootstrap()')
    return bootstrap?.health?.server_version === VERSION_A && bootstrap.health.server_identity === beforeHealth.server_identity
      ? bootstrap : null
  }, 60_000)
  assert(connected.activeProfileId === PROFILE)
  const initial = await client.evaluate('window.agentsDock.updates.status()')
  assert(initial.currentVersion === VERSION_A && initial.channel === 'direct' && initial.track === 'beta')
  phase('candidate-a-app-and-server-connected')
  await openMigrationUpdateSettings(client)
  const checkAdmission = await until('Native update check admission', async () => {
    const status = await client.evaluate('window.agentsDock.updates.status()')
    if (status.state === 'disabled') throw new Error('Packaged App updater is disabled.')
    if (status.state === 'downloaded') return 'already-downloaded'
    if (['idle', 'not-available', 'error'].includes(status.state)) return 'check'
    return null
  }, 8 * 60_000)
  if (checkAdmission === 'check') await client.clickButton(['Check for updates'])
  const downloaded = await until('Candidate B downloaded', async () => {
    const status = await client.evaluate('window.agentsDock.updates.status()')
    if (status.state === 'error' || status.state === 'disabled') throw new Error(`Native updater ${status.state}`)
    return status.state === 'downloaded' && status.availableVersion === VERSION_B ? status : null
  }, 8 * 60_000)
  assert(downloaded.currentVersion === VERSION_A)
  phase('candidate-b-downloaded-through-exact-feed')
  await client.clickButton(['Update AgentsDock'])
  let serverFirst = false
  const upgradedHealth = await until('Server B completes before App replacement', async () => {
    let value
    try { value = await health() } catch { return null }
    if (value.server_version !== VERSION_B) return null
    serverFirst = appVersion(ownedApp) === VERSION_A
    return value
  }, 12 * 60_000)
  assert(serverFirst, 'App replacement preceded observed server activation.')
  assert(upgradedHealth.server_identity === beforeHealth.server_identity,
    'Managed update changed the server identity.')
  const preserved = await api('GET', `/api/sessions/${encodeURIComponent(savedId)}`)
  assert(preserved.session?.id === savedId && preserved.session.title === 'Disposable update history',
    'Saved test chat was not preserved by the managed update.')
  phase('server-b-activated-before-app-replacement')
  client.close()
  client = null
  await until('Native App B replacement', () => appVersion(ownedApp) === VERSION_B, 5 * 60_000)
  verifyApp(ownedApp, VERSION_B)
  assert(await hashFile(join(ownedApp, 'Contents/Resources/app.asar')) === expectedAsar,
    'Installed App B differs from the sealed candidate.')
  await until('Native App B relaunch', () => processesFor(ownedApp).some(pid => pid !== launched.pid), 60_000)
  phase('native-app-b-replaced-and-relaunched')
  await stopOwned(ownedApp)
  launched = launch()
  client = await until('Reopened App B renderer', () => connect(debugPort), 60_000)
  const after = await until('Reopened App and Server B connected', async () => {
    const bootstrap = await client.evaluate('window.agentsDock?.bootstrap()')
    return bootstrap?.health?.server_version === VERSION_B && bootstrap.health.server_identity === beforeHealth.server_identity
      ? bootstrap : null
  }, 90_000)
  assert(after.activeProfileId === PROFILE)
  const updateStatus = await client.evaluate('window.agentsDock.updates.status()')
  assert(updateStatus.currentVersion === VERSION_B)
  assert((await readFile(join(profileDirectory, 'update-track'), 'utf8')).trim() === 'beta')
  phase('reopened-app-and-server-identity-preserved')
  report.status = 'passed'
  report.serverIdentityPreserved = true
  report.savedChatPreserved = true
  report.appReplacementObserved = true
  report.serverFirstObserved = true
  await writeFile(join(work, 'public-evidence.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
} finally {
  try { client?.close() } catch { /* The updater may already have exited. */ }
  if (existsSync(ownedApp)) await stopOwned(ownedApp).catch(() => {})
  if (keychainCreated) executePrivate('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT])
  logs.end()
}
