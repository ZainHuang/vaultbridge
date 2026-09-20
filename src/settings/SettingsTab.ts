import { Notice, PluginSettingTab, Setting, type App } from 'obsidian';
import { safeError } from '../errors';
import type LocalMirrorSyncPlugin from '../main';

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: LocalMirrorSyncPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'VaultBridge' });
    containerEl.createEl('p', { text: 'V1.1 · Stateful Three-Way Sync. Review Preview or enable safe Auto Sync. Every sync is verified.' });
    new Setting(containerEl).setName('Sync Dashboard').setDesc('Repository health, file counts, devices and local history. Opens cached state without GitHub requests.')
      .addButton(button => button.setButtonText('Open Dashboard').onClick(() => { void this.plugin.openDashboard(); }))
      .addButton(button => button.setButtonText('Sync History').onClick(() => { void this.plugin.openDashboard(true); }));
    const state = this.plugin.stateError ? undefined : this.plugin.syncState.current();
    const deviceSetting = new Setting(containerEl).setName('Device Status').setDesc(state
      ? `Device: ${state.deviceId}\n${state.baseManifest ? 'SYNC HISTORY PRESENT' : 'NEW DEVICE'}\nBase generation: ${state.baseManifest?.generation ?? 'No sync history'}`
      : safeError(this.plugin.stateError));
    deviceSetting.settingEl.addClass('lms-device-setting');
    const initializationSetting = new Setting(containerEl).setName('Device initialization').setDesc('Empty Vaults download from GitHub. Existing Vaults and legacy repositories use a reviewed union. BASE is saved only after verification.')
      .addButton(button => button.setButtonText('Review in Preview').onClick(() => this.plugin.openPreview()))
      .addButton(button => button.setButtonText('Initialize from GitHub').onClick(() => this.plugin.openPreview()))
      .addButton(button => button.setButtonText('Recovery').onClick(() => this.plugin.openRecovery()));
    initializationSetting.settingEl.addClass('lms-init-setting');
    const draft = { ...this.plugin.settings };
    new Setting(containerEl).setName('Device name').setDesc('A recognizable name for this device. Published with your next file sync commit.')
      .addText(text => { text.inputEl.setAttribute('aria-label', 'Device name'); text.inputEl.maxLength = 80; text.setValue(draft.deviceName).onChange(value => { draft.deviceName = value.trim(); }); });
    new Setting(containerEl).setName('Device type').addDropdown(dropdown => dropdown.addOptions({ desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet', other: 'Other' })
      .setValue(draft.deviceType).onChange(value => { draft.deviceType = value; }));
    for (const [key, name] of [['owner', 'GitHub Owner'], ['repository', 'Repository'], ['branch', 'Branch']] as const) {
      new Setting(containerEl).setName(name).addText(text => text.setValue(draft[key]).onChange(value => { draft[key] = value.trim(); }));
    }
    let token: string | undefined;
    new Setting(containerEl).setName('GitHub Token').setDesc(this.plugin.tokens.supportsSecrets
      ? 'Stored in Obsidian SecretStorage. Leave untouched to keep the current token; enter a blank value to clear it.'
      : 'SecretStorage is unavailable. Explicitly saved tokens stay in this plugin’s local data.json, which is always excluded from mirror scope.')
      .addText(text => {
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
        text.setPlaceholder(draft.secretName || draft.localToken ? 'Saved token (unchanged)' : 'Fine-grained PAT');
        text.onChange(value => { token = value.trim(); });
      });
    new Setting(containerEl).setName('Sync Mode').setDesc('Stateful Three-Way Sync · BASE / LOCAL / REMOTE. Fine-grained PAT requires repository Contents: Read and write.');
    new Setting(containerEl).setName('Delete Safety Threshold').setDesc('Removed paths above this count (including rename sources) require typing the exact deletion count before execution.')
      .addText(text => {
        text.inputEl.type = 'number'; text.inputEl.min = '0'; text.inputEl.step = '1';
        text.setValue(String(draft.deleteSafetyThreshold)).onChange(value => { draft.deleteSafetyThreshold = value.trim() === '' ? NaN : Number(value); });
      });
    new Setting(containerEl).setName('Ignore Patterns').setDesc('One Git-compatible glob per line. Root .gitignore is loaded first; these rules run last. Audio is ignored only when matched by your rules. Protected paths cannot be re-included.')
      .addTextArea(text => {
        text.inputEl.rows = 6;
        text.setPlaceholder('*.mp3\n*.m4a\n*.wav').setValue(draft.ignorePatterns).onChange(value => { draft.ignorePatterns = value; });
      });
    new Setting(containerEl).setName('Include .obsidian').setDesc('Off by default. This plugin, its token/state, workspace files and cache are always excluded.')
      .addToggle(toggle => toggle.setValue(draft.includeObsidian).onChange(value => { draft.includeObsidian = value; }));
    new Setting(containerEl).setName('Auto Sync').setDesc('OFF by default. Vault changes trigger a debounced Preview; only small, conflict-free plans execute. Initialization, adoption, recovery, remote Manifest changes and high-risk plans require manual review.')
      .addToggle(toggle => toggle.setValue(draft.autoSync).onChange(value => { draft.autoSync = value; }));
    for (const [key, label, min] of [['autoSyncDebounceSeconds', 'Auto Sync debounce (seconds)', 1], ['autoSyncDeleteThreshold', 'Auto Sync delete threshold', 0], ['autoSyncChangeThreshold', 'Auto Sync changed files threshold', 1]] as const) {
      new Setting(containerEl).setName(label).addText(text => {
        text.inputEl.type = 'number'; text.inputEl.min = String(min); text.inputEl.max = '86400'; text.inputEl.step = '1'; text.inputEl.setAttribute('aria-label', label);
        text.setValue(String(draft[key])).onChange(value => { draft[key] = value.trim() ? Number(value) : NaN; });
      });
    }
    const auto = this.plugin.product.snapshot().auto;
    const autoStatus = new Setting(containerEl).setName('Auto Sync Status').setDesc(`${this.plugin.settings.autoSync ? 'Enabled' : 'Disabled'}\nLast check: ${auto.lastCheckAt ? new Date(auto.lastCheckAt).toLocaleString() : 'Not yet'}\nLast sync: ${auto.lastSyncAt ? new Date(auto.lastSyncAt).toLocaleString() : 'Not yet'}\nResult: ${auto.result}${auto.reason ? `\n${auto.reason}` : ''}`);
    autoStatus.settingEl.addClass('lms-device-setting');
    new Setting(containerEl).setName('Auto Verify').setDesc('Always ON · Remote commit, local bytes and saved BASE are read back. Failed verification preserves recovery data.');
    new Setting(containerEl).setName('Recovery storage').setDesc('Pre-sync copies stay in .local-mirror-sync/transactions and are never uploaded. Individual synced files are limited to 20 MiB for mobile memory safety.');
    const feedback = containerEl.createEl('p', { attr: { role: 'status' } });
    // Settings may live in an Obsidian popout which the user closes while the
    // adapter is saving. Do not touch controls in a destroyed window afterwards.
    const connected = () => {
      try { return containerEl.isConnected && !containerEl.ownerDocument.defaultView?.closed; } catch { return false; }
    };
    new Setting(containerEl).addButton(button => button.setButtonText('Save settings').setCta().onClick(async () => {
      button.setDisabled(true);
      try {
        if (!Number.isSafeInteger(draft.deleteSafetyThreshold) || draft.deleteSafetyThreshold < 0) {
          feedback.setText('Delete Safety Threshold must be a non-negative integer.'); return;
        }
        if (!draft.deviceName || draft.deviceName.length > 80) { feedback.setText('Device name must contain 1 to 80 characters.'); return; }
        for (const key of ['autoSyncDebounceSeconds', 'autoSyncDeleteThreshold', 'autoSyncChangeThreshold'] as const) {
          if (!Number.isSafeInteger(draft[key]) || draft[key] < (key === 'autoSyncDeleteThreshold' ? 0 : 1) || draft[key] > 86400) {
            feedback.setText('Auto Sync values must be whole numbers from 1 to 86400 (delete threshold may be 0).'); return;
          }
        }
        await this.plugin.saveSettings(draft, token);
        token = undefined;
        if (connected()) { this.display(); new Notice('VaultBridge settings saved.'); }
      } catch (error) { if (connected()) feedback.setText(safeError(error)); }
      finally { if (connected()) button.setDisabled(false); }
    }));
  }

}
