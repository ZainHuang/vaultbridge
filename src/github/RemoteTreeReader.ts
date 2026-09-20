import { assertActive, PreviewError } from '../errors';
import { assertPath, pathOrder } from '../vault/paths';
import type { Progress } from '../vault/VaultScanner';
import { GitHubClient } from './GitHubClient';
import type { RemoteEntry, RemoteSnapshot } from './types';

const SHA = /^[0-9a-f]{40}$/;
const invalid = () => new PreviewError('REMOTE_TREE', 'INVALID_RESPONSE', 'GitHub returned an incomplete or inconsistent response. No plan was created.');
const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
function sha(value: unknown): string {
  if (typeof value !== 'string' || !SHA.test(value)) throw invalid();
  return value;
}

function tree(value: unknown, expected: string, shallow = false): { entries: RemoteEntry[]; truncated: boolean } {
  const data = obj(value);
  if (sha(data.sha) !== expected || !Array.isArray(data.tree) || typeof data.truncated !== 'boolean') throw invalid();
  const entries = data.tree.map((value: unknown): RemoteEntry => {
    const entry = obj(value);
    if (typeof entry.path !== 'string' || typeof entry.mode !== 'string') throw invalid();
    assertPath(entry.path);
    if (shallow && entry.path.includes('/')) throw invalid();
    const modeType: Record<string, string> = { '100644': 'blob', '100755': 'blob', '120000': 'blob', '040000': 'tree', '160000': 'commit' };
    if (!Object.hasOwn(modeType, entry.mode) || modeType[entry.mode] !== entry.type) throw invalid();
    if (entry.type === 'blob' && (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0)) throw invalid();
    return { path: entry.path, sha: sha(entry.sha), mode: entry.mode, type: entry.type as RemoteEntry['type'],
      ...(entry.type === 'blob' ? { size: entry.size as number } : {}) };
  });
  if (new Set(entries.map(entry => entry.path)).size !== entries.length) throw invalid();
  return { entries, truncated: data.truncated };
}

export class RemoteTreeReader {
  constructor(private readonly client: GitHubClient) {}

  async read(branch: string, progress: Progress = () => {}, signal?: AbortSignal): Promise<RemoteSnapshot> {
    progress('Reading GitHub branch HEAD');
    const ref = obj(await this.client.get(`ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, 'REMOTE_REF', signal));
    if (ref.ref !== `refs/heads/${branch}`) throw invalid();
    const target = obj(ref.object);
    if (target.type !== 'commit') throw invalid();
    const remoteHeadSha = sha(target.sha);
    return this.readCommit(remoteHeadSha, progress, signal);
  }

  async readCommit(remoteHeadSha: string, progress: Progress = () => {}, signal?: AbortSignal): Promise<RemoteSnapshot> {
    sha(remoteHeadSha);
    const commit = obj(await this.client.get(`commits/${remoteHeadSha}`, 'REMOTE_COMMIT', signal));
    if (sha(commit.sha) !== remoteHeadSha) throw invalid();
    const treeSha = sha(obj(commit.tree).sha);
    progress('Reading complete GitHub tree');
    const recursive = tree(await this.client.get(`trees/${treeSha}?recursive=1`, 'REMOTE_TREE', signal), treeSha);
    let entries = recursive.entries;
    if (recursive.truncated) {
      // Discard the partial response entirely. Follow only immutable SHA references.
      entries = [];
      const queue = [{ sha: treeSha, prefix: '' }];
      const cache = new Map<string, RemoteEntry[]>();
      for (let index = 0; index < queue.length; index++) {
        assertActive(signal);
        if (index >= 25_000 || entries.length > 250_000) {
          throw new PreviewError('REMOTE_TREE', 'TREE_LIMIT', 'Remote exceeds the complete-tree safety limit. No plan was created.');
        }
        const node = queue[index]!;
        progress(`Reading GitHub subtrees: ${index + 1}`);
        let children = cache.get(node.sha);
        if (!children) {
          const result = tree(await this.client.get(`trees/${node.sha}`, 'REMOTE_TREE', signal), node.sha, true);
          if (result.truncated) throw new PreviewError('REMOTE_TREE', 'TRUNCATED_TREE', 'A subtree is truncated. A complete Preview cannot be generated.');
          children = result.entries;
          cache.set(node.sha, children);
        }
        for (const entry of children) {
          const path = node.prefix + entry.path;
          entries.push({ ...entry, path });
          if (entry.type === 'tree') queue.push({ sha: entry.sha, prefix: `${path}/` });
        }
      }
    }
    const map = new Map(entries.map(entry => [entry.path, entry]));
    if (map.size !== entries.length) throw invalid();
    for (const entry of entries) {
      const slash = entry.path.lastIndexOf('/');
      if (slash >= 0 && map.get(entry.path.slice(0, slash))?.type !== 'tree') throw invalid();
    }
    return { remoteHeadSha, treeSha, entries: entries.sort((a, b) => pathOrder(a.path, b.path)), fetchedAt: new Date().toISOString() };
  }
}
