import { PreviewError } from '../errors';
import { RemoteManifestReader } from '../github/RemoteManifestReader';
import type { GetTransport } from '../github/types';
import type { Progress, VaultReader } from '../vault/VaultScanner';
import { ThreeWaySyncPlanner } from './planner/ThreeWaySyncPlanner';
import type { ThreeWayPlan } from './planner/SyncDecision';
import { parseLocalState } from './state/LocalStateStore';
import type { LocalSyncState } from './state/LocalSyncState';
import type { PreviewOptions } from './PreviewService';
import { PreviewSnapshotReader } from './PreviewSnapshotReader';

export interface StatefulPreviewResult { state: LocalSyncState; plan: ThreeWayPlan }
export class StatefulPreviewService {
  constructor(private readonly reader: VaultReader, private readonly transport: GetTransport, private readonly configDir: string,
    private readonly currentState: () => LocalSyncState) {}
  async preview(options: PreviewOptions, token: string, progress: Progress = () => {}, signal?: AbortSignal): Promise<StatefulPreviewResult> {
    const state = parseLocalState(this.currentState());
    if (state.baseManifest && (!state.target || state.target.owner.toLowerCase() !== options.owner.toLowerCase()
      || state.target.repository.toLowerCase() !== options.repository.toLowerCase() || state.target.branch !== options.branch)) {
      throw new PreviewError('LOCAL_STATE', 'LOCAL_STATE_TARGET_MISMATCH', 'The synchronized base does not belong to this repository and branch. Review the device state before Preview.');
    }
    const capture = await new PreviewSnapshotReader(this.reader, this.transport, this.configDir).read(options, token, progress, signal);
    progress('Reading pinned remote sync manifest');
    let remoteManifest: unknown;
    let manifestFailure: PreviewError | undefined;
    try { remoteManifest = await new RemoteManifestReader(capture.client).read(capture.remote, signal); }
    catch (error) {
      if (!(error instanceof PreviewError) || error.code !== 'REMOTE_MANIFEST_INVALID') throw error;
      remoteManifest = { invalid: true };
      manifestFailure = error;
    }
    await capture.verify();
    if (JSON.stringify(this.currentState()) !== JSON.stringify(state)) throw new PreviewError('LOCAL_STATE', 'LOCAL_STATE_CHANGED', 'Local sync metadata changed during Preview. Run Preview again.');
    progress('Comparing BASE / LOCAL / REMOTE');
    const plan = new ThreeWaySyncPlanner().create({ base: state.baseManifest ?? null, local: capture.local,
      remote: capture.remote, remoteManifest, localFiles: state.localFiles }, capture.ignore);
    if (manifestFailure && plan.status === 'REMOTE_MANIFEST_INVALID') plan.reason = manifestFailure.message;
    return { state, plan };
  }
}
