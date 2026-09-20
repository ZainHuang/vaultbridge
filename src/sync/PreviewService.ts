import { PreviewSnapshotReader } from './PreviewSnapshotReader';
import type { GetTransport, RepositoryTarget } from '../github/types';
import type { Progress, VaultReader } from '../vault/VaultScanner';
import { SyncPlanner } from './SyncPlanner';
import { newDeviceState, type DeviceState } from '../state/DeviceState';
import { InitializationGate } from './InitializationGate';
import type { PreviewResult } from './PreviewResult';

export interface PreviewOptions extends RepositoryTarget {
  includeObsidian: boolean;
  ignorePatterns: string;
  deleteSafetyThreshold: number;
}

/** Retained legacy regression seam. The shipped command uses StatefulPreviewService. */
export class PreviewService {
  private readonly fallbackState = newDeviceState();
  constructor(private readonly reader: VaultReader, private readonly transport: GetTransport, private readonly configDir: string,
    private readonly deviceState: () => DeviceState = () => this.fallbackState) {}

  async preview(options: PreviewOptions, token: string, progress: Progress = () => {}, signal?: AbortSignal): Promise<PreviewResult> {
    const deviceState = { ...this.deviceState() };
    const capture = await new PreviewSnapshotReader(this.reader, this.transport, this.configDir).read(options, token, progress, signal);
    await capture.verify();
    const { local, remote, ignore } = capture;
    progress('Checking device initialization');
    const gate = new InitializationGate().evaluate(local, remote, deviceState, ignore);
    progress('Building local → GitHub plan');
    const plan = new SyncPlanner().create(local, remote, ignore, options, options.deleteSafetyThreshold);
    return { deviceState, gate, plan, executionAllowed: gate.status === 'ALLOW' && !plan.hasConflicts };
  }
}
