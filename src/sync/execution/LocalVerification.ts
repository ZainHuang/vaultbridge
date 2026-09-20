import { PreviewError } from '../../errors';
import { IgnoreService } from '../../vault/IgnoreService';
import { pathOrder } from '../../vault/paths';
import { LocalScanError, VaultScanner, type VaultReader, type FileProgress } from '../../vault/VaultScanner';
import type { SyncTransaction } from './TransactionStore';

export interface LocalVerifyIssue {
  path: string; expectedSha: string | null; actualSha: string | null;
  kind: 'missing' | 'added' | 'modified';
  ignored: boolean; protected: boolean; internal: boolean; excluded: boolean;
  problem?: string;
}
export class LocalVerificationError extends PreviewError {
  constructor(public readonly diagnostics: LocalVerifyIssue[]) {
    super('SYNC', 'LOCAL_VERIFY_FAILED', `Local verification failed. BASE has not advanced; recovery copies are retained.\n${diagnostics.map(d =>
      `${d.kind} · ${d.path}\nexpected blob SHA: ${d.expectedSha ?? '(absent)'}\nactual blob SHA: ${d.actualSha ?? (d.problem ? '(unavailable)' : '(absent)')}\nignored=${d.ignored}; protected/internal=${d.protected}/${d.internal}; plan-excluded=${d.excluded}${d.problem ? `; ${d.problem}` : ''}`).join('\n\n')}`);
  }
}
/** The persisted plan's scope is authoritative, including whole-identity exclusions.
 * New eligible paths are still differences: an after-map allowlist would hide edits. */
export function transactionIgnore(t: SyncTransaction): IgnoreService {
  const scope = JSON.parse(t.scopeKey) as { configDir: string; gitignore: string };
  return new IgnoreService({ configDir: scope.configDir, gitignore: scope.gitignore,
    includeObsidian: t.options.includeObsidian, patterns: t.options.ignorePatterns });
}
export async function verifyLocal(vault: VaultReader, t: SyncTransaction, ignore = transactionIgnore(t), fileProgress?: FileProgress): Promise<void> {
  const issue = (path: string, actualSha: string | null, problem?: string): LocalVerifyIssue => {
    const expectedSha = t.after[path] ?? null;
    return { path, expectedSha, actualSha, kind: !expectedSha ? 'added' : actualSha === null && !problem ? 'missing' : 'modified',
      ignored: !!ignore.reason(path === '/' ? '__root__' : path), protected: !!ignore.protectedReason(path), internal: !!ignore.protectedReason(path),
      excluded: t.excludedPaths.includes(path), ...(problem ? { problem } : {}) };
  };
  const differences = (actual: Record<string, string>) => [...new Set([...Object.keys(t.after), ...Object.keys(actual)])].sort(pathOrder)
    .filter(p => t.after[p] !== actual[p]).map(p => issue(p, actual[p] ?? null));
  let scan;
  try { scan = await new VaultScanner(vault).scan(ignore, undefined, undefined, t.excludedPaths, fileProgress); }
  catch (error) {
    if (error instanceof LocalScanError) {
      const combined = new Map((error.observedFiles ? differences(Object.fromEntries(error.observedFiles.map(f => [f.path, f.sha]))) : []).map(d => [d.path, d]));
      for (const d of error.diagnostics) combined.set(d.path, { ...issue(d.path, d.actualSha, d.problem),
        ...(d.problem === 'missing-during-scan' ? { kind: 'missing' as const } : {}) });
      throw new LocalVerificationError([...combined.values()].sort((a, b) => pathOrder(a.path, b.path)));
    }
    throw error;
  }
  const actual = Object.fromEntries(scan.files.map(f => [f.path, f.sha]));
  const result = differences(actual);
  if (result.length) throw new LocalVerificationError(result);
}
