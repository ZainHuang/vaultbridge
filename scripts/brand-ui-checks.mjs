import assert from 'node:assert/strict';

export async function verifyBrand({ page, remote, preview, execute, close, state, report, screenshot, surface }) {
  const metadata = await page.evaluate(() => {
    const plugin = app.plugins.plugins['local-mirror-sync'];
    return { id: plugin.manifest.id, name: plugin.manifest.name,
      commands: Object.values(app.commands.commands).filter(c => c.id.startsWith('local-mirror-sync:')).map(c => c.name) };
  });
  assert.equal(metadata.id, 'local-mirror-sync'); assert.equal(metadata.name, 'VaultBridge');
  assert(metadata.commands.every(name => name.startsWith('VaultBridge:')));
  await preview();
  const ui = await surface('.lms-modal');
  assert.equal(await ui.locator('.lms-modal .modal-title').innerText(), 'VaultBridge');
  await screenshot('vaultbridge-preview');
  await execute(); await close();
  const before = await state(); assert(before.baseManifest);
  const saved = await page.evaluate(async () => {
    const p = app.plugins.plugins['local-mirror-sync'];
    return { settings: await p.loadData(), raw: await app.vault.adapter.read('.obsidian/plugins/local-mirror-sync/sync-state.json') };
  });
  await page.evaluate(async () => { await app.plugins.unloadPlugin('local-mirror-sync'); await app.plugins.enablePlugin('local-mirror-sync'); });
  assert.deepEqual(await state(), before);
  assert.deepEqual(await page.evaluate(async () => {
    const p = app.plugins.plugins['local-mirror-sync'];
    return { settings: await p.loadData(), raw: await app.vault.adapter.read('.obsidian/plugins/local-mirror-sync/sync-state.json') };
  }), saved);
  const requests = remote.calls.length;
  await page.evaluate(() => app.plugins.plugins['local-mirror-sync'].openDashboard());
  const dashboard = await surface('.lms-dashboard');
  assert(await dashboard.getByText('VaultBridge Dashboard', { exact: true }).count());
  await screenshot('vaultbridge-dashboard');
  assert.equal(remote.calls.length, requests);
  await page.evaluate(() => { app.setting.open(); app.setting.openTabById('local-mirror-sync'); });
  const settings = await surface('.lms-device-setting');
  assert(await settings.getByRole('heading', { name: 'VaultBridge', exact: true }).count());
  await screenshot('vaultbridge-settings');
  await page.evaluate(() => app.setting.close());
  report.checks.push('VaultBridge display name, command prefix, Preview, Dashboard and Settings verified in production Obsidian');
  report.checks.push('Same plugin ID reload preserves exact settings bytes, deviceId and BASE; opening Dashboard issues no GitHub requests');
}
