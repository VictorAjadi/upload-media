/**
 * @upload-media/server - S3StorageAdapter
 *
 * Uses S3's *real* multipart upload API (CreateMultipartUpload /
 * UploadPart / CompleteMultipartUpload) so chunks stream straight to
 * S3 instead of being assembled somewhere in between. Works against
 * AWS S3 or any S3-compatible provider (Cloudflare R2, MinIO,
 * DigitalOcean Spaces, Backblaze B2) via `endpoint` + `forcePathStyle`.
 *
 * S3 requires every part except the last to be >= 5MB. Client chunk
 * sizes are usually smaller than that (1-2MB), so this adapter buffers
 * incoming chunks internally and only calls UploadPart once the buffer
 * crosses the configured minimum — the client-side chunk size and the
 * S3 part size are therefore fully decoupled, and this "just works"
 * regardless of how the frontend is configured.
 */

import { Readable } from 'stream';
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
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  endpoint?: string; // for S3-compatible providers
  forcePathStyle?: boolean;
  /** Public URL builder, defaults to the AWS virtual-hosted-style URL */
  buildPublicUrl?: (bucket: string, key: string) => string;
  /** Override how a logical bucket/fileId becomes an S3 key */
  buildKey?: (fileId: string, ctx: StorageContext) => string;
  /** Minimum bytes to buffer before flushing an UploadPart (default 5MB, the S3 minimum) */
  minPartSize?: number;
  /** Pass an already-constructed S3Client instead of letting the adapter build one */
  client?: any;
}

interface MultipartState {
  uploadId: string;
  key: string;
  partNumber: number;
  parts: { ETag: string; PartNumber: number }[];
  buffer: Buffer[];
  bufferedBytes: number;
}

export class S3StorageAdapter implements StorageAdapter {
  readonly name = 's3';
  private options: S3StorageOptions;
  private client: any;
  private uploads = new Map<string, MultipartState>();

  constructor(options: S3StorageOptions) {
    this.options = options;
    this.minPartSize = options.minPartSize ?? MIN_S3_PART_SIZE;
  }

  private minPartSize: number;

  private async getClient() {
    if (this.options.client) return this.options.client;
    if (this.client) return this.client;

    let S3Client: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ({ S3Client } = require('@aws-sdk/client-s3'));
    } catch {
      throw new Error(
        '[upload-media/server] S3StorageAdapter requires "@aws-sdk/client-s3". ' +
          'Install it with: npm install @aws-sdk/client-s3'
      );
    }

    this.client = new S3Client({
      region: this.options.region,
      credentials: this.options.credentials,
      endpoint: this.options.endpoint,
      forcePathStyle: this.options.forcePathStyle,
    });
    return this.client;
  }

  private buildKey(fileId: string, ctx: StorageContext): string {
    if (this.options.buildKey) return this.options.buildKey(fileId, ctx);
    return `${ctx.bucket}/${fileId}`;
  }

  private buildPublicUrl(key: string): string {
    if (this.options.buildPublicUrl) return this.options.buildPublicUrl(this.options.bucket, key);
    if (this.options.endpoint) {
      return `${this.options.endpoint.replace(/\/$/, '')}/${this.options.bucket}/${key}`;
    }
    return `https://${this.options.bucket}.s3.${this.options.region}.amazonaws.com/${key}`;
  }

  async writeChunk(fileId: string, chunkNumber: number, data: Buffer, ctx: StorageContext): Promise<void> {
    const sdk = await this.loadCommands();
    const client = await this.getClient();

    let state = this.uploads.get(fileId);
    if (!state) {
      const key = this.buildKey(fileId, ctx);
      const created = await client.send(
        new sdk.CreateMultipartUploadCommand({
          Bucket: this.options.bucket,
          Key: key,
          ContentType: ctx.contentType,
        })
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

  private async flushPart(state: MultipartState, sdk: any, client: any, isFinal: boolean): Promise<void> {
    if (state.bufferedBytes === 0 && !isFinal) return;
    if (state.bufferedBytes === 0 && isFinal && state.parts.length > 0) return; // nothing left to flush

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
      })
    );

    state.parts.push({ ETag: result.ETag, PartNumber: state.partNumber });
    state.partNumber += 1;
  }

  private async loadCommands() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('@aws-sdk/client-s3');
    } catch {
      throw new Error(
        '[upload-media/server] S3StorageAdapter requires "@aws-sdk/client-s3". ' +
          'Install it with: npm install @aws-sdk/client-s3'
      );
    }
  }

  async finalize(fileId: string, ctx: StorageContext): Promise<StorageWriteResult> {
    const sdk = await this.loadCommands();
    const client = await this.getClient();
    const state = this.uploads.get(fileId);

    if (!state) {
      throw new Error(`[S3StorageAdapter] No active multipart upload found for fileId "${fileId}"`);
    }

    // Flush whatever remains — the *last* part is allowed to be under 5MB.
    await this.flushPart(state, sdk, client, true);

    await client.send(
      new sdk.CompleteMultipartUploadCommand({
        Bucket: this.options.bucket,
        Key: state.key,
        UploadId: state.uploadId,
        MultipartUpload: { Parts: state.parts },
      })
    );

    this.uploads.delete(fileId);

    return {
      storageRef: state.key,
      url: this.buildPublicUrl(state.key),
    };
  }

  async putObject(fileId: string, data: Buffer, ctx: StorageContext): Promise<StorageWriteResult> {
    const sdk = await this.loadCommands();
    const client = await this.getClient();
    const key = this.buildKey(fileId, ctx);

    await client.send(
      new sdk.PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: data,
        ContentType: ctx.contentType,
      })
    );

    return { storageRef: key, url: this.buildPublicUrl(key) };
  }

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
      })
    );

    return result.Body as Readable;
  }

  async delete(ref: string): Promise<void> {
    const sdk = await this.loadCommands();
    const client = await this.getClient();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: this.options.bucket, Key: ref }));
  }
}
