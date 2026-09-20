export type DeviceInitializationState = 'UNINITIALIZED' | 'INITIALIZED_FROM_REMOTE' | 'INITIALIZED_AS_PRIMARY';

export interface DeviceState {
  deviceId: string;
  initializationState: DeviceInitializationState;
  initializationTimestamp?: string;
  initializationMode?: 'remote-bootstrap' | 'local-primary';
  lastVerifiedRemoteCommit?: string;
  lastSuccessfulPreviewAt?: string;
  lastVerifiedLocalFileCount?: number;
}

export function newDeviceState(): DeviceState {
  return { deviceId: crypto.randomUUID(), initializationState: 'UNINITIALIZED' };
}

/** Settings and legacy sync history are never initialization evidence. */
export function parseDeviceState(value: unknown): DeviceState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (typeof data.deviceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.deviceId)) return undefined;
  if (!['UNINITIALIZED', 'INITIALIZED_FROM_REMOTE', 'INITIALIZED_AS_PRIMARY'].includes(String(data.initializationState))) return undefined;
  const state: DeviceState = { deviceId: data.deviceId, initializationState: data.initializationState as DeviceInitializationState };
  const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
  if (data.lastSuccessfulPreviewAt !== undefined) {
    if (!date(data.lastSuccessfulPreviewAt)) return undefined;
    state.lastSuccessfulPreviewAt = data.lastSuccessfulPreviewAt;
  }
  if (state.initializationState === 'UNINITIALIZED') return state;
  if (!date(data.initializationTimestamp) || !Number.isSafeInteger(data.lastVerifiedLocalFileCount) || (data.lastVerifiedLocalFileCount as number) < 0) return undefined;
  const expectedMode = state.initializationState === 'INITIALIZED_AS_PRIMARY' ? 'local-primary' : 'remote-bootstrap';
  if (data.initializationMode !== expectedMode) return undefined;
  state.initializationTimestamp = data.initializationTimestamp;
  state.initializationMode = expectedMode;
  state.lastVerifiedLocalFileCount = data.lastVerifiedLocalFileCount as number;
  if (data.lastVerifiedRemoteCommit !== undefined) {
    if (typeof data.lastVerifiedRemoteCommit !== 'string' || !/^[0-9a-f]{40}$/.test(data.lastVerifiedRemoteCommit)) return undefined;
    state.lastVerifiedRemoteCommit = data.lastVerifiedRemoteCommit;
  }
  if (state.initializationState === 'INITIALIZED_FROM_REMOTE' && !state.lastVerifiedRemoteCommit) return undefined;
  return state;
}
