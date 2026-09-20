import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
it('the shipped command is wired to stateful preview without a Local Primary bypass', async () => {
  const main = await readFile('src/main.ts', 'utf8');
  const ui = await readFile('src/ui/PreviewModal.ts', 'utf8');
  const settings = await readFile('src/settings/SettingsTab.ts', 'utf8');
  expect(main).toContain('SyncService');
  expect(main).not.toContain('InitializationSession');
  expect(ui + settings).not.toMatch(/Local Primary|Local → GitHub Mirror|Local Authoritative/);
  expect(ui + settings).toContain('Stateful Three-Way Sync');
});
