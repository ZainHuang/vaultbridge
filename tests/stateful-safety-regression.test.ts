import { describe, expect, it } from 'vitest';
import { ThreeWaySyncPlanner } from '../src/sync/planner/ThreeWaySyncPlanner';
import { resolveFile } from '../src/sync/planner/ThreeWayFileResolver';
import { parseLocalState } from '../src/sync/state/LocalStateStore';
import { manifestOf, version, ignore } from './stateful-helpers';
import { localSnapshot, remoteSnapshot, bytes, referenceSha } from './helpers';

describe('Final path ownership and metadata review regressions', () => {
  const sha = (text: string) => referenceSha(bytes(text));
  const original = { ...version(), blobSha: sha('old') };
  it('a remote rename cannot overwrite a separate local addition at its destination', () => {
    const plan = new ThreeWaySyncPlanner().create({ base: manifestOf(original), local: localSnapshot({ 'A.md': 'old', 'B.md': 'unrelated' }),
      remote: remoteSnapshot({ 'B.md': 'old' }), remoteManifest: { ...manifestOf({ ...original, path: 'B.md', revision: 2 }), generation: 2 } }, ignore);
    expect(plan.entries).toHaveLength(2);
    expect(plan.entries.every(entry => entry.category === 'CONFLICT_IDENTITY_UNCERTAIN')).toBe(true);
  });
  it('a reused tombstone path cannot schedule pull-delete plus pull-add over one local file', () => {
    const plan = new ThreeWaySyncPlanner().create({ base: manifestOf(original), local: localSnapshot({ 'A.md': 'old' }), remote: remoteSnapshot({ 'A.md': 'new' }),
      remoteManifest: { ...manifestOf({ ...original, deleted: true, revision: 2 }, { ...original, fileId: 'new-id', blobSha: sha('new') }), generation: 2 } }, ignore);
    expect(plan.entries.every(entry => entry.category === 'CONFLICT_IDENTITY_UNCERTAIN')).toBe(true);
    expect(plan.counts.PULL_DELETE + plan.counts.PULL_ADD).toBe(0);
  });
  it('a two-file path swap requires review rather than independent overwriting renames', () => {
    const other = { ...original, fileId: 'other', path: 'B.md', blobSha: sha('other') };
    const plan = new ThreeWaySyncPlanner().create({ base: manifestOf(original, other), local: localSnapshot({ 'A.md': 'old', 'B.md': 'other' }),
      remote: remoteSnapshot({ 'B.md': 'old', 'A.md': 'other' }), remoteManifest: { ...manifestOf({ ...original, path: 'B.md', revision: 2 }, { ...other, path: 'A.md', revision: 2 }), generation: 2 } }, ignore);
    expect(plan.entries.every(entry => entry.category === 'CONFLICT_IDENTITY_UNCERTAIN')).toBe(true);
  });
  it('same content with divergent new paths is not false convergence', () => {
    expect(resolveFile({ local: version('a', 'A.md'), remote: version('a', 'B.md') }).category).toBe('CONFLICT_IDENTITY_UNCERTAIN');
  });
  it('a local tombstone plus reappearing bytes cannot silently converge with the old identity', () => {
    const plan = new ThreeWaySyncPlanner().create({ base: manifestOf(original), local: localSnapshot({ 'A.md': 'old' }),
      remote: remoteSnapshot({ 'A.md': 'old' }), remoteManifest: manifestOf(original), localFiles: { 'id-1': { ...original, deleted: true } } }, ignore);
    expect(plan.entries.every(entry => entry.category === 'CONFLICT_IDENTITY_UNCERTAIN')).toBe(true);
  });
  it('stable local metadata may omit blobSha; current scanner bytes determine content', () => {
    const current = { schemaVersion: 1, deviceId: '12345678-1234-4234-8234-123456789abc', localFiles: { 'id-1': { fileId: 'id-1', path: 'B.md', deleted: false } } };
    expect(parseLocalState(current)).toEqual(current);
    const plan = new ThreeWaySyncPlanner().create({ base: manifestOf(original), local: localSnapshot({ 'B.md': 'new' }), remote: remoteSnapshot({ 'A.md': 'old' }),
      remoteManifest: manifestOf(original), localFiles: current.localFiles }, ignore);
    expect(plan.entries).toMatchObject([{ category: 'PUSH_RENAME_AND_UPDATE', fileId: 'id-1' }]);
  });
  it.each([
    { target: { owner: 9, repository: 'x', branch: 'main' } },
    { baseManifest: manifestOf(original), lastSeenGeneration: 99 },
  ])('invalid state metadata fails closed %#', fields => {
    expect(() => parseLocalState({ schemaVersion: 1, deviceId: '12345678-1234-4234-8234-123456789abc', ...fields })).toThrow();
  });
});
