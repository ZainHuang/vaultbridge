import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function verifyV11({ page, remote, report, runDir, preview, sync, close, state }) {
  const capture = async name => { await page.screenshot({ path: join(runDir, `${name}.png`) }); report.screenshots.push(`${name}.png`); };
  const dashboard = async () => { await page.evaluate(() => app.commands.executeCommandById('local-mirror-sync:dashboard')); await page.locator('.lms-dashboard:visible').waitFor(); };
  await dashboard(); assert.match(await page.locator('.lms-dashboard:visible').innerText(), /Sync Required/);
  assert.match(await page.locator('.lms-dashboard:visible').innerText(), /No verified sync history/);
  await capture('v11-01-empty-dashboard'); report.checks.push('Dashboard initial state and empty history are visible before any sync');
  await page.evaluate(() => { app.setting.open(); app.setting.openTabById('local-mirror-sync'); });
  const findSettings = async () => {
    for (let n = 0; n < 100; n++) {
      for (const p of page.context().pages()) if (await p.getByRole('spinbutton', { name: 'Auto Sync debounce (seconds)' }).count()) return p;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Settings surface unavailable');
  };
  let s = await findSettings();
  const autoRow = () => s.locator('.setting-item').filter({ has: s.getByText('Auto Sync', { exact: true }) });
  assert.equal(await autoRow().locator('.checkbox-container').evaluate(el => el.classList.contains('is-enabled')), false);
  assert.equal(await s.getByRole('spinbutton', { name: 'Auto Sync debounce (seconds)' }).inputValue(), '30');
  await s.getByRole('textbox', { name: 'Device name', exact: true }).fill('Windows-PC');
  await s.screenshot({ path: join(runDir, 'v11-02-settings-default-off.png') }); report.screenshots.push('v11-02-settings-default-off.png');
  await s.getByRole('button', { name: 'Save settings', exact: true }).click();
  await s.getByText('VaultBridge settings saved.', { exact: true }).waitFor();
  await page.evaluate(() => app.setting.close());
  await preview(); await sync(); await close(); await dashboard();
  assert.match(await page.locator('.lms-dashboard:visible .lms-dashboard-health').innerText(), /Healthy/);
  assert.equal((await state()).baseManifest.generation, 1);
  assert.match(await page.locator('.lms-dashboard:visible').innerText(), /Windows-PC/);
  const calls = remote.calls.length;
  await dashboard(); await dashboard(); assert.equal(remote.calls.length, calls);
  await page.evaluate(() => app.commands.executeCommandById('local-mirror-sync:sync-history'));
  await page.locator('.lms-dashboard:visible .lms-history-record').first().waitFor(); assert.match(await page.locator('.lms-dashboard:visible .lms-history-record').first().innerText(), /PASS/);
  await capture('v11-03-verified-history'); report.checks.push('Verified dashboard, repository, generation, counts and history render with zero GitHub requests on open');
  await page.evaluate(() => { app.setting.open(); app.setting.openTabById('local-mirror-sync'); });
  s = await findSettings();
  await autoRow().locator('.checkbox-container').click();
  await s.getByRole('spinbutton', { name: 'Auto Sync debounce (seconds)' }).fill('1');
  await s.getByRole('button', { name: 'Save settings', exact: true }).click();
  // Closing a settings popout during the async save must not access dead DOM.
  await page.evaluate(() => app.setting.close());
  await page.waitForFunction(() => app.plugins.plugins['local-mirror-sync'].settings.autoSync === true);
  await page.evaluate(async () => { await app.vault.modify(app.vault.getAbstractFileByPath('note.md'), '# Automatic verified edit'); });
  await page.waitForFunction(() => app.plugins.plugins['local-mirror-sync'].product.snapshot().auto.result === 'Verified', null, { timeout: 30000 });
  assert.equal(remote.text('note.md'), '# Automatic verified edit');
  assert.equal((await state()).baseManifest.generation, 2);
  await dashboard(); await capture('v11-04-auto-verified'); report.checks.push('Real Vault modify event debounces to automatic Sync + Verify through production plugin');
  // Rename events preserve stable identity and must not trigger a sync feedback loop.
  await page.evaluate(async () => { await app.vault.rename(app.vault.getAbstractFileByPath('note.md'), 'renamed.md'); });
  await page.waitForFunction(() => app.plugins.plugins['local-mirror-sync'].syncState.current().baseManifest.generation === 3, null, { timeout: 30000 });
  assert.equal(remote.text('renamed.md'), '# Automatic verified edit');
  await page.evaluate(async () => { for (let i = 0; i < 21; i++) await app.vault.create(`batch-${i}.md`, `batch ${i}`); });
  const safeHead = remote.head;
  await page.waitForFunction(() => app.plugins.plugins['local-mirror-sync'].product.snapshot().auto.result === 'Manual confirmation required', null, { timeout: 30000 });
  assert.equal(remote.head, safeHead); await dashboard(); await capture('v11-05-manual-required');
  assert.match(await page.locator('.lms-dashboard:visible').innerText(), /Manual confirmation required/);
  report.checks.push('Real rename preserves identity; 21 additions stop at manual confirmation without publication');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.body.classList.add('emulate-mobile'); app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse(); });
  await dashboard(); assert(await page.locator('.lms-dashboard:visible').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await capture('v11-06-mobile-dashboard');
  await page.getByRole('button', { name: 'Review in Preview', exact: true }).click();
  let reviewOpened = false;
  for (let n = 0; n < 100 && !reviewOpened; n++) {
    for (const p of page.context().pages()) if (await p.locator('.lms-summary').count()) reviewOpened = true;
    if (!reviewOpened) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(reviewOpened); await close();
  await page.evaluate(async () => { await app.plugins.unloadPlugin('local-mirror-sync'); await app.plugins.enablePlugin('local-mirror-sync'); });
  // Disable network-triggering work before checking cached persistence after reload.
  await page.evaluate(() => { const p = app.plugins.plugins['local-mirror-sync']; p.settings.autoSync = false; p.auto.configure(); });
  await dashboard(); assert.match(await page.locator('.lms-dashboard:visible').innerText(), /Windows-PC/);
  await page.evaluate(() => app.commands.executeCommandById('local-mirror-sync:sync-history'));
  assert.equal(await page.locator('.lms-dashboard:visible .lms-history-record').count(), 3);
  await capture('v11-07-reloaded-history');
  report.checks.push('390px dashboard contains overflow; review action opens Preview; device and three histories survive plugin reload');
}
