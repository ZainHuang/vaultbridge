import { expect, it } from 'vitest';
import { decodeBytes, encodeBytes } from '../src/github/GitHubWriter';
it('round trips a 4 MiB binary attachment without regexp stack overflow', () => {
  const bytes = new Uint8Array(4 * 1024 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const encoded = encodeBytes(bytes); expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
  expect(Buffer.compare(Buffer.from(decodeBytes(encoded)), Buffer.from(bytes))).toBe(0);
});
