import { PreviewError } from '../errors';
import { NEAR_EMPTY_LOCAL_LIMIT, SIGNIFICANT_FILE_COUNT } from '../sync/InitializationGate';
import type { PreviewResult } from '../sync/PreviewResult';
import { newDeviceState, parseDeviceState, type DeviceState } from './DeviceState';

export const PRIMARY_CONFIRMATION = 'USE LOCAL AS PRIMARY';
export const DEVICE_STATE_FILENAME = 'device-state.json';
export interface DeviceStateStorage { read(): Promise<string | null>; write(contents: string): Promise<void> }

export function primaryDeclarationBlock(preview: PreviewResult): string | undefined {
  if (preview.gate.status === 'BLOCK_SUSPICIOUS_EMPTY_LOCAL') return 'Restore the expected local files before changing device authority.';
  if (preview.deviceState.initializationState !== 'UNINITIALIZED') return 'This device is already initialized. Declaring it again cannot reset its safety baseline.';
  if (preview.plan.localCount === 0) return 'Add or restore your complete local files before declaring Local Primary. An empty local Vault cannot establish device authority.';
  if (preview.plan.localCount <= NEAR_EMPTY_LOCAL_LIMIT && preview.plan.remoteCount >= SIGNIFICANT_FILE_COUNT) {
    return 'An empty or nearly empty local Vault cannot be declared Primary over an existing remote Vault. Initialize from GitHub when Restore is available, or restore your complete local files first.';
  }
  if (preview.plan.hasConflicts) return 'Resolve the reported path conflicts before declaring Local Primary.';
  return undefined;
}

export class StateStore {
  private state?: DeviceState;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: DeviceStateStorage) {}

  async load(): Promise<DeviceState> {
    let contents: string | null;
    try { contents = await this.storage.read(); }
    catch { throw new PreviewError('DEVICE_STATE', 'READ_FAILED', 'Device state could not be read. Initialization is blocked.'); }
    let parsed: DeviceState | undefined;
    try { parsed = contents === null ? undefined : parseDeviceState(JSON.parse(contents)); } catch { /* Corrupt state fails closed. */ }
    if (parsed) this.state = parsed;
    else await this.persist(newDeviceState());
    return this.current();
  }

  current(): DeviceState {
    if (!this.state) throw new PreviewError('DEVICE_STATE', 'NOT_LOADED', 'Device state is unavailable.');
    return { ...this.state };
  }

  private async persist(next: DeviceState): Promise<DeviceState> {
    try {
      const contents = JSON.stringify(next, null, 2);
      await this.storage.write(contents);
      if (await this.storage.read() !== contents) throw new Error('read-back mismatch');
      this.state = { ...next };
      return this.current();
    } catch {
      // Never continue with a trusted in-memory state after uncertain persistence.
      this.state = undefined;
      throw new PreviewError('DEVICE_STATE', 'SAVE_FAILED', 'Device state could not be saved and read back. Initialization remains blocked. Reload the plugin after fixing local storage.');
    }
  }

  private update(mutate: (state: DeviceState) => DeviceState): Promise<DeviceState> {
    const pending = this.queue.then(() => this.persist(mutate(this.current())));
    this.queue = pending.catch(() => {});
    return pending;
  }

  recordSuccessfulPreview(preview: PreviewResult): Promise<DeviceState> {
    return this.update(state => {
      if (state.deviceId !== preview.deviceState.deviceId) throw new PreviewError('DEVICE_STATE', 'STALE_DEVICE', 'The device identity changed. Run Preview again.');
      // Audit only: blocked/diagnostic scans never lower or establish a trusted baseline.
      return { ...state, lastSuccessfulPreviewAt: preview.plan.createdAt };
    });
  }

  declareLocalPrimary(phrase: string, preview: PreviewResult, validateFreshness: () => void = () => {}): Promise<DeviceState> {
    return this.update(state => {
      if (phrase !== PRIMARY_CONFIRMATION) throw new PreviewError('INITIALIZATION', 'CONFIRMATION_REQUIRED', `Type ${PRIMARY_CONFIRMATION} exactly.`);
      if (state.deviceId !== preview.deviceState.deviceId || state.initializationState !== preview.deviceState.initializationState) {
        throw new PreviewError('INITIALIZATION', 'STALE_PREVIEW', 'Device state changed. Run Preview again.');
      }
      const block = primaryDeclarationBlock(preview);
      if (block) throw new PreviewError('INITIALIZATION', 'DECLARATION_BLOCKED', block);
      validateFreshness();
      return { ...state, initializationState: 'INITIALIZED_AS_PRIMARY', initializationMode: 'local-primary',
        initializationTimestamp: new Date().toISOString(), lastVerifiedLocalFileCount: preview.plan.localCount };
    });
  }
  // No initialize-from-remote method exists in Phase 1.5. Restore + Verify must own it later.
}
