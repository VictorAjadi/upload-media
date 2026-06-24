/**
 * @upload-media/server - Encryption Utilities
 *
 * Decrypts the query strings encrypted by the frontend.
 * Works with both Node.js (crypto module) and Bun (bun:crypto or crypto APIs).
 *
 * Expected format: base64url(iv | tag | ciphertext)
 */

function fromBase64Url(str: string): Buffer {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  str += '='.repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(str, 'base64');
}

function isNodeJs(): boolean {
  return typeof global !== 'undefined' && !(globalThis as any).Bun;
}

function isBun(): boolean {
  return !!(globalThis as any).Bun;
}

/**
 * Decrypt an AES-256-GCM encrypted query string.
 * Mirrors frontend encryption exactly: iv (12 bytes) | tag (16 bytes) | ciphertext.
 */
export function decryptQueryString(token: string): string {
  const key = deriveKey();
  const raw = fromBase64Url(token);

  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);

  if (isNodeJs()) {
    return decryptNodeJs(encrypted, tag, iv, key);
  } else if (isBun()) {
    return decryptBun(encrypted, tag, iv, key);
  } else {
    throw new Error('[decrypt] Unable to determine runtime (Node.js or Bun)');
  }
}

function deriveKey(): Buffer {
  const keyString = (process.env.VITE_QUERY_STRING_KEY || '').padEnd(32, '0').slice(0, 32);

  if (isNodeJs()) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(keyString).digest();
  } else if (isBun()) {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256');
    hash.update(keyString);
    return hash.digest();
  }

  throw new Error('[deriveKey] Unable to determine runtime');
}

function decryptNodeJs(encrypted: Buffer, tag: Buffer, iv: Buffer, key: Buffer): string {
  const crypto = require('crypto');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

function decryptBun(encrypted: Buffer, tag: Buffer, iv: Buffer, key: Buffer): string {
  // Bun supports Node.js crypto module directly in recent versions
  try {
    const crypto = require('crypto');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    // Fallback: Bun also supports webcrypto via globalThis.crypto
    throw new Error('[decryptBun] crypto.createDecipheriv not available in this Bun version');
  }
}

/**
 * Hash a string using SHA-256.
 */
export function hashString(input: string): string {
  if (isNodeJs()) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(input).digest('hex');
  } else if (isBun()) {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256');
    hash.update(input);
    return hash.digest('hex');
  }
  throw new Error('[hashString] Unable to determine runtime');
}

/**
 * Generate a random hex string of specified byte length.
 */
export function generateRandomString(byteLength: number = 32): string {
  if (isNodeJs()) {
    const crypto = require('crypto');
    return crypto.randomBytes(byteLength).toString('hex');
  } else if (isBun()) {
    const crypto = require('crypto');
    return crypto.randomBytes(byteLength).toString('hex');
  }
  throw new Error('[generateRandomString] Unable to determine runtime');
}

/**
 * Sign data using HMAC-SHA256.
 */
export function signData(data: string, secret: string): string {
  if (isNodeJs()) {
    const crypto = require('crypto');
    return crypto.createHmac('sha256', secret).update(data).digest('hex');
  } else if (isBun()) {
    const crypto = require('crypto');
    return crypto.createHmac('sha256', secret).update(data).digest('hex');
  }
  throw new Error('[signData] Unable to determine runtime');
}

/**
 * Verify a signature created by signData.
 */
export function verifySignature(data: string, secret: string, signature: string): boolean {
  const expected = signData(data, secret);
  return expected === signature;
}
