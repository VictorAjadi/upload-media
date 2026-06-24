/**
 * @upload-media/client - Encryption Utilities
 * 
 * Production-grade AES-256-GCM using WebCrypto.
 * Format: base64url(iv | tag | ciphertext)
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBase64Url(buffer: Uint8Array): string {
  let str = btoa(String.fromCharCode(...buffer));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str: string): Uint8Array {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  str += '='.repeat((4 - (str.length % 4)) % 4);
  return new Uint8Array(atob(str).split('').map((c) => c.charCodeAt(0)));
}

function getEnv(name: string): string | undefined {
  if (typeof process !== 'undefined' && process.env) {
    return process.env[name];
  }
  // @ts-ignore - Handle Vite/etc
  if (typeof import.meta !== 'undefined' && import.meta.env) {
    // @ts-ignore
    return import.meta.env[name];
  }
  return undefined;
}

async function getKey(): Promise<CryptoKey> {
  const envKey = getEnv('VITE_QUERY_STRING_KEY') || getEnv('QUERY_STRING_KEY') || 'default_secret_key_change_me_in_prod';
  const keyRaw = enc.encode(envKey.padEnd(32, '0')).slice(0, 32);
  return crypto.subtle.importKey('raw', keyRaw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptQueryString(text: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  const encryptedBytes = new Uint8Array(encrypted);

  const combined = new Uint8Array(iv.length + encryptedBytes.length);
  combined.set(iv);
  combined.set(encryptedBytes, iv.length);

  return toBase64Url(combined);
}

export async function decryptQueryString(token: string): Promise<string> {
  const key = await getKey();
  const combined = fromBase64Url(token);

  const iv = combined.slice(0, 12);
  const data = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return dec.decode(decrypted);
}

export async function generateFileHash(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return toBase64Url(new Uint8Array(hashBuffer));
}

export async function generateChunkHash(chunk: Blob): Promise<string> {
  return generateFileHash(chunk);
}

export async function verifyFileIntegrity(blob: Blob, expectedHash: string): Promise<boolean> {
  const hash = await generateFileHash(blob);
  return hash === expectedHash;
}

export async function signFormData(formData: FormData): Promise<string> {
  const parts: string[] = [];
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') {
      parts.push(`${key}=${value}`);
    }
  }
  const key = await getKey();
  const signed = await crypto.subtle.sign('HMAC', key, enc.encode(parts.join('&')));
  return toBase64Url(new Uint8Array(signed));
}

export function generateRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function createHMAC(data: string, key: string): Promise<string> {
  const keyObj = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', keyObj, enc.encode(data));
  return toBase64Url(new Uint8Array(signature));
}

export async function verifyHMAC(data: string, key: string, signature: string): Promise<boolean> {
  const keyObj = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  // Use as BufferSource for WebCrypto compatibility with Uint8Array
  return crypto.subtle.verify('HMAC', keyObj, fromBase64Url(signature) as any, enc.encode(data) as any);
}

export function toBase64(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data));
}

export function fromBase64(base64: string): Uint8Array {
  return new Uint8Array(atob(base64).split('').map((c) => c.charCodeAt(0)));
}
