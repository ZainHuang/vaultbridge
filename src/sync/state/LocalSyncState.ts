import type { RepositoryTarget } from '../../github/types';
import type { SyncManifest } from '../manifest/ManifestSchema';
export interface LocalFileState {
  fileId: string;
  path: string;
  blobSha?: string;
  deleted: boolean;
}
export interface LocalSyncState {
  schemaVersion: 1;
  deviceId: string;
  target?: RepositoryTarget;
  lastSeenGeneration?: number;
  baseRemoteCommit?: string;
  baseManifest?: SyncManifest;
  lastSuccessfulSyncAt?: string;
  localFiles?: Record<string, LocalFileState>;
  /** Ignore scope confirmed by the last verified transaction. Changes require union review. */
  syncScope?: string;
}
