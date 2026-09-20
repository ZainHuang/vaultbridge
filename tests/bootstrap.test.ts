import { describe, expect, it } from 'vitest';
import { ThreeWaySyncPlanner } from '../src/sync/planner/ThreeWaySyncPlanner';
import { manifestOf, ignore, version } from './stateful-helpers';
import { localSnapshot, remoteSnapshot } from './helpers';
describe('Bootstrap gates', () => {
  const remote = remoteSnapshot(Object.fromEntries(Array.from({ length: 245 }, (_, i) => [`note-${i}.md`, String(i)])));
  const manifest = { ...manifestOf(...remote.entries.map(e => ({ ...version(), fileId: e.path, path: e.path, blobSha: e.sha }))), generation: 37 };
  it.each([
    [null, {}, manifest, remote, 'BOOTSTRAP_FROM_REMOTE'],
    [null, { 'local.md': 'new' }, manifest, remote, 'BOOTSTRAP_CONFLICT_LOCAL_NOT_EMPTY'],
    [null, { 'local.md': 'new' }, null, remoteSnapshot({}), 'INITIALIZE_REMOTE_FROM_LOCAL'],
    [null, {}, null, remote, 'LEGACY_REMOTE_REQUIRES_ADOPTION'],
    [manifestOf(), {}, null, remoteSnapshot({}), 'REMOTE_MANIFEST_MISSING'],
    [manifest, {}, null, remote, 'REMOTE_MANIFEST_MISSING'],
    [null, {}, manifestOf(), remoteSnapshot({}), 'BOOTSTRAP_FROM_REMOTE'],
  ] as const)('gate %# → %s', (base, files, remoteManifest, remote, expected) => {
    const plan = new ThreeWaySyncPlanner().create({ base, local: localSnapshot(files), remote, remoteManifest }, ignore);
    expect(plan.status).toBe(expected);
    expect(plan.entries).toEqual([]);
    expect(plan.executionAllowed).toBe(false);
    expect(plan.counts.PUSH_DELETE).toBe(0);
  });
  it('0 local / 245 remote is a new-device bootstrap with generation 37, never mass deletion', () => {
    const plan = new ThreeWaySyncPlanner().create({ base: null, local: localSnapshot({}), remote, remoteManifest: manifest }, ignore);
    expect(plan).toMatchObject({ status: 'BOOTSTRAP_FROM_REMOTE', deviceState: 'NEW DEVICE', remoteGeneration: 37, localCount: 0, remoteCount: 245 });
    expect(Object.values(plan.counts).reduce((a, b) => a + b, 0)).toBe(0);
  });
});
