# VaultBridge changelog

## 1.1.10 — Blocked-plan diagnostics and mobile confirmation

- Repository-level blocked previews show diagnostics and review/repair guidance, with Sync disabled and no synthetic operation counts or deletion confirmation.
- Deletion impact and confirmation are available only for executable plans above the configured threshold.
- Explicit maintenance supports exactly reviewed additive Manifest registrations with new identities, verified backup refs, unchanged user Trees and candidate verification before publication. Preview never repairs a Manifest automatically.
- Mobile confirmation dialogs adapt to the keyboard-visible viewport and native keyboard height, scroll the focused field/actions into view, and respect safe areas.
- Three-way resolution, existing stable identities and tombstones retain their existing semantics.

## 1.1.9 — First public VaultBridge release

- Renamed the display name, settings, Preview, Dashboard, command prefix, activity labels, commit messages and distribution metadata to VaultBridge.
- Kept Obsidian plugin ID `local-mirror-sync`, existing command/view IDs, SecretStorage references, state paths, Manifest and Recovery formats. No ID or data migration.
- Published user installation/setup/recovery documentation, MIT license, reproducible build instructions, public-file audit and CI.
- Includes Stateful BASE / LOCAL / REMOTE Three-Way Sync, stable file identity, tombstone deletion and rename propagation, conflict protection, initialization/adoption, verified GitHub publication and Recovery.
- Includes safe event-driven Auto Sync (default OFF), cached Dashboard, local Sync History, device reports and activity status.
- Retains the existing stable 1.1.9 Dashboard refresh fix and all prior sync/recovery behavior. The rename does not change synchronization semantics or increment the version.

Release assets: `main.js`, `manifest.json`, `styles.css`, `vaultbridge-1.1.9.zip`, `SHA256SUMS.txt`.
