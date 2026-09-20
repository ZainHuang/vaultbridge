import { describe, expect, it } from 'vitest';
import { RemoteManifestReader } from '../src/github/RemoteManifestReader';
import { GitHubClient } from '../src/github/GitHubClient';
import { bytes, referenceSha, remoteSnapshot, target } from './helpers';
import { manifestOf } from './stateful-helpers';
import { MANIFEST_PATH } from '../src/sync/manifest/ManifestSchema';
import type { GetRequest } from '../src/github/types';
describe('Read-only manifest blob reader', () => {
  const text = JSON.stringify(manifestOf()); const sha = referenceSha(bytes(text));
  const remote = remoteSnapshot({ [MANIFEST_PATH]: text });
  const response = { sha, size: bytes(text).length, encoding: 'base64', content: Buffer.from(text).toString('base64') };
  it('reads exactly the immutable manifest blob named by the pinned tree and verifies bytes', async () => {
    const calls: GetRequest[] = [];
    const reader = new RemoteManifestReader(new GitHubClient(target, '', async request => { calls.push(request); return { status: 200, json: response }; }));
    expect(await reader.read(remote)).toEqual(manifestOf());
    expect(calls).toHaveLength(1); expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toMatch(new RegExp(`/git/blobs/${sha}$`));
  });
  it('absence makes no blob request', async () => {
    const reader = new RemoteManifestReader(new GitHubClient(target, '', async () => { throw new Error('must not call'); }));
    expect(await reader.read(remoteSnapshot({}))).toBeNull();
  });
  it.each([{ ...response, sha: 'f'.repeat(40) }, { ...response, size: 1 }, { ...response, content: '***' },
    { ...response, content: Buffer.from('{}').toString('base64') }, { ...response, encoding: 'utf8' }])('rejects corrupt blob envelope %#', async json => {
    await expect(new RemoteManifestReader(new GitHubClient(target, '', async () => ({ status: 200, json }))).read(remote)).rejects.toMatchObject({ code: 'REMOTE_MANIFEST_INVALID' });
  });
  it('rejects oversized manifest before downloading it', async () => {
    const huge = { ...remote, entries: remote.entries.map(e => ({ ...e, size: 8 * 1024 * 1024 })) };
    await expect(new RemoteManifestReader(new GitHubClient(target, '', async () => { throw new Error('must not call'); })).read(huge)).rejects.toMatchObject({ code: 'REMOTE_MANIFEST_INVALID' });
  });
  it('does not reinterpret a failed GET as a missing manifest', async () => {
    await expect(new RemoteManifestReader(new GitHubClient(target, '', async () => ({ status: 404, json: {} }))).read(remote)).rejects.toMatchObject({ code: 'HTTP_404' });
  });
});
