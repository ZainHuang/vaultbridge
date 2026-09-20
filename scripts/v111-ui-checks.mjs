import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function verifyV111({ page, remote, report, runDir, preview, sync, close, state, surface, getUI, inject, setDropPatch }) {
  const capture = async name => { await getUI().screenshot({ path: join(runDir, `${name}.png`) }); report.screenshots.push(`${name}.png`); };
  const dashboard = async () => {
    await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openDashboard());
    await surface('.lms-dashboard:visible .lms-recovery-panel');
    await getUI().locator('.lms-recovery-panel').getByText(/^(Healthy|Pending Recovery)$/).waitFor();
  };
  const active = () => page.evaluate(() => app.plugins.plugins['local-mirror-sync'].sync.transactions.active());
  const original = await state();
  await dashboard();
  assert.match(await getUI().locator('.lms-recovery-panel').innerText(), /Recovery Status\s+Healthy/);
  report.checks.push('Empty dashboard shows Recovery Status Healthy from local transaction storage');
  // Fail before publication using the existing production HTTP transport boundary.
  await page.evaluate(() => {
    const plugin = app.plugins.plugins['local-mirror-sync']; const transport = plugin.sync.transport;
    plugin.sync.transport = req => window.__failRecoveryBlobs && req.method === 'POST' && req.url.endsWith('/blobs')
      ? Promise.resolve({ status: 403, json: {} }) : transport(req);
    window.__failRecoveryBlobs = true;
  });
  await preview(); await getUI().getByRole('button', { name: 'Sync & Verify', exact: true }).click();
  await getUI().getByRole('button', { name: 'Abort Transaction', exact: true }).waitFor();
  const pending = await active(); assert.equal(pending.phase, 'prepared');
  await close(); await dashboard();
  const panel = await getUI().locator('.lms-recovery-panel').innerText();
  for (const label of ['Pending Recovery', 'Transaction ID', pending.id, 'Phase', 'Created Time', 'Repository', 'test-owner/test-repository']) assert(panel.includes(label));
  const reads = remote.calls.length; await dashboard(); assert.equal(remote.calls.length, reads);
  await capture('v111-01-pending-dashboard');
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openPreview());
  await surface('.lms-modal');
  await getUI().getByRole('button', { name: 'Review Recovery', exact: true }).waitFor();
  assert.equal(await getUI().getByRole('button', { name: 'Retry Preview', exact: true }).count(), 0);
  for (const name of ['Resume Transaction', 'Abort Transaction']) assert.equal(await getUI().getByRole('button', { name, exact: true }).count(), 1);
  await capture('v111-02-blocked-preview');
  report.checks.push('Pending dashboard shows transaction details without HTTP; blocked Preview offers Review/Resume/Abort and no Retry Preview');
  await getUI().getByRole('button', { name: 'Review Recovery', exact: true }).click();
  await surface('.lms-recovery-dialog');
  await getUI().getByRole('button', { name: 'Abort Transaction', exact: true }).waitFor();
  await getUI().setViewportSize({ width: 390, height: 844 });
  assert(await getUI().locator('.lms-recovery-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await capture('v111-03-recovery-mobile');
  const head = remote.head; const count = remote.calls.length;
  // Even damaged state must not be repaired by Abort.
  await page.evaluate(() => { app.plugins.plugins['local-mirror-sync'].stateError = new Error('injected state diagnostic'); });
  await getUI().getByRole('button', { name: 'Abort Transaction', exact: true }).click();
  await getUI().getByText('Transaction aborted. Recovery backups retained. Run Preview again.', { exact: true }).waitFor();
  assert.equal(await active(), null); assert.equal(remote.head, head);
  assert(remote.calls.slice(count).every(c => c.method === 'GET')); assert.deepEqual(await state(), original);
  assert.equal(await page.evaluate(() => app.vault.adapter.read('note.md')), '# Original\nWindows note');
  assert.equal(await page.evaluate(() => app.vault.adapter.exists('.local-mirror-sync/transactions/active.json')), false);
  assert.equal(await page.evaluate(id => app.vault.adapter.exists(`.local-mirror-sync/transactions/${id}/journal.json`), pending.id), true);
  await page.evaluate(() => { const p = app.plugins.plugins['local-mirror-sync']; p.stateError = undefined; window.__failRecoveryBlobs = false; p.recoveryModal.close(); });
  await dashboard(); assert.match(await getUI().locator('.lms-recovery-panel').innerText(), /Healthy/);
  report.checks.push('390px Recovery Abort deletes only active pointer, retains journal and backups, makes GET-only calls, preserves user notes and BASE even with a state error');
  await preview(); await sync(); await close();
  const beforeRecovery = await state();
  await page.evaluate(async () => { await app.vault.modify(app.vault.getAbstractFileByPath('note.md'), '# Published recovery'); });
  setDropPatch(true); await preview(); await getUI().getByRole('button', { name: 'Sync & Verify', exact: true }).click();
  await getUI().getByRole('button', { name: 'Review Recovery', exact: true }).waitFor(); setDropPatch(false);
  const publishedHead = remote.head; await close();
  await page.evaluate(async () => { await app.plugins.unloadPlugin('local-mirror-sync'); await app.plugins.enablePlugin('local-mirror-sync'); }); await inject();
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openRecovery()); await surface('.lms-recovery-dialog');
  await getUI().getByRole('button', { name: 'Abort Transaction', exact: true }).waitFor();
  await getUI().getByRole('button', { name: 'Abort Transaction', exact: true }).click();
  await getUI().getByText(/RECOVERY_ENV_CHANGED/).waitFor();
  assert(await active()); assert.equal(remote.head, publishedHead); assert.deepEqual(await state(), beforeRecovery);
  await capture('v111-04-published-abort-blocked');
  await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).click();
  await surface('.lms-summary');
  assert.equal(await active(), null); assert.equal(remote.head, publishedHead); assert((await state()).baseManifest.generation > beforeRecovery.baseManifest.generation);
  await capture('v111-05-resumed');
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].recoveryModal.close());
  await dashboard(); assert.match(await getUI().locator('.lms-recovery-panel').innerText(), /Healthy/);
  report.checks.push('Lost publish response survives reload; Abort reports RECOVERY_ENV_CHANGED without mutations, Resume verifies the original published commit and clears recovery');
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openRecovery()); await surface('.lms-recovery-dialog');
  await getUI().getByText('No pending sync. You can run Preview again.', { exact: true }).waitFor();
  report.checks.push('Empty Recovery dialog provides a fresh Preview action after completion');
}
