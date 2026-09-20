import type { PreviewOptions } from '../sync/PreviewService';

export interface Settings extends PreviewOptions {
  secretName: string;
  localToken: string;
  autoSync: boolean;
  autoSyncDebounceSeconds: number;
  autoSyncDeleteThreshold: number;
  autoSyncChangeThreshold: number;
  deviceName: string;
  deviceType: string;
}
export const DEFAULT_SETTINGS: Settings = {
  owner: '', repository: '', branch: 'main', secretName: '', localToken: '',
  includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 20,
  autoSync: false, autoSyncDebounceSeconds: 30, autoSyncDeleteThreshold: 5, autoSyncChangeThreshold: 20,
  deviceName: '', deviceType: '',
};

export function loadSettings(data: unknown): Settings {
  const settings = { ...DEFAULT_SETTINGS };
  if (!data || typeof data !== 'object') return settings;
  for (const key of ['owner', 'repository', 'branch', 'secretName', 'localToken', 'ignorePatterns'] as const) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === 'string') settings[key] = value;
  }
  const stored = data as Record<string, unknown>;
  if (typeof stored.includeObsidian === 'boolean') settings.includeObsidian = stored.includeObsidian;
  if (typeof stored.autoSync === 'boolean') settings.autoSync = stored.autoSync;
  for (const key of ['deviceName', 'deviceType'] as const) if (typeof stored[key] === 'string' && stored[key].length <= (key === 'deviceName' ? 80 : 40)) settings[key] = stored[key];
  for (const key of ['autoSyncDebounceSeconds', 'autoSyncDeleteThreshold', 'autoSyncChangeThreshold'] as const) {
    const n = stored[key]; const min = key === 'autoSyncDeleteThreshold' ? 0 : 1;
    if (Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= 86400) settings[key] = n as number;
  }
  if (Number.isSafeInteger(stored.deleteSafetyThreshold) && (stored.deleteSafetyThreshold as number) >= 0) settings.deleteSafetyThreshold = stored.deleteSafetyThreshold as number;
  return settings;
}
