# VaultBridge changelog

## 1.1.14 — Correct plugin author

- Obsidian plugin author is now shown as ZainHuang. Sync behavior and stored data are unchanged.

## 1.1.13 — Focused Preview and confirmation dialog

- Preview lists only Push, Pull and Conflict decisions, ten per page. Unchanged files remain in the plan for verification but are omitted from the displayed rows and category buttons.
- Clicking **Sync & Verify** now opens a separate dialog for exact `DELETE N` confirmation when the existing threshold requires it. Legacy **Adopt & Verify** collects its `USE LOCAL` / `USE REMOTE` phrase in the same way. Cancel leaves Preview intact and performs no sync.
- Dashboard no longer repeats recent History records at the bottom. The dedicated Sync History view and its button remain available.
- File decisions, deletion thresholds, BASE, Manifest, Recovery and Three-Way Sync semantics are unchanged.

## 1.1.12 — Old empty directory cleanup

- Sync now removes empty source directories after file moves/deletions, deepest first. Recorded old paths in completed local transaction journals also allow a subsequent zero-file-change Sync to clean leftovers from earlier versions.
- Cleanup moves empty directories into the transaction recovery area; it never recursively deletes them. Concurrent children are restored or retained in recovery, and cleanup errors prevent success/BASE finalization.
- Unrelated empty directories, hidden/internal directories, ignored or excluded paths, and directories with any remaining children are preserved. Missing or damaged history does not authorize broad empty-folder deletion.
- File identity, three-way resolution, Manifest format and file verification are unchanged. Preview and standalone Verify remain read-only.

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
