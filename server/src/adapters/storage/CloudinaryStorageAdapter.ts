/**
 * @upload-media/server - CloudinaryStorageAdapter
 *
 * [1] assembleChunksToPath() implemented. UploadEngine calls this on
 *     the last chunk so FFmpeg can process the file from disk before
 *     the final upload goes to Cloudinary.
 *
 *     Cloudinary's upload_large_stream does not expose already-written
 *     chunks for re-reading, so the adapter maintains a local
 *     chunkCache (raw engine-chunks indexed by chunkNumber) in parallel.
 *     assembleChunksToPath() drains that cache in order into a temp
 *     file on disk and returns the path.
 *
 *     The Cloudinary stream is left open during media processing —
 *     finalize() ends the stream and waits for Cloudinary's confirmation
 *     once the (optionally re-encoded) file has been streamed in via
 *     putStream / putObject.
 *
 * [2] finalize() previously only ended the upload_large_stream and
 *     returned the result. It is now also called by UploadEngine after
 *     media processing, at which point the engine streams the processed
 *     file via putObject (or putStream). The pending upload started by
 *     writeChunk is therefore ABORTED in finalize() when the engine is
 *     going to re-upload a processed variant — detected by checking
 *     whether the caller supplies a ctx whose contentType differs from
 *     the one used to open the stream.
 *
 *     Simpler rule implemented here: UploadEngine always calls
 *     putObject/putStream for the final artifact after processing, so
 *     finalize() just aborts and removes any lingering stream rather
 *     than trying to complete it with raw bytes.
 *
 *     If no processing happens the engine calls finalize() directly and
 *     the stream IS completed normally.
 *
 * [3] chunkCache is cleared in finalize() and on abort (FIX [4] parity).
 *
 * [4] putStream() added. If the storage adapter exposes putStream(),
 *     UploadEngine prefers it for large processed files (zero heap copy).
 *     Cloudinary's upload_stream is used under the hood.
 *
 * [5] StorageContext is threaded through all methods for consistency.
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

export interface CloudinaryStorageOptions {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** Folder prefix for all uploads, e.g. "myapp/uploads" */
  folder?: string;
  /** Override how a fileId maps to a Cloudinary public_id */
  buildPublicId?: (fileId: string, ctx: StorageContext) => string;
  /** Pass an already-configured cloudinary instance (v1 or v2 API) */
  cloudinary?: any;
  /**
   * Directory for temporary assembled files used during media processing.
   * Defaults to os.tmpdir().
   */
  tempDir?: string;
}

interface PendingUpload {
  stream: any; // Writable returned by upload_large_stream
  done: Promise<any>;
}

export class CloudinaryStorageAdapter implements StorageAdapter {
  readonly name = 'cloudinary';
  readonly hasNativeVariantSupport = true;
  private options: CloudinaryStorageOptions;
  private _cloudinary: any;
  private tempDir: string;

  /** Active upload_large_stream sessions keyed by fileId. */
  private pending = new Map<string, PendingUpload>();

  /**
   * Raw engine-chunks cached so assembleChunksToPath() can
   * reconstruct the file without re-downloading from Cloudinary.
   */
  private chunkCache = new Map<string, Buffer[]>();

  constructor(options: CloudinaryStorageOptions) {
    this.options = options;
    this.tempDir = options.tempDir ?? os.tmpdir();
  }

  // ── SDK lazy-loader ──────────────────────────────────────────────────────

  private getSdk(): any {
    if (this._cloudinary) return this._cloudinary;
    if (this.options.cloudinary) {
      this._cloudinary = this.options.cloudinary;
      return this._cloudinary;
    }

    let cloudinary: any;
    try {
      cloudinary = require('cloudinary').v2;
    } catch {
      throw new Error(
        '[upload-media/server] CloudinaryStorageAdapter requires the "cloudinary" package. ' +
        'Install it with: npm install cloudinary',
      );
    }

    cloudinary.config({
      cloud_name: this.options.cloudName,
      api_key: this.options.apiKey,
      api_secret: this.options.apiSecret,
      secure: true,
    });

    this._cloudinary = cloudinary;
    return cloudinary;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private resourceTypeFor(contentType: string): 'image' | 'video' | 'raw' {
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('video/') || contentType.startsWith('audio/')) return 'video';
    return 'raw';
  }

  private buildPublicId(fileId: string, ctx: StorageContext): string {
    if (this.options.buildPublicId) return this.options.buildPublicId(fileId, ctx);
    const folder = this.options.folder
      ? `${this.options.folder}/${ctx.bucket}`
      : ctx.bucket;
    return `${folder}/${fileId}`;
  }

  private getOrCreateUpload(fileId: string, ctx: StorageContext): PendingUpload {
    const existing = this.pending.get(fileId);
    if (existing) return existing;

    const cloudinary = this.getSdk();
    const publicId = this.buildPublicId(fileId, ctx);

    let resolveDone!: (v: any) => void;
    let rejectDone!: (e: any) => void;
    const done = new Promise<any>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });

    const stream = cloudinary.uploader.upload_large_stream(
      {
        public_id: publicId,
        resource_type: this.resourceTypeFor(ctx.contentType),
        use_filename: true,
        unique_filename: false,
        chunk_size: 6 * 1024 * 1024,
      },
      (error: any, result: any) => {
        if (error) rejectDone(error);
        else resolveDone(result);
      },
    );

    const entry: PendingUpload = { stream, done };
    this.pending.set(fileId, entry);
    return entry;
  }

  // ── writeChunk ───────────────────────────────────────────────────────────

  async writeChunk(
    fileId: string,
    chunkNumber: number,
    data: Buffer,
    ctx: StorageContext,
  ): Promise<void> {
    // FIX [1]: cache chunk for assembleChunksToPath
    if (!this.chunkCache.has(fileId)) this.chunkCache.set(fileId, []);
    this.chunkCache.get(fileId)![chunkNumber] = data;

    const { stream } = this.getOrCreateUpload(fileId, ctx);
    const ok = stream.write(data);
    if (!ok) await new Promise<void>((r) => stream.once('drain', r));
  }

  // ── assembleChunksToPath ───────────────────────────────────────
  //
  // Drains the chunkCache to a temp file in order. The in-progress
  // upload_large_stream is aborted here because the engine will
  // re-upload the processed file via putObject/putStream.

  async assembleChunksToPath(
    fileId: string,
    totalChunks: number,
    ext: string,
    ctx: StorageContext,
  ): Promise<string> {
    const cache = this.chunkCache.get(fileId);
    if (!cache || cache.length < totalChunks) {
      throw new Error(
        `[CloudinaryStorageAdapter] Chunk cache incomplete for fileId "${fileId}" ` +
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
                `[CloudinaryStorageAdapter] Missing cached chunk ${i} for file "${fileId}"`,
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

    // Abort the raw stream — the engine will re-upload the processed file.
    this._abortPending(fileId);

    return dest;
  }

  /** Destroy the pending upload_large_stream without completing it. */
  private _abortPending(fileId: string): void {
    const entry = this.pending.get(fileId);
    if (entry) {
      try { entry.stream.destroy(); } catch { /* ignore */ }
      this.pending.delete(fileId);
    }
    this.chunkCache.delete(fileId);
  }

  // ── finalize ───────────────────────────────────────────────────
  //
  // Called by UploadEngine when NO media processing is configured.
  // Ends the upload_large_stream and waits for Cloudinary's confirmation.

  async finalize(fileId: string, ctx: StorageContext): Promise<StorageWriteResult> {
    const entry = this.pending.get(fileId);
    if (!entry) {
      // The stream was already aborted by assembleChunksToPath (processing
      // path). The engine will call putObject with the processed file next.
      throw new Error(
        `[CloudinaryStorageAdapter] No active upload stream for fileId "${fileId}". ` +
        'If media processing is enabled, the engine re-uploads via putObject — ' +
        'do not call finalize() manually in that case.',
      );
    }

    entry.stream.end();
    const result = await entry.done;

    this.pending.delete(fileId);
    this.chunkCache.delete(fileId); // FIX [3]

    return {
      storageRef: result.public_id,
      url: result.secure_url,
    };
  }

  // ── putStream ──────────────────────────────────────────────────
  //
  // Called by UploadEngine.streamFileToStorage() for large processed files.
  // Pipes a readable stream directly into Cloudinary's upload_stream.

  async putStream(
    fileId: string,
    stream: Readable,
    ctx: StorageContext,
  ): Promise<StorageWriteResult> {
    const cloudinary = this.getSdk();
    const publicId = this.buildPublicId(fileId, ctx);

    const result: any = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id: publicId,
          resource_type: this.resourceTypeFor(ctx.contentType),
          use_filename: true,
          unique_filename: false,
        },
        (error: any, res: any) => (error ? reject(error) : resolve(res)),
      );
      stream.pipe(uploadStream);
      stream.on('error', reject);
    });

    return { storageRef: result.public_id, url: result.secure_url };
  }

  // ── putObject ────────────────────────────────────────────────────────────

  async putObject(
    fileId: string,
    data: Buffer,
    ctx: StorageContext,
  ): Promise<StorageWriteResult> {
    const cloudinary = this.getSdk();
    const publicId = this.buildPublicId(fileId, ctx);

    const result: any = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          public_id: publicId,
          resource_type: this.resourceTypeFor(ctx.contentType),
          use_filename: true,
          unique_filename: false,
        },
        (error: any, res: any) => (error ? reject(error) : resolve(res)),
      );
      stream.end(data);
    });

    return { storageRef: result.public_id, url: result.secure_url };
  }

  // ── readStream ───────────────────────────────────────────────────────────

  async readStream(ref: string, _options?: StorageReadOptions): Promise<Readable> {
    // Cloudinary assets are served from CDN. Proxy through our server only
    // when needed (e.g. private/authenticated assets).
    const cloudinary = this.getSdk();
    const https = require('https');
    const signedUrl = cloudinary.url(ref, { secure: true, resource_type: 'auto' });

    return new Promise<Readable>((resolve, reject) => {
      https.get(signedUrl, (response: Readable) => resolve(response)).on('error', reject);
    }) as unknown as Readable;
  }

  // ── delete ───────────────────────────────────────────────────────────────

  async delete(ref: string): Promise<void> {
    const cloudinary = this.getSdk();
    await cloudinary.uploader.destroy(ref, { resource_type: 'auto' });
  }
}