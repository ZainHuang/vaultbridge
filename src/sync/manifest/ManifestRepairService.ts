import { PreviewError } from '../../errors';
import type { GitHubWriter } from '../../github/GitHubWriter';
import { RemoteManifestReader } from '../../github/RemoteManifestReader';
import { RemoteTreeReader } from '../../github/RemoteTreeReader';
import type { RemoteSnapshot } from '../../github/types';
import type { IgnoreService } from '../../vault/IgnoreService';
import { validateManifestHistory, validateManifestTree } from './ManifestConsistency';
import { MANIFEST_PATH, type SyncManifest } from './ManifestSchema';
import { parseManifest, isSha } from './ManifestValidator';
import { auditRemoteManifest, manifestCommitParents, type ManifestAudit } from './RemoteManifestAudit';

interface RepairJournal {
  version: 1; id: string; originalHead: string; originalTree: string; backupRef: string;
  manifest: SyncManifest; phase: 'prepared' | 'candidate' | 'verified'; candidate?: string;
}
const fail = (code: string, message: string) => new PreviewError('MANIFEST_REPAIR', code, message);
const fileMap = (snapshot: RemoteSnapshot) => JSON.stringify(snapshot.entries.filter(e => e.type !== 'tree' && e.path !== MANIFEST_PATH)
  .map(e => [e.path, e.type, e.mode, e.sha, e.size]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

/** Explicit maintenance operation, never called by Preview/Auto Sync.
 * Only same-path blob drift is safe without a user identity decision. Retain
 * IDs/tombstones, derive content exclusively from the pinned Git Tree, and never
 * touch local notes or BASE. Missing/added/renamed paths remain blocked. */
export class ManifestRepairService {
  private busy = false;
  constructor(private readonly github: GitHubWriter, private readonly ignore: IgnoreService,
    private readonly journal: { read(): Promise<string | null>; write(text: string): Promise<void> }) {}
  private corrected(audit: ManifestAudit): SyncManifest {
    if (!audit.historyValid || !audit.diagnostics.length || audit.diagnostics.some(d => d.kind !== 'BLOB_SHA_MISMATCH')) {
      throw fail('MANIFEST_REPAIR_UNSAFE', 'Repair requires proven lineage and same-path blob drift only. Identity, scope and structural problems require explicit review.');
    }
    const next = structuredClone(audit.manifest); next.generation++;
    for (const issue of audit.diagnostics) {
      const entry = next.files[issue.fileId!]!;
      entry.blobSha = issue.actualSha!; entry.revision++;
    }
    parseManifest(next); validateManifestHistory(audit.manifest, next);
    validateManifestTree(next, audit.snapshot.entries.filter(e => e.type !== 'tree' && !this.ignore.reason(e.path)), p => !this.ignore.reason(p));
    return next;
  }
  private async save(value: RepairJournal) {
    const text = JSON.stringify(value); await this.journal.write(text);
    if (await this.journal.read() !== text) throw fail('REPAIR_JOURNAL_UNVERIFIED', 'Repair journal read-back failed. Retain all evidence; do not publish.');
  }
  private async verifyCandidate(t: RepairJournal, original: RemoteSnapshot) {
    if (!t.candidate) throw fail('REPAIR_JOURNAL_INVALID', 'No candidate commit is recorded.');
    await manifestCommitParents(this.github.reader, t.candidate, t.originalHead);
    const snapshot = await new RemoteTreeReader(this.github.reader).readCommit(t.candidate);
    const manifest = await new RemoteManifestReader(this.github.reader).read(snapshot);
    if (JSON.stringify(manifest) !== JSON.stringify(t.manifest) || fileMap(snapshot) !== fileMap(original)) {
      throw fail('REPAIR_VERIFY_FAILED', 'Candidate must change only the Manifest and preserve every other file SHA/mode.');
    }
    validateManifestTree(t.manifest, snapshot.entries.filter(e => e.type !== 'tree' && !this.ignore.reason(e.path)), p => !this.ignore.reason(p));
    await this.github.verifyBackup(t.backupRef, t.originalHead);
  }
  async repair(reviewedHead: string): Promise<{ head: string; backupRef: string; generation: number }> {
    if (this.busy) throw fail('BUSY', 'A Manifest repair is already running.'); this.busy = true;
    try {
      const saved = await this.journal.read();
      let t: RepairJournal | undefined;
      if (saved) {
        try {
          t = JSON.parse(saved) as RepairJournal;
          if (t.version !== 1 || t.originalHead !== reviewedHead || !isSha(t.originalHead) || !isSha(t.originalTree)
            || !/^[a-f0-9-]{36}$/.test(t.id) || t.backupRef !== `refs/heads/local-mirror-sync-backup/${t.id}`
            || !['prepared', 'candidate', 'verified'].includes(t.phase) || (t.phase !== 'prepared' && !isSha(t.candidate))) throw new Error();
          parseManifest(t.manifest);
        } catch { throw fail('REPAIR_JOURNAL_INVALID', 'Existing repair journal cannot be replaced or trusted. Preserve it for review.'); }
      }
      const head = await this.github.head();
      if (head !== reviewedHead && head !== t?.candidate) throw fail('REMOTE_HEAD_CHANGED', 'Remote HEAD differs from the reviewed repair state. No new repair will be published.');
      const audit = await auditRemoteManifest(this.github.reader, reviewedHead, this.ignore);
      const manifest = this.corrected(audit);
      if (t && (JSON.stringify(t.manifest) !== JSON.stringify(manifest) || t.originalTree !== audit.snapshot.treeSha)) {
        throw fail('REPAIR_JOURNAL_INVALID', 'Journal differs from the independently reconstructed repair.');
      }
      if (!t) {
        const id = crypto.randomUUID();
        t = { version: 1, id, originalHead: reviewedHead, originalTree: audit.snapshot.treeSha,
          backupRef: `refs/heads/local-mirror-sync-backup/${id}`, manifest, phase: 'prepared' };
        await this.save(t);
      }
      if (!t.candidate) {
        // An interrupted POST may already have created the immutable backup ref.
        try { await this.github.verifyBackup(t.backupRef, t.originalHead); }
        catch (error) {
          if (!(error instanceof PreviewError) || error.code !== 'HTTP_404') throw error;
          try { await this.github.backup(t.backupRef, t.originalHead); }
          catch (failure) { await this.github.verifyBackup(t.backupRef, t.originalHead).catch(() => { throw failure; }); }
        }
        if (await this.github.head() !== reviewedHead) throw fail('REMOTE_HEAD_CHANGED', 'Remote changed before candidate construction.');
        const sha = await this.github.upload(new TextEncoder().encode(JSON.stringify(manifest)));
        const tree = await this.github.create('trees', { base_tree: t.originalTree, tree: [{ path: MANIFEST_PATH, type: 'blob', mode: '100644', sha }] });
        t.candidate = await this.github.create('commits', { tree, parents: [t.originalHead], message: `VaultBridge Manifest repair generation ${manifest.generation} (preserve user tree)` });
        t.phase = 'candidate'; await this.save(t);
      }
      await this.verifyCandidate(t, audit.snapshot);
      const beforePublish = await this.github.head();
      if (beforePublish === t.originalHead) {
        try { await this.github.publish(t.candidate!, t.originalHead); }
        catch (error) { if (await this.github.head() !== t.candidate) throw error; }
      } else if (beforePublish !== t.candidate) throw fail('REMOTE_HEAD_CHANGED', 'Remote changed before publication. Retain repair evidence.');
      await this.verifyCandidate(t, audit.snapshot);
      const verified = await auditRemoteManifest(this.github.reader, t.candidate!, this.ignore);
      if (verified.diagnostics.length || !verified.historyValid || await this.github.head() !== t.candidate) {
        throw fail('REPAIR_VERIFY_FAILED', 'Current remote state did not pass full Manifest/tree/history verification. BASE remains unchanged.');
      }
      t.phase = 'verified'; await this.save(t);
      return { head: t.candidate!, backupRef: t.backupRef, generation: t.manifest.generation };
    } finally { this.busy = false; }
  }
}
