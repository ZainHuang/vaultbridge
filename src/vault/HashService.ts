import { sha1 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Raw bytes, including BOM/CRLF, are hashed exactly as a Git blob. */
export function gitBlobSha(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  return bytesToHex(sha1.create().update(header).update(bytes).digest());
}
