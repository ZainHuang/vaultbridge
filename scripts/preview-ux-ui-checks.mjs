import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function verifyPreviewUX({ page, remote, report, runDir, preview, close, surface, getUI, state }) {
  const capture = async name => { await getUI().screenshot({ path: join(runDir, `${name}.png`) }); report.screenshots.push(`${name}.png`); };
  await page.evaluate(async () => {
    await app.vault.createFolder('batch');
    for (let n = 0; n < 14; n++) await app.vault.create(`batch/${n.toString().padStart(2, '0')}.md`, `Original ${n}`);
  });
  await preview();
  await getUI().getByRole('button', { name: 'Sync & Verify', exact: true }).click();
  await getUI().getByText('Sync verified. BASE updated successfully.').waitFor(); await close();
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openDashboard());
  await surface('.lms-dashboard');
  const dashboard = getUI();
  await dashboard.locator('.lms-recovery-panel').getByText('Healthy', { exact: true }).waitFor();
  assert.equal(await dashboard.getByRole('heading', { name: 'Sync History', exact: true }).count(), 0);
  assert.equal(await dashboard.locator('.lms-history-record').count(), 0);
  await dashboard.getByRole('button', { name: 'Sync History', exact: true }).click();
  await surface('.lms-dashboard');
  await getUI().getByRole('heading', { name: 'Sync History', exact: true }).waitFor();
  assert.equal(await getUI().locator('.lms-history-record').count(), 1);
  report.checks.push('Dashboard omits duplicate History section; dedicated Sync History remains accessible');

  await page.evaluate(async () => {
    const plugin = app.plugins.plugins['local-mirror-sync'];
    for (let n = 0; n < 12; n++) {
      const file = app.vault.getAbstractFileByPath(`batch/${n.toString().padStart(2, '0')}.md`);
      await app.vault.modify(file, `Changed ${n}`);
    }
    await app.vault.delete(app.vault.getAbstractFileByPath('batch/12.md'));
    await plugin.metadataPending;
    plugin.settings.deleteSafetyThreshold = 0;
  });
  const head = remote.head; const generation = (await state()).lastSeenGeneration;
  await preview();
  const ui = getUI();
  assert.equal(await ui.locator('.lms-entry').count(), 10);
  assert.equal(await ui.locator('.lms-category').filter({ hasText: 'UNCHANGED' }).count(), 0);
  assert.equal(await ui.getByRole('button', { name: /Unchanged \d+/ }).count(), 0);
  assert.match(await ui.locator('.lms-table-wrap').innerText(), /PUSH_UPDATE/);
  assert.equal(await ui.getByText('1–10 of 13 entries', { exact: true }).count(), 1);
  assert.equal(await ui.getByRole('textbox', { name: 'Delete confirmation' }).count(), 0);
  await capture('preview-changes-first-page');
  await ui.getByRole('button', { name: 'Next 10', exact: true }).click();
  assert.equal(await ui.locator('.lms-entry').count(), 3);
  assert.match(await ui.locator('.lms-table-wrap').innerText(), /PUSH_DELETE/);
  assert.equal(await ui.getByText('11–13 of 13 entries', { exact: true }).count(), 1);
  await ui.getByRole('button', { name: 'Previous 10', exact: true }).click();
  await ui.getByRole('searchbox', { name: 'Filter by path' }).fill('batch/00.md');
  assert.equal(await ui.locator('.lms-entry').count(), 1);
  await ui.getByRole('searchbox', { name: 'Filter by path' }).fill('');
  report.checks.push('Preview shows changed files only, ten per page, with working pagination and search');

  await ui.getByRole('button', { name: 'Sync & Verify', exact: true }).click();
  const dialog = ui.locator('.lms-confirm-modal'); await dialog.waitFor();
  const confirm = dialog.getByRole('button', { name: 'Confirm & Sync', exact: true });
  const phrase = dialog.getByRole('textbox', { name: 'Delete confirmation' });
  assert(await confirm.isDisabled());
  await phrase.fill('delete 1'); assert(await confirm.isDisabled());
  await capture('preview-confirmation-dialog');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(remote.head, head); assert.equal((await state()).lastSeenGeneration, generation);
  await ui.getByRole('button', { name: 'Sync & Verify', exact: true }).click();
  await dialog.waitFor();
  assert.equal(await phrase.inputValue(), '');
  await phrase.fill('DELETE 1'); assert.equal(await confirm.isDisabled(), false);
  await confirm.click();
  await ui.getByText('Sync verified. BASE updated successfully.').waitFor();
  assert.equal(remote.contents()['batch/12.md'], undefined);
  assert((await state()).lastSeenGeneration > generation);
  report.checks.push('Deletion phrase is requested after Sync click; wrong/cancelled input makes no changes; exact phrase executes and verifies');
  await close();
}
