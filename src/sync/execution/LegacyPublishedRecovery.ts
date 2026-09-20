import { PreviewError } from '../../errors';
import { GitHubWriter } from '../../github/GitHubWriter';
import { RemoteManifestReader } from '../../github/RemoteManifestReader';
import { RemoteTreeReader } from '../../github/RemoteTreeReader';
import type { GitTransport } from '../../github/types';
import type { SyncObserver } from '../../product/ProductStore';
import type { Progress } from '../../vault/VaultScanner';
import { pathConflictChecker } from '../../vault/PathConflictDetector';
import { validateManifestHistory, validateManifestTree } from '../manifest/ManifestConsistency';
import type { PreviewOptions } from '../PreviewService';
import { PreviewSnapshotReader } from '../PreviewSnapshotReader';
import type { LocalStateStore } from '../state/LocalStateStore';
import type { SyncVault } from './SyncVault';
import { sameTransactionTarget as sameTarget, type SyncTransaction, type TransactionStore } from './TransactionStore';

// V1.0 has neither observability nor creation metadata. Never widen the normal
// V1.1 recovery path, or infer that a prepared candidate was already published.
export const isLegacyPublished = (t: SyncTransaction) => t.createdAt === undefined && t.observation === undefined && t.phase !== 'prepared';
const fail = (code: string, detail: string) => new PreviewError('RECOVERY', code, `${detail} BASE has not advanced. Recovery remains blocked; no user files or remote refs were changed.`);
export const legacyTransactionChanged = () => fail('LEGACY_TRANSACTION_CHANGED', 'The pending transaction changed since review or during verification.');

function mapDifferences(expected: Record<string, string>, actual: Record<string, string>) {
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort().flatMap(path => {
    if (expected[path] === actual[path]) return [];
    return [`${path}: ${!actual[path] ? 'missing' : !expected[path] ? 'unexpected' : `hash differs (expected ${expected[path]}, actual ${actual[path]})`}`];
  });
}
const describeDifferences = (differences: string[]) => `${differences.length} difference(s).\n${differences.slice(0, 20).join('\n')}${differences.length > 20 ? '\nAdditional differences omitted; the full list is retained when starting fresh Preview.' : ''}`;
function verifyMap(expected: Record<string, string>, actual: Record<string, string>, code: string, label: string) {
  const differences = mapDifferences(expected, actual);
  if (differences.length) throw fail(code, `${label}: ${describeDifferences(differences)}`);
}

/** Read-only reconciliation: prove the exact published state, then write local
 * metadata only. Descendants are verified against their current Manifest, never
 * by replaying the old transaction. No publish/apply/recovery-blob replay. */
export async function recoverLegacyPublished(t: SyncTransaction, options: PreviewOptions, token: string,
  vault: SyncVault, transport: GitTransport, configDir: string, state: LocalStateStore,
  transactions: TransactionStore, progress: Progress, active: () => void, observer?: SyncObserver,
  intent: 'resume' | 'fresh-preview' = 'resume'): Promise<void> {
  if (!sameTarget(options, t.options)) throw fail('LEGACY_TARGET_MISMATCH', 'Current repository/branch differs from the legacy transaction.');
  const previous = state.current(); const stateKey = JSON.stringify(previous);
  const sameBase = (base: typeof previous) => JSON.stringify(previous.baseManifest) === JSON.stringify(base.baseManifest) && previous.baseRemoteCommit === base.baseRemoteCommit;
  const rules = JSON.parse(t.scopeKey) as { configDir: string; gitignore: string };
  if (rules.configDir !== configDir || options.includeObsidian !== t.options.includeObsidian || options.ignorePatterns !== t.options.ignorePatterns) {
    throw fail('LEGACY_SCOPE_CHANGED', 'Configuration directory or ignore settings differ from the reviewed legacy scope.');
  }
  const github = new GitHubWriter(options, token, transport);
  observer?.activity?.({ type: 'stage', stage: 'Verify remote' });
  progress('Checking legacy published commit ancestry and retained backup…');
  const head = await github.head();
  const advanced = head !== t.commit;
  if (advanced && !await github.contains(t.commit, head)) throw fail('LEGACY_RECOVERY_DIVERGED', `Current ${options.branch} HEAD ${head} does not descend from legacy published commit ${t.commit}.`);
  if (!advanced && intent === 'fresh-preview') throw fail('LEGACY_FRESH_PREVIEW_UNAVAILABLE', 'Current HEAD is the published commit; use Resume Transaction.');
  const assertHead = (current: string) => {
    if (current !== head) throw fail('REMOTE_ADVANCED_SINCE_LEGACY_TRANSACTION', `Current ${options.branch} HEAD changed during recovery from ${head} to ${current}. Retry against the new current HEAD.`);
  };
  const verifyHead = async () => assertHead(await github.head());
  const verifyBackup = async () => {
    if (!t.backupRef) return;
    try { await github.verifyBackup(t.backupRef, t.originalHead); }
    catch (error) { throw fail('LEGACY_BACKUP_UNVERIFIED', `Cannot verify backup ${t.backupRef} at original HEAD ${t.originalHead}${error instanceof PreviewError ? ` (${error.code})` : ''}.`); }
  };
  const verifyContext = async () => {
    active();
    if (JSON.stringify(await transactions.active()) !== JSON.stringify(t)) throw legacyTransactionChanged();
    if (JSON.stringify(state.current()) !== stateKey) throw fail('LEGACY_STATE_CHANGED', 'Current device state changed during verification.');
  };
  await verifyHead(); await verifyBackup();
  const capture = await new PreviewSnapshotReader(vault, transport, configDir).read(options, token, progress, undefined, (stage, processed, total) => observer?.activity?.({ type: 'stage', stage, processed, total })).catch(error => {
    if (error instanceof PreviewError && error.code === 'LOCAL_CHANGED') throw fail('LEGACY_LOCAL_MISMATCH', 'Local bytes changed during scanning.');
    throw error;
  });
  assertHead(capture.remote.remoteHeadSha);
  observer?.activity?.({ type: 'stage', stage: 'Verify remote' });
  const manifest = await new RemoteManifestReader(capture.client).read(capture.remote);
  if (!manifest) throw fail('LEGACY_MANIFEST_MISSING', 'Current remote tree has no sync Manifest.');
  if (!advanced && JSON.stringify(manifest) !== JSON.stringify(t.manifest)) throw fail('LEGACY_MANIFEST_MISMATCH', `Remote Manifest identities/revisions or generation ${manifest.generation} differ from transaction generation ${t.manifest.generation}.`);
  if (advanced) validateManifestHistory(t.manifest, manifest);
  const alreadyVerified = previous.baseRemoteCommit === t.commit && JSON.stringify(previous.baseManifest) === JSON.stringify(t.manifest);
  const verifiedCurrent = previous.baseRemoteCommit === head && JSON.stringify(previous.baseManifest) === JSON.stringify(manifest);
  // Verify an interrupted recovery BASE from its own immutable commit. The last
  // audit attempt may be newer than the last successful BASE write.
  let verifiedCheckpoint = false;
  if (advanced && previous.baseManifest && previous.baseRemoteCommit && !alreadyVerified && !verifiedCurrent
    && await github.contains(t.commit, previous.baseRemoteCommit)) {
    if (!await github.contains(previous.baseRemoteCommit, head)) throw fail('LEGACY_RECOVERY_DIVERGED',
      `Current HEAD ${head} does not descend from the saved recovery BASE ${previous.baseRemoteCommit}.`);
    const baseSnapshot = await new RemoteTreeReader(github.reader).readCommit(previous.baseRemoteCommit);
    verifiedCheckpoint = JSON.stringify(previous.baseManifest) === JSON.stringify(await new RemoteManifestReader(github.reader).read(baseSnapshot));
  }
  if (previous.target && !sameTarget(previous.target, t.options)
    || previous.baseManifest && !alreadyVerified && !verifiedCurrent && !verifiedCheckpoint
      && (previous.deviceId !== t.originalState.deviceId || !sameBase(t.originalState))) {
    throw fail('LEGACY_BASE_MISMATCH', 'Current BASE belongs to another state; it cannot be replaced by this legacy transaction.');
  }
  validateManifestHistory(previous.baseManifest ?? null, manifest);
  // .gitignore may itself have been changed by the published transaction.
  const currentRules = Object.values(manifest.files).find(f => f.path === '.gitignore' && !f.deleted);
  const appliedRules = advanced ? currentRules ? currentRules.blobSha === capture.local.files.find(l => l.path === '.gitignore')?.sha
    : Object.values(manifest.files).some(f => f.path === '.gitignore' && f.deleted) && !await vault.stat('.gitignore') : ('.gitignore' in t.before || '.gitignore' in t.after)
    && (t.after['.gitignore'] ? capture.local.files.find(f => f.path === '.gitignore')?.sha === t.after['.gitignore'] : !await vault.stat('.gitignore'));
  if (capture.gitignore !== rules.gitignore && !appliedRules) throw fail('LEGACY_SCOPE_CHANGED', 'Local .gitignore differs from the legacy reviewed/published rules.');
  const live = Object.values(manifest.files).filter(f => !f.deleted);
  for (const entry of live) {
    if (capture.ignore.reason(entry.path) || !advanced && t.excludedPaths.includes(entry.path)) throw fail('LEGACY_SCOPE_UNVERIFIED', `Manifest path ${entry.path} is excluded; its current bytes cannot be verified in this scope.`);
  }
  const expected = Object.fromEntries(live.map(f => [f.path, f.blobSha!]));
  if (!advanced) verifyMap(expected, t.after, 'LEGACY_TRANSACTION_MISMATCH', 'Transaction after-map differs from its Manifest');
  const remoteFiles = capture.remote.entries.filter(f => f.type !== 'tree' && !capture.ignore.reason(f.path));
  const remoteMap = Object.fromEntries(remoteFiles.map(f => [f.path, f.sha]));
  if (!advanced) verifyMap(expected, remoteMap, 'LEGACY_REMOTE_TREE_MISMATCH', 'Remote tree differs from Manifest');
  for (const file of remoteFiles) if (file.type !== 'blob' || !['100644', '100755'].includes(file.mode)) {
    throw fail('LEGACY_REMOTE_TREE_MISMATCH', `Unsupported remote file mode ${file.mode} at ${file.path}.`);
  }
  const conflict = pathConflictChecker(Object.keys(expected), capture.remote.entries, capture.ignore);
  for (const path of Object.keys(expected).sort()) {
    const problem = conflict(path);
    if (problem) throw fail('LEGACY_PATH_CONFLICT', `${path}: ${problem}`);
  }
  const remoteDifferences = mapDifferences(expected, remoteMap);
  if (!remoteDifferences.length) validateManifestTree(manifest, remoteFiles, () => true);
  const localMap = Object.fromEntries(capture.local.files.map(f => [f.path, f.sha]));
  if (!advanced) verifyMap(expected, localMap, 'LEGACY_LOCAL_MISMATCH', 'Local bytes differ from the published Manifest/tree');
  const differences = [...remoteDifferences.map(d => `Remote Tree / Manifest: ${d}`),
    ...mapDifferences(expected, localMap).map(d => `Local / Manifest: ${d}`)];
  const localByPath = new Map(capture.local.files.map(f => [f.path, f]));
  for (const file of remoteFiles) if (localMap[file.path] === file.sha && localByPath.get(file.path)?.size !== file.size) {
    throw fail('LEGACY_REMOTE_TREE_MISMATCH', `Remote size differs from verified local bytes at ${file.path}.`);
  }
  const verifyLocal = async () => {
    observer?.activity?.({ type: 'stage', stage: 'Verify local' });
    try { await capture.verify(); }
    catch (error) {
      if (error instanceof PreviewError && error.code === 'LOCAL_CHANGED') throw fail('LEGACY_LOCAL_MISMATCH', 'Local bytes or ignore rules changed during final verification.');
      throw error;
    }
  };
  progress('Rechecking current local bytes and remote HEAD before completing recovery…');
  await verifyBackup(); await verifyHead(); await verifyLocal();
  await verifyContext(); await verifyHead(); await verifyContext();
  if (advanced && differences.length && intent === 'resume') throw new PreviewError('RECOVERY', 'LEGACY_CURRENT_STATE_DIFFERS',
    `Published commit ${t.commit} is an ancestor of current HEAD ${head}, generation ${manifest.generation}.\n${describeDifferences(differences)}\nBASE has not advanced. Start fresh Preview from current HEAD to review the current state with the normal sync rules. No notes or remote refs were changed.`);
  if (advanced) {
    t.legacyRecovery = { action: intent === 'fresh-preview' ? 'START_FRESH_PREVIEW' : 'RECOVER_TO_CURRENT_HEAD',
      head, generation: manifest.generation, timestamp: new Date().toISOString(), differences };
    await transactions.save(t);
    await verifyLocal(); await verifyBackup(); await verifyHead(); await verifyContext();
  }
  if (intent === 'fresh-preview') {
    await transactions.clear();
    await observer?.recoveryCleared?.();
    progress('Legacy recovery retained as an audit record. Start fresh Preview from current HEAD. BASE is unchanged.');
    return;
  }
  // Preserve the current device identity. The old device ID is journal evidence,
  // not a prerequisite for rebuilding this device's missing BASE from proof.
  observer?.activity?.({ type: 'stage', stage: 'Save BASE', generation: manifest.generation });
  await state.save({ schemaVersion: 1, deviceId: previous.deviceId, target: { owner: options.owner, repository: options.repository, branch: options.branch },
    baseManifest: manifest, baseRemoteCommit: head, lastSeenGeneration: manifest.generation,
    lastSuccessfulSyncAt: new Date().toISOString(), localFiles: { ...manifest.files },
    syncScope: JSON.stringify({ configDir, includeObsidian: options.includeObsidian, patterns: options.ignorePatterns, gitignore: capture.gitignore }) });
  // Mark completion only after BASE read-back and observability succeed.
  // Interrupted metadata checkpoints repeat the same read-only proof.
  await observer?.verified({ ...t, commit: head, manifest, after: expected, originalState: { ...t.originalState, deviceId: previous.deviceId } });
  observer?.activity?.({ type: 'stage', stage: 'Finalize transaction' });
  t.phase = 'complete'; await transactions.save(t); await transactions.clear();
  observer?.activity?.({ type: 'stage', stage: 'Complete' });
  progress(`${advanced ? 'RECOVER_TO_CURRENT_HEAD' : 'Verified legacy transaction'} · BASE generation ${manifest.generation} · ${head}`);
}
