import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function verifyV112({ page, remote, report, runDir, preview, close, state, surface, getUI, inject }) {
  const capture = async name => { await getUI().screenshot({ path: join(runDir, `${name}.png`) }); report.screenshots.push(`${name}.png`); };
  const active = () => page.evaluate(() => app.plugins.plugins['local-mirror-sync'].sync.transactions.active());
  const open = async () => {
    await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openRecovery());
    await surface('.lms-recovery-dialog'); await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).waitFor();
  };
  remote.external({ 'old.md': 'old remote note' });
  await preview(); await getUI().getByRole('button', { name: 'Use Local', exact: true }).click();
  await getUI().getByRole('textbox', { name: 'Adoption confirmation' }).fill('USE LOCAL');
  await page.evaluate(() => {
    const p = app.plugins.plugins['local-mirror-sync']; window.__saveState = p.syncState.save.bind(p.syncState);
    p.syncState.save = async () => { throw new Error('fixture power loss before BASE'); };
  });
  await getUI().getByRole('button', { name: 'Adopt & Verify', exact: true }).click();
  await getUI().getByRole('button', { name: 'Review Recovery', exact: true }).waitFor(); await close();
  await page.evaluate(async () => {
    const p = app.plugins.plugins['local-mirror-sync']; p.syncState.save = window.__saveState;
    const t = await p.sync.transactions.active(); delete t.createdAt; delete t.observation; t.phase = 'published';
    await p.sync.transactions.save(t);
    await p.syncState.save({ schemaVersion: 1, deviceId: crypto.randomUUID() });
  });
  const pending = await active(); const current = await state(); const head = remote.head; const refs = new Map(remote.refs);
  await page.evaluate(async () => { await app.plugins.unloadPlugin('local-mirror-sync'); await app.plugins.enablePlugin('local-mirror-sync'); }); await inject();
  await open();
  assert.match(await getUI().locator('.lms-recovery-dialog').innerText(), /Unavailable \(legacy transaction\)/);
  assert(await getUI().getByRole('button', { name: 'Abort Transaction', exact: true }).isDisabled());
  await capture('v112-01-legacy-published');
  report.checks.push('Production reload shows legacy published transaction with unavailable creation time, retained backup ref and disabled Abort');

  await page.evaluate(async () => {
    const p = app.plugins.plugins['local-mirror-sync']; const path = `${app.vault.configDir}/plugins/local-mirror-sync/sync-state.json`;
    window.__legacySavedState = await app.vault.adapter.read(path);
    await app.vault.adapter.write(path, '{corrupt state'); p.stateError = new Error('fixture damaged state');
  });
  await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).click();
  await getUI().getByText(/LEGACY_LOCAL_STATE_UNAVAILABLE/).waitFor({ timeout: 10000 });
  assert.equal(await page.evaluate(() => app.vault.adapter.read(`${app.vault.configDir}/plugins/local-mirror-sync/sync-state.json`)), '{corrupt state');
  assert.equal((await active()).id, pending.id);
  await page.evaluate(async () => {
    const p = app.plugins.plugins['local-mirror-sync'];
    await app.vault.adapter.write(`${app.vault.configDir}/plugins/local-mirror-sync/sync-state.json`, window.__legacySavedState);
    await p.syncState.load(); p.stateError = undefined;
  });
  report.checks.push('Unreadable existing local state remains untouched and blocked; legacy Recovery never restores an unverified journal BASE');
  assert.match(await getUI().locator('.lms-recovery-dialog').innerText(), /Legacy recovery only verifies current content/);

  // Specific local diff, at a narrow viewport, must survive repeated attempts.
  await page.evaluate(async () => { await app.vault.modify(app.vault.getAbstractFileByPath('note.md'), '# User edit'); });
  const calls = remote.calls.length;
  await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).click();
  await getUI().getByText(/LEGACY_LOCAL_MISMATCH/).waitFor({ timeout: 15000 });
  assert.match(await getUI().locator('.lms-recovery-status').first().innerText(), /note\.md.*hash differs/);
  await getUI().setViewportSize({ width: 390, height: 844 });
  assert(await getUI().locator('.lms-recovery-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await capture('v112-02-local-diff-mobile');
  assert.deepEqual(await state(), current); assert.equal((await active()).id, pending.id);
  assert.equal(await page.evaluate(() => app.vault.adapter.read('note.md')), '# User edit');
  assert(remote.calls.slice(calls).every(c => c.method === 'GET'));
  report.checks.push('390px UI displays path and hash mismatch, preserves local edit and missing BASE, keeps recovery blocked, with GET-only remote traffic');

  // Remote advancement is not conflated with a local mismatch or environment error.
  remote.external(Object.fromEntries(Object.keys(remote.contents()).map(p => [p, remote.text(p)])));
  await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).click();
  await getUI().getByText(/LEGACY_CURRENT_STATE_DIFFERS/).waitFor();
  await getUI().getByRole('button', { name: 'Start fresh Preview from current HEAD', exact: true }).waitFor();
  assert(await getUI().locator('.lms-recovery-status').first().evaluate(el => {
    const rect = el.getBoundingClientRect(); return rect.top >= 0 && rect.top < innerHeight;
  }), 'The failure reason should be visible after Resume, without scrolling back to the top');
  assert(await getUI().locator('.lms-recovery-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await capture('v112-03-remote-advanced-mobile');
  assert.deepEqual(await state(), current); assert.equal((await active()).id, pending.id);
  report.checks.push('Descendant main with current differences displays LEGACY_CURRENT_STATE_DIFFERS and explicit fresh Preview, preserving BASE and content');

  // Reset the disposable fixture to its published bytes; production recovery does no apply.
  remote.head = head;
  await page.evaluate(async () => { await app.vault.modify(app.vault.getAbstractFileByPath('note.md'), '# Original\nWindows note'); });
  await page.evaluate(() => {
    const p = app.plugins.plugins['local-mirror-sync']; p.sync.vault.apply = async () => { throw new Error('legacy recovery must never apply notes'); };
  });
  await getUI().getByRole('button', { name: 'Resume Transaction', exact: true }).click();
  await getUI().getByText('Recovery completed. Run Preview to inspect the current state.', { exact: true }).waitFor({ timeout: 30000 });
  const rebuilt = await state(); assert.equal(rebuilt.deviceId, current.deviceId); assert.equal(rebuilt.baseRemoteCommit, pending.commit);
  assert.equal(rebuilt.lastSeenGeneration, pending.manifest.generation); assert.deepEqual(rebuilt.baseManifest, pending.manifest);
  assert.equal(await active(), null); assert.equal(remote.head, head); assert.deepEqual(remote.refs, refs);
  assert(remote.calls.slice(calls).every(c => c.method === 'GET'));
  await capture('v112-04-rebuilt-base');
  report.checks.push('Exact current Local/Tree/Manifest proof reconstructs BASE on the current device, preserves backup, invokes no file apply, clears pending after durable completion');
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].recoveryModal.close());
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openDashboard());
  await surface('.lms-dashboard:visible .lms-recovery-panel');
  await getUI().locator('.lms-recovery-panel').getByText('Healthy', { exact: true }).waitFor();
  const dashboardCalls = remote.calls.length;
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openDashboard());
  assert.equal(remote.calls.length, dashboardCalls);
  await capture('v112-05-healthy-dashboard');
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openRecovery()); await surface('.lms-recovery-dialog');
  await getUI().getByText('No pending sync. You can run Preview again.', { exact: true }).waitFor();
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].recoveryModal.close());
  await preview(); assert.match(await getUI().locator('.lms-operations').innerText(), /Push 0 · Pull 0 · Conflict 0/);
  report.checks.push('Recovery empty state, cached Healthy dashboard and normal zero-change Preview work after completion');
  return pending;
}
