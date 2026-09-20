import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function verifyActivity({ page, remote, report, runDir, preview, close, surface, getUI }) {
  await page.locator('.lms-activity-entry').waitFor({ timeout: 5000 });
  const shot = async name => { await getUI().screenshot({ path: join(runDir, `${name}.png`) }); report.screenshots.push(`${name}.png`); };
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openActivityPanel());
  await surface('.lms-activity-panel');
  await getUI().getByText('No activity in this session.', { exact: true }).waitFor();
  await shot('activity-empty');
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].activityPanel.close());
  await preview();
  await page.evaluate(() => {
    const p = app.plugins.plugins['local-mirror-sync']; const transport = p.sync.transport;
    p.sync.transport = async r => {
      // The first GET after PATCH now belongs to publication read-back. Hold
      // immutable commit verification, where Verify remote has actually begun.
      const resource = r.method === 'PATCH' ? 'publish' : window.__activityPublished && r.method === 'GET' && r.url.includes('/commits/') ? 'verify' : null;
      if (resource && !window[`__released_${resource}`]) {
        window.__activityGate = resource;
        await new Promise(resolve => { window.__releaseActivity = () => { window[`__released_${resource}`] = true; resolve(); }; });
      }
      const result = await transport(r); if (r.method === 'PATCH') window.__activityPublished = true; return result;
    };
  });
  await getUI().getByRole('button', { name: 'Sync & Verify', exact: true }).click();
  await page.waitForFunction(() => window.__activityGate === 'publish');
  assert.match(await page.locator('.lms-activity-entry').innerText(), /Syncing/);
  // Closing Preview must not cancel a journaled transaction; inspect the global entry.
  await close(); await page.locator('.lms-activity-entry').click(); await surface('.lms-activity-panel');
  await getUI().locator('.lms-activity-current').getByText('Publish', { exact: true }).waitFor();
  await shot('activity-syncing');
  const calls = remote.calls.length;
  await getUI().waitForTimeout(1200);
  assert.equal(remote.calls.length, calls);
  assert.equal(await getUI().locator('.lms-activity-current').getByText('Publish', { exact: true }).count(), 1);
  await page.evaluate(() => window.__releaseActivity());
  await page.waitForFunction(() => window.__activityGate === 'verify');
  assert.match(await page.locator('.lms-activity-entry').innerText(), /Verifying/);
  await getUI().locator('.lms-activity-current').getByText('Verify remote', { exact: true }).waitFor();
  await shot('activity-verifying');
  await page.evaluate(() => window.__releaseActivity());
  await getUI().getByText('Synced & verified', { exact: true }).first().waitFor();
  for (const stage of ['Scan local', 'Read remote', 'Build plan', 'Upload blobs', 'Create tree', 'Create commit', 'Publish', 'Verify remote', 'Verify local', 'Save BASE', 'Complete']) assert.equal(await getUI().locator('.lms-activity-steps').getByText(stage, { exact: true }).count(), 1);
  await shot('activity-complete');
  await page.locator('.lms-activity-entry').getByText('Healthy', { exact: true }).waitFor();
  const doneCalls = remote.calls.length;
  await getUI().setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.body.classList.add('emulate-mobile'); app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse(); });
  assert(await getUI().locator('.lms-activity-panel').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await shot('activity-mobile');
  assert.equal(remote.calls.length, doneCalls);
  report.checks.push('Real Publish/Verify holds show distinct animated statuses; open panel uses zero requests; complete trace, verified-to-Healthy and 390px overflow pass');
  await page.evaluate(() => { app.plugins.plugins['local-mirror-sync'].activityPanel.close(); document.body.classList.remove('emulate-mobile'); });
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.evaluate(async () => {
    const p = app.plugins.plugins['local-mirror-sync'];
    await p.saveSettings({ ...p.settings, autoSync: true, autoSyncDebounceSeconds: 3 });
    window.__activityPublished = false; window.__released_publish = false; window.__released_verify = false; window.__activityGate = undefined;
    await app.vault.modify(app.vault.getAbstractFileByPath('note.md'), '# Auto activity');
  });
  await page.locator('.lms-activity-entry').getByText(/Auto sync in [1-3]s/).waitFor();
  await page.screenshot({ path: join(runDir, 'activity-countdown.png') }); report.screenshots.push('activity-countdown.png');
  await page.waitForFunction(() => window.__activityGate === 'publish');
  assert.match(await page.locator('.lms-activity-entry').innerText(), /Syncing/);
  await page.locator('.lms-activity-entry').click(); await surface('.lms-activity-panel');
  await getUI().locator('.lms-activity-current').getByText('Publish', { exact: true }).waitFor();
  await page.evaluate(() => window.__releaseActivity()); await page.waitForFunction(() => window.__activityGate === 'verify');
  assert.match(await page.locator('.lms-activity-entry').innerText(), /Verifying/);
  await page.evaluate(() => window.__releaseActivity());
  await page.waitForFunction(() => app.plugins.plugins['local-mirror-sync'].product.snapshot().auto.result === 'Verified');
  assert.equal(remote.text('note.md'), '# Auto activity');
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].activityPanel.close());
  report.checks.push('Real Auto Sync Vault event displays deadline countdown, Syncing, Verifying and verified completion');

  const safeHead = remote.head;
  await page.evaluate(async () => {
    const p = app.plugins.plugins['local-mirror-sync']; await p.saveSettings({ ...p.settings, autoSyncChangeThreshold: 1 });
    await app.vault.create('risk-a.md', 'a'); await app.vault.create('risk-b.md', 'b');
  });
  await page.locator('.lms-activity-entry').getByText('Review required', { exact: true }).waitFor({ timeout: 15000 });
  assert.equal(remote.head, safeHead);
  await page.locator('.lms-activity-entry').click(); await surface('.lms-summary');
  await getUI().getByRole('button', { name: 'Sync & Verify', exact: true }).waitFor(); await close();
  report.checks.push('High-risk automatic plan never publishes; status entry goes directly to Preview');

  // Create a real same-path add conflict with a second fixture device.
  const { pathToFileURL } = await import('node:url');
  const { WritableVault, SyncService, LocalStateStore } = await import(pathToFileURL(join(runDir, 'fixture.mjs')).href);
  const vault = new WritableVault({}); const peerState = new LocalStateStore({ read: () => vault.readInternal('state'), write: s => vault.writeInternal('state', s) });
  await peerState.load(); const service = new SyncService(vault, remote.transport, '.obsidian', peerState);
  const options = { owner: 'test-owner', repository: 'test-repository', branch: 'main', includeObsidian: false, ignorePatterns: '', deleteSafetyThreshold: 20 };
  await service.execute(await service.preview(options, 'test'), 'test');
  vault.files.set('risk-a.md', new TextEncoder().encode('peer conflict'));
  await service.execute(await service.preview(options, 'test'), 'test');
  await preview(); await close();
  await page.locator('.lms-activity-entry').getByText('Review required · Conflict', { exact: true }).waitFor();
  await page.locator('.lms-activity-entry').click(); await surface('.lms-summary');
  await getUI().locator('.lms-entry').filter({ hasText: 'CONFLICT' }).first().locator('summary').click();
  assert.equal(await getUI().getByRole('button', { name: 'Use LOCAL', exact: true }).count(), 1); await close();
  report.checks.push('Real three-way conflict status routes directly to conflict Preview without resolving it');

  // Resolve by matching this disposable fixture's bytes, then interrupt upload.
  await page.evaluate(async () => {
    const p = app.plugins.plugins['local-mirror-sync']; await p.saveSettings({ ...p.settings, autoSync: false });
    await app.vault.modify(app.vault.getAbstractFileByPath('risk-a.md'), 'peer conflict');
    const transport = p.sync.transport;
    p.sync.transport = r => r.method === 'POST' && r.url.endsWith('/blobs') ? Promise.resolve({ status: 403, json: {} }) : transport(r);
  });
  await preview(); await getUI().getByRole('button', { name: 'Sync & Verify', exact: true }).click();
  await getUI().getByRole('button', { name: 'Review Recovery', exact: true }).waitFor(); await close();
  await page.locator('.lms-activity-entry').getByText('Review required · Recovery required', { exact: true }).waitFor();
  const recoveryCalls = remote.calls.length;
  await page.locator('.lms-activity-entry').click(); await surface('.lms-recovery-dialog');
  await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).waitFor();
  assert.equal(remote.calls.length, recoveryCalls);
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].recoveryModal.close());
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openActivityPanel()); await surface('.lms-activity-panel');
  await getUI().locator('.lms-activity-error').waitFor();
  await getUI().setViewportSize({ width: 390, height: 844 });
  assert(await getUI().locator('.lms-activity-panel').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await shot('activity-mobile-error');
  await page.evaluate(async () => {
    app.plugins.plugins['local-mirror-sync'].activityPanel.close(); document.body.classList.add('emulate-mobile');
    await app.plugins.unloadPlugin('local-mirror-sync'); await app.plugins.enablePlugin('local-mirror-sync');
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.lms-activity-ribbon').count(), 1);
  assert.match(await page.locator('.lms-activity-ribbon').getAttribute('aria-label'), /Recovery required/);
  // Invoke the native ribbon entry even if the user's mobile sidebar is collapsed.
  await page.locator('.lms-activity-ribbon').dispatchEvent('click'); await surface('.lms-recovery-dialog');
  await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).waitFor();
  assert.equal(remote.calls.length, recoveryCalls);
  report.checks.push('Interrupted upload retains safe error and routes to Recovery without requests; mobile-emulated reload retains native ribbon entry and recovery route');

}
