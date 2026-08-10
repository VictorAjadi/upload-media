/**
 * @upload-media/server - S3StorageAdapter (v1.3 — Optimized)
 *
 * Fully optimized S3 multipart upload adapter with:
 *
 * [1] Configurable chunk cache strategy (`disk` | `memory`).
 *     - `disk`: chunks spilled to temp files — O(1) heap, ideal for large media.
 *     - `memory`: chunks held in RAM — lower latency, ideal for small files / serverless.
 *
 * [2] Zero double-write for raw (untransformed) uploads.
 *     The multipart upload started during writeChunk() is finalized directly via
 *     CompleteMultipartUploadCommand; the engine skips the redundant putStream re-upload.
 *
 * [3] AbortMultipartUploadCommand on integrity failure / purge.
 *     Prevents orphaned S3 parts from accruing storage charges.
 *
 * [4] SDK module cached once — `require('@aws-sdk/client-s3')` called at most once
 *     per process lifetime instead of per-method.
 *
 * [5] assembleChunksToPath() reads from the configured cache (disk or memory)
 *     and streams to a temp file for FFmpeg/media processing.
 *
 * [6] Deterministic temp cleanup in finalize(), abortMultipart(), and on error.
 */

import { Readable } from 'stream';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  StorageAdapter,
  StorageContext,
  StorageReadOptions,
  StorageWriteResult,
} from '../../types';

const MIN_S3_PART_SIZE = 5 * 1024 * 1024; // Hard S3 minimum for all but last part

export type ChunkCacheStrategy = 'disk' | 'memory';

export interface S3StorageOptions {
  bucket: string;
  region: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** For S3-compatible providers (Cloudflare R2, MinIO, DigitalOcean Spaces, etc.) */
  endpoint?: string;
  forcePathStyle?: boolean;
  /** Public URL builder; defaults to AWS virtual-hosted-style URL. */
  buildPublicUrl?: (bucket: string, key: string) => string;
  /** Override how a logical fileId becomes an S3 object key. */
  buildKey?: (fileId: string, ctx: StorageContext) => string;
  /**
   * Minimum bytes to buffer before flushing an UploadPart.
   * Default: 5 MB (the S3 minimum for all but the last part).
   */
  minPartSize?: number;
  /** Pass an already-constructed S3Client to skip credential config. */
  client?: any;
  /**
   * Directory for temporary assembled files and chunk cache (when using 'disk' strategy).
   * Defaults to os.tmpdir().
   */
  tempDir?: string;
  /**
   * Strategy for caching incoming chunks between writeChunk() and assembleChunksToPath().
   *
   * - `'disk'`   — Chunks are spilled to temp files. O(1) heap usage regardless of file
   *                size. Best for large media (video/audio) or memory-constrained servers.
   *
   * - `'memory'` — Chunks are held in a Buffer[] array in heap memory. Lower latency
   *                (no disk I/O), but heap grows proportionally with file size. Best for
   *                small files (avatars/thumbnails) or short-lived serverless functions
   *                where disk may be ephemeral or slow.
   *
   * Default: `'disk'`
   */
  chunkCacheStrategy?: ChunkCacheStrategy;
}

interface MultipartState {
  uploadId: string;
  key: string;
  partNumber: number;
  parts: { ETag: string; PartNumber: number }[];
  /** Incoming engine-chunks buffered until they reach minPartSize. */
  buffer: Buffer[];
  bufferedBytes: number;
  /** Total engine-chunks received (for validation). */
  chunksReceived: number;
}

export class S3StorageAdapter implements StorageAdapter {
  readonly name = 's3';
  private options: S3StorageOptions;
  private _client: any = null;
  private _sdk: any = null;
  private minPartSize: number;
  private tempDir: string;
  private cacheStrategy: ChunkCacheStrategy;

  /** Active multipart uploads keyed by fileId. */
  private uploads = new Map<string, MultipartState>();

  /**
   * In-memory chunk cache (only used when cacheStrategy === 'memory').
   * Maps fileId -> sparse Buffer[] indexed by chunkNumber.
   */
  private memoryCache = new Map<string, Buffer[]>();

  constructor(options: S3StorageOptions) {
    this.options = options;
    this.minPartSize = options.minPartSize ?? MIN_S3_PART_SIZE;
    this.tempDir = options.tempDir ?? os.tmpdir();
    this.cacheStrategy = options.chunkCacheStrategy ?? 'disk';
  }

  // ── SDK lazy-loader (Fix 5: cached once per process) ────────────────────────

  private loadSDK(): any {
    if (this._sdk) return this._sdk;
    try {
      this._sdk = require('@aws-sdk/client-s3');
      return this._sdk;
    } catch {
      throw new Error(
        '[upload-media/server] S3StorageAdapter requires "@aws-sdk/client-s3". ' +
        'Install it with: npm install @aws-sdk/client-s3',
      );
    }
  }

  private getClient(): any {
    if (this.options.client) return this.options.client;
    if (this._client) return this._client;

    const sdk = this.loadSDK();
    this._client = new sdk.S3Client({
      region: this.options.region,
      credentials: this.options.credentials,
      endpoint: this.options.endpoint,
      forcePathStyle: this.options.forcePathStyle,
    });
    return this._client;
  }

  // ── Key / URL builders ───────────────────────────────────────────────────

  private resolveKey(fileId: string, ctx: StorageContext): string {
    if (this.options.buildKey) return this.options.buildKey(fileId, ctx);
    return `${ctx.bucket}/${fileId}`;
  }

  private resolvePublicUrl(key: string): string {
    if (this.options.buildPublicUrl) {
      return this.options.buildPublicUrl(this.options.bucket, key);
    }
    if (this.options.endpoint) {
      return `${this.options.endpoint.replace(/\/$/, '')}/${this.options.bucket}/${key}`;
    }
    return `https://${this.options.bucket}.s3.${this.options.region}.amazonaws.com/${key}`;
  }

  // ── Chunk cache helpers (Fix 2: configurable disk | memory) ─────────────

  private chunkCachePath(fileId: string, chunkNumber: number): string {
    return path.join(this.tempDir, `s3_cache_${fileId}_${chunkNumber}.bin`);
  }

  private async cacheChunk(fileId: string, chunkNumber: number, data: Buffer): Promise<void> {
    if (this.cacheStrategy === 'memory') {
      if (!this.memoryCache.has(fileId)) this.memoryCache.set(fileId, []);
      this.memoryCache.get(fileId)![chunkNumber] = data;
    } else {
      await fs.promises.mkdir(this.tempDir, { recursive: true });
      await fs.promises.writeFile(this.chunkCachePath(fileId, chunkNumber), data);
    }
  }

  private async readCachedChunk(fileId: string, chunkNumber: number): Promise<Buffer> {
    if (this.cacheStrategy === 'memory') {
      const cache = this.memoryCache.get(fileId);
      if (!cache || !cache[chunkNumber]) {
        throw new Error(`[S3StorageAdapter] Missing cached chunk ${chunkNumber} for file "${fileId}" (memory)`);
      }
      return cache[chunkNumber];
    } else {
      const p = this.chunkCachePath(fileId, chunkNumber);
      try {
        return await fs.promises.readFile(p);
      } catch {
        throw new Error(`[S3StorageAdapter] Missing cached chunk ${chunkNumber} for file "${fileId}" (disk: ${p})`);
      }
    }
  }

  private async cleanupCache(fileId: string, totalChunks?: number): Promise<void> {
    if (this.cacheStrategy === 'memory') {
      this.memoryCache.delete(fileId);
    } else {
      // Best-effort cleanup of chunk files
      const count = totalChunks ?? 10000; // upper bound scan
      const toDelete: Promise<void>[] = [];
      for (let i = 0; i < count; i++) {
        const p = this.chunkCachePath(fileId, i);
        toDelete.push(fs.promises.unlink(p).catch(() => {}));
      }
      await Promise.all(toDelete);
    }
  }

  // ── Part flusher ─────────────────────────────────────────────────────────

  private async flushPart(
    state: MultipartState,
    isFinal: boolean,
  ): Promise<void> {
    if (state.bufferedBytes === 0) return;

    const sdk = this.loadSDK();
    const client = this.getClient();

    const body = Buffer.concat(state.buffer, state.bufferedBytes);
    state.buffer = [];
    state.bufferedBytes = 0;

    const result = await client.send(
      new sdk.UploadPartCommand({
        Bucket: this.options.bucket,
        Key: state.key,
        UploadId: state.uploadId,
        PartNumber: state.partNumber,
        Body: body,
      }),
    );

    state.parts.push({ ETag: result.ETag, PartNumber: state.partNumber });
    state.partNumber += 1;
  }

  // ── writeChunk ───────────────────────────────────────────────────────────

  async writeChunk(
    fileId: string,
    chunkNumber: number,
    data: Buffer,
    ctx: StorageContext,
  ): Promise<void> {
    const sdk = this.loadSDK();
    const client = this.getClient();

    // Cache chunk for later assembly (disk or memory per config)
    await this.cacheChunk(fileId, chunkNumber, data);

    let state = this.uploads.get(fileId);
    if (!state) {
      const key = this.resolveKey(fileId, ctx);
      const created = await client.send(
        new sdk.CreateMultipartUploadCommand({
          Bucket: this.options.bucket,
          Key: key,
          ContentType: ctx.contentType,
        }),
      );
      state = {
        uploadId: created.UploadId,
        key,
        partNumber: 1,
        parts: [],
        buffer: [],
        bufferedBytes: 0,
        chunksReceived: 0,
      };
      this.uploads.set(fileId, state);
    }

    state.chunksReceived += 1;
    state.buffer.push(data);
    state.bufferedBytes += data.length;

    if (state.bufferedBytes >= this.minPartSize) {
      await this.flushPart(state, false);
    }
  }

  // ── assembleChunksToPath (Fix 2: reads from disk or memory cache) ───────

  async assembleChunksToPath(
    fileId: string,
    totalChunks: number,
    ext: string,
    ctx: StorageContext,
  ): Promise<string> {
    const dest = path.join(this.tempDir, `${fileId}_assembled${ext}`);
    const writeStream = fs.createWriteStream(dest);

    await new Promise<void>((resolve, reject) => {
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);

      (async () => {
        try {
          for (let i = 0; i < totalChunks; i++) {
            const buf = await this.readCachedChunk(fileId, i);
            const ok = writeStream.write(buf);
            if (!ok) await new Promise<void>((r) => writeStream.once('drain', r));
          }
          writeStream.end();
        } catch (err) {
          writeStream.destroy(err as Error);
          reject(err);
        }
      })();
    });

    return dest;
  }

  // ── finalize (Fix 1, 6: complete S3 multipart + cleanup cache) ──────────

  async finalize(fileId: string, ctx: StorageContext): Promise<StorageWriteResult> {
    const sdk = this.loadSDK();
    const client = this.getClient();
    const state = this.uploads.get(fileId);

    if (!state) {
      throw new Error(
        `[S3StorageAdapter] No active multipart upload found for fileId "${fileId}"`,
      );
    }

    // Flush whatever remains — the last part is allowed to be under 5 MB.
    await this.flushPart(state, true);

    await client.send(
      new sdk.CompleteMultipartUploadCommand({
        Bucket: this.options.bucket,
        Key: state.key,
        UploadId: state.uploadId,
        MultipartUpload: { Parts: state.parts },
      }),
    );

    const result: StorageWriteResult = {
      storageRef: state.key,
      url: this.resolvePublicUrl(state.key),
    };

    // Deterministic cleanup
    this.uploads.delete(fileId);
    await this.cleanupCache(fileId, state.chunksReceived).catch(() => {});

    return result;
  }

  // ── abortMultipart (Fix 3: abort S3 multipart + purge cache) ────────────

  async abortMultipart(fileId: string): Promise<void> {
    const state = this.uploads.get(fileId);
    if (!state) return; // Nothing to abort

    const sdk = this.loadSDK();
    const client = this.getClient();

    try {
      await client.send(
        new sdk.AbortMultipartUploadCommand({
          Bucket: this.options.bucket,
          Key: state.key,
          UploadId: state.uploadId,
        }),
      );
    } catch (err) {
      console.warn(`[S3StorageAdapter] AbortMultipartUpload failed for "${fileId}":`, err);
    }

    this.uploads.delete(fileId);
    await this.cleanupCache(fileId, state.chunksReceived).catch(() => {});
  }

  /**
   * Returns true if this adapter has an active multipart upload for the given fileId
   * that can be finalized directly (no re-upload needed for raw files).
   */
  hasActiveMultipart(fileId: string): boolean {
    return this.uploads.has(fileId);
  }

  // ── putStream ────────────────────────────────────────────────────────────

  async putStream(
    fileId: string,
    stream: Readable,
    ctx: StorageContext,
  ): Promise<StorageWriteResult> {
    const sdk = this.loadSDK();
    const client = this.getClient();
    const key = this.resolveKey(fileId, ctx);

    await client.send(
      new sdk.PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: stream,
        ContentType: ctx.contentType,
      }),
    );

    return { storageRef: key, url: this.resolvePublicUrl(key) };
  }

  // ── putObject ────────────────────────────────────────────────────────────

  async putObject(
    fileId: string,
    data: Buffer,
    ctx: StorageContext,
  ): Promise<StorageWriteResult> {
    const sdk = this.loadSDK();
    const client = this.getClient();
    const key = this.resolveKey(fileId, ctx);

    await client.send(
      new sdk.PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: data,
        ContentType: ctx.contentType,
      }),
    );

    return { storageRef: key, url: this.resolvePublicUrl(key) };
  }

  // ── readStream ───────────────────────────────────────────────────────────

  async readStream(ref: string, options?: StorageReadOptions): Promise<Readable> {
    const sdk = this.loadSDK();
    const client = this.getClient();

    const range =
      options?.start !== undefined || options?.end !== undefined
        ? `bytes=${options?.start ?? 0}-${options?.end ?? ''}`
        : undefined;

    const result = await client.send(
      new sdk.GetObjectCommand({
        Bucket: this.options.bucket,
        Key: ref,
        Range: range,
      }),
    );

    return result.Body as Readable;
  }

  // ── delete ───────────────────────────────────────────────────────────────

  async delete(ref: string): Promise<void> {
    const sdk = this.loadSDK();
    const client = this.getClient();
    await client.send(
      new sdk.DeleteObjectCommand({ Bucket: this.options.bucket, Key: ref }),
    );
  }
}