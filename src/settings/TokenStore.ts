import { PreviewError } from '../errors';
import type { Settings } from './settings';

export interface Secrets { getSecret(id: string): string | null; setSecret(id: string, secret: string): void }

export class TokenStore {
  constructor(private readonly secrets?: Secrets) {}
  get supportsSecrets(): boolean { return !!this.secrets; }

  read(settings: Settings): string {
    try {
      if (settings.secretName) {
        if (!this.secrets) throw new Error('unavailable');
        const token = this.secrets.getSecret(settings.secretName);
        if (token === null) throw new Error('missing');
        return token;
      }
      return settings.localToken;
    } catch {
      throw new PreviewError('TOKEN', 'SECRET_UNAVAILABLE', 'Saved secret is unavailable on this device. Save the GitHub Token again.');
    }
  }

  /** Called only by the explicit settings Save action, never by Preview. */
  withToken(settings: Settings, token: string): Settings {
    try {
      if (this.secrets) {
        const secretName = settings.secretName || `local-mirror-sync-${crypto.randomUUID()}`;
        this.secrets.setSecret(secretName, token);
        return { ...settings, secretName, localToken: '' };
      }
      return { ...settings, secretName: '', localToken: token };
    } catch {
      throw new PreviewError('TOKEN', 'SECRET_SAVE_FAILED', 'SecretStorage could not save the token. Settings were not saved.');
    }
  }
}
