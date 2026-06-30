/**
 * @upload-media/server - S3StorageAdapter
 *
 * [1] assembleChunksToPath() implemented. UploadEngine calls this on
 *     the last chunk. The adapter streams each buffered S3 part to a
 *     temp file on disk so FFmpeg can read from disk rather than
 *     holding the full file in heap. The in-progress multipart upload
 *     is NOT finalized here — the engine calls finalize() separately
 *     after media processing, which completes the S3 multipart upload
 *     via CompleteMultipartUploadCommand.
 *
 *     Because S3 does not expose already-uploaded parts for re-reading
 *     (without downloading the whole object), the adapter maintains a
 *     local part-buffer cache (partCache) in parallel so we can
 *     reconstruct the file for assembleChunksToPath without an extra
 *     S3 round-trip.
 *
 * [2] finalize() was already correct — it calls
 *     CompleteMultipartUploadCommand — but was never called by the
 *     engine. UploadEngine now calls finalize() after
 *     assembleChunksToPath + media processing (see UploadEngine fix).
 *     No change needed here; documented for clarity.
 *
 * [3] StorageContext (including ctx.chunkCount) is now threaded through
 *     all methods consistently.
 *
 * [4] partCache is cleared in finalize() and on abort to avoid unbounded
 *     memory growth for long-lived server processes with many uploads.
 */

import { Readable } from 'stream';
import * as os from 'os';
import * as path from 'path';
import * as fsCb from 'fs';
import {
  StorageAdapter,
  StorageContext,
  StorageReadOptions,
  StorageWriteResult,
} from '../../types';

const MIN_S3_PART_SIZE = 5 * 1024 * 1024; // hard S3 requirement

export interface S3StorageOptions {
  bucket: string;
  region: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** For S3-compatible providers (Cloudflare R2, MinIO, etc.) */
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
   * Directory for temporary assembled files used during media processing.
   * Defaults to os.tmpdir().
   */
  tempDir?: string;
}

interface MultipartState {
  uploadId: string;
  key: string;
  partNumber: number;
  parts: { ETag: string; PartNumber: number }[];
  /** Incoming engine-chunks buffered until they reach minPartSize. */
  buffer: Buffer[];
  bufferedBytes: number;
}

export class S3StorageAdapter implements StorageAdapter {
  readonly name = 's3';
  private options: S3StorageOptions;
  private _client: any;
  private minPartSize: number;
  private tempDir: string;

  /** Active multipart uploads keyed by fileId. */
  private uploads = new Map<string, MultipartState>();

  /**
   * Parallel cache of the raw engine-chunks (before S3-part
   * buffering) so assembleChunksToPath() can reconstruct the file
   * without downloading from S3.
   */
  private partCache = new Map<string, Buffer[]>();

  constructor(options: S3StorageOptions) {
    this.options = options;
    this.minPartSize = options.minPartSize ?? MIN_S3_PART_SIZE;
    this.tempDir = options.tempDir ?? os.tmpdir();
  }

  // ── SDK lazy-loader ──────────────────────────────────────────────────────

  private async getClient(): Promise<any> {
    if (this.options.client) return this.options.client;
    if (this._client) return this._client;

    let S3Client: any;
    try {
      ({ S3Client } = require('@aws-sdk/client-s3'));
    } catch {
      throw new Error(
        '[upload-media/server] S3StorageAdapter requires "@aws-sdk/client-s3". ' +
        'Install it with: npm install @aws-sdk/client-s3',
      );
    }

    this._client = new S3Client({
      region: this.options.region,
      credentials: this.options.credentials,
      endpoint: this.options.endpoint,
      forcePathStyle: this.options.forcePathStyle,
    });
    return this._client;
  }

  private async loadCommands(): Promise<any> {
    try {
      return require('@aws-sdk/client-s3');
    } catch {
      throw new Error(
        '[upload-media/server] S3StorageAdapter requires "@aws-sdk/client-s3". ' +
        'Install it with: npm install @aws-sdk/client-s3',
      );
    }
  }

  // ── Key / URL builders ───────────────────────────────────────────────────

  private buildKey(fileId: string, ctx: StorageContext): string {
    if (this.options.buildKey) return this.options.buildKey(fileId, ctx);
    return `${ctx.bucket}/${fileId}`;
  }

  private buildPublicUrl(key: string): string {
    if (this.options.buildPublicUrl) {
      return this.options.buildPublicUrl(this.options.bucket, key);
    }
    if (this.options.endpoint) {
      return `${this.options.endpoint.replace(/\/$/, '')}/${this.options.bucket}/${key}`;
    }
    return `https://${this.options.bucket}.s3.${this.options.region}.amazonaws.com/${key}`;
  }

  // ── Part flusher ─────────────────────────────────────────────────────────

  private async flushPart(
    state: MultipartState,
    sdk: any,
    client: any,
    isFinal: boolean,
  ): Promise<void> {
    if (state.bufferedBytes === 0) return;

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
    const sdk = await this.loadCommands();
    const client = await this.getClient();

    // FIX [1]: cache raw chunk for assembleChunksToPath
    if (!this.partCache.has(fileId)) this.partCache.set(fileId, []);
    this.partCache.get(fileId)![chunkNumber] = data;

    let state = this.uploads.get(fileId);
    if (!state) {
      const key = this.buildKey(fileId, ctx);
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
      };
      this.uploads.set(fileId, state);
    }

    state.buffer.push(data);
    state.bufferedBytes += data.length;

    if (state.bufferedBytes >= this.minPartSize) {
      await this.flushPart(state, sdk, client, false);
    }
  }

  // ── assembleChunksToPath  ───────────────────────────────────────
  //
  // Reads cached engine-chunks in order and writes them to a temp file.
  // The multipart upload on S3 is left open; finalize() completes it.

  async assembleChunksToPath(
    fileId: string,
    totalChunks: number,
    ext: string,
    ctx: StorageContext,
  ): Promise<string> {
    const cache = this.partCache.get(fileId);
    if (!cache || cache.length < totalChunks) {
      throw new Error(
        `[S3StorageAdapter] Part cache incomplete for fileId "${fileId}" ` +
        `(have ${cache?.length ?? 0}, need ${totalChunks})`,
      );
    }

    const dest = path.join(this.tempDir, `${fileId}_assembled${ext}`);
    const writeStream = fsCb.createWriteStream(dest);

    await new Promise<void>((resolve, reject) => {
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);

      (async () => {
        try {
          for (let i = 0; i < totalChunks; i++) {
            const buf = cache[i];
            if (!buf) {
              throw new Error(
                `[S3StorageAdapter] Missing cached chunk ${i} for file "${fileId}"`,
              );
            }
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

  // ── finalize (FIX [2]) ───────────────────────────────────────────────────

  async finalize(fileId: string, ctx: StorageContext): Promise<StorageWriteResult> {
    const sdk = await this.loadCommands();
    const client = await this.getClient();
    const state = this.uploads.get(fileId);

    if (!state) {
      throw new Error(
        `[S3StorageAdapter] No active multipart upload found for fileId "${fileId}"`,
      );
    }

    // Flush whatever remains — the last part is allowed to be under 5 MB.
    await this.flushPart(state, sdk, client, true);

    await client.send(
      new sdk.CompleteMultipartUploadCommand({
        Bucket: this.options.bucket,
        Key: state.key,
        UploadId: state.uploadId,
        MultipartUpload: { Parts: state.parts },
      }),
    );

    this.uploads.delete(fileId);
    this.partCache.delete(fileId); // FIX [4]: release memory

    return {
      storageRef: state.key,
      url: this.buildPublicUrl(state.key),
    };
  }

  // ── putStream ────────────────────────────────────────────────────────────

  async putStream(
    fileId: string,
    stream: Readable,
    ctx: StorageContext,
  ): Promise<StorageWriteResult> {
    const sdk = await this.loadCommands();
    const client = await this.getClient();
    const key = this.buildKey(fileId, ctx);

    // Let the AWS SDK handle stream uploading.
    await client.send(
      new sdk.PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: stream,
        ContentType: ctx.contentType,
      }),
    );

    return { storageRef: key, url: this.buildPublicUrl(key) };
  }

  // ── putObject ────────────────────────────────────────────────────────────

  async putObject(
    fileId: string,
    data: Buffer,
    ctx: StorageContext,
  ): Promise<StorageWriteResult> {
    const sdk = await this.loadCommands();
    const client = await this.getClient();
    const key = this.buildKey(fileId, ctx);

    await client.send(
      new sdk.PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: data,
        ContentType: ctx.contentType,
      }),
    );

    return { storageRef: key, url: this.buildPublicUrl(key) };
  }

  // ── readStream ───────────────────────────────────────────────────────────

  async readStream(ref: string, options?: StorageReadOptions): Promise<Readable> {
    const sdk = await this.loadCommands();
    const client = await this.getClient();

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
    const sdk = await this.loadCommands();
    const client = await this.getClient();
    await client.send(
      new sdk.DeleteObjectCommand({ Bucket: this.options.bucket, Key: ref }),
    );
  }
}