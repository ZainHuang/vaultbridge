import { PreviewError, safeError } from '../errors';
import type { Settings } from '../settings/settings';
import type { SyncPreview } from '../sync/execution/SyncService';

export interface AutoStatus { scheduledAt?: number; result: string; lastCheckAt?: string; lastSyncAt?: string; reason?: string }
interface AutoHost {
  settings(): Settings;
  busy(): boolean;
  check(): Promise<{ preview: SyncPreview; block?: string }>;
  execute(preview: SyncPreview): Promise<void>;
  status(status: AutoStatus): unknown;
}

/** Event-driven, single-flight scheduling. No polling or automatic recovery/resolution. */
export class AutoSyncController {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running = false;
  private pending = false;
  private manual = false;
  private state: AutoStatus = { result: 'Waiting for changes' };
  constructor(private readonly host: AutoHost, initial?: AutoStatus) {
    if (initial) this.state = { ...initial };
    this.manual = initial?.result === 'Manual confirmation required';
  }
  changed(): void {
    if (this.stopped || !this.host.settings().autoSync || this.manual) return;
    this.pending = true;
    this.schedule();
  }
  private schedule(): void {
    clearTimeout(this.timer);
    this.state.scheduledAt = Date.now() + this.host.settings().autoSyncDebounceSeconds * 1000;
    this.reportSchedule();
    this.timer = setTimeout(() => { void this.run(); }, this.host.settings().autoSyncDebounceSeconds * 1000);
  }
  private reportSchedule(): void {
    void Promise.resolve(this.host.status({ ...this.state })).catch(() => { this.manual = true; clearTimeout(this.timer); });
  }
  configure(): void {
    clearTimeout(this.timer);
    this.state.scheduledAt = undefined; this.reportSchedule();
    if (this.host.settings().autoSync && this.pending && !this.manual) this.schedule();
  }
  reviewed(): void {
    this.manual = false; this.state.result = 'Waiting for changes'; this.state.reason = undefined;
    void Promise.resolve(this.host.status({ ...this.state })).catch(() => { this.manual = true; });
  }
  stop(): void { this.stopped = true; this.pending = false; clearTimeout(this.timer); this.state.scheduledAt = undefined; this.reportSchedule(); }
  async run(): Promise<void> {
    clearTimeout(this.timer); this.state.scheduledAt = undefined;
    if (this.stopped || !this.host.settings().autoSync || this.manual) return;
    if (this.running || this.host.busy()) { this.pending = true; this.schedule(); return; }
    this.running = true; this.pending = false;
    const settingsKey = JSON.stringify(this.host.settings());
    this.state = { ...this.state, lastCheckAt: new Date().toISOString(), result: 'Checking', reason: undefined };
    try {
      await this.host.status({ ...this.state });
      const { preview, block } = await this.host.check();
      if (this.stopped || !this.host.settings().autoSync) return;
      if (settingsKey !== JSON.stringify(this.host.settings())) throw new PreviewError('AUTO', 'SETTINGS_CHANGED', 'Settings changed during automatic Preview. Review the new plan.');
      if (block) { this.manual = true; this.state.result = 'Manual confirmation required'; this.state.reason = block; }
      else if (!preview.plan.entries.some(e => /^(PUSH|PULL)_/.test(e.category))) this.state.result = 'Up to date';
      else {
        this.state.result = 'Syncing'; await this.host.status({ ...this.state });
        await this.host.execute(preview);
        this.state.result = 'Verified'; this.state.lastSyncAt = new Date().toISOString();
      }
    } catch (error) {
      const offline = error instanceof PreviewError && /^(HTTP_|NETWORK)/.test(error.code);
      this.manual = !offline;
      this.state.result = offline ? 'Offline' : 'Manual confirmation required';
      this.state.reason = safeError(error);
    } finally {
      this.running = false;
      // A reporting failure must never start an unhandled background rejection.
      if (!this.stopped) { try { await this.host.status({ ...this.state }); } catch { this.manual = true; } }
      if (this.pending && !this.stopped && !this.manual && this.host.settings().autoSync) this.schedule();
    }
  }
}
