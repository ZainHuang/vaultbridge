# VaultBridge security and data boundaries

## Credentials and disclosure

Use a private GitHub repository for notes and a fine-grained token limited to that repository with Contents read/write. Store it in VaultBridge Settings on each device. Obsidian SecretStorage is preferred; when unavailable, explicit saving uses local plugin `data.json`. This fallback is not encrypted by VaultBridge. Both the plugin directory and its state are hard-excluded from synchronization.

Do not post tokens, private notes, raw transaction journals, `data.json` or complete diagnostic logs in public issues. If a token is exposed, revoke it in GitHub and save a replacement on the affected device. Public bug reports should use synthetic files and redacted error codes. For a vulnerability, use the repository's **Security → Report a vulnerability** private reporting channel when available; do not disclose an exploit or private data in an issue.

## What leaves the device

The runtime sends HTTPS requests directly to `api.github.com` for the selected repository/branch. Eligible Vault files, the generated Manifest and advisory device reports are published. Device reports include device identity/name/type and sync metadata; use a non-sensitive device name. Notes stored on GitHub are not end-to-end encrypted by this plugin. Repository access controls still apply.

Local settings, BASE, Recovery transactions, quarantine and `.sync-history/` are excluded from file mirroring even with negated ignore rules. The generated remote Manifest/device reports are explicitly committed protocol data, not uploads of the local Recovery tree. Journals contain target/scope and recovery bytes, never the Token. Recovery copies contain real user content and must be protected like the Vault.

## Synchronization guarantees and limits

Preview and the standalone Verify command are read-only. Only execution of a service-owned reviewed plan authorizes mutations. The executor checks current local content, ignore scope, device state and remote HEAD again before acting.

File content and Manifest are published in one commit on the reviewed parent. Branch updates use `force:false`; no Git pull/merge, forced overwrite or last-writer-wins protocol is used. HTTP/auth/rate-limit errors are never treated as an empty repository. Blob encoding, size and Git blob SHA are checked.

BASE advances only after verification and state serialization/read-back. Stable IDs are not inserted into frontmatter. Deletion requires BASE/identity/tombstone evidence; uncertain identities and path collisions block. Supported conflicts require explicit per-file choices. Legacy Adoption additionally requires a typed authority choice and a verified backup ref before mutation.

Transactions retain verified journals and content-addressed recovery copies. Destructive local operations quarantine original bytes. Markdown writes use Obsidian `Vault.process` with a content-hash precondition. This is a recoverable protocol, not a cross-filesystem distributed atomic transaction. Independent backups are still necessary.

After interruption, Resume revalidates transaction and environment. A lost publication response is recovered by proving the fixed candidate, not creating another business commit. Published recovery with no local apply may establish the verified published BASE while retaining later Local edits for the next Preview. Transactions with local writes must pass Local verification. Legacy transactions have a separate ancestry/current-state verification path; divergence or invalid history blocks.

Abort only removes the active pointer for a still-prepared, unpublished transaction with unchanged remote HEAD. It preserves Vault files, BASE, remote branch, journals, blobs and backup refs. Do not delete Recovery to bypass a guard.

## Operational limits

Auto Sync defaults OFF and requires manual review for risky or uncertain plans. It is event-driven and does not poll GitHub or guarantee mobile background execution. Dashboard/History are local caches, not real-time remote health monitors.

Individual synced files are limited to 20 MiB, Manifest to 2 MiB, and recovery ancestry checks to 500 commits. Unsupported or non-portable paths, symlinks and submodules block. Recovery objects and tombstones are not automatically garbage-collected. Do not run another writer/sync engine against the same Vault or edit GitHub files outside the Manifest protocol.

## Release and validation boundary

The public repository contains source, synthetic test generators and maintained docs. Private operational scripts/reports, real Vaults, credentials, Recovery and test profiles are excluded. Releases contain the three plugin files and an installation archive; bundled third-party licenses are retained.

The bundle uses Obsidian as its only external runtime dependency and rejects Node-only APIs. Automated validation includes unit/property tests, isolated Windows Obsidian with an HTTP fixture and mobile emulation. Physical iPhone/Android and real multi-device private-repository sync are separate acceptance work; publishing this source repository is not proof of those tests. See [validation](docs/validation.md) and [upgrade compatibility](docs/compatibility.md).
