import { PreviewError } from '../../errors';
import type { DeviceStateStorage } from '../../state/StateStore';
import { isCounter, isRecord, isSha, parseManifest, validFileMetadata } from '../manifest/ManifestValidator';
import type { LocalSyncState } from './LocalSyncState';
import { renamedPath } from '../identity/SyncDomain';
import { validateTarget } from '../../github/GitHubClient';

export const LOCAL_SYNC_STATE_FILENAME = 'sync-state.json';
export function parseLocalState(input: unknown): LocalSyncState {
  try {
    const value: unknown = typeof input === 'string' ? JSON.parse(input) : input;
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.deviceId !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.deviceId)) throw new Error();
    const base = value.baseManifest === undefined ? undefined : parseManifest(value.baseManifest);
    if (value.target !== undefined) {
      if (!isRecord(value.target) || !['owner', 'repository', 'branch'].every(key => typeof (value.target as Record<string, unknown>)[key] === 'string')) throw new Error();
      validateTarget(value.target as unknown as NonNullable<LocalSyncState['target']>);
    }
    if (value.lastSeenGeneration !== undefined && !isCounter(value.lastSeenGeneration)) throw new Error();
    if (value.syncScope !== undefined && typeof value.syncScope !== 'string') throw new Error();
    if (base && value.lastSeenGeneration !== undefined && value.lastSeenGeneration !== base.generation) throw new Error();
    if (value.baseRemoteCommit !== undefined && !isSha(value.baseRemoteCommit)) throw new Error();
    if (value.lastSuccessfulSyncAt !== undefined && (typeof value.lastSuccessfulSyncAt !== 'string' || !Number.isFinite(Date.parse(value.lastSuccessfulSyncAt)))) throw new Error();
    if (value.localFiles !== undefined) {
      if (!isRecord(value.localFiles)) throw new Error();
      const paths = new Set<string>();
      for (const [id, entry] of Object.entries(value.localFiles)) {
        if (!isRecord(entry) || !validFileMetadata(entry, true) || entry.fileId !== id) throw new Error();
        if (!entry.deleted && paths.has(entry.path as string)) throw new Error();
        if (!entry.deleted) paths.add(entry.path as string);
      }
    }
    return structuredClone(value) as unknown as LocalSyncState;
  } catch { throw new PreviewError('LOCAL_STATE', 'LOCAL_STATE_INVALID', 'Local sync state is corrupt. Preserve and review it before Preview; it has not been reset.'); }
}

export class LocalStateStore {
  private state?: LocalSyncState;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: DeviceStateStorage) {}
  async load(): Promise<LocalSyncState> {
    this.state = undefined;
    let contents: string | null;
    try { contents = await this.storage.read(); }
    catch { throw new PreviewError('LOCAL_STATE', 'LOCAL_STATE_READ_FAILED', 'Local sync state cannot be read.'); }
    if (contents === null) return this.save({ schemaVersion: 1, deviceId: crypto.randomUUID() });
    this.state = parseLocalState(contents);
    return this.current();
  }
  current(): LocalSyncState {
    if (!this.state) throw new PreviewError('LOCAL_STATE', 'LOCAL_STATE_UNAVAILABLE', 'Local sync state is unavailable.');
    return structuredClone(this.state);
  }
  /** Metadata storage only. Preview never calls this to establish or advance BASE. */
  save(state: LocalSyncState): Promise<LocalSyncState> {
    const next = parseLocalState(state);
    return this.update(() => next);
  }
  recordRename(oldPath: string, path: string): Promise<LocalSyncState> {
    return this.update(() => {
      const current = this.current();
      const localFiles = { ...current.baseManifest?.files, ...current.localFiles };
      for (const [id, entry] of Object.entries(localFiles)) {
        if (entry.deleted) continue;
        const destination = renamedPath(entry.path, { oldPath, path });
        if (destination !== entry.path) localFiles[id] = { ...entry, path: destination };
      }
      return { ...current, localFiles };
    });
  }
  recordDelete(path: string): Promise<LocalSyncState> {
    return this.update(() => {
      const current = this.current();
      const localFiles = { ...current.baseManifest?.files, ...current.localFiles };
      for (const [id, entry] of Object.entries(localFiles)) if (!entry.deleted && (entry.path === path || entry.path.startsWith(`${path}/`))) localFiles[id] = { ...entry, deleted: true };
      return { ...current, localFiles };
    });
  }
  recordCreate(path: string): Promise<LocalSyncState> {
    return this.update(() => {
      const current = this.current();
      const localFiles = { ...current.baseManifest?.files, ...current.localFiles };
      const entries = Object.values(localFiles);
      if (entries.some(e => e.deleted && e.path === path) && !entries.some(e => !e.deleted && e.path === path)) {
        const fileId = crypto.randomUUID(); localFiles[fileId] = { fileId, path, deleted: false };
      }
      return { ...current, localFiles };
    });
  }
  private update(mutate: () => LocalSyncState): Promise<LocalSyncState> {
    const pending = this.queue.then(async () => {
      try {
        const next = parseLocalState(mutate());
        const contents = JSON.stringify(next, null, 2);
        await this.storage.write(contents);
        if (await this.storage.read() !== contents) throw new Error();
        this.state = next;
        return this.current();
      } catch {
        this.state = undefined;
        throw new PreviewError('LOCAL_STATE', 'LOCAL_STATE_SAVE_FAILED', 'Local sync state could not be saved and verified. Preview is blocked.');
      }
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
}
