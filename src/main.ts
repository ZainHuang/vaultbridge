import { ActivityPanel } from './ui/ActivityPanel';
import { activityIndicator } from './product/SyncActivity';
import { Modal, Platform, Plugin, requestUrl, setIcon } from 'obsidian';
import { PreviewError, safeError } from './errors';
import { SettingsTab } from './settings/SettingsTab';
import { DEFAULT_SETTINGS, loadSettings, type Settings } from './settings/settings';
import { TokenStore } from './settings/TokenStore';
import { SyncService } from './sync/execution/SyncService';
import { isLegacyPublished } from './sync/execution/LegacyPublishedRecovery';
import { PreviewModal } from './ui/PreviewModal';
import { obsidianSyncVault } from './vault/ObsidianSyncVault';
import { LOCAL_SYNC_STATE_FILENAME, LocalStateStore } from './sync/state/LocalStateStore';
import { AutoSyncController } from './product/AutoSyncController';
import { ProductStore, dashboardState } from './product/ProductStore';
import { obsidianProductStorage } from './product/ObsidianProductStorage';
import { DashboardView, DASHBOARD_VIEW, HISTORY_VIEW } from './ui/DashboardView';
import { IgnoreService } from './vault/IgnoreService';
import { recoveryDetails, type RecoveryAction } from './ui/RecoveryUI';

export default class LocalMirrorSyncPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  tokens!: TokenStore;
  syncState!: LocalStateStore;
  sync!: SyncService;
  product!: ProductStore;
  productError?: unknown;
  auto!: AutoSyncController;
  stateError?: unknown;
  private metadataPending: Promise<unknown> = Promise.resolve();
  private previewModal?: PreviewModal;
  private recoveryModal?: Modal;
  private statusBar?: HTMLElement;
  private activityRibbon?: HTMLElement;
  private activityPanel?: ActivityPanel;
  private activityClock?: number;
  private reviewing = false;
  private unloaded = false;
  private productPending: Promise<unknown> = Promise.resolve();
  private readonly autoSettings = new WeakMap<object, string>();

  async onload(): Promise<void> {
    this.settings = loadSettings(await this.loadData());
    if (!this.settings.deviceName) this.settings.deviceName = Platform.isIosApp ? 'iPhone' : Platform.isAndroidApp ? 'Android' : Platform.isWin ? 'Windows-PC' : Platform.isMacOS ? 'MacBook' : 'Desktop';
    if (!this.settings.deviceType) this.settings.deviceType = Platform.isMobile ? 'mobile' : 'desktop';
    this.tokens = new TokenStore(this.app.secretStorage);
    const statePath = `${this.app.vault.configDir}/plugins/local-mirror-sync/${LOCAL_SYNC_STATE_FILENAME}`;
    const adapter = this.app.vault.adapter;
    this.syncState = new LocalStateStore({
      read: async () => await adapter.exists(statePath) ? adapter.read(statePath) : null,
      write: contents => adapter.write(statePath, contents),
    });
    try { await this.syncState.load(); } catch (error) { this.stateError = error; }
    this.product = new ProductStore(obsidianProductStorage(this.app.vault), () => this.refreshDashboard());
    try {
      await this.product.load(this.stateError ? '00000000-0000-4000-8000-000000000000' : this.syncState.current().deviceId, this.settings.deviceName, this.settings.deviceType);
    } catch (error) { this.productError = error; }
    this.sync = new SyncService(obsidianSyncVault(this.app.vault), async request => {
      const response = await requestUrl(request);
      return { status: response.status, json: response.status >= 200 && response.status < 300 ? response.json : null };
    }, this.app.vault.configDir, this.syncState, this.product);
    this.registerView(DASHBOARD_VIEW, leaf => new DashboardView(leaf, this));
    this.registerView(HISTORY_VIEW, leaf => new DashboardView(leaf, this, true));
    if (!Platform.isMobile) {
      this.statusBar = this.addStatusBarItem(); this.statusBar.addClass('lms-activity-entry');
      this.statusBar.setAttribute('role', 'button'); this.statusBar.tabIndex = 0;
      this.statusBar.onclick = () => this.openActivity();
      this.statusBar.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.openActivity(); } };
    }
    this.auto = new AutoSyncController({
      settings: () => this.settings, busy: () => this.sync.running || this.reviewing,
      check: async () => {
        await this.metadataPending; await this.productPending;
        if (this.stateError || this.productError) throw this.stateError ?? this.productError;
        const settings = { ...this.settings };
        try {
          const preview = await this.sync.preview(this.syncOptions(), this.tokens.read(settings));
          this.autoSettings.set(preview, JSON.stringify(settings));
          return { preview, block: this.sync.autoBlock(preview, settings) };
        } catch (error) { await this.recordFailure(error); throw error; }
      },
      execute: async preview => {
        await this.metadataPending;
        if (this.reviewing || !this.settings.autoSync || this.autoSettings.get(preview) !== JSON.stringify(this.settings)) throw new PreviewError('AUTO', 'SETTINGS_CHANGED', 'Automatic sync paused because settings or manual review changed.');
        if (this.stateError || this.productError) throw this.stateError ?? this.productError;
        const block = this.sync.autoBlock(preview, this.settings);
        if (block) throw new PreviewError('AUTO', 'MANUAL_REQUIRED', block);
        try { await this.sync.execute(preview, this.tokens.read(this.settings)); }
        catch (error) { await this.recordFailure(error); throw error; }
      },
      status: status => this.product.auto(status),
    }, this.product.snapshot().auto);
    try { if (this.stateError || await this.sync.transactions.active()) await this.product.failure(this.stateError, true); }
    catch (error) { await this.recordFailure(error); }
    this.addSettingTab(new SettingsTab(this.app, this));
    const track = (work: () => Promise<unknown>) => {
      if (!this.stateError && !this.sync.executing) this.metadataPending = this.metadataPending.then(work).catch(error => { this.stateError = error; });
    };
    const userPath = (path: string) => !new IgnoreService({ configDir: this.app.vault.configDir, includeObsidian: this.settings.includeObsidian, patterns: this.settings.ignorePatterns, gitignore: '' }).reason(path);
    // Preserve V1 identity tracking even for user-ignored notes: a later scope
    // review still needs the recorded rename/delete evidence.
    const identityPath = (path: string) => !['.local-mirror-sync', '.sync-history', this.app.vault.configDir].some(dir => path === dir || path.startsWith(`${dir}/`));
    const dirty = () => {
      this.productPending = this.productPending.then(() => this.product.dirty()).catch(error => { this.productError = error; this.refreshDashboard(); });
      this.auto.changed();
    };
    this.registerEvent(this.app.vault.on('create', file => { if (identityPath(file.path)) track(() => this.syncState.recordCreate(file.path)); if (userPath(file.path)) dirty(); }));
    this.registerEvent(this.app.vault.on('modify', file => { if (userPath(file.path)) dirty(); }));
    this.registerEvent(this.app.vault.on('delete', file => { if (identityPath(file.path)) track(() => this.syncState.recordDelete(file.path)); if (userPath(file.path)) dirty(); }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (identityPath(oldPath) && identityPath(file.path)) track(() => this.syncState.recordRename(oldPath, file.path));
      if (userPath(oldPath) || userPath(file.path)) dirty();
    }));
    this.addCommand({ id: 'preview-sync', name: 'Preview Sync', callback: () => this.openPreview() });
    this.addCommand({ id: 'sync', name: 'Sync (review first)', callback: () => this.openPreview() });
    this.addCommand({ id: 'verify-sync', name: 'Verify Sync (read-only)', callback: () => this.openPreview(true) });
    this.addCommand({ id: 'initialize', name: 'Initialize / Adopt Vault', callback: () => this.openPreview() });
    this.addCommand({ id: 'recover-sync', name: 'Recover interrupted sync', callback: () => this.openRecovery() });
    this.addCommand({ id: 'dashboard', name: 'Open Dashboard', callback: () => { void this.openDashboard(); } });
    this.addCommand({ id: 'sync-history', name: 'Sync History', callback: () => { void this.openDashboard(true); } });
    this.activityRibbon = this.addRibbonIcon('refresh-cw', 'VaultBridge activity', () => this.openActivity());
    this.activityRibbon.addClass('lms-activity-ribbon');
    this.refreshDashboard();
    // Opening the app does not scan. Saved Auto Sync reacts to subsequent Vault events.
  }

  private syncOptions() {
    const { owner, repository, branch, includeObsidian, ignorePatterns, deleteSafetyThreshold } = this.settings;
    return { owner, repository, branch, includeObsidian, ignorePatterns, deleteSafetyThreshold };
  }
  private async recordFailure(error: unknown): Promise<void> {
    let recovery = !!this.stateError;
    try { recovery ||= !!await this.sync.transactions.active(); } catch { recovery = true; }
    try { await this.product.failure(error, recovery); } catch (e) { this.productError = e; this.refreshDashboard(); }
  }
  refreshDashboard(): void {
    if (this.unloaded || !this.product) return;
    try {
      this.refreshActivity();
      for (const type of [DASHBOARD_VIEW, HISTORY_VIEW]) for (const leaf of this.app.workspace.getLeavesOfType(type)) if (leaf.view instanceof DashboardView) leaf.view.render();
    } catch { /* View may open while the local cache is loading. */ }
  }
  activityStatus() {
    let state; try { state = this.syncState.current(); } catch { /* Recovery is represented by the product cache. */ }
    return activityIndicator(dashboardState(state, this.product.snapshot(), this.settings), this.product.activitySnapshot(), Date.now(),
      this.stateError || this.productError ? safeError(this.stateError ?? this.productError) : undefined);
  }
  private refreshActivity(): void {
    if (this.unloaded || !this.product) return;
    const status = this.activityStatus();
    for (const entry of [this.statusBar, this.activityRibbon]) {
      if (!entry) continue;
      const label = `VaultBridge: ${status.label}`;
      entry.setAttribute('aria-label', label); entry.setAttribute('title', label);
      entry.toggleClass('lms-activity-running', status.animated);
      entry.toggleClass('lms-activity-attention', status.destination !== 'activity' || status.label === 'Error');
      if (entry === this.statusBar) {
        let icon = entry.querySelector<HTMLElement>('.lms-activity-icon');
        if (!icon) { icon = entry.createSpan({ cls: 'lms-activity-icon' }); entry.createSpan({ cls: 'lms-activity-label' }); }
        const iconName = status.animated ? 'refresh-cw' : status.label === 'Healthy' || status.label === 'Synced & verified' ? 'check' : 'circle-alert';
        if (icon.dataset.icon !== iconName) { setIcon(icon, iconName); icon.dataset.icon = iconName; }
        entry.querySelector('.lms-activity-label')!.textContent = status.label;
      }
    }
    this.activityPanel?.render();
    // Clock redraws only. No lifecycle events, persistence, scans or requests.
    const a = this.product.activitySnapshot();
    const needsClock = a.running || this.product.snapshot().auto.scheduledAt !== undefined || a.verified && Date.now() - (a.endedAt ?? 0) < 4000;
    if (needsClock && this.activityClock === undefined) this.activityClock = window.setInterval(() => this.refreshActivity(), 1000);
    else if (!needsClock && this.activityClock !== undefined) { window.clearInterval(this.activityClock); this.activityClock = undefined; }
  }
  openActivity(): void {
    const destination = this.activityStatus().destination;
    if (destination === 'recovery') this.openRecovery();
    else if (destination === 'preview') this.openPreview();
    else this.openActivityPanel();
  }
  openActivityPanel(): void {
    this.activityPanel?.close(); this.activityPanel = new ActivityPanel(this.app, this); this.activityPanel.open();
  }

  async openDashboard(history = false): Promise<void> {
    const type = history ? HISTORY_VIEW : DASHBOARD_VIEW;
    const leaf = this.app.workspace.getLeavesOfType(type)[0] ?? this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type, active: true }); await this.app.workspace.revealLeaf(leaf);
  }

  openPreview(verifyOnly = false): void {
    if (this.sync.running) return;
    this.previewModal?.close();
    this.reviewing = true;
    const { owner, repository, branch, includeObsidian, ignorePatterns, deleteSafetyThreshold } = this.settings;
    const options = { owner, repository, branch, includeObsidian, ignorePatterns, deleteSafetyThreshold };
    const settings = { ...this.settings };
    const settingsKey = JSON.stringify(settings);
    this.previewModal = new PreviewModal(this.app, options, async (progress, signal) => {
      await this.metadataPending;
      await this.productPending;
      if (this.stateError) throw this.stateError;
      if (JSON.stringify(this.settings) !== settingsKey) throw new PreviewError('SETTINGS', 'SETTINGS_CHANGED', 'Settings changed. Reopen Preview to use the new target and ignore rules.');
      let result;
      try { result = await this.sync.preview(options, this.tokens.read(settings), progress, signal); }
      catch (error) { await this.recordFailure(error); throw error; }
      // Content is hashed twice by PreviewSnapshotReader; a delayed filesystem
      // notification for unchanged bytes must not invalidate a verified snapshot.
      if (JSON.stringify(this.settings) !== settingsKey) throw new PreviewError('SETTINGS', 'SETTINGS_CHANGED', 'Settings changed during Preview. Run Preview again.');
      return result;
    }, verifyOnly ? undefined : {
      execute: async (result, progress, signal, confirmation) => {
        await this.metadataPending;
        if (this.stateError) throw this.stateError;
        if (JSON.stringify(this.settings) !== settingsKey) throw new PreviewError('SETTINGS', 'SETTINGS_CHANGED', 'Settings changed. Refresh Preview.');
        try { await this.sync.execute(result, this.tokens.read(settings), progress, signal, confirmation); this.auto.reviewed(); }
        catch (error) { try { this.syncState.current(); } catch (stateError) { this.stateError = stateError; } await this.recordFailure(error); throw error; }
      },
      resolve: (result, key, choice) => this.sync.resolve(result, key, choice),
      resolveAll: (result, choice) => this.sync.resolveAll(result, choice),
      selectAdoption: (result, choice) => this.sync.selectAdoption(result, choice),
      inspect: (result, entry) => this.sync.inspect(result, entry, this.tokens.read(settings)),
      recover: action => this.openRecovery(action),
      recoveryPending: async () => !!await this.sync.transactions.active(),
    }, action => this.openRecovery(action));
    const onClose = this.previewModal.onClose.bind(this.previewModal);
    this.previewModal.onClose = () => { onClose(); this.reviewing = false; };
    this.previewModal.open();
  }

  async saveSettings(settings: Settings, token?: string): Promise<void> {
    if (this.sync.running) throw new PreviewError('SETTINGS', 'SYNC_RUNNING', 'Wait for the running sync before changing settings.');
    const saved = token === undefined ? { ...settings } : this.tokens.withToken(settings, token);
    try { await this.saveData(saved); }
    catch { throw new PreviewError('SETTINGS', 'SAVE_FAILED', 'Settings could not be saved.'); }
    this.settings = saved;
    await this.product.configure(saved.deviceName, saved.deviceType);
    this.auto.configure(); this.refreshDashboard();
  }

  openRecovery(intent?: RecoveryAction): void {
    if (this.sync.running) return;
    this.previewModal?.close();
    this.recoveryModal?.close();
    this.reviewing = true;
    const modal = new Modal(this.app); this.recoveryModal = modal; modal.modalEl.addClasses(['lms-modal', 'lms-recovery-dialog']); modal.setTitle('Sync recovery');
    let closed = false;
    modal.onClose = () => { closed = true; this.reviewing = false; };
    const status = modal.contentEl.createEl('p', { text: 'Checking pending transaction…', cls: 'lms-status lms-recovery-status', attr: { role: 'status' } });
    void this.sync.transactions.active().then(t => {
      if (closed) return;
      const freshPreview = () => { modal.close(); this.openPreview(); };
      if (!t) {
        status.setText('No pending sync. You can run Preview again.');
        modal.contentEl.createEl('button', { text: 'Preview again' }).onclick = freshPreview;
        return;
      }
      status.setText('Pending Recovery');
      recoveryDetails(modal.contentEl, t);
      if (isLegacyPublished(t)) modal.contentEl.createEl('p', { text: 'Legacy recovery only verifies current content. If main is the published commit or its descendant, matching current Local bytes, Remote Tree and Manifest rebuild this device’s BASE at current HEAD. Differences offer a fresh Preview with BASE unchanged and the old recovery retained for audit. Diverged history stays blocked.', cls: 'lms-muted' });
      modal.contentEl.createEl('p', { text: `Recovery folder: .local-mirror-sync/transactions/${t.id}`, cls: 'lms-head' });
      if (t.backupRef) modal.contentEl.createEl('p', { text: `GitHub backup: ${t.backupRef}\nOriginal HEAD: ${t.originalHead}`, cls: 'lms-head lms-recovery-status' });
      modal.contentEl.createEl('p', { text: 'Resume verifies the published commit, Tree and Manifest before completing BASE. Published Push and Use Local Adoption preserve later Local edits for a new Preview. Transactions with local PULL writes must still pass Local verification. Reopening this dialog resumes interrupted work.', cls: 'lms-muted' });
      modal.contentEl.createEl('p', { text: 'Abort is allowed only before publication while the main branch HEAD is unchanged. Recovery backups are retained; user files, BASE and GitHub are not changed.', cls: 'lms-muted' });
      const actions = modal.contentEl.createDiv({ cls: 'lms-device-actions' });
      let running = false;
      const run = async (action: 'resume' | 'abort' | 'fresh-preview') => {
        if (running) return; running = true;
        const discard = action === 'abort';
        actions.querySelector('.lms-recovery-fresh')?.remove();
        actions.querySelectorAll('button').forEach(b => { b.disabled = true; });
        status.setText(discard ? 'Checking Abort safety…' : action === 'fresh-preview' ? 'Rechecking current HEAD before starting fresh Preview…' : 'Checking recovery environment…');
        try {
          await this.metadataPending;
          if (!discard && this.stateError) {
            try { await this.syncState.load(); }
            catch {
              if (isLegacyPublished(t)) throw new PreviewError('RECOVERY', 'LEGACY_LOCAL_STATE_UNAVAILABLE', 'Existing local state cannot be read. It has been preserved; legacy recovery cannot replace an unverified BASE.');
              const statePath = `${this.app.vault.configDir}/plugins/local-mirror-sync/${LOCAL_SYNC_STATE_FILENAME}`;
              const backupPath = `${this.sync.transactions.directory(t.id)}/damaged-local-state-${crypto.randomUUID()}.json`;
              const damaged = await this.app.vault.adapter.read(statePath);
              await this.app.vault.adapter.write(backupPath, damaged);
              if (await this.app.vault.adapter.read(backupPath) !== damaged) throw new PreviewError('RECOVERY', 'BACKUP_FAILED', 'Damaged state could not be preserved.');
              await this.syncState.save(t.originalState);
            }
            this.stateError = undefined;
          }
          if (discard) { await this.sync.abortTransaction(this.settings, this.tokens.read(this.settings), t); await this.product.recoveryCleared(); }
          else if (action === 'fresh-preview') {
            await this.sync.startFreshPreviewFromCurrentHead(this.settings, this.tokens.read(this.settings), text => { if (!closed) status.setText(text); }, t);
          } else {
            await this.sync.resume(this.settings, this.tokens.read(this.settings), text => { if (!closed) status.setText(text); }, t);
            if (this.product.snapshot().status === 'Recovery Required') await this.product.recoveryCleared();
          }
          this.auto.reviewed(); this.productError = undefined; this.refreshDashboard();
          if (!closed) {
            if (action === 'fresh-preview' || action === 'resume' && !isLegacyPublished(t)) { freshPreview(); return; }
            status.setText(discard ? 'Transaction aborted. Recovery backups retained. Run Preview again.' : 'Recovery completed. Run Preview to inspect the current state.');
            actions.empty(); actions.createEl('button', { text: 'Preview again', cls: 'mod-cta' }).onclick = freshPreview;
          }
        } catch (error) {
          await this.recordFailure(error);
          if (!closed) {
            status.setText(safeError(error)); actions.querySelectorAll('button').forEach(b => { b.disabled = false; });
            status.scrollIntoView({ block: 'nearest' });
            abort.disabled = t.phase !== 'prepared';
            if (error instanceof PreviewError && error.code === 'LEGACY_CURRENT_STATE_DIFFERS')
              actions.createEl('button', { text: 'Start fresh Preview from current HEAD', cls: 'lms-recovery-fresh' }).onclick = () => { void run('fresh-preview'); };
            if (error instanceof PreviewError && error.code === 'RECOVERY_ENV_CHANGED' && !actions.querySelector('.lms-recovery-preview'))
              actions.createEl('button', { text: 'Preview again', cls: 'lms-recovery-preview' }).onclick = freshPreview;
          }
        } finally { running = false; }
      };
      actions.createEl('button', { text: 'Resume Transaction', cls: 'mod-cta' }).onclick = () => { void run('resume'); };
      const abort = actions.createEl('button', { text: 'Abort Transaction' });
      abort.disabled = t.phase !== 'prepared';
      abort.onclick = () => { void run('abort'); };
      if (abort.disabled) modal.contentEl.createEl('p', { text: 'Abort unavailable: this transaction may already be published or applied. Resume Transaction to finish verification.', cls: 'lms-warning' });
      if (intent === 'resume') void run('resume');
      else if (intent === 'abort' && !abort.disabled) void run('abort');
    }).catch(error => { if (!closed) status.setText(safeError(error)); });
    modal.open();
  }

  onunload(): void { this.unloaded = true; window.clearInterval(this.activityClock); this.activityPanel?.close(); this.auto?.stop(); this.sync?.stop(); this.previewModal?.close(); this.recoveryModal?.close(); }
}
