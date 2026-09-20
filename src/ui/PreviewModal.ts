import { Modal, type App } from 'obsidian';
import { PreviewError, safeError } from '../errors';
import { recoveryActions, type RecoveryAction } from './RecoveryUI';
import { keepModalAboveKeyboard } from './MobileModalViewport';
import type { RepositoryTarget } from '../github/types';
import type { SyncDecision, ThreeWayPlan } from '../sync/planner/SyncDecision';
import { PREVIEW_GROUPS, decisionGroup, previewGroups, canExecutePreview, repositoryBlocked, type PreviewGroup } from './PreviewModel';
import type { Progress } from '../vault/VaultScanner';
import type { StatefulPreviewResult } from '../sync/StatefulPreviewService';
import type { SyncPreview } from '../sync/execution/SyncService';
import type { Resolution } from '../sync/execution/ExecutionPlan';

type RunPreview = (progress: Progress, signal: AbortSignal) => Promise<StatefulPreviewResult>;
export interface SyncActions {
  execute(result: SyncPreview, progress: Progress, signal: AbortSignal, confirmation: string): Promise<void>;
  resolve(result: SyncPreview, key: string, choice: Resolution): SyncPreview;
  selectAdoption(result: SyncPreview, choice: Resolution): SyncPreview;
  inspect(result: SyncPreview, entry: SyncDecision): Promise<string>;
  recover(action?: RecoveryAction): void;
  recoveryPending?(): Promise<boolean>;
}

export class PreviewModal extends Modal {
  private controller?: AbortController;
  private plan?: ThreeWayPlan;
  private filter: PreviewGroup | 'ALL' = 'ALL';
  private query = '';
  private page = 0;
  private rowsEl!: HTMLElement;
  private countEl!: HTMLElement;
  private result?: SyncPreview;
  private executing = false;
  private releaseViewport?: () => void;

  constructor(app: App, private readonly target: RepositoryTarget & { deleteSafetyThreshold?: number }, private readonly run: RunPreview, private readonly actions?: SyncActions,
    private readonly recover?: (action?: RecoveryAction) => void) { super(app); }

  onOpen(): void {
    this.modalEl.addClass('lms-modal');
    this.setTitle('VaultBridge');
    this.releaseViewport = keepModalAboveKeyboard(this);
    void this.load();
  }

  onClose(): void {
    this.releaseViewport?.();
    if (!this.executing) this.controller?.abort();
    this.contentEl.empty();
  }

  private header(): void {
    const el = this.contentEl;
    el.empty();
    el.createEl('p', { text: this.actions ? 'V1.1 · Stateful Three-Way Sync' : 'Stateful Three-Way Sync · Preview only', cls: 'lms-subtitle' });
    const info = el.createEl('dl', { cls: 'lms-meta' });
    for (const [label, value] of [['Remote', `${this.target.owner}/${this.target.repository}`], ['Branch', this.target.branch]]) {
      info.createEl('dt', { text: label });
      info.createEl('dd', { text: value || 'Not configured' });
    }
  }

  private async load(): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.plan = undefined;
    this.result = undefined;
    this.filter = 'ALL'; this.query = ''; this.page = 0;
    this.header();
    const status = this.contentEl.createEl('p', { text: 'Preparing Preview…', cls: 'lms-status', attr: { role: 'status', 'aria-live': 'polite' } });
    this.contentEl.createEl('p', { text: 'Reading file bytes and GitHub metadata. No files are changed.', cls: 'lms-muted' });
    const cancel = this.contentEl.createEl('button', { text: 'Cancel' });
    cancel.onclick = () => this.close();
    try {
      const result = await this.run(message => { if (!controller.signal.aborted) status.setText(message); }, controller.signal);
      if (controller.signal.aborted) return;
      this.plan = result.plan;
      this.renderPlan(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      this.header();
      this.contentEl.createEl('p', { text: 'Preview unavailable', cls: 'lms-error', attr: { role: 'alert' } });
      this.contentEl.createEl('p', { text: safeError(error), cls: 'lms-wrap' });
      this.contentEl.createEl('p', { text: 'No partial plan was generated. Local files and GitHub were not changed.', cls: 'lms-muted' });
      if (error instanceof PreviewError && error.code === 'REMOTE_MANIFEST_INVALID') this.reviewGuidance();
      const open = this.recover ?? this.actions?.recover;
      if (error instanceof PreviewError && error.code === 'RECOVERY_REQUIRED' && open) recoveryActions(this.contentEl, open);
      else {
        const retry = this.contentEl.createEl('button', { text: 'Retry Preview' });
        retry.onclick = () => { void this.load(); };
      }
    }
  }

  private reviewGuidance(): void {
    this.contentEl.createEl('p', { text: 'Review / Repair required: review the diagnostics against the pinned GitHub Tree, Manifest and device state. Back up the current HEAD and Manifest before an explicitly reviewed repair, then verify consistency and refresh Preview. No executable file plan is available.', cls: 'lms-repair-guidance lms-muted' });
  }

  private renderPlan(result: StatefulPreviewResult): void {
    const { plan } = result;
    this.plan = plan;
    this.result = 'mode' in result ? result as SyncPreview : undefined;
    this.header();
    const el = this.contentEl;
    const device = el.createDiv({ cls: 'lms-device-status', attr: { 'aria-label': 'Device Status' } });
    device.createEl('h3', { text: plan.deviceState });
    device.createEl('p', { text: `Device: ${result.state.deviceId}`, cls: 'lms-head' });
    device.createEl('p', { text: `Base generation: ${result.state.baseManifest?.generation ?? 'No sync history'} · Remote generation: ${plan.remoteGeneration ?? 'No manifest'}`, cls: 'lms-wrap' });
    device.createEl('p', { text: `Local files: ${plan.localCount} · Remote files: ${plan.remoteCount}` });
    if (repositoryBlocked(plan) || this.result?.mode === 'BLOCKED') {
      const banner = el.createDiv({ cls: 'lms-blocking-banner', attr: { role: 'alert' } });
      banner.createEl('strong', { text: plan.status, cls: 'lms-gate-code' });
      if (plan.reason) banner.createEl('p', { text: plan.reason });
      el.createEl('p', { text: `HEAD ${plan.remoteHeadSha}`, cls: 'lms-head' });
      this.reviewGuidance();
      const footer = el.createDiv({ cls: 'lms-footer' });
      if (this.actions) footer.createEl('button', { text: 'Sync & Verify', cls: 'mod-cta lms-execute' }).disabled = true;
      footer.createEl('button', { text: 'Refresh Preview' }).onclick = () => { void this.load(); };
      footer.createEl('button', { text: 'Close' }).onclick = () => this.close();
      return;
    }
    if (this.result) {
      const messages: Record<string, string> = {
        INITIALIZE: 'Initialize GitHub: create the first Manifest from local files.',
        BOOTSTRAP: 'Initialize this device: download GitHub files and establish BASE after verification.',
        ADOPT: 'Legacy repository · No BASE or Manifest. Choose the file tree for generation 1. Later sync uses three-way conflicts.',
        ATTACH: 'Attach existing Vault: retain both sides and review overlapping paths before establishing BASE.',
        SCOPE_REVIEW: 'Ignore scope changed: review a union of both sides before using the new scope. No inferred deletions.',
      };
      if (messages[this.result.mode]) el.createEl('p', { text: messages[this.result.mode], cls: 'lms-status' });
      if (this.result.mode === 'ADOPT' && this.actions) {
        const prepared = this.result;
        const choices = el.createDiv({ cls: 'lms-device-actions lms-adoption-choices', attr: { 'aria-label': 'Legacy adoption authority' } });
        for (const choice of ['local', 'remote'] as const) {
          const button = choices.createEl('button', { text: choice === 'local' ? 'Use Local' : 'Use Remote', attr: { 'aria-pressed': String(prepared.adoptionChoice === choice) } });
          button.onclick = () => { this.filter = 'ALL'; this.query = ''; this.page = 0; this.renderPlan(this.actions!.selectAdoption(prepared, choice)); };
        }
        if (prepared.adoptionChoice) {
          const local = prepared.adoptionChoice === 'local';
          const counts = plan.counts;
          const impact = el.createDiv({ cls: 'lms-warning lms-adoption-impact', attr: { role: 'status', 'aria-live': 'polite' } });
          impact.createEl('strong', { text: local ? 'GitHub will match Local' : 'Local will match GitHub' });
          impact.createEl('p', { text: local
            ? `Upload ${counts.PUSH_ADD} · Overwrite remote ${counts.PUSH_UPDATE} · Delete remote ${counts.PUSH_DELETE}`
            : `Download ${counts.PULL_ADD} · Overwrite local ${counts.PULL_UPDATE} · Remove from active Vault ${counts.PULL_DELETE}` });
          impact.createEl('p', { text: 'Backup before changes: GitHub branch at old HEAD and verified local recovery copies. Ignored/protected files are excluded.', cls: 'lms-muted' });
        } else el.createEl('p', { text: 'Choose a side to review additions, overwrites and removals. Execution requires typed confirmation.', cls: 'lms-muted' });
      }
    }
    if (plan.status !== 'READY' && !this.result) {
      const bootstrap = plan.status === 'BOOTSTRAP_FROM_REMOTE' || plan.status === 'INITIALIZE_REMOTE_FROM_LOCAL';
      const banner = el.createDiv({ cls: bootstrap ? 'lms-status' : 'lms-blocking-banner', attr: { role: bootstrap ? 'status' : 'alert' } });
      banner.createEl('strong', { text: plan.status, cls: 'lms-gate-code' });
      if (plan.reason) banner.createEl('p', { text: plan.reason });
    }
    el.createEl('p', { text: `HEAD ${plan.remoteHeadSha}`, cls: 'lms-head' });
    const groups = previewGroups(plan);
    const summary = el.createDiv({ cls: 'lms-summary', attr: { 'aria-label': 'Plan categories' } });
    const all = summary.createEl('button', { text: 'ALL', attr: { 'aria-pressed': 'true' } });
    all.onclick = () => this.selectCategory('ALL', summary, all);
    for (const group of PREVIEW_GROUPS) {
      const button = summary.createEl('button', { text: `${group} ${groups[group]}`, attr: { 'aria-pressed': 'false' } });
      button.onclick = () => this.selectCategory(group, summary, button);
    }
    el.createEl('p', { text: `Push ${groups.Push} · Pull ${groups.Pull} · Conflict ${groups.Conflict}`, cls: 'lms-operations' });
    const deletions = plan.counts.PUSH_DELETE + plan.counts.PULL_DELETE;
    if (deletions > (this.target.deleteSafetyThreshold ?? 20) && this.result?.mode !== 'ADOPT') el.createEl('p', { text: `Deletion review: ${plan.counts.PUSH_DELETE} remote and ${plan.counts.PULL_DELETE} local deletions suggested. Nothing will be deleted in Preview.`, cls: 'lms-warning' });
    if (plan.hasConflicts) el.createEl('p', { text: 'Conflicts require review. Both versions are preserved; no automatic winner is selected.', cls: 'lms-error' });
    if (plan.status === 'READY' && !groups.Push && !groups.Pull && !groups.Conflict) el.createEl('p', { text: 'No changes planned. The synchronized identities agree.', cls: 'lms-status' });
    if (this.result?.mode !== 'ADOPT' || !this.actions) el.createEl('p', { text: this.actions ? 'Review this snapshot before Sync. Files and BASE change only after you execute; recovery copies are retained locally.' : 'Preview only. No upload, download, deletion or sync-history advancement. Ignored files and internal metadata are outside the sync domain.', cls: 'lms-muted' });
    const label = el.createEl('label', { cls: 'lms-search-label', text: 'Filter by path' });
    const search = label.createEl('input', { type: 'search', placeholder: 'Search current and old paths', cls: 'lms-search' });
    search.oninput = () => { this.query = search.value.toLocaleLowerCase(); this.page = 0; this.renderRows(); };
    this.countEl = el.createDiv({ cls: 'lms-muted', attr: { 'aria-live': 'polite' } });
    this.rowsEl = el.createDiv({ cls: 'lms-table-wrap', attr: { 'aria-label': 'File plan' } });
    this.renderRows();
    const footer = el.createDiv({ cls: 'lms-footer' });
    if (this.result && this.actions) {
      const prepared = this.result;
      let confirmation: HTMLInputElement | undefined;
      const requiredConfirmation = !canExecutePreview(prepared) ? '' : prepared.adoptionChoice ? `USE ${prepared.adoptionChoice.toUpperCase()}`
        : prepared.requiresDeleteConfirmation && prepared.deletions > (this.target.deleteSafetyThreshold ?? 20) ? `DELETE ${prepared.deletions}` : '';
      if (requiredConfirmation) {
        const label = el.createEl('label', { text: prepared.adoptionChoice ? `Type ${requiredConfirmation} to confirm the adoption impact above` : `Type ${requiredConfirmation} to approve removed paths (including rename sources)`, cls: 'lms-search-label' });
        footer.before(label);
        confirmation = label.createEl('input', { cls: 'lms-confirm-input', attr: { 'aria-label': prepared.adoptionChoice ? 'Adoption confirmation' : 'Delete confirmation', autocomplete: 'off', spellcheck: 'false' } });
      }
      const execute = footer.createEl('button', { text: prepared.mode === 'ADOPT' ? 'Adopt & Verify' : 'Sync & Verify', cls: 'mod-cta lms-execute' });
      const enable = () => { execute.disabled = !canExecutePreview(prepared) || !!requiredConfirmation && confirmation?.value !== requiredConfirmation; };
      enable(); if (confirmation) confirmation.oninput = enable;
      execute.onclick = async () => {
        if (this.executing || execute.disabled || !canExecutePreview(prepared)) return;
        this.executing = true;
        this.contentEl.querySelectorAll('button, input').forEach(e => { (e as HTMLButtonElement).disabled = true; });
        const status = el.createEl('p', { text: 'Rechecking Preview…', cls: 'lms-status', attr: { role: 'status', 'aria-live': 'polite' } });
        try {
          await this.actions!.execute(prepared, text => status.setText(text), this.controller!.signal, confirmation?.value ?? '');
          this.header();
          this.contentEl.createEl('p', { text: 'Sync verified. BASE updated successfully.', cls: 'lms-status' });
          this.contentEl.createEl('button', { text: 'Preview again' }).onclick = () => { void this.load(); };
        } catch (error) {
          this.header();
          this.contentEl.createEl('p', { text: safeError(error), cls: 'lms-error', attr: { role: 'alert' } });
          this.contentEl.createEl('p', { text: 'BASE is updated only after verification. If a transaction started, its backups remain available for recovery.', cls: 'lms-muted' });
          let pending: boolean;
          try { pending = await this.actions!.recoveryPending?.() ?? false; } catch { pending = true; }
          if (pending) recoveryActions(this.contentEl, action => this.actions!.recover(action));
          else this.contentEl.createEl('button', { text: 'Refresh Preview' }).onclick = () => { void this.load(); };
        } finally { this.executing = false; }
      };
    }
    const refresh = footer.createEl('button', { text: 'Refresh Preview' });
    refresh.onclick = () => { void this.load(); };
    const close = footer.createEl('button', { text: 'Close' });
    close.onclick = () => this.close();
  }

  private selectCategory(category: PreviewGroup | 'ALL', summary: HTMLElement, selected: HTMLButtonElement): void {
    this.filter = category; this.page = 0;
    summary.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button === selected)));
    this.renderRows();
  }

  private renderRows(): void {
    if (!this.plan) return;
    const entries = this.plan.entries.filter(entry => (this.filter === 'ALL' || decisionGroup(entry.category) === this.filter)
      && `${entry.path}\n${entry.oldPath ?? ''}`.toLocaleLowerCase().includes(this.query));
    const start = this.page * 100;
    this.rowsEl.empty();
    this.countEl.setText(entries.length ? `${start + 1}–${Math.min(start + 100, entries.length)} of ${entries.length} entries` : '0 entries');
    if (!entries.length) this.rowsEl.createEl('p', { text: 'No files match this filter.', cls: 'lms-empty' });
    entries.slice(start, start + 100).forEach(entry => this.renderEntry(entry));
    if (entries.length > 100) {
      const pager = this.rowsEl.createDiv({ cls: 'lms-pager' });
      const previous = pager.createEl('button', { text: 'Previous 100' });
      previous.disabled = this.page === 0;
      previous.onclick = () => { this.page--; this.renderRows(); this.rowsEl.scrollTop = 0; };
      const next = pager.createEl('button', { text: 'Next 100' });
      next.disabled = start + 100 >= entries.length;
      next.onclick = () => { this.page++; this.renderRows(); this.rowsEl.scrollTop = 0; };
    }
  }

  private renderEntry(entry: SyncDecision): void {
    const details = this.rowsEl.createEl('details', { cls: 'lms-entry' });
    const summary = details.createEl('summary');
    summary.createSpan({ text: entry.category, cls: `lms-category lms-${entry.category.toLowerCase()}` });
    summary.createSpan({ text: entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path, cls: 'lms-path' });
    const body = details.createDiv({ cls: 'lms-entry-detail' });
    if (entry.reason) body.createEl('p', { text: entry.reason });
    if (entry.fileId) body.createEl('p', { text: `File ID: ${entry.fileId}`, cls: 'lms-head' });
    if (entry.baseSha) body.createEl('p', { text: `Base blob: ${entry.baseSha}`, cls: 'lms-head' });
    if (entry.localSha) body.createEl('p', { text: `Local blob: ${entry.localSha}`, cls: 'lms-head' });
    if (entry.remoteSha) body.createEl('p', { text: `Remote blob: ${entry.remoteSha}`, cls: 'lms-head' });
    if (entry.category.startsWith('CONFLICT_') && this.actions && this.result) {
      const current = this.result;
      const controls = body.createDiv({ cls: 'lms-device-actions' });
      controls.createEl('button', { text: 'Inspect both versions' }).onclick = async () => {
        const modal = new Modal(this.app); modal.modalEl.addClass('lms-modal'); modal.setTitle(entry.path);
        const content = modal.contentEl.createEl('pre', { text: 'Loading pinned versions…', cls: 'lms-compare' }); modal.open();
        try { content.setText(await this.actions!.inspect(current, entry)); } catch (error) { content.setText(safeError(error)); }
      };
      if (entry.category !== 'CONFLICT_IDENTITY_UNCERTAIN' && current.mode !== 'ADOPT') for (const choice of ['local', 'remote'] as const) {
        controls.createEl('button', { text: `Use ${choice.toUpperCase()}` }).onclick = () => {
          const resolved = this.actions!.resolve(current, entry.fileId ?? entry.path, choice);
          this.renderPlan(resolved);
        };
      }
      else if (entry.category === 'CONFLICT_IDENTITY_UNCERTAIN') body.createEl('p', { text: 'Identity or path ownership is ambiguous. Restore the tracked path or rename it inside Obsidian, then refresh. No side can be chosen automatically.', cls: 'lms-warning' });
    }
  }
}
