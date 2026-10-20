#!/usr/bin/env node
// Native acceptance of public packages, on disposable hosted Macs only.
import assert from 'node:assert/strict'
import { createHash, verify } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { connect as connectTcp } from 'node:net'
import { userInfo } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { connect, freePort, hashFile, openMigrationUpdateSettings, processesFor,
  stopOwned, until, verifyApp } from './verify_electron_migration.mjs'

const branch = 'test/public-server-upgrade-20261020'
assert(process.platform === 'darwin' && process.env.GITHUB_ACTIONS === 'true'
  && process.env.RUNNER_ENVIRONMENT === 'github-hosted'
  && process.env.GITHUB_REPOSITORY === 'ZhengyiLuo/AgentsDock'
  && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
  && process.env.GITHUB_REF === `refs/heads/${branch}`
  && process.env.GITHUB_WORKFLOW_REF === `ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/${branch}`,
'This test requires its disposable manually dispatched GitHub macOS runner.')
const home = userInfo().homedir
assert(resolve(process.env.HOME) === resolve(home), 'Never redirect HOME.')
for (const key of ['AGENTS_SERVER_INSTALL_DIR', 'AGENTS_SERVER_CONFIG_DIR', 'AGENTS_SERVER_INSTANCE',
  'AGENTSDOCK_STATE_DIR', 'AGENTS_SERVER_STATE_DIR', 'XDG_CONFIG_HOME']) assert(!process.env[key], 'Inherited installation selectors forbidden.')
const baseline = process.argv[2]
assert(['legacy103', 'npm109'].includes(baseline))
const initialVersion = baseline === 'legacy103' ? '1.0.3' : '1.0.9'
const work = join(resolve(process.env.RUNNER_TEMP), `public-upgrade-${baseline}`)
assert(!relative(resolve(process.env.RUNNER_TEMP), work).startsWith('..'))
await mkdir(work, { mode: 0o700 })
const privateLog = createWriteStream(join(work, 'private.log'), { flags: 'wx', mode: 0o600 })
const installRoot = join(home, '.local/share/agents-server')
const configRoot = join(home, '.config/agents-server')
const labels = ['com.agentsdock.server', 'com.agentsdock.gateway']
const serviceFile = label => join(home, 'Library/LaunchAgents', `${label}.plist`)
for (const path of [installRoot, configRoot, join(home, '.agentsdock'), join(home, '.zenithbot-agent'), ...labels.map(serviceFile)]) {
  assert(!existsSync(path), 'Existing state prevents disposable acceptance.')
}
function commandStatus(command, args) {
  try { execFileSync(command, args, { stdio: 'ignore', timeout: 10_000 }); return 0 }
  catch (error) { assert(Number.isInteger(error.status)); return error.status }
}
for (const label of labels) assert(commandStatus('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`]) !== 0)
const env = { ...process.env, AGENTSDOCK_DISABLE_ANALYTICS: '1',
  UV_CACHE_DIR: join(work, 'uv-cache'), npm_config_cache: join(work, 'npm-cache') }
async function run(command, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout ?? 1_200_000)
    child.stdout.on('data', chunk => { privateLog.write(chunk); if (output.length < 8 * 1024 ** 2) output += chunk })
    child.stderr.on('data', chunk => privateLog.write(chunk))
    child.on('error', () => { clearTimeout(timer); reject(new Error('Native command launch failed; output withheld.')) })
    child.on('close', code => {
      clearTimeout(timer)
      code === 0 ? resolveResult(output) : reject(new Error(`Native ${command.split('/').at(-1)} failed (${code}); private output withheld.`))
    })
    child.stdin.end(options.input)
  })
}
const pins = JSON.parse(await readFile(new URL('./public-server-upgrade-pins.json', import.meta.url), 'utf8'))
const publicKey = await readFile(new URL('../server/release-public-key.pem', import.meta.url))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const report = { kind: 'public-native-server-upgrade', baseline, phases: [], checks: {},
  untested: ['live provider response/history', 'active provider and queued user work',
    'activation rollback', 'logout/reboot', 'Windows/Linux desktop', 'desktop binary auto-replacement'] }
const phase = name => { report.phases.push(name); process.stdout.write(`phase ${name}\n`) }
async function download(url, path) {
  assert(url.startsWith('https://github.com/ZhengyiLuo/') || url.startsWith('https://registry.npmjs.org/@agentsdock/server/'))
  await run('/usr/bin/curl', ['--fail', '--location', '--retry', '3', '--max-time', '600', '--output', path, url])
}
async function descriptor(version, kind) {
  const prefix = kind === 'legacy' ? 'agents-server-manifest' : 'agents-server-npm-manifest'
  const repo = kind === 'legacy' ? 'AgentsServer' : 'AgentsDock'
  const dir = join(work, `${kind}-${version}`)
  await mkdir(dir)
  const base = `https://github.com/ZhengyiLuo/${repo}/releases/download/v${version}`
  for (const suffix of ['json', 'sig']) await download(`${base}/${prefix}.${suffix}`, join(dir, `${prefix}.${suffix}`))
  const bytes = await readFile(join(dir, `${prefix}.json`))
  const signature = await readFile(join(dir, `${prefix}.sig`))
  assert.equal(digest(bytes), pins[`${kind}:${version}`].manifestSha256, 'Descriptor differs from independent preflight.')
  assert(signature.length === 64 && verify(null, bytes, publicKey, signature), 'Release signature failed.')
  const manifest = JSON.parse(bytes)
  assert.equal(manifest.version, version)
  assert.equal(manifest.schema, kind === 'legacy' ? 1 : 2)
  const archive = join(dir, manifest.archive.name)
  await download(manifest.archive.url, archive)
  assert.equal((await readFile(archive)).length, manifest.archive.size)
  assert.equal(await hashFile(archive), manifest.archive.sha256)
  if (kind === 'npm') {
    assert.equal(manifest.distribution, 'npm')
    assert.equal(manifest.npm.version, version)
    assert.equal(`sha512-${createHash('sha512').update(await readFile(archive)).digest('base64')}`, manifest.npm.integrity)
  }
  return { archive, manifest, bytes, signature }
}
async function appPackage(version) {
  const archive = join(work, `AgentsDock-${version}-mac-universal.zip`)
  await download(`https://github.com/ZhengyiLuo/AgentsDock/releases/download/v${version}/AgentsDock-${version}-mac-universal.zip`, archive)
  assert.equal(await hashFile(archive), pins[`app:${version}`].sha256, 'Desktop differs from independent preflight.')
  const directory = join(work, `app-${version}`)
  await mkdir(directory)
  await run('/usr/bin/ditto', ['-x', '-k', archive, directory])
  const path = join(directory, 'AgentsDock.app')
  verifyApp(path, version)
  return path
}
let client, ownedApp, keychainCreated = false, token, savedId, identity, savedBefore
const acceptedPackages = new Map()
const profileId = `public-upgrade-${baseline}`
const account = `agent-access-token:${profileId}`
const keychainService = 'com.zhengyiluo.AgentsDock'
const port = await freePort()
const serverUrl = `http://127.0.0.1:${port}`
async function api(path, body) {
  return new Promise((resolveResponse, reject) => {
    const bytes = body === undefined ? undefined : JSON.stringify(body)
    const call = request(`${serverUrl}${path}`, { method: bytes === undefined ? 'GET' : 'POST',
      headers: { 'X-AgentsDock-Token': token ?? '', 'Content-Type': 'application/json',
        ...(bytes === undefined ? {} : { 'Content-Length': Buffer.byteLength(bytes) }) }, timeout: 5000 }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk; if (text.length > 4 * 1024 ** 2) call.destroy(new Error('Response exceeded bound.')) })
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) reject(new Error(`Fixture API HTTP ${response.statusCode}`))
        else { try { resolveResponse(JSON.parse(text)) } catch (error) { reject(error) } }
      })
    })
    call.on('timeout', () => call.destroy(new Error('Fixture API timeout.')))
    call.on('error', reject)
    call.end(bytes)
  })
}
const readToken = () => {
  const values = readFileSync(join(configRoot, 'env'), 'utf8').split(/\r?\n/)
    .filter(line => line.startsWith('AGENTSDOCK_AGENT_TOKEN=')).map(line => line.split('=').slice(1).join('='))
  assert(values.length === 1 && /^[A-Za-z0-9_-]{32,}$/.test(values[0]))
  return values[0]
}
async function service(action) {
  for (const label of action === 'stop' ? [...labels].reverse() : labels) {
    if (!existsSync(serviceFile(label))) continue
    await run('/bin/launchctl', action === 'stop'
      ? ['bootout', `gui/${process.getuid()}`, serviceFile(label)]
      : ['bootstrap', `gui/${process.getuid()}`, serviceFile(label)])
  }
}
// Forward TLS to the real public hosts, without terminating TLS or replacing
// payloads. Fault injection rejects only npm CONNECT; signed bytes remain real.
let failNpm = false
const connections = [], sockets = new Set()
const proxy = createServer((_req, res) => res.writeHead(405).end())
proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
proxy.on('connect', (req, socket, head) => {
  const host = req.url?.match(/^([A-Za-z0-9.-]+):443$/)?.[1]
  const allowed = ['registry.npmjs.org', 'github.com', 'api.github.com', 'pypi.org',
    'files.pythonhosted.org', 'nodejs.org'].includes(host) || host?.endsWith('.githubusercontent.com')
  if (!allowed) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
  const refused = host === 'registry.npmjs.org' && failNpm
  connections.push({ host, refused })
  if (refused) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return }
  const upstream = connectTcp(443, host)
  sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream))
  upstream.on('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.write(head); socket.pipe(upstream); upstream.pipe(socket) })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())
})
await new Promise(resolveReady => proxy.listen(0, '127.0.0.1', resolveReady))
const proxyEnvironment = { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: 'localhost,127.0.0.1' }
const safe = text => text?.slice(0, 400)
  .replace(/https?:\/\/\S+|\b[A-Za-z0-9_-]{28,}\b/g, '[redacted]')
  .replace(/(?:\/Users|\/home|\/Volumes|\/tmp)\/[^\s,;:)]+/g, '[path]')
async function status() {
  const update = await client?.evaluate('window.agentsDock?.updates.status()').catch(() => null)
  const server = await api('/api/admin/update').catch(() => null)
  const health = await api('/api/health').catch(() => null)
  return { appVersion: update?.currentVersion, records: update?.serverUpdates?.map(item => ({
    phase: item.phase, target: item.targetVersion, paused: item.paused, operationOwned: item.operationOwned, message: safe(item.message) })),
  server: server ? { phase: server.phase, version: server.current_version, target: server.target_version,
    errorCode: server.error_code, blockers: server.blocker_counts } : null,
  health: health ? { version: health.server_version, gateway: health.gateway?.version,
    execution: health.execution_service?.version, ready: health.chat_readiness?.ready } : null }
}
async function waitState(label, predicate, timeout = 12 * 60_000) {
  let previous = '', lastPrinted = 0
  const result = await until(label, async () => {
    const snapshot = await status(), encoded = JSON.stringify(snapshot)
    if (encoded !== previous && Date.now() - lastPrinted > 2000) {
      process.stdout.write(`state ${encoded}\n`); previous = encoded; lastPrinted = Date.now()
    }
    return predicate(snapshot) || snapshot.records?.some(item => ['failed', 'blocked'].includes(item.phase)) ? snapshot : null
  }, timeout)
  assert(predicate(result), `${label}: published App reported a terminal failure.`)
  return result
}
const profileDirectory = join(work, 'profile')
async function launchApp(app, track) {
  ownedApp = app
  await writeFile(join(profileDirectory, 'update-track'), `${track}\n`, { mode: 0o600 })
  const debugPort = await freePort()
  const child = spawn(join(app, 'Contents/MacOS/AgentsDock'), [`--remote-debugging-port=${debugPort}`],
    { env: { ...env, AGENTSDOCK_USER_DATA: profileDirectory }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => privateLog.write(chunk))
  child.stderr.on('data', chunk => privateLog.write(chunk))
  child.on('error', () => privateLog.write('Fixture App launch failed.\n'))
  client = await until('Published App renderer', () => connect(debugPort), 90_000)
}
async function preserve(version) {
  const health = await api('/api/health')
  assert.equal(health.server_version, version)
  assert.equal(health.server_identity, identity)
  assert.equal(readToken(), token)
  const saved = await api(`/api/sessions/${encodeURIComponent(savedId)}`)
  assert.equal(saved.session?.title, 'Public upgrade preservation fixture')
  assert.equal(saved.session?.cwd, join(work, 'chat-workspace'))
  for (const key of ['title', 'cwd', 'backend', 'auto_title_enabled']) {
    // Published 1.0.3 has no auto-title field. Its null projection in newer
    // schemas is an added default, not loss of a value the old server stored.
    if (key === 'auto_title_enabled' && savedBefore.session?.[key] === undefined
      && saved.session?.[key] === null) {
      report.checks.legacyAbsentAutoTitleProjectedAsNull = true
      continue
    }
    assert.deepEqual(saved.session?.[key], savedBefore.session?.[key], `Persisted session field changed: ${key}`)
  }
  assert.deepEqual(saved.events, savedBefore.events, 'Saved session events changed.')
  assert.equal((await readFile(join(installRoot, 'current/VERSION'), 'utf8')).trim(), version)
  const compared = await run('python3', ['-c', `
import pathlib,sys,tarfile
root=pathlib.Path(sys.argv[1]).resolve()
count=0
with tarfile.open(sys.argv[2]) as archive:
 for member in archive.getmembers():
  if not member.name.startswith("package/server/") or not member.isfile(): continue
  relative=pathlib.PurePosixPath(member.name).relative_to("package/server")
  assert ".." not in relative.parts
  installed=root / relative
  assert installed.is_file() and installed.resolve().is_relative_to(root)
  assert installed.read_bytes()==archive.extractfile(member).read(), "Installed package bytes differ: "+str(relative)
  count+=1
assert count>100
print(count)
`, join(installRoot, 'current'), acceptedPackages.get(version)])
  report.checks[`${version}:exactRuntimeFilesCompared`] = Number(compared.trim())
  report.checks[`${version}:identityTokenSavedSessionAndSettingsPreserved`] = true
}
async function closeApp() {
  try { client?.close() } catch {}
  client = null
  if (!ownedApp) return
  await stopOwned(ownedApp).catch(async () => {
    report.appExit = 'owned-app-required-force-close'
    for (const pid of processesFor(ownedApp)) process.kill(pid, 'SIGKILL')
    await until('Owned app force close', () => processesFor(ownedApp).length === 0)
  })
  ownedApp = null
}
try {
  const first = await descriptor(initialVersion, baseline === 'legacy103' ? 'legacy' : 'npm')
  const stable = await descriptor('1.0.10', 'npm'), beta = await descriptor('1.0.11-beta.2', 'npm')
  acceptedPackages.set('1.0.10', stable.archive)
  acceptedPackages.set('1.0.11-beta.2', beta.archive)
  const stableApp = await appPackage('1.0.10'), betaApp = await appPackage('1.0.11-beta.2')
  for (const [app, release] of [[stableApp, stable], [betaApp, beta]]) {
    assert((await readFile(join(app, 'Contents/Resources/coordinated-release/agents-server-npm-manifest.json'))).equals(release.bytes))
    assert((await readFile(join(app, 'Contents/Resources/coordinated-release/agents-server-npm-manifest.sig'))).equals(release.signature))
  }
  phase('public-signatures-hashes-and-app-descriptor-pins-verified')
  if (baseline === 'legacy103') {
    const unpacked = join(work, 'legacy-source')
    await mkdir(unpacked)
    await run('/usr/bin/tar', ['-xzf', first.archive, '-C', unpacked])
    await run('/bin/bash', [join(unpacked, `agents-server-${initialVersion}/install.sh`), '--release-version', initialVersion,
      '--bind', '127.0.0.1', '--port', String(port), '--non-interactive'])
  } else {
    const prefix = join(work, 'baseline-cli')
    await run('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', first.archive])
    await run('node', [join(prefix, 'node_modules/@agentsdock/server/npm/cli.cjs'),
      'install', '--bind', '127.0.0.1', '--port', String(port), '--non-interactive'])
  }
  token = readToken()
  const health = await until('Initial managed server healthy', async () => {
    const result = await api('/api/health')
    return result.server_version === initialVersion ? result : null
  })
  identity = health.server_identity
  assert(typeof identity === 'string' && identity.length > 8)
  report.checks.baselineNpmCapability = health.capabilities?.server_update_ensure_v1?.available === true
  await mkdir(join(work, 'chat-workspace'))
  const created = await api('/api/sessions', { backend: 'codex', cwd: join(work, 'chat-workspace'),
    title: 'Public upgrade preservation fixture', auto_title_enabled: false, import_history: false })
  savedId = created.session?.id
  assert(typeof savedId === 'string')
  savedBefore = await api(`/api/sessions/${encodeURIComponent(savedId)}`)
  report.checks.baselineAutoTitleValue = savedBefore.session?.auto_title_enabled ?? null
  report.checks.baselineEventCount = savedBefore.events?.length ?? 0
  phase('real-baseline-installed-and-session-created')
  await mkdir(profileDirectory, { mode: 0o700 })
  await writeFile(join(profileDirectory, 'settings.json'), JSON.stringify({ schemaVersion: 2, activeProfileId: profileId,
    profiles: [{ id: profileId, name: 'Disposable public upgrade', serverUrl, serverIdentity: identity,
      keychainAccessToken: true, serverSetupComplete: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }), { mode: 0o600 })
  await writeFile(join(profileDirectory, 'app-language.json'), '{"preference":"en"}\n', { mode: 0o600 })
  assert.equal(commandStatus('/usr/bin/security', ['find-generic-password', '-s', keychainService, '-a', account]), 44)
  await run('/usr/bin/security', ['-i'], { input: `add-generic-password -s ${keychainService} -a ${account} -w ${token}\n` })
  keychainCreated = true
  await service('stop')
  for (const [key, value] of Object.entries(proxyEnvironment)) {
    await run('/bin/launchctl', ['setenv', key, value]); env[key] = value
  }
  await launchApp(stableApp, 'stable')
  await waitState('App records offline server', state => state.records?.some(item => item.phase === 'offline'), 90_000)
  report.checks.offlineIntentRecorded = true
  phase('offline-intent-observed-in-published-app')
  await service('start')
  await waitState('Reconnected baseline upgraded to stable', state =>
    state.health?.version === '1.0.10' && state.records?.some(item => item.phase === 'current'))
  await preserve('1.0.10')
  report.checks.stableDownloadHosts = [...new Set(connections.filter(item => !item.refused).map(item => item.host))]
  report.checks.offlineReconnectAutomatic = true
  phase('stable-upgrade-through-real-app-completed')
  await openMigrationUpdateSettings(client)
  assert(await client.evaluate('!!document.querySelector(".coordinated-server-update-row")'), 'Paired status not rendered.')
  await closeApp()
  connections.length = 0
  failNpm = true
  await launchApp(betaApp, 'beta')
  await waitState('Npm download fails without replacing incumbent', state =>
    state.records?.some(item => item.phase === 'failed' || item.phase === 'blocked'), 5 * 60_000)
  assert(connections.some(item => item.host === 'registry.npmjs.org' && item.refused), 'Expected registry fault not observed.')
  await preserve('1.0.10')
  report.checks.failedDownloadPreservedIncumbent = true
  phase('registry-failure-preserved-stable-server')
  failNpm = false
  await openMigrationUpdateSettings(client)
  await client.clickButton(['Retry server update'])
  await waitState('UI retry installs beta npm release', state =>
    state.health?.version === '1.0.11-beta.2' && state.records?.some(item => item.phase === 'current'))
  await preserve('1.0.11-beta.2')
  assert(connections.some(item => item.host === 'registry.npmjs.org' && !item.refused))
  report.checks.betaNpmDownloadObserved = true
  report.checks.retryFromRealApp = true
  report.checks.stableToBetaChannelSwitch = true
  phase('beta-npm-upgrade-after-ui-retry-completed')
  report.status = 'passed-scoped-checks'
} catch (error) {
  report.status = 'failed'
  report.failure = safe(error.message)
  report.finalState = await status().catch(() => null)
  process.exitCode = 1
} finally {
  await closeApp().catch(() => { report.appExit = 'owned-app-cleanup-failed' })
  if (keychainCreated) await run('/usr/bin/security', ['delete-generic-password', '-s', keychainService, '-a', account]).catch(() => {})
  for (const key of Object.keys(proxyEnvironment)) await run('/bin/launchctl', ['unsetenv', key]).catch(() => {})
  for (const socket of sockets) socket.destroy()
  proxy.close()
  privateLog.end()
  process.stdout.write(`PUBLIC_ACCEPTANCE ${JSON.stringify(report)}\n`)
}
