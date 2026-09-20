import { gitBlobSha } from '../src/vault/HashService';
import type { GitTransport } from '../src/github/types';
import type { SyncVault } from '../src/sync/execution/SyncVault';
import { MemoryVault, bytes, treeEntries } from './helpers';

export class WritableVault extends MemoryVault implements SyncVault {
  internal = new Map<string, string>();
  mutations: string[] = [];
  failPath?: string;
  async readInternal(path: string) { return this.internal.get(path) ?? null; }
  async writeInternal(path: string, text: string) { this.internal.set(path, text); }
  async removeInternal(path: string) { this.internal.delete(path); }
  // This fixture derives folders from files and has no persistent empty folders.
  async removeEmptyFolder(_path: string, _recoveryPath: string) { /* No empty directories in MemoryVault. */ }
  override async list(parent: string) {
    const listing = await super.list(parent);
    if (!parent && [...this.internal.keys()].some(p => p.startsWith('.local-mirror-sync/')) && !listing.folders.includes('.local-mirror-sync')) listing.folders.push('.local-mirror-sync');
    return listing;
  }
  async apply(path: string, data: Uint8Array | null, expected: string | null, recovery: string) {
    if (path === this.failPath) throw new Error('disk failure');
    const current = this.files.get(path);
    const hash = current ? gitBlobSha(current) : null;
    const desired = data ? gitBlobSha(data) : null;
    if (hash === desired) return;
    if (hash !== expected && !(hash === null && this.files.has(recovery) && gitBlobSha(this.files.get(recovery)!) === expected)) throw new Error('local changed');
    if (current) { this.files.set(recovery, current); this.files.delete(path); }
    if (data) this.files.set(path, data.slice());
    this.mutations.push(path);
  }
}

export class GitFixture {
  blobs = new Map<string, Uint8Array>();
  trees = new Map<string, Record<string, string>>();
  commits = new Map<string, { tree: string; parents: string[] }>();
  head = '';
  refs = new Map<string, string>();
  calls: { method: string; resource: string; body?: Record<string, unknown> }[] = [];
  beforePatch?: () => void;
  losePatchResponse = false;
  private sequence = 1;
  constructor(files: Record<string, string> = {}) { this.external(files); }
  id() { return (this.sequence++).toString(16).padStart(40, '0'); }
  blob(data: Uint8Array) { const sha = gitBlobSha(data); this.blobs.set(sha, data); return sha; }
  contents() { return this.trees.get(this.commits.get(this.head)!.tree)!; }
  text(path: string) { return new TextDecoder().decode(this.blobs.get(this.contents()[path]!)!); }
  external(files: Record<string, string>) {
    const tree = this.id(); this.trees.set(tree, Object.fromEntries(Object.entries(files).map(([p, s]) => [p, this.blob(bytes(s))])));
    const commit = this.id(); this.commits.set(commit, { tree, parents: this.head ? [this.head] : [] }); this.head = commit;
  }
  ancestor(ancestor: string, head: string): boolean { return head === ancestor || (this.commits.get(head)?.parents.some(p => this.ancestor(ancestor, p)) ?? false); }
  transport: GitTransport = async request => {
    const resource = request.url.split('/git/')[1]!;
    const body = request.body ? JSON.parse(request.body) as Record<string, unknown> : undefined;
    this.calls.push({ method: request.method, resource, body });
    if (request.method === 'GET') {
      if (resource.startsWith('ref/')) {
        const ref = `refs/${resource.slice(4)}`;
        const sha = ref === 'refs/heads/main' ? this.head : this.refs.get(ref);
        return { status: sha ? 200 : 404, json: { ref, object: { type: 'commit', sha } } };
      }
      const [kind, raw] = resource.split('/'); const sha = raw!.split('?')[0]!;
      if (kind === 'commits') { const c = this.commits.get(sha)!; return { status: 200, json: { sha, tree: { sha: c.tree }, parents: c.parents.map(sha => ({ sha })) } }; }
      if (kind === 'trees') { const files = Object.fromEntries(Object.entries(this.trees.get(sha)!).map(([p, s]) => [p, this.blobs.get(s)!])); return { status: 200, json: { sha, tree: treeEntries(files), truncated: false } }; }
      if (kind === 'blobs') { const data = this.blobs.get(sha)!; return { status: 200, json: { sha, size: data.length, encoding: 'base64', content: Buffer.from(data).toString('base64') } }; }
    }
    if (request.method === 'POST' && resource === 'refs') {
      const ref = body!.ref as string; const sha = body!.sha as string;
      if (this.refs.has(ref) || !this.commits.has(sha)) return { status: 422, json: {} };
      this.refs.set(ref, sha);
      return { status: 201, json: { ref, object: { type: 'commit', sha } } };
    }
    if (request.method === 'POST' && resource === 'blobs') {
      const data = new Uint8Array(Buffer.from(body!.content as string, 'base64'));
      return { status: 201, json: { sha: this.blob(data) } };
    }
    if (request.method === 'POST' && resource === 'trees') {
      const files = { ...this.trees.get(body!.base_tree as string) };
      for (const item of body!.tree as { path: string; sha: string | null }[]) { if (item.sha === null) delete files[item.path]; else files[item.path] = item.sha; }
      const sha = this.id(); this.trees.set(sha, files); return { status: 201, json: { sha } };
    }
    if (request.method === 'POST' && resource === 'commits') {
      const sha = this.id(); this.commits.set(sha, { tree: body!.tree as string, parents: body!.parents as string[] }); return { status: 201, json: { sha } };
    }
    if (request.method === 'PATCH' && resource.startsWith('refs/')) {
      this.beforePatch?.(); this.beforePatch = undefined;
      if (body!.force !== false || !this.ancestor(this.head, body!.sha as string)) return { status: 422, json: {} };
      this.head = body!.sha as string;
      if (this.losePatchResponse) { this.losePatchResponse = false; throw new Error('network lost after publication'); }
      return { status: 200, json: { ref: 'refs/heads/main', object: { sha: this.head, type: 'commit' } } };
    }
    throw new Error(`Unexpected ${request.method} ${resource}`);
  };
}
