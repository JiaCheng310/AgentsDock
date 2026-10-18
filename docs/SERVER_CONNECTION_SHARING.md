# Server connection sharing

The desktop Show QR code button and its section heading are temporarily hidden
by a source comment. The QR component, IPC and CLI pairing implementation remain
in place; the QR behavior below describes the retained implementation.

Settings → Server provides explicit actions on each saved server, including
inactive or offline profiles:

- Preview the first four characters of a saved token with a masked suffix, then
  copy the full token with the button at the end of its row. Short tokens stay
  fully masked.
- Display a locally generated connection QR code and save it as a PNG.

No server upgrade or new HTTP endpoint is required. Token copying reads the
selected profile's credential in the desktop main process and returns no token
to the renderer. Expanding a card separately requests an asynchronous preview,
masked in the main process before IPC; collapsed cards do not read credentials.
The preview is discarded on collapse and refreshed after token edits. It is not
persisted or logged. Normal profile listing still exposes only credential presence.
QR pixels themselves contain the credential, remain in the open component's
memory, and are not written to settings, analytics or logs. Saving is an explicit
native file-picker action. Credential changes invalidate pending reads and
saved-image requests. A stored token may no longer be valid on the server;
copying it does not reauthenticate or rotate it.

The code contains the saved URL. Loopback and wildcard addresses produce an
explicit local-only warning. Users need a phone-reachable address and a server
that listens on that address; generating a QR does not change network binding,
firewall rules or Tailscale membership. This grants the access of the existing
operator token, rather than read-only access to an individual chat.

## Retained connection payload

The payload is `agentsdock://connect#` followed by URL-encoded fragment fields:

| Field | Meaning |
| --- | --- |
| `v` | Required format version, currently `1` |
| `url` | HTTP(S) server URL, without URL credentials, query or fragment |
| `token` | Saved server access token |
| `name` | Suggested display name |
| `identity` | Expected durable server identity, when already known |

The serializer and strict parser are in
`electron/src/shared/server-connection-link.ts`. Special characters and Unicode
must round-trip through URL encoding. Reject unsupported versions, duplicate or
unknown fields, empty tokens and oversized payloads. The size limit is 1,800
UTF-8 bytes for the complete link. Treat the whole link and QR image as secrets.

Mobile QR connection support has been removed for now, including camera scans,
QR-image import and connection-link handling. On mobile, use **Servers → Add
Server**, enter the URL and access token, and test the connection before saving.
The existing identity checks, secure token storage and terminal links remain.
The payload above describes the retained desktop/CLI implementation, not an
available mobile connection method.

## CLI

```sh
agentsdock pair                 # default instance, prefer Tailscale then LAN
agentsdock pair work
agentsdock pair work --network lan
agentsdock pair work --output connection.png
agentsdock pair work --link      # explicitly print the secret connection URL
agentsdock qrcode work           # alias
```

The command reads only the selected OS user's managed instance configuration,
reuses the instance manager's binding-aware address discovery, and authenticates
health at the selected address before encoding its identity and token. It prints
an address, sharing guidance and a terminal QR; `--output` instead saves a PNG
with owner-only permissions and refuses to overwrite an existing file. The QR
renderer is bundled with its third-party notices, preserving offline npm installs
and the exact single runtime dependency. Regenerate it with
`node scripts/build_cli_qr.mjs` after installing the locked desktop dependencies.

If several LAN addresses exist, the command asks you to select a listed address
with `--url http://192.168.1.20:7851`; it never guesses between a Wi-Fi interface
and a virtual-machine bridge. Arbitrary URLs are rejected.

`--network auto` is the default. `tailscale`, `lan`, and `local` choose a specific
network. Auto never falls back to localhost. `--network local` explicitly enables
same-computer/iOS-simulator testing and warns that a physical phone cannot use it.
A phone must share a reachable LAN or private Tailscale network; pairing does not
change the server bind, firewall, or Tailscale policy and does not start/restart a
service. This feature is available only in a package containing these changes;
it is not added to already-published npm versions.

## Acceptance

- Focused desktop service, IPC, preload, QR contract and component checks cover
  profile targeting, unchanged active selection, credential changes, rejected
  untrusted callers, missing credentials, save cancellation and stale saves.
- Native offscreen desktop interaction verified the copy action with the real
  macOS clipboard and authenticated health on a local test server, and verified
  displaying the QR plus the local-only warning.
- An independent macOS Vision decode of an image produced by the shared encoder
  recovered the expected URL/token and authenticated to that same test server.
  Automated service tests verify the saved PNG bytes with a mocked destination
  picker. This is not a mobile scan test.
- The computer-control policy blocked interacting with Electron's native save
  picker. Completing that picker, visual acceptance across both themes/narrow
  layouts, and real mobile import remain pending; do not report full acceptance.

Manual desktop check: copy tokens from two different profiles without switching
servers, confirm the matching credentials, open/close the QR, save/cancel the PNG
picker, reopen the app, and repeat. Use disposable connection profiles and keep
token-bearing screenshots and PNGs out of public reports.


Prior CLI/mobile verification (before mobile QR removal):

The mobile QR fixtures and integration described below were subsequently removed.
Current mobile checks cover manual connection and the absence of QR entry points.

- Packaged runtime + short CLI installed offline with lifecycle scripts disabled.
  The installed CLI rejected automatic localhost pairing; explicit local pairing
  generated a PNG whose independent Vision decode authenticated to the intended
  test server with the exact expected identity. No service restart was needed.
- CLI/package/instance tests cover address choice, omitted/invalid selectors,
  private output, failed authentication, symlink rejection, immutable PNG output,
  offline packaging and unchanged installation/lifecycle behavior.
- Mobile contract and component fixtures cover all three encoders, confirmation
  before network access, duplicate taps, QR image import, authentication failure,
  identity mismatch, cancellation and reuse of saved identities. Existing profile
  and setup checks also pass. Component native modules are mocked in these tests.
- Simulator UI operation is blocked by the computer-control policy. Actual app
  scanning/import, native SecureStore persistence across reopen, theme/layout,
  cold/warm deep-link presentation, and a physical phone over LAN/Tailscale remain
  manual acceptance requirements. Build success alone does not close those gaps.
- The iOS simulator Release build passed with camera permission and both URL
  schemes verified in the actual bundle. It was installed into an isolated
  simulator with a QR image fixture; it has not been launched or driven.
