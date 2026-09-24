import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function verifyDashboard({ page, remote, report, runDir, preview, sync, close, surface, getUI }) {
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openDashboard());
  await surface('.lms-dashboard');
  const dashboard = getUI();
  await dashboard.locator('.lms-recovery-panel').getByText('Healthy', { exact: true }).waitFor();
  const before = remote.calls.length;
  const unchanged = await dashboard.evaluate(async () => {
    const p = app.plugins.plugins['local-mirror-sync'];
    const root = document.querySelector('.lms-dashboard'); const heading = root.querySelector('h1');
    const button = [...root.querySelectorAll('button')].find(b => b.textContent === 'Review in Preview'); button.focus();
    let removed = 0; let checking = 0;
    const observer = new MutationObserver(records => {
      removed += records.filter(r => r.target === root).reduce((n, r) => n + r.removedNodes.length, 0);
      if (root.textContent.includes('Checking pending transaction')) checking++;
    }); observer.observe(root, { childList: true, subtree: true, characterData: true });
    for (let i = 0; i < 12; i++) {
      p.product.activity({ type: 'stage', stage: 'Scan local', processed: i, total: 12 });
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    observer.disconnect();
    return { removed, checking, sameHeading: root.querySelector('h1') === heading, focusRetained: document.activeElement === button };
  });
  assert.deepEqual(unchanged, { removed: 0, checking: 0, sameHeading: true, focusRetained: true });
  assert.equal(remote.calls.length, before);
  report.checks.push('Repeated progress notifications preserve Dashboard DOM and focus, never flash Checking, and issue zero GitHub requests');

  await page.evaluate(() => {
    const p = app.plugins.plugins['local-mirror-sync']; const active = p.sync.transactions.active.bind(p.sync.transactions);
    window.__restoreDashboardRead = () => { p.sync.transactions.active = active; };
    p.sync.transactions.active = async () => {
      await new Promise(resolve => { window.__releaseDashboardRead = resolve; }); return active();
    };
    p.refreshDashboard();
  });
  assert.equal(await dashboard.locator('.lms-recovery-panel').getByText('Healthy', { exact: true }).count(), 1);
  assert.equal(await dashboard.getByText('Checking pending transaction…', { exact: true }).count(), 0);
  await page.evaluate(() => { window.__restoreDashboardRead(); window.__releaseDashboardRead(); });
  await dashboard.screenshot({ path: join(runDir, 'dashboard-stable.png') }); report.screenshots.push('dashboard-stable.png');
  report.checks.push('A slow local journal read preserves the last complete Dashboard while refresh is pending');

  // A real state change must still update the cached page automatically.
  await preview(); await sync(); await close();
  await dashboard.locator('.lms-dashboard-health').getByText('Healthy', { exact: true }).waitFor();
  assert.equal(await dashboard.locator('.lms-history-record').count(), 0);
  assert.equal(await dashboard.getByRole('heading', { name: 'Sync History', exact: true }).count(), 0);
  await dashboard.locator('.lms-recovery-panel').getByText('Healthy', { exact: true }).waitFor();
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openDashboard(true));
  await surface('.lms-dashboard');
  await getUI().getByRole('heading', { name: 'Sync History', exact: true }).waitFor();
  const history = await getUI().evaluate(async () => {
    const p = app.plugins.plugins['local-mirror-sync'];
    const root = [...document.querySelectorAll('.lms-dashboard')].find(el => el.querySelector('h1')?.textContent === 'Sync History');
    const row = root.querySelector('.lms-history-record'); p.refreshDashboard(); await new Promise(resolve => setTimeout(resolve, 100));
    return { sameRow: row === root.querySelector('.lms-history-record'), count: root.querySelectorAll('.lms-history-record').length };
  });
  assert.deepEqual(history, { sameRow: true, count: 1 });
  report.checks.push('Real Sync completion refreshes health/history; unchanged History notifications preserve row nodes');
  await getUI().setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.body.classList.add('emulate-mobile'); app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse(); });
  // Obsidian animates sidebar collapse; check overflow once the mobile layout settles.
  await getUI().waitForFunction(() => {
    const el = [...document.querySelectorAll('.lms-dashboard')].find(el => el.getBoundingClientRect().width > 0);
    return el && el.scrollWidth <= el.clientWidth + 1;
  });
  assert(await getUI().locator('.lms-dashboard:visible').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await getUI().screenshot({ path: join(runDir, 'dashboard-history-mobile.png') }); report.screenshots.push('dashboard-history-mobile.png');
}
