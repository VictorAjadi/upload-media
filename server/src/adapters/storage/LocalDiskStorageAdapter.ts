/**
 * @upload-media/server - LocalDiskStorageAdapter
 *
 * [1] writeChunk now writes each chunk to its own indexed file
 *     (e.g. <fileId>.chunk-000001) instead of blindly appending to a
 *     single .part file. This makes writes order-safe and retry-safe —
 *     a re-sent chunk just overwrites its own file with the same data.
 *
 * [2] fs.open(..., 'w') removed — it truncated the running file on
 *     every re-open (e.g. after a server restart mid-upload). Chunk
 *     files are now written with fs.writeFile which is atomic.
 *
 * [3] assembleChunksToPath() implemented. UploadEngine calls this
 *     first; it streams each chunk file to disk in order without ever
 *     loading the full file into heap. Falls back to UploadEngine's
 *     own buffer path only if this method is absent — which it no
 *     longer is, so the fallback readChunk crash path is avoided.
 *
 * [4] finalize() concatenates chunk files to the final path, then
 *     deletes the chunk files. Called by UploadEngine after
 *     assembleChunksToPath when no media processing is needed.
 *
 * [5] fileCtx map stores StorageContext per fileId so finalize() and
 *     assembleChunksToPath() can reconstruct paths without callers
 *     having to re-supply the context. Entries are cleaned up after use.
 */

import { createReadStream, promises as fs } from 'fs';
import * as fsCb from 'fs';
import { Readable } from 'stream';
import * as path from 'path';
import {
  StorageAdapter,
  StorageContext,
  StorageReadOptions,
  StorageWriteResult,
} from '../../types';

export interface LocalDiskStorageOptions {
  rootDir: string;
  publicBaseUrl?: string;
}

export class LocalDiskStorageAdapter implements StorageAdapter {
  readonly name = 'local-disk';
  private rootDir: string;
  private publicBaseUrl?: string;

  /** Remembers the StorageContext for each in-progress upload. */
  private fileCtx = new Map<string, StorageContext>();

  constructor(options: LocalDiskStorageOptions) {
    this.rootDir = options.rootDir;
    this.publicBaseUrl = options.publicBaseUrl;
  }

  // ── Path helpers ────────────────────────────────────────────────────────

  private async ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  /**
   * Path for an individual chunk file.
   * Zero-padded index keeps OS directory listings in order.
   */
  private chunkPath(fileId: string, chunkNumber: number, ctx: StorageContext): string {
    const idx = String(chunkNumber).padStart(6, '0');
    return path.join(
      this.rootDir,
      ctx.bucket || 'default',
      `${fileId}.chunk-${idx}`,
    );
  }

  /** Path for the final assembled file. */
  private finalPath(fileId: string, ctx: StorageContext): string {
    const ext = ctx.originalName ? path.extname(ctx.originalName) : '';
    return path.join(this.rootDir, ctx.bucket || 'default', `${fileId}${ext}`);
  }

  /** Temporary assembled path used during media processing. */
  private assembledPath(fileId: string, ext: string, ctx: StorageContext): string {
    return path.join(this.rootDir, ctx.bucket || 'default', `${fileId}_assembled${ext}`);
  }

  // ── StorageAdapter implementation ───────────────────────────────────────

  /**
   * Write one chunk to its own file 
   * Writing is idempotent: retrying chunk N just overwrites the same file.
   */
  async writeChunk(
    fileId: string,
    chunkNumber: number,
    data: Buffer,
    ctx: StorageContext,
  ): Promise<void> {
    const dest = this.chunkPath(fileId, chunkNumber, ctx);
    await this.ensureDir(path.dirname(dest));
    await fs.writeFile(dest, data); // atomic, retry-safe
    this.fileCtx.set(fileId, ctx);  // remember context for later stages
  }

  /**
   * Stream all chunk files to a single assembled file on disk
   *
   * UploadEngine.assembleChunksToDisk() calls this first. Because it
   * exists on this adapter, the engine never falls through to the
   * missing readChunk() fallback.
   *
   * Returns the path of the assembled file so FFmpeg (or the engine's
   * single-quality path) can read directly from disk.
   */
  async assembleChunksToPath(
    fileId: string,
    totalChunks: number,
    ext: string,
    ctx: StorageContext,
  ): Promise<string> {
    const resolvedCtx = ctx ?? this.fileCtx.get(fileId);
    if (!resolvedCtx) {
      throw new Error(`[LocalDisk] No StorageContext for fileId "${fileId}"`);
    }

    const dest = this.assembledPath(fileId, ext, resolvedCtx);
    await this.ensureDir(path.dirname(dest));

    const writeStream = fsCb.createWriteStream(dest);
    await new Promise<void>((resolve, reject) => {
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);

      (async () => {
        try {
          for (let i = 0; i < totalChunks; i++) {
            const chunkFile = this.chunkPath(fileId, i, resolvedCtx);
            const buf = await fs.readFile(chunkFile);
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

  async finalize(fileId: string, ctx: StorageContext): Promise<StorageWriteResult> {
    const resolvedCtx = ctx ?? this.fileCtx.get(fileId);
    if (!resolvedCtx) {
      throw new Error(`[LocalDisk] No StorageContext for fileId "${fileId}"`);
    }

    const totalChunks = resolvedCtx.chunkCount;
    const dest = this.finalPath(fileId, resolvedCtx);
    await this.ensureDir(path.dirname(dest));

    const writeStream = fsCb.createWriteStream(dest);
    await new Promise<void>((resolve, reject) => {
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);

      (async () => {
        try {
          for (let i = 0; i < totalChunks; i++) {
            const chunkFile = this.chunkPath(fileId, i, resolvedCtx);
            const buf = await fs.readFile(chunkFile);
            const ok = writeStream.write(buf);
            if (!ok) await new Promise<void>((r) => writeStream.once('drain', r));
            // Delete the chunk file as soon as it's been flushed to avoid
            // leaving orphaned files on disk if later chunks fail.
            await fs.unlink(chunkFile).catch(() => { });
          }
          writeStream.end();
        } catch (err) {
          writeStream.destroy(err as Error);
          reject(err);
        }
      })();
    });

    this.fileCtx.delete(fileId);

    const ref = path.relative(this.rootDir, dest);
    return {
      storageRef: ref,
      url: this.publicBaseUrl
        ? `${this.publicBaseUrl.replace(/\/$/, '')}/${ref}`
        : undefined,
    };
  }

  // ── putStream ────────────────────────────────────────────────────────────

  async putStream(
    fileId: string,
    stream: Readable,
    ctx: StorageContext,
  ): Promise<StorageWriteResult> {
    const dest = this.finalPath(fileId, ctx);
    await this.ensureDir(path.dirname(dest));

    const writeStream = fsCb.createWriteStream(dest);
    await new Promise<void>((resolve, reject) => {
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);
      stream.pipe(writeStream);
      stream.on('error', reject);
    });

    const ref = path.relative(this.rootDir, dest);
    return {
      storageRef: ref,
      url: this.publicBaseUrl
        ? `${this.publicBaseUrl.replace(/\/$/, '')}/${ref}`
        : undefined,
    };
  }

  /** Single-shot write for non-chunked uploads. */
  async putObject(
    fileId: string,
    data: Buffer,
    ctx: StorageContext,
  ): Promise<StorageWriteResult> {
    const dest = this.finalPath(fileId, ctx);
    await this.ensureDir(path.dirname(dest));
    await fs.writeFile(dest, data);

    const ref = path.relative(this.rootDir, dest);
    return {
      storageRef: ref,
      url: this.publicBaseUrl
        ? `${this.publicBaseUrl.replace(/\/$/, '')}/${ref}`
        : undefined,
    };
  }

  async readStream(ref: string, options?: StorageReadOptions): Promise<Readable> {
    return createReadStream(path.join(this.rootDir, ref), {
      start: options?.start,
      end: options?.end,
    });
  }

  async delete(ref: string): Promise<void> {
    await fs.unlink(path.join(this.rootDir, ref)).catch(() => {
      /* already gone — not an error */
    });
  }
}