import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function verifyPublish({ page, remote, report, runDir, preview, sync, close, state, surface, getUI, inject, setDropPatch }) {
  assert.equal(await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].settings.autoSync), false);
  const oldHead = remote.head;
  await preview(); await sync();
  const completedHead = remote.head;
  assert.notEqual(completedHead, oldHead); assert.equal((await state()).baseRemoteCommit, completedHead);
  assert.equal(await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].sync.transactions.active()), null);
  assert.equal(remote.calls.filter(c => c.method === 'PATCH').length, 1);
  assert.equal(remote.calls.filter(c => c.method === 'POST' && c.resource === 'commits').length, 1);
  await getUI().screenshot({ path: join(runDir, 'publish-first-sync.png') }); report.screenshots.push('publish-first-sync.png');
  report.checks.push('Auto OFF, first manual Sync completes despite cacheable GET ref (max-age=60), one commit/PATCH, exact main HEAD and no Recovery');
  await close();
  await page.evaluate(async () => { await app.vault.modify(app.vault.getAbstractFileByPath('note.md'), '# Publish lost response'); });
  setDropPatch(true); await preview(); await getUI().getByRole('button', { name: 'Sync & Verify', exact: true }).click();
  await getUI().getByRole('button', { name: 'Review Recovery', exact: true }).waitFor(); setDropPatch(false);
  const pending = await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].sync.transactions.active());
  assert.equal(pending.phase, 'prepared'); assert.equal(remote.head, pending.commit); assert.equal((await state()).baseRemoteCommit, completedHead);
  await close();
  await page.evaluate(async () => { await app.plugins.unloadPlugin('local-mirror-sync'); await app.plugins.enablePlugin('local-mirror-sync'); }); await inject();
  const before = remote.calls.length;
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openRecovery()); await surface('.lms-recovery-dialog');
  await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).click();
  await page.waitForFunction(() => !app.plugins.plugins['local-mirror-sync'].sync.running && !app.plugins.plugins['local-mirror-sync'].recoveryModal?.contentEl.querySelector('.lms-error'));
  await surface('.lms-summary');
  assert.equal((await state()).baseRemoteCommit, pending.commit);
  assert.equal(await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].sync.transactions.active()), null);
  assert(remote.calls.slice(before).every(c => c.method === 'GET'));
  await getUI().screenshot({ path: join(runDir, 'publish-recovered.png') }); report.screenshots.push('publish-recovered.png');
  report.checks.push('Lost PATCH response remains prepared; plugin reload Resume reads uncached main HEAD and finishes with GET only, no second commit/PATCH');
  report.publish = { oldHead, completedHead, recoveredHead: pending.commit };
}
