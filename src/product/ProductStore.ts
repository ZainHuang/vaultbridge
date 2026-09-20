import { type ActivityEvent, type ActivitySnapshot } from './SyncActivity';
import { PreviewError, safeError } from '../errors';
import { decodeBytes } from '../github/BinaryCodec';
import type { RepositoryTarget } from '../github/types';
import type { Capture } from '../sync/execution/ExecutionPlan';
import type { SyncPreview } from '../sync/execution/SyncService';
import type { SyncTransaction } from '../sync/execution/TransactionStore';
import type { SyncDecision } from '../sync/planner/SyncDecision';
import type { LocalSyncState } from '../sync/state/LocalSyncState';
import { gitBlobSha } from '../vault/HashService';
import type { AutoStatus } from './AutoSyncController';

export interface ProductStorage { read(path: string): Promise<string | null>; write(path: string, contents: string): Promise<void> }
export interface DeviceInfo { deviceId: string; deviceName: string; deviceType: string; lastSyncAt?: string; lastGeneration?: number }
interface Counts { addCount: number; updateCount: number; deleteCount: number; renameCount: number }
export interface Observation extends Counts { timestamp: string; device: DeviceInfo }
export interface HistoryRecord extends Counts {
  transactionId: string; timestamp: string; deviceId: string; generationBefore: number; generationAfter: number; commitSha: string; verifyResult: 'PASS';
}
export type Health = 'Healthy' | 'Sync Required' | 'Conflict' | 'Recovery Required' | 'Offline';
export interface ProductCache {
  currentDevice: DeviceInfo; devices: DeviceInfo[]; targetKey?: string; status: Health;
  localFiles?: number; remoteFiles?: number; lastCheckAt?: string; lastVerifiedAt?: string; lastChangeAt?: string;
  auto: AutoStatus; warning?: string;
}
export interface SyncObserver {
  readonly revision: number;
  preview(preview: SyncPreview, capture: Capture, revision: number, target: RepositoryTarget): Promise<void>;
  prepare(transaction: SyncTransaction, entries: SyncDecision[]): Observation;
  verified(transaction: SyncTransaction): Promise<void>;
  recoveryCleared?(): Promise<void>;
  activityChanged?(): void;
  activity?(event: ActivityEvent): void;
}
export const DEVICE_REPORT_ROOT = '.local-mirror-sync/devices/';
const CACHE = 'product-state.json';
const INDEX = '.sync-history/index.json';
const targetKey = (target: RepositoryTarget) => JSON.stringify([target.owner.toLowerCase(), target.repository.toLowerCase(), target.branch]);
const date = (s: unknown): s is string => typeof s === 'string' && Number.isFinite(Date.parse(s));
const validDevice = (d: DeviceInfo) => d && /^[a-f0-9-]{36}$/i.test(d.deviceId) && typeof d.deviceName === 'string' && d.deviceName.length > 0 && d.deviceName.length <= 80
  && typeof d.deviceType === 'string' && d.deviceType.length <= 40 && (d.lastSyncAt === undefined || date(d.lastSyncAt))
  && (d.lastGeneration === undefined || Number.isSafeInteger(d.lastGeneration) && d.lastGeneration >= 0);
const storageError = () => new PreviewError('OBSERVABILITY', 'STORAGE_FAILED', 'Local dashboard/history storage could not be read back. Preserve the files and review recovery.');

export function changeCounts(entries: SyncDecision[]): Counts {
  const counts = { addCount: 0, updateCount: 0, deleteCount: 0, renameCount: 0 };
  for (const e of entries) {
    if (!/^(PUSH|PULL)_/.test(e.category)) continue;
    if (e.category.endsWith('_ADD')) counts.addCount++;
    if (e.category.endsWith('_UPDATE')) counts.updateCount++;
    if (e.category.endsWith('_DELETE')) counts.deleteCount++;
    if (e.category.includes('_RENAME')) counts.renameCount++;
  }
  return counts;
}

/** Advisory state only. It cannot establish BASE, file identity, or sync authority. */
export class ProductStore implements SyncObserver {
  revision = 0;
  private live: ActivitySnapshot = { running: false, steps: [], verified: false };
  private cache!: ProductCache;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly peerBlobs = new Map<string, DeviceInfo>();
  private records: HistoryRecord[] = [];
  constructor(private readonly storage: ProductStorage, private readonly changed: () => void = () => {}) {}
  async load(deviceId: string, deviceName: string, deviceType: string): Promise<void> {
    this.cache = { currentDevice: { deviceId, deviceName, deviceType }, devices: [], status: 'Sync Required', auto: { result: 'Waiting for changes' } };
    const raw = await this.storage.read(CACHE);
    let previous: ProductCache | undefined;
    try { if (raw) { const p = JSON.parse(raw) as ProductCache; if (validDevice(p.currentDevice) && p.currentDevice.deviceId === deviceId && Array.isArray(p.devices) && p.devices.every(validDevice)) previous = p; } } catch { /* Cache is not authority. */ }
    this.cache = { ...previous, currentDevice: { ...previous?.currentDevice, deviceId, deviceName, deviceType }, devices: previous?.devices ?? [],
      status: 'Sync Required', auto: previous?.auto ?? { result: 'Waiting for changes' }, ...(raw && !previous ? { warning: 'Dashboard cache unavailable; run Preview to refresh.' } : {}) };
    try { this.records = await this.history(); } catch { this.cache.warning = 'Sync History could not be read. Existing history files are preserved.'; }
    this.cache.auto.scheduledAt = undefined;
    if (['Checking', 'Syncing', 'Waiting for Auto Sync'].includes(this.cache.auto.result)) this.cache.auto.result = 'Waiting for changes';
    this.live = { running: false, steps: [], verified: false };
    this.mergeDevices([this.cache.currentDevice]); await this.persist();
  }
  snapshot(): ProductCache { return structuredClone(this.cache); }
  activityChanged(): void { this.changed(); }
  activitySnapshot(): ActivitySnapshot { return structuredClone(this.live); }
  activity(event: ActivityEvent): void {
    if (event.type === 'start') this.live = { running: true, operation: event.operation, startedAt: Date.now(), steps: [], verified: false };
    else if (event.type === 'stage') {
      if (event.completedSteps) this.live.steps = structuredClone(event.completedSteps);
      if (this.live.stage !== event.stage) this.live.steps.push({ stage: event.stage, at: Date.now() });
      Object.assign(this.live, { stage: event.stage, processed: event.processed, total: event.total });
      if (event.transactionId) this.live.transactionId = event.transactionId;
      if (event.generation !== undefined) this.live.generation = event.generation;
      if (event.stage === 'Complete') this.live.verified = true;
    } else { this.live.running = false; this.live.endedAt = Date.now(); this.live.error = event.error; if (event.error) this.live.verified = false; }
    this.changed();
  }
  cachedHistory(): HistoryRecord[] { return structuredClone(this.records); }
  async configure(deviceName: string, deviceType: string): Promise<void> {
    const next = { ...this.cache.currentDevice, deviceName: deviceName.trim(), deviceType };
    if (!validDevice(next)) throw new PreviewError('SETTINGS', 'DEVICE_NAME', 'Enter a device name between 1 and 80 characters.');
    this.cache.currentDevice = next; this.mergeDevices([next]); await this.persist();
  }
  async dirty(): Promise<void> {
    this.revision++; this.cache.lastChangeAt = new Date().toISOString();
    if (!['Conflict', 'Recovery Required'].includes(this.cache.status)) this.cache.status = 'Sync Required';
    await this.persist();
  }
  async auto(status: AutoStatus): Promise<void> {
    const previous = JSON.stringify({ ...this.cache.auto, scheduledAt: undefined });
    this.cache.auto = { ...status };
    if (previous === JSON.stringify({ ...status, scheduledAt: undefined })) { this.changed(); return; }
    await this.persist();
  }
  async failure(_error: unknown, recovery: boolean): Promise<void> { if (_error) this.live.error = safeError(_error); this.cache.status = recovery ? 'Recovery Required' : 'Offline'; await this.persist(); }
  async recoveryCleared(): Promise<void> { this.live.error = undefined; this.live.review = true; this.cache.status = 'Sync Required'; await this.persist(); }
  private mergeDevices(devices: DeviceInfo[]) {
    const byId = new Map(this.cache.devices.map(d => [d.deviceId, d]));
    for (const d of devices) byId.set(d.deviceId, d);
    byId.set(this.cache.currentDevice.deviceId, this.cache.currentDevice);
    this.cache.devices = [...byId.values()].sort((a, b) => a.deviceName.localeCompare(b.deviceName));
  }
  async preview(preview: SyncPreview, capture: Capture, revision: number, target: RepositoryTarget): Promise<void> {
    const peers: DeviceInfo[] = [];
    const reports = capture.remote.entries.filter(e => e.path.startsWith(DEVICE_REPORT_ROOT) && e.path.endsWith('.json'));
    for (const entry of reports.slice(0, 100)) {
      try {
        if (entry.type !== 'blob' || entry.mode !== '100644' || entry.size === undefined || entry.size > 4096) throw new Error();
        let device = this.peerBlobs.get(entry.sha);
        if (!device) {
          const blob = await capture.client.get(`blobs/${entry.sha}`, 'DEVICE_REPORT') as { content: string; sha: string; encoding: string; size: number };
          if (blob.sha !== entry.sha || blob.encoding !== 'base64' || blob.size !== entry.size || typeof blob.content !== 'string' || blob.content.length > 8192) throw new Error();
          const bytes = decodeBytes(blob.content);
          if (bytes.length !== entry.size || gitBlobSha(bytes) !== entry.sha) throw new Error();
          device = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as DeviceInfo;
          if (!validDevice(device)) throw new Error(); this.peerBlobs.set(entry.sha, device);
        }
        if (entry.path !== `${DEVICE_REPORT_ROOT}${device.deviceId}.json`) throw new Error();
        peers.push(device);
      } catch { this.cache.warning = 'Some device reports are unavailable. File sync decisions are unaffected.'; }
    }
    const key = targetKey(target);
    if (this.cache.targetKey && this.cache.targetKey !== key) this.cache.devices = [];
    this.cache.targetKey = key;
    this.mergeDevices(peers);
    this.cache.localFiles = preview.plan.localCount; this.cache.remoteFiles = preview.plan.remoteCount;
    this.cache.lastCheckAt = new Date().toISOString();
    this.cache.status = preview.plan.hasConflicts ? 'Conflict'
      : preview.mode !== 'SYNC' || !preview.state.baseManifest || !preview.state.lastSuccessfulSyncAt || revision !== this.revision
        || preview.plan.remoteGeneration !== preview.state.baseManifest.generation
        || preview.plan.entries.some(e => /^(PUSH|PULL)_/.test(e.category)) ? 'Sync Required' : 'Healthy';
    this.live.review = preview.mode !== 'SYNC' || !preview.canExecute || preview.requiresDeleteConfirmation;
    this.live.generation = preview.plan.remoteGeneration ?? preview.state.baseManifest?.generation;
    await this.persist();
  }
  prepare(t: SyncTransaction, entries: SyncDecision[]): Observation {
    const timestamp = new Date().toISOString();
    return { timestamp, ...changeCounts(entries), device: { ...this.cache.currentDevice, deviceId: t.originalState.deviceId, lastSyncAt: timestamp, lastGeneration: t.manifest.generation } };
  }
  async verified(t: SyncTransaction): Promise<void> {
    const observation = t.observation ?? { timestamp: new Date().toISOString(), ...changeCounts([]), device: this.cache.currentDevice };
    const record: HistoryRecord = { transactionId: t.id, timestamp: observation.timestamp, deviceId: t.originalState.deviceId,
      generationBefore: t.originalState.baseManifest?.generation ?? 0, generationAfter: t.manifest.generation, commitSha: t.commit,
      addCount: observation.addCount, updateCount: observation.updateCount, deleteCount: observation.deleteCount, renameCount: observation.renameCount, verifyResult: 'PASS' };
    if (t.observation) {
      await this.appendHistory(record);
      this.records = [record, ...this.records.filter(r => r.transactionId !== record.transactionId)].slice(0, 100);
    } else this.cache.warning = 'Recovered a V1.0 transaction. Its original operation counts were not recorded; no historical counts were invented.';
    this.cache.currentDevice = { ...this.cache.currentDevice, deviceId: t.originalState.deviceId, lastSyncAt: record.timestamp, lastGeneration: record.generationAfter };
    this.mergeDevices([this.cache.currentDevice]); this.cache.targetKey = targetKey(t.options);
    this.cache.status = 'Healthy'; this.cache.lastVerifiedAt = record.timestamp; this.cache.lastCheckAt = new Date().toISOString();
    this.cache.localFiles = Object.keys(t.after).length; this.cache.remoteFiles = Object.keys(t.after).length;
    await this.persist();
  }
  private async index(): Promise<string[]> {
    const raw = await this.storage.read(INDEX); if (raw === null) return [];
    try { const paths: unknown = JSON.parse(raw); if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !/^\.sync-history\/history-\d{8}-\d{6}(?:-[a-f0-9-]+)?\.json$/.test(p))) throw new Error(); return paths as string[]; }
    catch { throw storageError(); }
  }
  private async appendHistory(record: HistoryRecord): Promise<void> {
    const index = await this.index();
    const stamp = record.timestamp.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    let path = `.sync-history/history-${stamp}.json`;
    const existing = await this.storage.read(path);
    if (existing !== null && (JSON.parse(existing) as HistoryRecord).transactionId !== record.transactionId) path = `.sync-history/history-${stamp}-${record.transactionId}.json`;
    const contents = JSON.stringify(record, null, 2);
    const saved = await this.storage.read(path);
    if (saved !== null && saved !== contents) throw storageError();
    if (saved === null) await this.write(path, contents);
    if (!index.includes(path)) await this.write(INDEX, JSON.stringify([...index, path]));
  }
  async history(limit = 100): Promise<HistoryRecord[]> {
    const records: HistoryRecord[] = [];
    for (const path of (await this.index()).slice(-limit).reverse()) {
      const raw = await this.storage.read(path);
      try {
        if (raw === null) throw new Error(); const r = JSON.parse(raw) as HistoryRecord;
        if (r.verifyResult !== 'PASS' || !date(r.timestamp) || !/^[a-f0-9]{40}$/.test(r.commitSha) || !['addCount', 'updateCount', 'deleteCount', 'renameCount', 'generationBefore', 'generationAfter'].every(k => Number.isSafeInteger(r[k as keyof HistoryRecord]) && Number(r[k as keyof HistoryRecord]) >= 0)) throw new Error();
        records.push(r);
      } catch { throw storageError(); }
    }
    return records;
  }
  private persist(): Promise<void> {
    const contents = JSON.stringify({ ...this.cache, auto: { ...this.cache.auto, scheduledAt: undefined } }); this.changed();
    const next = this.queue.then(() => this.write(CACHE, contents)); this.queue = next.catch(() => {}); return next;
  }
  private async write(path: string, contents: string): Promise<void> {
    try { await this.storage.write(path, contents); if (await this.storage.read(path) !== contents) throw new Error(); }
    catch { throw storageError(); }
  }
}

export function dashboardState(state: LocalSyncState | undefined, cache: ProductCache, target: RepositoryTarget) {
  const matches = cache.targetKey === targetKey(target);
  const status: Health = cache.status === 'Recovery Required' ? 'Recovery Required'
    : cache.status === 'Offline' && (matches || !cache.targetKey) ? 'Offline'
    : !state?.baseManifest || !matches ? 'Sync Required' : cache.status;
  const sameBaseTarget = state?.target && targetKey(state.target) === targetKey(target);
  return { ...cache, status, generation: sameBaseTarget ? state?.baseManifest?.generation : undefined,
    lastVerifiedAt: matches ? cache.lastVerifiedAt ?? state?.lastSuccessfulSyncAt : sameBaseTarget ? state?.lastSuccessfulSyncAt : undefined,
    localFiles: matches ? cache.localFiles : undefined, remoteFiles: matches ? cache.remoteFiles : undefined };
}
