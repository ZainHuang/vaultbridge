import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function verifyLifecycle({ page, remote, report, runDir, preview, close, state, surface, getUI }) {
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openDashboard());
  await surface('.lms-recovery-panel');
  const dashboardPage = getUI();
  await dashboardPage.getByText('Healthy', { exact: true }).waitFor();
  await preview();
  // Hold the production completion pipeline at its first post-publication GET.
  await page.evaluate(() => {
    const p = app.plugins.plugins['local-mirror-sync']; const transport = p.sync.transport;
    let published = false;
    p.sync.transport = async r => {
      if (published && r.method === 'GET' && !window.__lifecycleReleased) {
        window.__lifecycleWaiting = true;
        await new Promise(resolve => { window.__lifecycleRelease = () => { window.__lifecycleReleased = true; resolve(); }; });
      }
      const result = await transport(r);
      if (r.method === 'PATCH') published = true;
      return result;
    };
  });
  await getUI().getByRole('button', { name: 'Sync & Verify', exact: true }).click();
  await page.waitForFunction(() => window.__lifecycleWaiting === true);
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].refreshDashboard());
  await dashboardPage.getByText('Sync in progress', { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await dashboardPage.getByText('Pending Recovery', { exact: true }).count(), 0);
  assert.equal(await dashboardPage.getByRole('button', { name: 'Resume Transaction', exact: true }).count(), 0);
  assert.equal((await state()).baseManifest, undefined);
  await dashboardPage.screenshot({ path: join(runDir, 'lifecycle-running.png') }); report.screenshots.push('lifecycle-running.png');
  await page.evaluate(() => window.__lifecycleRelease());
  await getUI().getByText('Sync verified. BASE updated successfully.', { exact: true }).waitFor();
  await close();
  // No explicit refresh/open: completion itself must refresh an already-open view.
  await dashboardPage.locator('.lms-recovery-panel').getByText('Healthy', { exact: true }).waitFor();
  assert.equal(await dashboardPage.getByRole('button', { name: 'Resume Transaction', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].sync.transactions.active()), null);
  const completed = await page.evaluate(async () => {
    const p = app.plugins.plugins['local-mirror-sync']; const history = p.product.cachedHistory();
    const raw = await app.vault.adapter.read(`.local-mirror-sync/transactions/${history[0].transactionId}/journal.json`);
    return JSON.parse(JSON.parse(raw).payload);
  });
  assert.equal(completed.phase, 'complete'); assert.equal((await state()).baseRemoteCommit, remote.head);
  assert.equal(remote.calls.filter(c => c.method === 'PATCH').length, 1);
  await dashboardPage.screenshot({ path: join(runDir, 'lifecycle-complete.png') }); report.screenshots.push('lifecycle-complete.png');
  report.checks.push('One Sync confirmation automatically verifies remote/local, advances BASE, completes journal and clears pointer; running and completed Dashboard never offer Resume');
  await dashboardPage.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.body.classList.add('emulate-mobile'); app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse(); });
  assert(await dashboardPage.locator('.lms-dashboard:visible').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await dashboardPage.screenshot({ path: join(runDir, 'lifecycle-mobile.png') }); report.screenshots.push('lifecycle-mobile.png');
}
