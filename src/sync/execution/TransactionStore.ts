import { PreviewError } from '../../errors';
import { decodeBytes, encodeBytes } from '../../github/GitHubWriter';
import { gitBlobSha } from '../../vault/HashService';
import { assertPath, portablePathIssue } from '../../vault/paths';
import { isRecord, isSha, parseManifest } from '../manifest/ManifestValidator';
import type { SyncManifest } from '../manifest/ManifestSchema';
import type { PreviewOptions } from '../PreviewService';
import { parseLocalState } from '../state/LocalStateStore';
import type { LocalSyncState } from '../state/LocalSyncState';
import type { SyncVault } from './SyncVault';
import type { Observation } from '../../product/ProductStore';
import type { PublishEvent } from '../../github/GitHubWriter';

export interface SyncTransaction {
  version: 1; id: string; options: PreviewOptions; originalState: LocalSyncState; scopeKey: string;
  originalHead: string; commit: string; manifest: SyncManifest;
  before: Record<string, string>; after: Record<string, string>;
  adoptionChoice?: 'local' | 'remote'; backupRef?: string;
  observation?: Observation; createdAt?: string;
  // Optional local diagnostic evidence, never publication authority or planner input.
  publication?: { treeSha: string; events: PublishEvent[] };
  // Local audit only; original publication, Manifest and phase remain evidence.
  legacyRecovery?: { action: 'RECOVER_TO_CURRENT_HEAD' | 'START_FRESH_PREVIEW'; head: string; generation: number; timestamp: string; differences: string[] };
  // Identity exclusions survive option changes until this transaction is finished.
  excludedPaths: string[]; phase: 'prepared' | 'published' | 'applying' | 'verified' | 'complete';
}
const ROOT = '.local-mirror-sync/transactions';
export const sameTransactionTarget = (a: Pick<PreviewOptions, 'owner' | 'repository' | 'branch'>, b: Pick<PreviewOptions, 'owner' | 'repository' | 'branch'>) => a.owner.toLowerCase() === b.owner.toLowerCase() && a.repository.toLowerCase() === b.repository.toLowerCase() && a.branch === b.branch;
export const recoveryError = () => new PreviewError('RECOVERY', 'RECOVERY_REQUIRED', 'A pending or damaged transaction needs recovery. No new sync can start. Recovery files remain in .local-mirror-sync/transactions.');
export const recoveryEnvironmentChanged = () => new PreviewError('RECOVERY', 'RECOVERY_ENV_CHANGED', 'Recovery environment changed or could not be verified. Review the transaction and run a fresh Preview. Pending recovery remains blocked until it can be safely resumed or aborted.');
function unpack(raw: string | null): unknown {
  if (!raw) throw recoveryError();
  const envelope: unknown = JSON.parse(raw);
  if (!isRecord(envelope) || typeof envelope.payload !== 'string' || gitBlobSha(new TextEncoder().encode(envelope.payload)) !== envelope.sha) throw recoveryError();
  return JSON.parse(envelope.payload);
}
export class TransactionStore {
  constructor(private readonly vault: SyncVault) {}
  directory(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw recoveryError(); return `${ROOT}/${id}`; }
  async active(): Promise<SyncTransaction | null> {
    const pointer = await this.vault.readInternal(`${ROOT}/active.json`);
    if (pointer === null || pointer === 'null') return null;
    try {
      const id: unknown = JSON.parse(pointer); if (typeof id !== 'string') throw recoveryError();
      let decoded: unknown;
      try { decoded = unpack(await this.vault.readInternal(`${this.directory(id)}/journal.json`)); }
      catch { decoded = unpack(await this.vault.readInternal(`${this.directory(id)}/journal-copy.json`)); }
      const transaction = decoded as SyncTransaction;
      if (transaction.version !== 1 || transaction.id !== id || !isSha(transaction.originalHead) || !isSha(transaction.commit)
        || !['prepared', 'published', 'applying', 'verified', 'complete'].includes(transaction.phase)) throw recoveryError();
      parseLocalState(transaction.originalState); parseManifest(transaction.manifest);
      const recovery = transaction.legacyRecovery;
      if (recovery && (!['RECOVER_TO_CURRENT_HEAD', 'START_FRESH_PREVIEW'].includes(recovery.action) || !isSha(recovery.head)
        || !Number.isSafeInteger(recovery.generation) || recovery.generation < transaction.manifest.generation
        || !Number.isFinite(Date.parse(recovery.timestamp)) || !Array.isArray(recovery.differences) || recovery.differences.some(d => typeof d !== 'string'))) throw recoveryError();
      if (transaction.adoptionChoice !== undefined && (!['local', 'remote'].includes(transaction.adoptionChoice)
        || transaction.originalState.baseManifest || transaction.manifest.generation !== 1
        || transaction.backupRef !== `refs/heads/local-mirror-sync-backup/${id}`)) throw recoveryError();
      if (typeof transaction.scopeKey !== 'string' || !isRecord(transaction.options) || !Array.isArray(transaction.excludedPaths)) throw recoveryError();
      const scope: unknown = JSON.parse(transaction.scopeKey);
      if (!isRecord(scope) || typeof scope.gitignore !== 'string' || typeof scope.configDir !== 'string'
        || scope.patterns !== transaction.options.ignorePatterns || scope.includeObsidian !== transaction.options.includeObsidian) throw recoveryError();
      for (const path of transaction.excludedPaths) assertPath(path);
      for (const map of [transaction.before, transaction.after]) {
        if (!isRecord(map)) throw recoveryError();
        for (const [path, sha] of Object.entries(map)) { assertPath(path); if (portablePathIssue(path) || !isSha(sha) || path.startsWith('.local-mirror-sync/')) throw recoveryError(); }
      }
      return transaction;
    } catch { throw recoveryError(); }
  }
  async save(t: SyncTransaction): Promise<void> {
    const payload = JSON.stringify(t);
    const envelope = JSON.stringify({ sha: gitBlobSha(new TextEncoder().encode(payload)), payload });
    // Both copies must be read back before publication can begin. A torn later
    // checkpoint can recover the already-durable candidate commit from either copy.
    await this.write(`${this.directory(t.id)}/journal.json`, envelope);
    await this.write(`${this.directory(t.id)}/journal-copy.json`, envelope);
  }
  async begin(t: SyncTransaction) { if (await this.active()) throw recoveryError(); await this.save(t); await this.write(`${ROOT}/active.json`, JSON.stringify(t.id)); }
  async clear() { await this.write(`${ROOT}/active.json`, 'null'); }
  async removePending() {
    await this.vault.removeInternal(`${ROOT}/active.json`);
    if (await this.vault.readInternal(`${ROOT}/active.json`) !== null) throw recoveryError();
  }
  async putBlob(id: string, bytes: Uint8Array) {
    this.directory(id);
    const sha = gitBlobSha(bytes); const path = `${ROOT}/objects/blobs/${sha}`;
    if (await this.vault.readInternal(path) !== null) { await this.blob(id, sha); return sha; }
    await this.write(path, encodeBytes(bytes)); return sha;
  }
  async blob(id: string, sha: string): Promise<Uint8Array> {
    if (!isSha(sha)) throw recoveryError();
    this.directory(id);
    const text = await this.vault.readInternal(`${ROOT}/objects/blobs/${sha}`);
    try { if (text === null) throw recoveryError(); const bytes = decodeBytes(text); if (gitBlobSha(bytes) !== sha) throw recoveryError(); return bytes; }
    catch { throw recoveryError(); }
  }
  private async write(path: string, contents: string) {
    await this.vault.writeInternal(path, contents);
    if (await this.vault.readInternal(path) !== contents) throw recoveryError();
  }
}
