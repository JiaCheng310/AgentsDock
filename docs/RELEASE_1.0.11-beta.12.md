# AgentsDock 1.0.11-beta.12

Desktop build 1267, with the matching npm server, `agentsdock` CLI and signed
legacy server bridge on the beta channel. Product source is
`ab95ad3284f91997c2b249ac413b155f99c09ce6`.

## Changes since 1.0.11-beta.2

- Keep normal user prompts and assistant replies visible in history pages
  containing many repair records.
- Fix Claude running-chat forks when native reply timestamps include
  milliseconds, preserving the existing conversation context and parent task.
- Add terminal pairing QR output and improve cross-device server address
  selection and connection recovery.
- Group desktop chats into Unread and Running sections while preserving saved
  folders and pins.
- Expose Codex goal status and its update time in server summaries for matching
  mobile notification clients.
- Extend privacy-limited desktop and shared-chat usage reporting.

Mobile Chinese-language, media and notification UI changes have their own mobile
release process. This desktop/server release includes no mobile package.
The later main fix in #108 for same-thread Codex model-switch compaction recovery
is not included in this release.

## Validation and remaining scope

Full source CI and four-platform package verification passed, including Mac
Developer ID signing and Apple notarization. Native npm installation/lifecycle
checks passed on macOS and Linux. Scoped Mac update/recovery and Linux rollback
rehearsals passed against these exact signed packages; see the
[development log](DEV_LOG.md#2026-10-21--prepare-signed-1011-beta12-packages)
for workflow evidence.

The scoped reports retain `releaseAcceptance: false`. Populated native provider
history migration remains blocked by fixture coverage. Busy/queued provider
work, logout/reboot survival, the native Windows updater and TF191 notification
compatibility remain unverified. Interactive pairing and optional dependency
prompts are outside the native CLI lifecycle check. Windows installers are
unsigned and may display security warnings.

Stable releases and npm `latest` remain unchanged. Reinstalling the CLI
alone does not update an existing server; installed servers use the signed
managed-update path.
