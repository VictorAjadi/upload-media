/**
 * @upload-media/server - DatabaseStorageAdapter
 *
 * Stores chunk bytes directly in whichever database the developer has
 * already wired up via a MetadataRepository (Mongo, Postgres, MySQL,
 * SQLite...). This is the "no extra infra" option — good for small
 * apps or self-hosted setups where adding S3/Cloudinary is overkill.
 * Requires the repository to implement createChunk/getChunk/
 * deleteChunksByFileId (MongooseRepository, SQLRepository, and
 * InMemoryRepository all do).
 */

import { Readable } from 'stream';
import {
  StorageAdapter,
  StorageContext,
  StorageReadOptions,
  StorageWriteResult,
  MetadataRepository,
} from '../../types';

export interface DatabaseStorageOptions {
  database: MetadataRepository;
  /** How many chunks to prefetch ahead while streaming reads (default 2) */
  prefetchCount?: number;
}

export class DatabaseStorageAdapter implements StorageAdapter {
  readonly name = 'database';
  private database: MetadataRepository;
  private prefetchCount: number;

  constructor(options: DatabaseStorageOptions) {
    if (!options.database.createChunk || !options.database.getChunk) {
      throw new Error(
        '[DatabaseStorageAdapter] The provided MetadataRepository does not implement ' +
        'createChunk/getChunk — DatabaseStorageAdapter cannot be used with it.'
      );
    }
    this.database = options.database;
    this.prefetchCount = options.prefetchCount ?? 2;
  }

  async writeChunk(fileId: string, chunkNumber: number, data: Buffer): Promise<void> {
    await this.database.createChunk!({ fileId, chunkNumber, data });
  }

  async finalize(fileId: string): Promise<StorageWriteResult> {
    // Nothing to assemble — chunks are already addressable by fileId.
    // The "ref" is simply the fileId; readStream re-derives chunk
    // metadata from the file record itself.
    return { storageRef: fileId };
  }

  async putObject(fileId: string, data: Buffer, ctx: StorageContext): Promise<StorageWriteResult> {
    // Single-shot write: store as one chunk (chunk 0) for uniformity.
    await this.database.createChunk!({ fileId, chunkNumber: 0, data });
    return { storageRef: fileId };
  }

  async readStream(ref: string, options?: StorageReadOptions): Promise<Readable> {
    const file = await this.database.getFileById(ref);
    if (!file) {
      throw new Error(`[DatabaseStorageAdapter] No file record found for ref "${ref}"`);
    }

    const startByte = options?.start ?? 0;
    const endByte = options?.end ?? file.size - 1;
    const startChunk = Math.floor(startByte / file.chunkSize);
    const endChunk = Math.floor(endByte / file.chunkSize);

    return new ChunkReadStream({
      database: this.database,
      fileId: ref,
      chunkSize: file.chunkSize,
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

/**
 * Streams a file's chunks out of the database one at a time (with light
 * prefetching), trimming the first/last chunk to the requested byte
 * range. Mirrors the memory-efficient streaming approach used by the
 * reference implementation, but generic over any MetadataRepository.
 */
class ChunkReadStream extends Readable {
  private current: number;
  private readonly opts: ChunkReadStreamOptions;
  private prefetch = new Map<number, Promise<Buffer | null>>();
  private reading = false;

  constructor(opts: ChunkReadStreamOptions) {
    // The highWaterMark option sets the maximum number of bytes that can be buffered in memory before the stream pauses.
    //1024 * 1024 = 1MB
    //so it will buffer 1MB of data in memory before pausing
    super({ highWaterMark: 1024 * 1024 });
    this.opts = opts;
    this.current = opts.startChunk;
  }

  private fetchChunk(chunkNumber: number): Promise<Buffer | null> {
    return this.opts.database.getChunk!(this.opts.fileId, chunkNumber);
  }

  private prefetchAhead(): void {
    for (let i = 1; i <= this.opts.prefetchCount; i++) {
      const num = this.current + i;
      if (num > this.opts.endChunk || this.prefetch.has(num)) continue;
      this.prefetch.set(num, this.fetchChunk(num));
    }
  }

  private chunkActualSize(chunkNumber: number): number {
    const isLast = chunkNumber === Math.ceil(this.opts.fileSize / this.opts.chunkSize) - 1;
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
      let buffer = this.prefetch.has(this.current)
        ? await this.prefetch.get(this.current)!
        : await this.fetchChunk(this.current);
      this.prefetch.delete(this.current);

      if (!buffer) {
        this.destroy(new Error(`Missing chunk ${this.current} for file ${this.opts.fileId}`));
        return;
      }

      const isFirst = this.current === Math.floor(this.opts.startByte / this.opts.chunkSize);
      const isLast = this.current === Math.floor(this.opts.endByte / this.opts.chunkSize);
      const actualSize = this.chunkActualSize(this.current);

      let sliceStart = 0;
      let sliceEnd = Math.min(actualSize, buffer.length);

      if (isFirst) sliceStart = this.opts.startByte % this.opts.chunkSize;
      if (isLast) sliceEnd = Math.min(sliceEnd, (this.opts.endByte % this.opts.chunkSize) + 1);

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
