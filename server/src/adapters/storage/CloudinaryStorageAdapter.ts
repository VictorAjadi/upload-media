/**
 * @upload-media/server - CloudinaryStorageAdapter
 *
 * Built on the official `cloudinary` SDK's `upload_large_stream`, which
 * implements Cloudinary's chunked-upload wire protocol correctly
 * (including retry semantics) — we don't reimplement that protocol by
 * hand. Each engine chunk is written into the stream as it arrives;
 * Cloudinary handles assembly server-side. `finalize()` closes the
 * stream and resolves once Cloudinary confirms the asset is ready.
 */

import { Readable } from 'stream';
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
  /** Pass an already-configured cloudinary instance (v1 or v2 API) instead */
  cloudinary?: any;
}

interface PendingUpload {
  stream: any; // Writable returned by upload_large_stream
  done: Promise<any>;
}

export class CloudinaryStorageAdapter implements StorageAdapter {
  readonly name = 'cloudinary';
  private options: CloudinaryStorageOptions;
  private cloudinary: any;
  private pending = new Map<string, PendingUpload>();

  constructor(options: CloudinaryStorageOptions) {
    this.options = options;
  }

  private getSdk() {
    if (this.cloudinary) return this.cloudinary;
    if (this.options.cloudinary) {
      this.cloudinary = this.options.cloudinary;
      return this.cloudinary;
    }

    let cloudinary: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      cloudinary = require('cloudinary').v2;
    } catch {
      throw new Error(
        '[upload-media/server] CloudinaryStorageAdapter requires the "cloudinary" package. ' +
          'Install it with: npm install cloudinary'
      );
    }

    cloudinary.config({
      cloud_name: this.options.cloudName,
      api_key: this.options.apiKey,
      api_secret: this.options.apiSecret,
      secure: true,
    });

    this.cloudinary = cloudinary;
    return cloudinary;
  }

  private resourceTypeFor(contentType: string): 'image' | 'video' | 'raw' {
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('video/') || contentType.startsWith('audio/')) return 'video';
    return 'raw';
  }

  private buildPublicId(fileId: string, ctx: StorageContext): string {
    if (this.options.buildPublicId) return this.options.buildPublicId(fileId, ctx);
    const folder = this.options.folder ? `${this.options.folder}/${ctx.bucket}` : ctx.bucket;
    return `${folder}/${fileId}`;
  }

  private getOrCreateUpload(fileId: string, ctx: StorageContext): PendingUpload {
    let entry = this.pending.get(fileId);
    if (entry) return entry;

    const cloudinary = this.getSdk();
    const publicId = this.buildPublicId(fileId, ctx);

    let resolveDone: (value: any) => void;
    let rejectDone: (err: any) => void;
    const done = new Promise<any>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const stream = cloudinary.uploader.upload_large_stream(
      {
        public_id: publicId,
        resource_type: this.resourceTypeFor(ctx.contentType),
        use_filename: true,
        unique_filename: false,
        chunk_size: 6 * 1024 * 1024, // Cloudinary's internal chunking granularity
      },
      (error: any, result: any) => {
        if (error) rejectDone(error);
        else resolveDone(result);
      }
    );

    entry = { stream, done };
    this.pending.set(fileId, entry);
    return entry;
  }

  async writeChunk(fileId: string, chunkNumber: number, data: Buffer, ctx: StorageContext): Promise<void> {
    const { stream } = this.getOrCreateUpload(fileId, ctx);

    const canContinue = stream.write(data);
    if (!canContinue) {
      await new Promise<void>((resolve) => stream.once('drain', resolve));
    }
  }

  async finalize(fileId: string): Promise<StorageWriteResult> {
    const entry = this.pending.get(fileId);
    if (!entry) {
      throw new Error(`[CloudinaryStorageAdapter] No active upload found for fileId "${fileId}"`);
    }

    entry.stream.end();
    const result = await entry.done;
    this.pending.delete(fileId);

    return {
      storageRef: result.public_id,
      url: result.secure_url,
    };
  }

  async putObject(fileId: string, data: Buffer, ctx: StorageContext): Promise<StorageWriteResult> {
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
        (error: any, res: any) => (error ? reject(error) : resolve(res))
      );
      stream.end(data);
    });

    return { storageRef: result.public_id, url: result.secure_url };
  }

  async readStream(ref: string): Promise<Readable> {
    // Cloudinary assets are served directly from their CDN via `url` —
    // proxying bytes through our own server is rarely desirable, but we
    // support it for parity with the other adapters (e.g. private assets).
    const cloudinary = this.getSdk();
    const https = require('https');
    const signedUrl = cloudinary.url(ref, { secure: true, resource_type: 'auto' });

    return new Promise<Readable>((resolve, reject) => {
      https.get(signedUrl, (response: Readable) => resolve(response)).on('error', reject);
    }) as unknown as Readable;
  }

  async delete(ref: string): Promise<void> {
    const cloudinary = this.getSdk();
    await cloudinary.uploader.destroy(ref, { resource_type: 'auto' });
  }
}
