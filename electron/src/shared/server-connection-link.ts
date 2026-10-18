/** Versioned pairing payload. Mobile clients must confirm and authenticate before saving it. */
export interface ServerConnectionDetails {
  serverUrl: string
  accessToken: string
  name: string
  serverIdentity: string | null
}

export interface ServerConnectionQr {
  dataUrl: string
  serverUrl: string
  localOnly: boolean
  revision: number
}

function checkedDetails(value: ServerConnectionDetails): ServerConnectionDetails {
  const url = new URL(value.serverUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS server address without embedded credentials.')
  }
  if (!value.accessToken || /[\x00-\x1f\x7f]/.test(value.accessToken)) throw new Error('Invalid access token.')
  return { ...value, serverUrl: url.toString().replace(/\/$/, '') }
}

export function serverConnectionLink(value: ServerConnectionDetails): string {
  const details = checkedDetails(value)
  const params = new URLSearchParams({ v: '1', url: details.serverUrl, token: details.accessToken, name: details.name })
  if (details.serverIdentity) params.set('identity', details.serverIdentity)
  const result = `agentsdock://connect#${params}`
  if (new TextEncoder().encode(result).length > 1800) throw new Error('Connection details are too long for a QR code.')
  return result
}

export function parseServerConnectionLink(value: string): ServerConnectionDetails {
  if (new TextEncoder().encode(value).length > 1800) throw new Error('Connection link is too long.')
  const link = new URL(value)
  if (link.protocol !== 'agentsdock:' || link.hostname !== 'connect' || link.pathname || link.search || link.username || link.password || link.port) {
    throw new Error('Invalid server connection link.')
  }
  const params = new URLSearchParams(link.hash.slice(1))
  for (const key of params.keys()) {
    if (!['v', 'url', 'token', 'name', 'identity'].includes(key) || params.getAll(key).length !== 1) throw new Error('Invalid connection field.')
  }
  if (params.get('v') !== '1') throw new Error('Unsupported connection link version.')
  return checkedDetails({ serverUrl: params.get('url') ?? '', accessToken: params.get('token') ?? '',
    name: params.get('name') ?? '', serverIdentity: params.get('identity') || null })
}

export function localOnlyServerUrl(value: string): boolean {
  const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.')
    || host === '0.0.0.0' || host === '::1' || host === '::' || host.startsWith('::ffff:7f')
}
