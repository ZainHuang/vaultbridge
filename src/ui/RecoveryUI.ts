import type { SyncTransaction } from '../sync/execution/TransactionStore';

export type RecoveryAction = 'resume' | 'abort';
export function recoveryActions(parent: HTMLElement, open: (action?: RecoveryAction) => void) {
  const actions = parent.createDiv({ cls: 'lms-device-actions' });
  actions.createEl('button', { text: 'Review Recovery' }).onclick = () => open();
  actions.createEl('button', { text: 'Resume Transaction', cls: 'mod-cta' }).onclick = () => open('resume');
  actions.createEl('button', { text: 'Abort Transaction' }).onclick = () => open('abort');
}
export function recoveryDetails(parent: HTMLElement, t: SyncTransaction) {
  const created = t.createdAt ?? t.observation?.timestamp;
  const values = [['Transaction ID', t.id], ['Phase', t.phase],
    ['Created Time', created && Number.isFinite(Date.parse(created)) ? new Date(created).toLocaleString() : 'Unavailable (legacy transaction)'],
    ['Repository', `${t.options.owner}/${t.options.repository}`], ['Branch', t.options.branch]];
  const fields = parent.createEl('dl', { cls: 'lms-dashboard-fields' });
  for (const [label, value] of values) { fields.createEl('dt', { text: label }); fields.createEl('dd', { text: value }); }
}
