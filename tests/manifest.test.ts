import { describe, expect, it } from 'vitest';
import { parseManifest } from '../src/sync/manifest/ManifestValidator';
const live = { fileId: 'id-1', path: 'A.md', blobSha: 'a'.repeat(40), deleted: false, revision: 1 };
const manifest = (files: Record<string, typeof live> = { 'id-1': live }) => ({ schemaVersion: 1, generation: 1, files });
describe('Manifest schema', () => {
  it('accepts a versioned live manifest', () => expect(parseManifest(JSON.stringify(manifest()))).toEqual(manifest()));
  it.each([
    ['invalid JSON', '{'],
    ['unsupported version', { ...manifest(), schemaVersion: 2 }],
    ['duplicate ID', manifest({ 'id-1': live, other: live })],
    ['duplicate live path', manifest({ 'id-1': live, other: { ...live, fileId: 'other' } })],
    ['negative revision', manifest({ 'id-1': { ...live, revision: -1 } })],
    ['fractional generation', { ...manifest(), generation: 1.5 }],
    ['missing tombstone identity', { ...manifest(), files: { x: { path: 'A.md', deleted: true, revision: 1 } } }],
    ['unsafe path', manifest({ 'id-1': { ...live, path: '../A.md' } })],
    ['missing live hash', { ...manifest(), files: { x: { fileId: 'x', path: 'A.md', deleted: false, revision: 1 } } }],
  ])('rejects %s', (_, value) => expect(() => parseManifest(value)).toThrow('REMOTE_MANIFEST_INVALID'));
  it('preserves tombstones, including paths reused by a new identity', () => {
    const data = manifest({ 'id-1': { ...live, deleted: true }, other: { ...live, fileId: 'other' } });
    expect(parseManifest(data)).toEqual(data);
  });
  it('accepts Unicode and binary metadata without touching file contents', () => {
    const data = manifest({ 'id-1': { ...live, path: '知识/附件.bin' } });
    expect(parseManifest(data).files['id-1']?.path).toBe('知识/附件.bin');
  });
  it('rejects duplicate JSON object keys before an identity can be overwritten by parsing', () => {
    const entry = JSON.stringify(live);
    expect(() => parseManifest(`{"schemaVersion":1,"generation":1,"files":{"id-1":${entry},"id-1":${entry}}}`)).toThrow('REMOTE_MANIFEST_INVALID');
  });
});
