import { createHash } from 'node:crypto';
import type { GetRequest, GetTransport, RemoteEntry, RemoteSnapshot } from '../src/github/types';
import type { LocalSnapshot, VaultReader } from '../src/vault/VaultScanner';

export const HEAD = 'a'.repeat(40);
export const TREE = 'b'.repeat(40);
export const SUBTREE = 'c'.repeat(40);
export const target = { owner: 'test-owner', repository: 'test-repository', branch: 'main' };
export const bytes = (value: string | number[]) => typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
export const referenceSha = (value: Uint8Array) => createHash('sha1').update(`blob ${value.byteLength}\0`).update(value).digest('hex');

export function localSnapshot(files: Record<string, string>): LocalSnapshot {
  return { files: Object.entries(files).map(([path, value]) => ({ path, size: bytes(value).length, sha: referenceSha(bytes(value)) })), ignored: [], protectedDirectories: [], scannedAt: '' };
}
export function remoteSnapshot(files: Record<string, string>): RemoteSnapshot {
  return { remoteHeadSha: HEAD, treeSha: TREE, fetchedAt: '', entries: Object.entries(files).map(([path, value]) => ({ path, sha: referenceSha(bytes(value)), size: bytes(value).length, mode: '100644', type: 'blob' })) };
}
export function treeEntries(files: Record<string, Uint8Array>): RemoteEntry[] {
  const directories = new Set<string>();
  for (const path of Object.keys(files)) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join('/'));
  }
  return [
    ...[...directories].map(path => ({ path, sha: SUBTREE, mode: '040000', type: 'tree' as const })),
    ...Object.entries(files).map(([path, value]) => ({ path, sha: referenceSha(value), size: value.length, mode: '100644', type: 'blob' as const })),
  ];
}

export class MemoryVault implements VaultReader {
  files = new Map<string, Uint8Array>();
  reads: string[] = [];
  listings: string[] = [];
  constructor(files: Record<string, string | number[]> = {}) {
    Object.entries(files).forEach(([path, value]) => this.files.set(path, bytes(value)));
  }
  async list(parent: string): Promise<{ files: string[]; folders: string[] }> {
    this.listings.push(parent);
    const prefix = parent ? `${parent}/` : '';
    const files: string[] = [];
    const folders = new Set<string>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const suffix = path.slice(prefix.length);
      if (suffix.includes('/')) folders.add(prefix + suffix.split('/')[0]);
      else files.push(path);
    }
    return { files, folders: [...folders] };
  }
  async stat(path: string) {
    const value = this.files.get(path);
    return value ? { type: 'file' as const, size: value.length, mtime: 1, ctime: 1 } : null;
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    this.reads.push(path);
    const value = this.files.get(path);
    if (!value) throw new Error('Missing');
    return value.slice().buffer as ArrayBuffer;
  }
}

export function remoteTransport(entries: RemoteEntry[], calls: GetRequest[] = []): GetTransport {
  return async request => {
    calls.push(request);
    if (request.url.includes('/ref/heads/')) return { status: 200, json: { ref: 'refs/heads/main', object: { type: 'commit', sha: HEAD } } };
    if (request.url.endsWith(`/commits/${HEAD}`)) return { status: 200, json: { sha: HEAD, tree: { sha: TREE } } };
    if (request.url.endsWith(`/trees/${TREE}?recursive=1`)) return { status: 200, json: { sha: TREE, tree: entries, truncated: false } };
    throw new Error('Unexpected request');
  };
}
