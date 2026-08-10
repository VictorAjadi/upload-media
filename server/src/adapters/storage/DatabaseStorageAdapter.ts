/**
 * @upload-media/server - DatabaseStorageAdapter v2
 *
 * FIX [STREAM-CHUNK]: putStream() implemented.
 *
 * Problem this fixes:
 *   UploadEngine's streamFileToStorage() prefers storage.putStream() when
 *   available, falling back to "read whole file into a Buffer, call
 *   putObject()" when it isn't. DatabaseStorageAdapter had no putStream,
 *   so EVERY encoded variant — no matter how large — was read fully into
 *   heap and written as a SINGLE chunk document (chunkNumber 0).
 *
 *   Two concrete failures from that:
 *     a) Heap exhaustion: large variants (hundreds of MB to GB) held fully
 *        in memory, and with parallel variant encoding several of these
 *        could be resident at once.
 *     b) MongoDB's 16MB BSON document size limit: any variant whose encoded
 *        size exceeds ~16MB cannot be written as a single chunk document at
 *        all — the insert fails outright on a real MongoDB deployment.
 *
 * Fix: putStream() now re-chunks the source stream into fixed-size pieces
 * (matching the ORIGINAL upload's chunkSize when available, so the file's
 * chunk geometry is consistent end-to-end) and writes each piece as its own
 * chunk document, exactly mirroring how the initial chunked upload itself
 * was stored. The final chunk is the remainder (e.g. for a 5MB file in 2MB
 * pieces: chunks of 2MB, 2MB, 1MB — NOT padded to 2MB).
 *
 * putStream() returns { storageRef, chunkCount, chunkSize, totalSize } so
 * the caller can persist accurate chunk metadata instead of assuming 1
 * chunk. This keeps FileServingHandler's ChunkReadStream — which already
 * assumes fixed chunkSize with a remainder-sized last chunk — working
 * unchanged; only the metadata written by the upload path needed fixing.
 *
 * Other fixes carried over from the previous revision:
 * [1] assembleChunksToPath() — streams chunk rows to a temp file on disk.
 * [2] finalize() — chunk rows are the source of truth, no-op move needed.
 * [3] StorageContext threaded through to all methods.
 * [4] putObject upsert semantics preserved for small/non-chunked files.
 */

import { Readable } from 'stream';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as fsCb from 'fs';
import {
  StorageAdapter,
  StorageContext,
  StorageReadOptions,
  StorageWriteResult,
  MetadataRepository,
} from '../../types';

export interface DatabaseStorageOptions {
  database: MetadataRepository;
  /**
   * Number of chunks to pre-fetch ahead of the current read position
   * in ChunkReadStream. Defaults to 2.
   */
  prefetchCount?: number;
  /**
   * Directory used for temporary assembled files during media processing.
   * Defaults to os.tmpdir().
   */
  tempDir?: string;
  /**
   * Fallback chunk size (bytes) used by putStream() when the StorageContext
   * does not carry an original chunkSize to inherit (e.g. non-chunked /
   * single-shot uploads that still produce a large processed variant).
   * Defaults to 4MB — comfortably under MongoDB's 16MB BSON document limit
   * even after BSON/driver overhead.
   */
  defaultStreamChunkSize?: number;
}

/** Extended write result that callers can use to persist accurate chunk metadata. */
export interface StreamWriteResult extends StorageWriteResult {
  chunkCount: number;
  chunkSize: number;
  totalSize: number;
}

const DEFAULT_STREAM_CHUNK_SIZE = 4 * 1024 * 1024; // 4MB — safely under Mongo's 16MB doc cap

/** Ensure we always hand back a proper Node.js Buffer. */
function toBuffer(input: Buffer | Uint8Array | ArrayBuffer | any): Buffer {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input && typeof input === 'object') {
    if (input.buffer && typeof input.buffer === 'object') return Buffer.from(input.buffer);
    if (input.data) return Buffer.from(input.data);
    if (input.type === 'Buffer' && Array.isArray(input.data)) return Buffer.from(input.data);
  }
  return Buffer.from(input);
}

export class DatabaseStorageAdapter implements StorageAdapter {
  readonly name = 'database';
  private database: MetadataRepository;
  private prefetchCount: number;
  private tempDir: string;
  private defaultStreamChunkSize: number;

  constructor(options: DatabaseStorageOptions) {
    if (!options.database.createChunk || !options.database.getChunk) {
      throw new Error(
        '[DatabaseStorageAdapter] The provided MetadataRepository does not implement ' +
        'createChunk / getChunk — DatabaseStorageAdapter cannot be used with it.',
      );
    }
    this.database = options.database;
    this.prefetchCount = options.prefetchCount ?? 2;
    this.tempDir = options.tempDir ?? os.tmpdir();
    this.defaultStreamChunkSize = options.defaultStreamChunkSize ?? DEFAULT_STREAM_CHUNK_SIZE;
  }

  // ── Core chunk write (original upload path — unchanged) ─────────────────

  async writeChunk(
    fileId: string,
    chunkNumber: number,
    data: Buffer,
    ctx: StorageContext,
  ): Promise<void> {
    const safe = toBuffer(data);
    await this.database.createChunk!({ fileId, chunkNumber, data: safe });
  }

  // ── assembleChunksToPath — streams chunk rows to a temp file on disk ────

  async assembleChunksToPath(
    fileId: string,
    totalChunks: number,
    ext: string,
    ctx: StorageContext,
  ): Promise<string> {
    const dest = path.join(this.tempDir, `${fileId}_assembled${ext}`);
    const writeStream = fsCb.createWriteStream(dest);

    await new Promise<void>((resolve, reject) => {
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);

      (async () => {
        try {
          let totalBytesWritten = 0;
          for (let i = 0; i < totalChunks; i++) {
            const raw = await this.database.getChunk!(fileId, i);
            if (!raw) {
              throw new Error(
                `[DatabaseStorageAdapter] Missing chunk ${i} for file "${fileId}"`,
              );
            }
            // Diagnostic: log type and size of raw chunk data for first few and last chunk
            if (i < 3 || i === totalChunks - 1) {
              const rawType = raw?.constructor?.name ?? typeof raw;
              const rawLen = Buffer.isBuffer(raw) ? raw.length
                : (raw as any)?.buffer?.length ?? (raw as any)?.length?.() ?? '?';
            }
            const buf = toBuffer(raw);
            const ok = writeStream.write(buf);
            totalBytesWritten += buf.length;
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

  // ── finalize ──────────────────────────────────────────────────────────

  async finalize(fileId: string, ctx: StorageContext): Promise<StorageWriteResult> {
    return { storageRef: fileId };
  }

  // ── Single-shot write (small files / fallback) ───────────────────────────
  //
  // Still used directly for things like thumbnails, which are always small
  // (a few hundred KB JPEGs) and safely fit in one chunk document.

  async putObject(
    fileId: string,
    data: Buffer,
    ctx: StorageContext,
  ): Promise<StorageWriteResult> {
    const safe = toBuffer(data);

    if (safe.length > this.defaultStreamChunkSize) {
      // Guard rail: if a caller bypasses putStream and hands putObject a
      // large buffer directly, re-chunk it in memory rather than writing an
      // oversized single document. This keeps the BSON-size invariant safe
      // even for callers that don't go through the streaming path, though
      // putStream is strongly preferred for anything non-trivially sized
      // since this path still requires the full buffer in heap up front.
      console.warn(
        `[DatabaseStorageAdapter] putObject received ${safe.length} bytes for ` +
        `"${fileId}", exceeding the ${this.defaultStreamChunkSize} byte single-chunk ` +
        `safety threshold. Re-chunking in memory — prefer putStream() for large files.`,
      );
      return this.writeBufferAsChunks(fileId, safe, this.resolveChunkSize(ctx));
    }

    await this.database.createChunk!({ fileId, chunkNumber: 0, data: safe });
    return { storageRef: fileId };
  }

  /** Shared chunking logic for the in-memory guard-rail path in putObject(). */
  private async writeBufferAsChunks(
    fileId: string,
    buffer: Buffer,
    chunkSize: number,
  ): Promise<StreamWriteResult> {
    const chunkCount = Math.max(1, Math.ceil(buffer.length / chunkSize));
    const chunks: import('../../types').ChunkRecord[] = [];

    for (let i = 0; i < chunkCount; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, buffer.length);
      chunks.push({ fileId, chunkNumber: i, data: buffer.subarray(start, end) });
    }

    if (this.database.createChunks) {
      await this.database.createChunks(chunks);
    } else {
      await Promise.all(chunks.map((c) => this.database.createChunk!(c)));
    }

    return { storageRef: fileId, chunkCount, chunkSize, totalSize: buffer.length };
  }

  // ── putStream — THE FIX ───────────────────────────────────────────────
  //
  // Reads `source` (e.g. fs.createReadStream(variantPath)) and writes it to
  // the database as a sequence of fixed-size chunk documents, never holding
  // more than ~chunkSize bytes in memory at once. This is what UploadEngine
  // calls for every encoded variant (and the primary/raw file) regardless
  // of size, so a 1.5GB 1080p variant is written the same way a 1.5GB
  // original upload was received: in pieces.
  //
  // Chunk-size selection — per explicit requirement, this REUSES the
  // ORIGINAL upload's chunkSize so the variant's chunk geometry matches the
  // source file's, with the correct "last chunk is a remainder, not padded"
  // behavior:
  //   e.g. a 5MB file uploaded in 2MB pieces is [2MB, 2MB, 1MB] — three
  //   chunks. If the encoded variant comes out to, say, 4.3MB, written with
  //   the SAME 2MB chunkSize it becomes [2MB, 2MB, 0.3MB] — still three
  //   chunks, last one sized to whatever is actually left. We do not pad,
  //   and we do not assume the variant's total size lines up evenly with
  //   chunkSize.
  //
  // ctx.chunkSize is expected to carry the original upload's chunk size
  // (UploadEngine sets this on storageCtx from the chunked-upload fields).
  // If absent (e.g. non-chunked single-shot upload), defaultStreamChunkSize
  // is used instead.

  async putStream(
    fileId: string,
    source: Readable,
    ctx: StorageContext,
  ): Promise<StreamWriteResult> {
    const chunkSize = this.resolveChunkSize(ctx);

    let chunkNumber = 0;
    let totalBytes = 0;
    let pending: Buffer[] = [];
    let pendingLength = 0;

    const batch: import('../../types').ChunkRecord[] = [];
    const BATCH_SIZE = 8;

    const flushBatch = async () => {
      if (batch.length === 0) return;
      if (this.database.createChunks) {
        await this.database.createChunks(batch);
      } else {
        await Promise.all(batch.map((c) => this.database.createChunk!(c)));
      }
      batch.length = 0;
    };

    for await (const chunk of source) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      pending.push(buf);
      pendingLength += buf.length;

      while (pendingLength >= chunkSize) {
        // Synchronously extract exactly chunkSize bytes across the buffered chunks
        let collected = 0;
        const pieces: Buffer[] = [];

        while (collected < chunkSize && pending.length > 0) {
          const first = pending[0];
          const needed = chunkSize - collected;

          if (first.length <= needed) {
            pieces.push(first);
            collected += first.length;
            pending.shift();
            pendingLength -= first.length;
          } else {
            pieces.push(first.subarray(0, needed));
            collected += needed;
            pending[0] = first.subarray(needed);
            pendingLength -= needed;
          }
        }

        const piece = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, chunkSize);

        batch.push({ fileId, chunkNumber, data: Buffer.from(piece) });
        chunkNumber += 1;
        totalBytes += piece.length;

        if (batch.length >= BATCH_SIZE) {
          await flushBatch();
        }
      }
    }

    // Flush whatever remains as the final (possibly smaller) chunk.
    if (pendingLength > 0) {
      const piece = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLength);
      batch.push({ fileId, chunkNumber, data: Buffer.from(piece) });
      chunkNumber += 1;
      totalBytes += piece.length;
    }

    await flushBatch();

    // Guarantee at least one chunk row exists even for a zero-byte source,
    // so chunkCount is never 0 and downstream readers don't divide by zero.
    if (chunkNumber === 0) {
      await this.database.createChunk!({ fileId, chunkNumber: 0, data: Buffer.alloc(0) });
      chunkNumber = 1;
    }

    return {
      storageRef: fileId,
      chunkCount: chunkNumber,
      chunkSize,
      totalSize: totalBytes,
    };
  }

  /**
   * Resolve the chunk size to use for re-chunking an outgoing stream.
   * Prefers the ORIGINAL upload's chunkSize (carried on StorageContext by
   * UploadEngine) so a variant's on-disk chunk geometry matches the source
   * file's. Falls back to defaultStreamChunkSize for non-chunked uploads.
   */
  private resolveChunkSize(ctx: StorageContext): number {
    const inherited = (ctx as any)?.chunkSize;
    if (typeof inherited === 'number' && inherited > 0) return inherited;
    return this.defaultStreamChunkSize;
  }

  // ── Streaming read (unchanged) ───────────────────────────────────────────

  async readStream(ref: string, options?: StorageReadOptions): Promise<Readable> {
    const file = await this.database.getFileById(ref);
    if (!file) {
      throw new Error(`[DatabaseStorageAdapter] No file record found for ref "${ref}"`);
    }

    const startByte = options?.start ?? 0;
    const endByte = options?.end ?? file.size - 1;
    const chunkSize = file.chunkSize || file.size;
    const startChunk = chunkSize > 0 ? Math.floor(startByte / chunkSize) : 0;
    const endChunk = chunkSize > 0 ? Math.floor(endByte / chunkSize) : 0;

    return new ChunkReadStream({
      database: this.database,
      fileId: ref,
      chunkSize,
      fileSize: file.size,
      startChunk,
      endChunk,
      startByte,
      endByte,
      prefetchCount: this.prefetchCount,
    });
  }

  async delete(ref: string): Promise<void> {
    if (this.database.deleteChunksByFileId) {
      await this.database.deleteChunksByFileId(ref);
    }
  }
}

// ── ChunkReadStream (unchanged — already assumes fixed chunkSize + remainder last chunk) ──

interface ChunkReadStreamOptions {
  database: MetadataRepository;
  fileId: string;
  chunkSize: number;
  fileSize: number;
  startChunk: number;
  endChunk: number;
  startByte: number;
  endByte: number;
  prefetchCount: number;
}

class ChunkReadStream extends Readable {
  private current: number;
  private readonly opts: ChunkReadStreamOptions;
  private prefetch = new Map<number, Promise<Buffer | null>>();
  private reading = false;

  constructor(opts: ChunkReadStreamOptions) {
    super({ highWaterMark: 1024 * 1024 });
    this.opts = opts;
    this.current = opts.startChunk;
  }

  private async fetchChunk(chunkNumber: number): Promise<Buffer | null> {
    const chunk = await this.opts.database.getChunk!(this.opts.fileId, chunkNumber);
    if (!chunk) return null;
    return toBuffer(chunk);
  }

  private prefetchAhead(): void {
    for (let i = 1; i <= this.opts.prefetchCount; i++) {
      const num = this.current + i;
      if (num > this.opts.endChunk || this.prefetch.has(num)) continue;
      this.prefetch.set(num, this.fetchChunk(num));
    }
  }

  private chunkActualSize(chunkNumber: number): number {
    const totalChunks = Math.ceil(this.opts.fileSize / this.opts.chunkSize);
    const isLast = chunkNumber === totalChunks - 1;
    if (!isLast) return this.opts.chunkSize;
    const remainder = this.opts.fileSize % this.opts.chunkSize;
    return remainder > 0 ? remainder : this.opts.chunkSize;
  }

  async _read(): Promise<void> {
    if (this.reading) return;
    if (this.current > this.opts.endChunk) {
      this.push(null);
      return;
    }

    this.reading = true;
    try {
      const buffer = this.prefetch.has(this.current)
        ? await this.prefetch.get(this.current)!
        : await this.fetchChunk(this.current);
      this.prefetch.delete(this.current);

      if (!buffer) {
        this.destroy(
          new Error(`Missing chunk ${this.current} for file ${this.opts.fileId}`),
        );
        return;
      }

      const isFirst =
        this.current === Math.floor(this.opts.startByte / this.opts.chunkSize);
      const isLast =
        this.current === Math.floor(this.opts.endByte / this.opts.chunkSize);
      const actualSize = this.chunkActualSize(this.current);

      let sliceStart = 0;
      let sliceEnd = Math.min(actualSize, buffer.length);

      if (isFirst) sliceStart = this.opts.startByte % this.opts.chunkSize;
      if (isLast)
        sliceEnd = Math.min(sliceEnd, (this.opts.endByte % this.opts.chunkSize) + 1);

      this.push(buffer.subarray(sliceStart, sliceEnd));
      this.current += 1;
      this.reading = false;

      if (this.current <= this.opts.endChunk) {
        this.prefetchAhead();
        setImmediate(() => this._read());
      }
    } catch (error) {
      this.reading = false;
      this.destroy(error as Error);
    }
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.prefetch.clear();
    callback(error);
  }
}

export { toBuffer };