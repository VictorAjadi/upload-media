import { createReadStream, promises as fs } from 'fs';
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
  private openHandles = new Map<string, fs.FileHandle>();

  constructor(options: LocalDiskStorageOptions) {
    this.rootDir = options.rootDir;
    this.publicBaseUrl = options.publicBaseUrl;
  }

  private async ensureDir(dir: string) {
    await fs.mkdir(dir, { recursive: true });
  }

  // ✅ FIXED: Include file extension
  private partPath(fileId: string, ctx: StorageContext): string {
    const ext = ctx.originalName ? path.extname(ctx.originalName) : '';
    const filename = `${fileId}${ext}.part`;
    return path.join(this.rootDir, ctx.bucket || 'default', filename);
  }

  // ✅ FIXED: Include file extension
  private finalPath(fileId: string, ctx: StorageContext): string {
    const ext = ctx.originalName ? path.extname(ctx.originalName) : '';
    const filename = `${fileId}${ext}`;
    return path.join(this.rootDir, ctx.bucket || 'default', filename);
  }

  async writeChunk(fileId: string, chunkNumber: number, data: Buffer, ctx: StorageContext): Promise<void> {
    const filePath = this.partPath(fileId, ctx);

    let handle = this.openHandles.get(fileId);
    if (!handle) {
      await this.ensureDir(path.dirname(filePath));
      handle = await fs.open(filePath, 'w');
      this.openHandles.set(fileId, handle);
    }

    await handle.appendFile(data);
  }

  async finalize(fileId: string, ctx: StorageContext): Promise<StorageWriteResult> {
    // Close file handle
    const handle = this.openHandles.get(fileId);
    if (handle) {
      await handle.close();
      this.openHandles.delete(fileId);
    }

    const partPath = this.partPath(fileId, ctx);
    const finalPath = this.finalPath(fileId, ctx);

    // Ensure target directory exists
    await this.ensureDir(path.dirname(finalPath));

    // Rename .part file to final name
    try {
      await fs.rename(partPath, finalPath);
    } catch (error) {
      console.error(`Failed to finalize upload: ${partPath} → ${finalPath}`, error);
      throw error;
    }

    const ref = path.relative(this.rootDir, finalPath);
    return {
      storageRef: ref,
      url: this.publicBaseUrl ? `${this.publicBaseUrl.replace(/\/$/, '')}/${ref}` : undefined,
    };
  }

  async putObject(fileId: string, data: Buffer, ctx: StorageContext): Promise<StorageWriteResult> {
    const finalPath = this.finalPath(fileId, ctx);
    await this.ensureDir(path.dirname(finalPath));
    await fs.writeFile(finalPath, data);

    const ref = path.relative(this.rootDir, finalPath);
    return {
      storageRef: ref,
      url: this.publicBaseUrl ? `${this.publicBaseUrl.replace(/\/$/, '')}/${ref}` : undefined,
    };
  }

  async readStream(ref: string, options?: StorageReadOptions): Promise<Readable> {
    const fullPath = path.join(this.rootDir, ref);
    return createReadStream(fullPath, {
      start: options?.start,
      end: options?.end,
    });
  }

  async delete(ref: string): Promise<void> {
    const fullPath = path.join(this.rootDir, ref);
    await fs.unlink(fullPath).catch(() => {
      /* already gone — not an error for our purposes */
    });
  }
}