export interface ManifestFileEntry {
  fileId: string;
  path: string;
  blobSha?: string;
  deleted: boolean;
  revision: number;
  lastChangedBy?: string;
  lastChangedAt?: string;
}
export interface SyncManifest {
  schemaVersion: 1;
  generation: number;
  /** Keyed by stable fileId, never by path. Tombstones are retained. */
  files: Record<string, ManifestFileEntry>;
}
export type BaseManifest = SyncManifest;
export type RemoteManifest = SyncManifest;
export const MANIFEST_PATH = '.local-mirror-sync/manifest.json';
