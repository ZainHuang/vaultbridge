# VaultBridge upgrade compatibility

VaultBridge is the new display and distribution name of Local Mirror Sync. The first public release keeps the existing stable version, **1.1.9**. It does not migrate device data or change the synchronization protocol.

## Why the plugin ID stays `local-mirror-sync`

Obsidian uses the plugin ID to find the installation and plugin settings. The runtime also uses fixed paths and validates existing Recovery backup references. Changing only the manifest ID would split installation/settings identity from the original state. A fresh missing state file creates a new deviceId, so a cosmetic ID change is unsafe.

| Contract | Preserved value |
| --- | --- |
| Obsidian plugin ID and installation folder | `local-mirror-sync` |
| Settings / fallback token | `<configDir>/plugins/local-mirror-sync/data.json` |
| SecretStorage | Existing `secretName`; new keys retain the `local-mirror-sync-` prefix |
| deviceId, BASE, local identity metadata | `<configDir>/plugins/local-mirror-sync/sync-state.json` |
| Historical initialization metadata | Existing `device-state.json`, untouched |
| Dashboard / Auto Sync cache | `<configDir>/plugins/local-mirror-sync/product-state.json` |
| Local history | `.sync-history/` |
| Remote Manifest | `.local-mirror-sync/manifest.json` |
| Local Recovery journal, objects, quarantine | `.local-mirror-sync/transactions/` |
| Advisory remote device reports | `.local-mirror-sync/devices/` |
| Adoption backup refs | `refs/heads/local-mirror-sync-backup/<transaction-id>` |
| Command IDs / saved workspace view types | Original `local-mirror-sync:*` and `local-mirror-sync-*` identifiers |

Protected-path rules still exclude the plugin, tokens, state, local history and recovery content even under `!**`. Remote Manifest/device reports are explicitly generated protocol data; they are not copied from the local Recovery directory.

## Update an existing installation

Disable the plugin, replace only `main.js`, `manifest.json` and `styles.css` in the **existing** folder, then enable it. Do not uninstall, rename the folder, copy another device's metadata or delete pending Recovery. Existing command shortcuts and saved Dashboard views keep their IDs. The name shown in Settings and the command palette becomes VaultBridge.

No migration function runs. No Token, deviceId, BASE, Manifest or Recovery record is rewritten as part of branding. Internal historical class names are retained to keep the patch small.

## Regression coverage

`tests/branding-compatibility.test.ts` checks display/package metadata, SecretStorage and local fallback retention, BASE/device identity, readable Manifest and an interrupted transaction across a reload in both default and custom config directories. It verifies that Recovery still blocks new sync, preserves stored records, and resumes the same candidate.

`npm run test:obsidian:brand` additionally loads the production bundle in an isolated Windows Obsidian Vault, verifies visible branding and original command IDs, and confirms unchanged persisted settings and BASE after plugin reload. Other integration suites cover Recovery and mobile emulation. No test uses a personal Vault.
