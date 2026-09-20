import { Modal, type App } from 'obsidian';
import type LocalMirrorSyncPlugin from '../main';

/** Subscribes through the plugin's existing ProductStore callback; no IO. */
export class ActivityPanel extends Modal {
  private elapsed?: HTMLElement;
  private details?: HTMLElement;
  private heading?: HTMLElement;
  private signature = '';
  constructor(app: App, private readonly plugin: LocalMirrorSyncPlugin) { super(app); }
  onOpen(): void {
    this.modalEl.addClasses(['lms-modal', 'lms-activity-dialog']); this.setTitle('Sync activity');
    this.contentEl.addClass('lms-activity-panel');
    this.heading = this.contentEl.createEl('p', { cls: 'lms-activity-health', attr: { role: 'status', 'aria-live': 'polite' } });
    this.elapsed = this.contentEl.createEl('p', { cls: 'lms-muted lms-activity-elapsed' });
    this.details = this.contentEl.createDiv();
    const actions = this.contentEl.createDiv({ cls: 'lms-device-actions' });
    actions.createEl('button', { text: 'Review in Preview' }).onclick = () => { this.close(); this.plugin.openPreview(); };
    actions.createEl('button', { text: 'Recovery' }).onclick = () => { this.close(); this.plugin.openRecovery(); };
    actions.createEl('button', { text: 'Dashboard' }).onclick = () => { this.close(); void this.plugin.openDashboard(); };
    this.render();
  }
  render(): void {
    if (!this.details?.isConnected) return;
    const a = this.plugin.product.activitySnapshot(); const cache = this.plugin.product.snapshot();
    const indicator = this.plugin.activityStatus();
    this.heading?.setText(indicator.label);
    this.elapsed?.setText(a.startedAt === undefined ? 'Elapsed —' : `Elapsed ${Math.max(0, Math.floor(((a.endedAt ?? Date.now()) - a.startedAt) / 1000))}s`);
    this.contentEl.querySelectorAll<HTMLButtonElement>('.lms-device-actions button').forEach(b => { b.disabled = a.running && b.textContent !== 'Dashboard'; });
    const error = a.error ?? cache.auto.reason;
    const signature = JSON.stringify([a, error, cache.currentDevice.lastGeneration]);
    if (signature === this.signature) return; this.signature = signature;
    const el = this.details; el.empty();
    const current = el.createDiv({ cls: 'lms-activity-current', attr: { role: 'status', 'aria-live': 'polite' } });
    current.createEl('strong', { text: a.stage ?? (a.running ? 'Starting sync activity…' : 'No activity in this session.') });
    if (a.total !== undefined && a.processed !== undefined) current.createEl('span', { text: `${a.processed} / ${a.total} files`, cls: 'lms-muted' });
    const fields = el.createEl('dl', { cls: 'lms-dashboard-fields' });
    fields.createEl('dt', { text: 'Generation' }); fields.createEl('dd', { text: String(a.generation ?? cache.currentDevice.lastGeneration ?? 'No BASE') });
    if (a.transactionId) { fields.createEl('dt', { text: 'Transaction' }); fields.createEl('dd', { text: a.transactionId }); }
    if (error) el.createEl('p', { text: `Recent error / review: ${error}`, cls: 'lms-warning lms-activity-error' });
    if (a.steps.length) {
      const steps = el.createEl('ol', { cls: 'lms-activity-steps', attr: { 'aria-label': 'Observed lifecycle stages' } });
      a.steps.forEach((step, i) => {
        const last = i === a.steps.length - 1;
        const state = last ? a.error ? 'Stopped' : a.running ? 'In progress' : 'Finished' : 'Done';
        const row = steps.createEl('li', { attr: { 'data-state': state } });
        row.createEl('span', { text: step.stage }); row.createEl('span', { text: state, cls: 'lms-muted' });
      });
    }
    el.createEl('p', { text: 'Only observed stages are shown. File counts appear when known; no estimated percentage.', cls: 'lms-muted' });
  }
  onClose(): void { this.contentEl.empty(); this.signature = ''; }
}
