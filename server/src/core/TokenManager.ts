/**
 * @upload-media/server — TokenManager
 *
 * Issues and verifies cryptographically signed, self-contained upload tokens.
 * These tokens replace stateful session lookups during chunked uploads,
 * allowing any server instance in a cluster to validate and route incoming
 * chunk requests without querying a shared session store.
 *
 * IMPORTANT DESIGN NOTE:
 * ─────────────────────
 * This token is NOT an authentication credential. It does NOT replace the
 * user's Bearer/JWT auth token. The upload token is a *handshake claim*
 * that encodes the upload's structural contract (file ID, total chunks,
 * chunk size, MIME type, bucket). It is issued by the server during the
 * `/init` handshake AFTER the user has already been authenticated via
 * their normal auth flow.
 *
 * In the request lifecycle:
 *   Authorization: Bearer <user-auth-token>   ← user identity (existing)
 *   X-Upload-Token: <upload-token>            ← upload contract (this module)
 *
 * Token format: base64url(payload).base64url(hmac-sha256-signature)
 * No external JWT dependency — we use raw HMAC-SHA256 for zero-dependency
 * operation in both Node.js and Bun runtimes.
 */

import * as crypto from 'crypto';

// ── Token Payload ────────────────────────────────────────────────────────────

export interface UploadTokenPayload {
  /** Unique file ID assigned at init — deterministic across the entire upload lifecycle */
  fid: string;
  /** Upload type key (must match a configured uploadType) */
  ut: string;
  /** Storage adapter key (resolved from upload type config) */
  sk: string;
  /** Total expected chunks */
  tc: number;
  /** Chunk size in bytes (the uniform size; last chunk may be smaller) */
  cs: number;
  /** Total file size in bytes (declared by client at init) */
  ts: number;
  /** MIME type */
  mt: string;
  /** Original filename */
  fn: string;
  /** Bucket / folder target */
  bk: string;
  /** Fieldname for the file (e.g. 'file', 'avatar') */
  fd: string;
  /** Issued-at timestamp (seconds since epoch) */
  iat: number;
  /** Expiry timestamp (seconds since epoch) */
  exp: number;
}

export interface MintOptions {
  /** Token lifetime in seconds. Default: 3600 (1 hour). */
  ttlSeconds?: number;
}

export interface TokenManagerOptions {
  /**
   * Secret key for HMAC signing. Must be at least 32 characters.
   * If not provided, a random secret is generated — but this means
   * tokens will not survive server restarts and cannot be verified
   * across cluster nodes unless they share the same secret.
   */
  secret?: string;
  /** Default token lifetime in seconds. Default: 3600 (1 hour). */
  defaultTtlSeconds?: number;
}

// ── Token Errors ─────────────────────────────────────────────────────────────

export class TokenError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number = 401) {
    super(message);
    this.name = 'TokenError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ── TokenManager ─────────────────────────────────────────────────────────────

export class TokenManager {
  private readonly key: Buffer;
  private readonly defaultTtlSeconds: number;

  constructor(options: TokenManagerOptions = {}) {
    // Derive a 256-bit key from the secret using SHA-256.
    // This normalizes any-length input to a fixed-size HMAC key.
    const secret = options.secret || this.generateFallbackSecret();
    this.key = crypto.createHash('sha256').update(secret).digest();
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? 3600;

    if (!options.secret) {
      console.warn(
        '[TokenManager] No `tokenSecret` configured — using a randomly generated secret. ' +
        'Upload tokens will NOT survive server restarts and will NOT work in multi-node ' +
        'clusters. Set `tokenSecret` in your UploadEngine config for production.'
      );
    }
  }

  /**
   * Mint a new upload token.
   *
   * Call this during the `/init` handshake after authentication and
   * validation have passed. The returned token encodes the entire
   * upload contract — any server node can verify it without a DB lookup.
   */
  mint(payload: Omit<UploadTokenPayload, 'iat' | 'exp'>, options?: MintOptions): string {
    const ttl = options?.ttlSeconds ?? this.defaultTtlSeconds;
    const now = Math.floor(Date.now() / 1000);

    const fullPayload: UploadTokenPayload = {
      ...payload,
      iat: now,
      exp: now + ttl,
    };

    const data = this.encodePayload(fullPayload);
    const signature = this.sign(data);

    return `${data}.${signature}`;
  }

  /**
   * Verify and decode an upload token.
   *
   * Checks both the HMAC signature and the expiry timestamp.
   * Throws TokenError on any failure — callers should catch and
   * return an appropriate HTTP 401/403 response.
   *
   * This method performs ZERO database operations.
   */
  verify(token: string): UploadTokenPayload {
    if (!token || typeof token !== 'string') {
      throw new TokenError('Upload token is missing or empty', 'TOKEN_MISSING');
    }

    const dotIndex = token.indexOf('.');
    if (dotIndex === -1 || dotIndex === 0 || dotIndex === token.length - 1) {
      throw new TokenError('Malformed upload token', 'TOKEN_MALFORMED');
    }

    const data = token.substring(0, dotIndex);
    const signature = token.substring(dotIndex + 1);

    // Verify HMAC signature using timing-safe comparison
    const expectedSignature = this.sign(data);
    if (!this.timingSafeEqual(signature, expectedSignature)) {
      throw new TokenError('Invalid upload token signature', 'TOKEN_INVALID_SIGNATURE');
    }

    // Decode payload
    let payload: UploadTokenPayload;
    try {
      payload = this.decodePayload(data);
    } catch {
      throw new TokenError('Corrupted upload token payload', 'TOKEN_CORRUPTED');
    }

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      throw new TokenError(
        `Upload token expired ${now - payload.exp} seconds ago. ` +
        'Re-initiate the upload with a new /init handshake.',
        'TOKEN_EXPIRED',
      );
    }

    // Sanity: iat should be in the past
    if (payload.iat > now + 30) {
      // Allow 30s clock skew
      throw new TokenError('Upload token issued in the future', 'TOKEN_FUTURE');
    }

    return payload;
  }

  /**
   * Check if a token is close to expiring.
   * Useful for the client to refresh before the token actually expires.
   *
   * @param token - The upload token string
   * @param thresholdSeconds - Warn if expiry is within this many seconds (default: 300 = 5min)
   */
  isExpiringSoon(token: string, thresholdSeconds: number = 300): boolean {
    try {
      const payload = this.verify(token);
      const now = Math.floor(Date.now() / 1000);
      return (payload.exp - now) <= thresholdSeconds;
    } catch {
      return true; // If we can't verify it, treat as expired
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private encodePayload(payload: UploadTokenPayload): string {
    const json = JSON.stringify(payload);
    return Buffer.from(json, 'utf-8').toString('base64url');
  }

  private decodePayload(data: string): UploadTokenPayload {
    const json = Buffer.from(data, 'base64url').toString('utf-8');
    return JSON.parse(json);
  }

  private sign(data: string): string {
    return crypto
      .createHmac('sha256', this.key)
      .update(data, 'utf-8')
      .digest('base64url');
  }

  /**
   * Timing-safe string comparison to prevent timing attacks on signatures.
   * Converts both strings to buffers of equal length before comparison.
   */
  private timingSafeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf-8');
    const bufB = Buffer.from(b, 'utf-8');

    // If lengths differ, the signature is definitely wrong.
    // We still perform the comparison on padded buffers to avoid
    // leaking length information via timing.
    if (bufA.length !== bufB.length) {
      const padded = Buffer.alloc(bufA.length);
      try {
        crypto.timingSafeEqual(bufA, padded);
      } catch { /* swallow */ }
      return false;
    }

    try {
      return crypto.timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
  }

  private generateFallbackSecret(): string {
    return crypto.randomBytes(32).toString('hex');
  }
}
