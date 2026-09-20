import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type LocalMirrorSyncPlugin from '../main';
import { dashboardState, type HistoryRecord } from '../product/ProductStore';
import { safeError } from '../errors';
import { recoveryActions, recoveryDetails } from './RecoveryUI';
import type { SyncTransaction } from '../sync/execution/TransactionStore';

export const DASHBOARD_VIEW = 'local-mirror-sync-dashboard';
export const HISTORY_VIEW = 'local-mirror-sync-history';
const time = (value?: string) => value ? new Date(value).toLocaleString() : 'Not yet';
const relative = (value?: string) => {
  if (!value) return 'No change observed';
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes} minutes ago` : `${Math.floor(minutes / 60)} hours ago`;
};
function fields(parent: HTMLElement, values: [string, string][]) {
  const list = parent.createEl('dl', { cls: 'lms-dashboard-fields' });
  for (const [label, value] of values) { list.createEl('dt', { text: label }); list.createEl('dd', { text: value }); }
}
function historyRow(parent: HTMLElement, record: HistoryRecord) {
  const row = parent.createEl('article', { cls: 'lms-history-record' });
  row.createEl('h3', { text: time(record.timestamp) });
  fields(row, [['Commit', record.commitSha], ['Changes', `+${record.addCount}  ~${record.updateCount}  -${record.deleteCount}  Rename ${record.renameCount}`],
    ['Generation', `${record.generationBefore} → ${record.generationAfter}`], ['Verify', record.verifyResult]]);
}

export class DashboardView extends ItemView {
  private revision = 0;
  private signature = '';
  constructor(leaf: WorkspaceLeaf, private readonly plugin: LocalMirrorSyncPlugin, private readonly historyOnly = false) { super(leaf); }
  getViewType(): string { return this.historyOnly ? HISTORY_VIEW : DASHBOARD_VIEW; }
  getDisplayText(): string { return this.historyOnly ? 'Sync History' : 'VaultBridge Dashboard'; }
  getIcon(): string { return this.historyOnly ? 'history' : 'refresh-cw'; }
  async onOpen(): Promise<void> { this.signature = ''; this.render(); }
  async onClose(): Promise<void> { ++this.revision; }
  render(): void {
    const revision = ++this.revision;
    // Keep the last complete view visible while local metadata is read. Progress
    // notifications must not remove buttons/focus or flash a loading state.
    if (!this.contentEl.childElementCount) {
      this.contentEl.createEl('h1', { text: this.getDisplayText() });
      this.contentEl.createEl('p', { text: 'Loading cached sync state…', attr: { role: 'status' } });
    }
    this.contentEl.addClass('lms-dashboard');
    if (!this.plugin.product) return;
    if (this.historyOnly || this.plugin.sync.running) { this.renderSnapshot(revision); return; }
    // Opening/refreshing the view remains local-only, with stale reads discarded.
    void this.plugin.sync.transactions.active().then(t => this.renderSnapshot(revision, t))
      .catch(error => this.renderSnapshot(revision, null, safeError(error)));
  }
  private renderSnapshot(revision: number, transaction: SyncTransaction | null = null, error?: string): void {
    if (revision !== this.revision || !this.contentEl.isConnected) return;
    const el = document.createElement('div');
    el.createEl('h1', { text: this.getDisplayText() });
    const history = this.plugin.product.cachedHistory();
    if (this.historyOnly) {
      el.createEl('p', { text: 'Saved on this device in .sync-history/. Latest 100 verified transactions.', cls: 'lms-muted' });
      el.createEl('button', { text: 'Open Dashboard' }).onclick = () => { void this.plugin.openDashboard(); };
      this.history(el, history); this.commitView(el); return;
    }
    let local; try { local = this.plugin.syncState.current(); } catch { /* Show recovery instead of inventing BASE. */ }
    const d = dashboardState(local, this.plugin.product.snapshot(), this.plugin.settings);
    const health = el.createDiv({ cls: 'lms-status lms-dashboard-health', attr: { role: 'status', 'aria-live': 'polite' } });
    health.createEl('strong', { text: d.status });
    health.createEl('p', { text: `Last verified: ${time(d.lastVerifiedAt)} · Last check: ${time(d.lastCheckAt)}` });
    el.createEl('p', { text: 'Cached on this device. Open Preview to check GitHub. No background polling.', cls: 'lms-muted' });
    if (d.warning || this.plugin.productError) el.createEl('p', { text: d.warning ?? 'Dashboard/history storage is unavailable. Review local storage and recovery.', cls: 'lms-warning' });
    const actions = el.createDiv({ cls: 'lms-device-actions' });
    actions.createEl('button', { text: 'Sync History' }).onclick = () => { void this.plugin.openDashboard(true); };
    const recovery = el.createEl('section', { cls: 'lms-recovery-panel' });
    recovery.createEl('h2', { text: 'Recovery Status' });
    const running = this.plugin.sync.running;
    recovery.createEl('p', { text: running ? 'Sync in progress' : transaction || error ? 'Pending Recovery' : 'Healthy', attr: { role: 'status', 'aria-live': 'polite' } });
    if (!running && (transaction || error)) {
      if (transaction) recoveryDetails(recovery, transaction);
      if (error) recovery.createEl('p', { text: error, cls: 'lms-warning' });
      recoveryActions(recovery, action => this.plugin.openRecovery(action));
    } else if (!running) {
      actions.createEl('button', { text: 'Review in Preview', cls: 'mod-cta' }).onclick = () => this.plugin.openPreview();
      actions.createEl('button', { text: 'Recovery' }).onclick = () => this.plugin.openRecovery();
    }
    const grid = el.createDiv({ cls: 'lms-dashboard-grid' });
    const repository = grid.createEl('section'); repository.createEl('h2', { text: 'Repository' });
    fields(repository, [['Repository', this.plugin.settings.owner && this.plugin.settings.repository ? `${this.plugin.settings.owner}/${this.plugin.settings.repository}` : 'Not configured'],
      ['Branch', this.plugin.settings.branch], ['Generation', String(d.generation ?? 'No BASE')]]);
    const files = grid.createEl('section'); files.createEl('h2', { text: 'Files' });
    fields(files, [['Local files', String(d.localFiles ?? 'Not checked')], ['Remote files', String(d.remoteFiles ?? 'Not checked')], ['Last change', relative(d.lastChangeAt)]]);
    const auto = grid.createEl('section'); auto.createEl('h2', { text: 'Auto Sync Status' });
    fields(auto, [['Auto Sync', this.plugin.settings.autoSync ? 'Enabled' : 'Disabled'], ['Last check', time(d.auto.lastCheckAt)], ['Last sync', time(d.auto.lastSyncAt)], ['Result', d.auto.result]]);
    if (d.auto.reason) auto.createEl('p', { text: d.auto.reason, cls: 'lms-warning' });
    const current = grid.createEl('section'); current.createEl('h2', { text: 'Current Device' });
    fields(current, [['Device', d.currentDevice.deviceName], ['Device ID', d.currentDevice.deviceId], ['Type', d.currentDevice.deviceType], ['Last Sync', time(d.currentDevice.lastSyncAt)]]);
    const devices = el.createEl('section'); devices.createEl('h2', { text: 'Devices' });
    devices.createEl('p', { text: 'Other devices show their last published sync report, refreshed during Preview. Their local Verify result and online status are not observed here.', cls: 'lms-muted' });
    for (const device of d.devices) {
      const row = devices.createDiv({ cls: 'lms-device-row' });
      row.createEl('strong', { text: device.deviceName });
      row.createEl('span', { text: `${device.deviceType} · Generation ${device.lastGeneration ?? 'Not synced'}` });
      row.createEl('span', { text: `Last sync: ${time(device.lastSyncAt)}` });
    }
    el.createEl('h2', { text: 'Sync History' }); this.history(el, history.slice(0, 5));
    this.commitView(el);
  }
  private commitView(next: HTMLElement): void {
    // Compare rendered output, not activity counters or invisible timestamps.
    // This also preserves focus/scroll when the displayed data is unchanged.
    const signature = next.innerHTML;
    if (signature === this.signature) return;
    const scrollTop = this.contentEl.scrollTop;
    this.contentEl.replaceChildren(...Array.from(next.childNodes));
    this.contentEl.scrollTop = scrollTop;
    this.signature = signature;
  }
  private history(el: HTMLElement, records: HistoryRecord[]) {
    if (!records.length) el.createEl('p', { text: 'No verified sync history on this device.', cls: 'lms-empty' });
    else for (const record of records) historyRow(el, record);
  }
}
