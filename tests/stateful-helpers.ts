import { IgnoreService } from '../src/vault/IgnoreService';
import type { ManifestFileEntry, SyncManifest } from '../src/sync/manifest/ManifestSchema';
export const version = (hash = 'a', path = 'A.md', deleted = false, fileId = 'id-1'): ManifestFileEntry => ({
  fileId, path, blobSha: hash.repeat(40), deleted, revision: 1,
});
export const manifestOf = (...entries: ManifestFileEntry[]): SyncManifest => ({ schemaVersion: 1, generation: 1,
  files: Object.fromEntries(entries.map(entry => [entry.fileId, entry])) });
export const ignore = new IgnoreService({ includeObsidian: false, configDir: '.obsidian', gitignore: '', patterns: '' });

