import { MANIFEST_PATH, type SyncManifest } from '../sync/manifest/ManifestSchema';
import { invalidManifest, isRecord, parseManifest } from '../sync/manifest/ManifestValidator';
import { gitBlobSha } from '../vault/HashService';
import type { GitHubClient } from './GitHubClient';
import type { RemoteSnapshot } from './types';
import { decodeBytes } from './BinaryCodec';
import { ManifestValidationError } from '../sync/manifest/ManifestDiagnostics';

export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
export class RemoteManifestReader {
  constructor(private readonly client: GitHubClient) {}
  async read(snapshot: RemoteSnapshot, signal?: AbortSignal): Promise<SyncManifest | null> {
    const matches = snapshot.entries.filter(entry => entry.path === MANIFEST_PATH);
    if (!matches.length) return null;
    const entry = matches[0]!;
    if (matches.length !== 1 || entry.type !== 'blob' || entry.mode !== '100644'
      || entry.size === undefined || entry.size > MAX_MANIFEST_BYTES) throw invalidManifest();
    // Read through the immutable tree SHA's blob, not a moving branch Contents URL.
    const data = await this.client.get(`blobs/${entry.sha}`, 'REMOTE_MANIFEST', signal);
    if (!isRecord(data) || data.sha !== entry.sha || data.size !== entry.size || data.encoding !== 'base64'
      || typeof data.content !== 'string' || data.content.length > MAX_MANIFEST_BYTES * 2) throw invalidManifest();
    try {
      const bytes = decodeBytes(data.content);
      if (bytes.length !== entry.size || gitBlobSha(bytes) !== entry.sha) throw invalidManifest();
      return parseManifest(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) { if (error instanceof ManifestValidationError) throw error; throw invalidManifest([{ kind: 'BLOB_INTEGRITY_FAILURE', path: MANIFEST_PATH, expectedSha: entry.sha, actualSha: null }]); }
  }
}
