#!/usr/bin/env node
// Test-only exact-origin feed for a disposable GitHub-hosted macOS runner.
import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { createReadStream, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { join, relative } from 'node:path'

const [rootArgument, certificate, privateKey, pidFile] = process.argv.slice(2)
assert(process.platform === 'darwin' && process.env.GITHUB_ACTIONS === 'true'
  && process.env.RUNNER_ENVIRONMENT === 'github-hosted'
  && process.env.GITHUB_REPOSITORY === 'ZhengyiLuo/AgentsDock'
  && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
  && process.env.GITHUB_WORKFLOW_REF?.includes('/.github/workflows/ci.yml@refs/heads/test/recoverable-update-replay-20261017'),
  'The test feed runs only inside its disposable manual macOS CI job.')
assert(rootArgument && certificate && privateKey && pidFile && process.env.RUNNER_TEMP,
  'Exact candidate and temporary certificate paths are required.')
const runner = realpathSync(process.env.RUNNER_TEMP)
const root = realpathSync(rootArgument)
assert(relative(runner, root).startsWith('..') === false && root !== runner,
  'Candidate files must remain inside the disposable runner.')
const VERSIONS = Object.freeze({ a: '1.0.11-beta.2', b: '1.0.11-beta.3' })
const SOURCES = Object.freeze({ a: 'a5cadf72c125f1bd0a2c8c2ab2409ed4cfd5d8cd',
  b: '9ef456a8613b019fd30b4bd5d2aee61b69538b73' })
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const publicKey = createPublicKey(readFileSync(join(process.cwd(), 'server/release-public-key.pem')))
const assets = new Map()

for (const letter of ['a', 'b']) {
  const version = VERSIONS[letter]
  const directory = join(root, letter)
  const sums = new Map(readFileSync(join(directory, 'SHA256SUMS'), 'utf8').trimEnd().split('\n').map(line => {
    const match = /^([0-9a-f]{64})  ([^\r\n]+)$/.exec(line)
    assert(match, 'Malformed desktop checksum manifest.')
    return [match[2], match[1]]
  }))
  const manifest = readFileSync(join(directory, 'agents-server-npm-manifest.json'))
  const signature = readFileSync(join(directory, 'agents-server-npm-manifest.sig'))
  assert(signature.length === 64 && verify(null, manifest, publicKey, signature),
    'Server descriptor is not signed by the established key.')
  const descriptor = JSON.parse(manifest.toString('utf8'))
  assert(descriptor.version === version && descriptor.commit === SOURCES[letter]
    && descriptor.npm?.version === version && descriptor.track === 'beta',
  'Signed server descriptor does not match the frozen candidate.')
  for (const name of [`AgentsDock-${version}-mac-universal.zip`, `AgentsDock-${version}-mac-universal.zip.blockmap`,
    'beta-mac.yml', 'agents-server-npm-manifest.json', 'agents-server-npm-manifest.sig']) {
    const path = join(directory, name)
    const stat = statSync(path)
    assert(stat.isFile() && stat.size > 0 && stat.size < 2 * 1024 ** 3
      && digest(readFileSync(path)) === sums.get(name), `Candidate ${letter} asset differs from SHA256SUMS: ${name}`)
    assets.set(`/ZhengyiLuo/AgentsDock/releases/download/v${version}/${name}`, path)
  }
  const archive = join(directory, `server-${version}.tgz`)
  const archiveStat = statSync(archive)
  assert(archiveStat.isFile() && archiveStat.size === descriptor.archive.size
    && digest(readFileSync(archive)) === descriptor.archive.sha256,
  'Signed npm archive bytes differ from the descriptor.')
  assets.set(new URL(descriptor.archive.url).pathname, archive)
}

const atom = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>https://github.com/ZhengyiLuo/AgentsDock/releases</id><title>Disposable AgentsDock update replay</title><updated>2026-10-17T00:00:00Z</updated>${['b', 'a'].map(letter => {
  const version = VERSIONS[letter]
  return `<entry><id>https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v${version}</id><title>${version}</title><updated>2026-10-17T00:00:00Z</updated><link href="https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v${version}"/></entry>`
}).join('')}</feed>`

const server = createServer({ key: readFileSync(privateKey), cert: readFileSync(certificate), minVersion: 'TLSv1.2' }, (request, response) => {
  const host = request.headers.host?.replace(/:443$/, '')
  if (!['github.com', 'registry.npmjs.org'].includes(host) || request.socket.servername !== host
    || !['GET', 'HEAD'].includes(request.method) || !request.url || request.url.includes('?')) {
    response.writeHead(404, { 'Cache-Control': 'no-store' }).end()
    return
  }
  const headers = { 'Cache-Control': 'no-store', 'X-AgentsDock-Replay': 'test-only' }
  if (host === 'github.com' && request.url === '/ZhengyiLuo/AgentsDock/releases.atom') {
    response.writeHead(200, { ...headers, 'Content-Type': 'application/atom+xml', 'Content-Length': Buffer.byteLength(atom) })
    response.end(request.method === 'HEAD' ? undefined : atom)
    return
  }
  const path = assets.get(request.url)
  if (!path || (host === 'registry.npmjs.org') !== request.url.startsWith('/@agentsdock/server/')) {
    response.writeHead(404, headers).end()
    return
  }
  response.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': statSync(path).size })
  if (request.method === 'HEAD') response.end()
  else createReadStream(path).pipe(response)
})
server.headersTimeout = 10_000
server.requestTimeout = 60_000
server.listen(443, '127.0.0.1', () => {
  writeFileSync(pidFile, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
  process.stdout.write('ready\n')
})
