import type { GitHubClient } from '../../github/GitHubClient';
import { RemoteManifestReader } from '../../github/RemoteManifestReader';
import { RemoteTreeReader } from '../../github/RemoteTreeReader';
import type { RemoteSnapshot } from '../../github/types';
import type { IgnoreService } from '../../vault/IgnoreService';
import { validateManifestHistory, validateManifestTree } from './ManifestConsistency';
import { ManifestValidationError, type ManifestIssue } from './ManifestDiagnostics';
import { invalidManifest, isRecord, isSha } from './ManifestValidator';
import type { SyncManifest } from './ManifestSchema';

export async function manifestCommitParents(client: GitHubClient, head: string, expectedParent?: string): Promise<string[]> {
  const value = await client.get(`commits/${head}`, 'MANIFEST_HISTORY');
  if (!isRecord(value) || value.sha !== head || !Array.isArray(value.parents)
    || value.parents.some(p => !isRecord(p) || !isSha(p.sha))) {
    throw invalidManifest([{ kind: 'COMMIT_PARENT_MISMATCH', detail: `Invalid commit/parent envelope at ${head}` }]);
  }
  const parents = (value.parents as { sha: string }[]).map(p => p.sha);
  if (expectedParent !== undefined && (parents.length !== 1 || parents[0] !== expectedParent)) {
    throw invalidManifest([{ kind: 'COMMIT_PARENT_MISMATCH', expected: expectedParent, actual: parents.join(',') || null, detail: `Commit ${head}` }]);
  }
  return parents;
}
function collect(issues: ManifestIssue[], validate: () => void): void {
  try { validate(); } catch (error) {
    if (!(error instanceof ManifestValidationError)) throw error;
    issues.push(...error.diagnostics);
  }
}
export function manifestScopeIssues(manifest: SyncManifest, ignore: IgnoreService): ManifestIssue[] {
  return Object.values(manifest.files).flatMap(entry => {
    const reason = ignore.reason(entry.path);
    return reason ? [{ kind: ignore.protectedReason(entry.path) ? 'PROTECTED_PATH' as const : 'IGNORED_PATH' as const,
      path: entry.path, fileId: entry.fileId, detail: reason }] : [];
  });
}
export interface ManifestAudit {
  head: string; snapshot: RemoteSnapshot; manifest: SyncManifest; originCommit: string;
  historyValid: boolean; diagnostics: ManifestIssue[];
  lineage: { commit: string; parents: string[]; generation: number | null }[];
}
/** Maintenance diagnostic: GET only. No BASE assumptions and no mutation.
 * Walk to the introduction commit. An unchanged Manifest in an intermediate
 * external edit is evidence, not a new generation. The current Tree must match.
 * Merge ancestry is deliberately not guessed by the bounded repair workflow. */
export async function auditRemoteManifest(client: GitHubClient, head: string, ignore: IgnoreService): Promise<ManifestAudit> {
  const reader = new RemoteTreeReader(client); const manifests = new RemoteManifestReader(client);
  const nodes: { snapshot: RemoteSnapshot; manifest: SyncManifest | null; parents: string[] }[] = [];
  const seen = new Set<string>(); let sha: string | undefined = head;
  while (sha) {
    if (nodes.length >= 500 || seen.has(sha)) throw invalidManifest([{ kind: 'COMMIT_PARENT_MISMATCH', detail: 'History cycle or 500 commit limit reached' }]);
    seen.add(sha);
    const parents = await manifestCommitParents(client, sha);
    if (parents.length > 1) throw invalidManifest([{ kind: 'COMMIT_PARENT_MISMATCH', detail: `Merge ancestry at ${sha} needs explicit review` }]);
    const snapshot = await reader.readCommit(sha); const manifest = await manifests.read(snapshot);
    nodes.push({ snapshot, manifest, parents });
    if (!manifest) break;
    sha = parents[0];
  }
  const current = nodes[0]!;
  if (!current.manifest) throw invalidManifest([{ kind: 'SCHEMA_VALIDATION_FAILURE', detail: 'Current Manifest is missing' }]);
  const historyIssues: ManifestIssue[] = [];
  let origin = current;
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index]!; if (!node.manifest) continue;
    const previous = nodes[index + 1]?.manifest;
    if (!previous) {
      origin = node;
      if (node.manifest.generation !== 1 || Object.values(node.manifest.files).some(f => f.revision !== 1 || f.deleted)) {
        historyIssues.push({ kind: 'HISTORY_LINEAGE_MISMATCH', expected: 1, actual: node.manifest.generation, detail: `Invalid initial generation/revision at ${node.snapshot.remoteHeadSha}` });
      }
    } else {
      collect(historyIssues, () => validateManifestHistory(previous, node.manifest!));
      const changed = JSON.stringify(previous) !== JSON.stringify(node.manifest);
      if (changed && node.manifest.generation !== previous.generation + 1) historyIssues.push({ kind: 'HISTORY_LINEAGE_MISMATCH', expected: previous.generation + 1,
        actual: node.manifest.generation, detail: `Manifest changed at ${node.snapshot.remoteHeadSha}` });
    }
  }
  // Prove publication itself, separately from later external Tree changes.
  collect(historyIssues, () => validateManifestTree(origin.manifest!, origin.snapshot.entries.filter(f => f.type !== 'tree' && !ignore.reason(f.path)), p => !ignore.reason(p)));
  const diagnostics = [...historyIssues, ...manifestScopeIssues(current.manifest, ignore)];
  collect(diagnostics, () => validateManifestTree(current.manifest!, current.snapshot.entries.filter(f => f.type !== 'tree' && !ignore.reason(f.path)), p => !ignore.reason(p)));
  return { head, snapshot: current.snapshot, manifest: current.manifest, originCommit: origin.snapshot.remoteHeadSha,
    historyValid: !historyIssues.length, diagnostics,
    lineage: nodes.map(n => ({ commit: n.snapshot.remoteHeadSha, parents: n.parents, generation: n.manifest?.generation ?? null })) };
}
