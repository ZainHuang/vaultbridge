export function encodeBytes(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return btoa(chunks.join(''));
}
export function decodeBytes(text: string): Uint8Array {
  const clean = text.replace(/[\r\n]/g, '');
  const padding = clean.indexOf('=');
  // A repeated quartet regexp over multi-MiB attachments overflows the JS regexp
  // stack. Check alphabet, alignment and padding independently in linear space.
  if (clean.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(clean)
    || padding >= 0 && !(padding === clean.length - 1 || padding === clean.length - 2 && clean.endsWith('=='))) throw new Error('Invalid base64');
  const decoded = atob(clean);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}
