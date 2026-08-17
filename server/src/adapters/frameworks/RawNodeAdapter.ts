/**
 * @upload-media/server - RawNodeAdapter
 *
 * Wraps a framework-agnostic UploadHandler for raw Node.js http.Server.
 * Also works with serverless handlers that receive req/res directly.
 */

import { IncomingMessage, ServerResponse } from 'http';
import { NormalizedRequest, NormalizedResponse, UploadHandler, FrameworkAdapter, FileServingOptions } from '../../types';
import { Readable } from 'stream';
import { FileServingHandler } from '../../core/FileServingHandler';
import { MetadataRepository } from '../../types';
class RawNodeNormalizedRequest implements NormalizedRequest {
  headers: Record<string, string | string[] | undefined>;
  stream: Readable;
  query: Record<string, any>;
  params: Record<string, any>;
  user?: any;
  raw: IncomingMessage;
  fields?: Record<string, any>;
  files?: any[];
  fileFields?: Record<string, any>;

  constructor(req: IncomingMessage) {
    this.raw = req;
    this.headers = req.headers;
    this.stream = req;

    // Parse query string
    const protocol = req.headers['x-forwarded-proto'] === 'https' || (req.socket as any)?.encrypted ? 'https' : 'http';
    const url = new URL(req.url || '', `${protocol}://${req.headers.host || 'localhost'}`);
    this.query = Object.fromEntries(url.searchParams);
    this.params = {};

    this.user = (req as any).user;
  }
}

class RawNodeNormalizedResponse implements NormalizedResponse {
  private res: ServerResponse;
  private statusCode: number = 200;

  constructor(res: ServerResponse) {
    this.res = res;
  }

  status(code: number): RawNodeNormalizedResponse {
    this.statusCode = code;
    this.res.statusCode = code;
    return this;
  }

  json(body: any): void {
    this.res.setHeader('Content-Type', 'application/json');
    this.res.end(JSON.stringify(body));
  }

  header(name: string, value: string): RawNodeNormalizedResponse {
    this.res.setHeader(name, value);
    return this;
  }

  end(): void {
    this.res.end();
  }

  async pipeFrom(stream: Readable): Promise<void> {
    this.res.setHeader('Content-Type', 'application/octet-stream');
    return new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      this.res.on('error', reject);
      this.res.on('finish', resolve);
      stream.pipe(this.res);
    });
  }

  get raw(): ServerResponse {
    return this.res;
  }
}

export const createRawNodeAdapter = (): FrameworkAdapter => ({
  name: 'raw-node',
  wrap(handler: UploadHandler) {
    return async (req: IncomingMessage, res: ServerResponse) => {
      const normalizedReq = new RawNodeNormalizedRequest(req);
      const normalizedRes = new RawNodeNormalizedResponse(res);

      try {
        const result = await handler(normalizedReq, normalizedRes);
        if (result !== undefined && !res.headersSent) {
          normalizedRes.json(result);
        }
        if (result && typeof result.onBackground === 'function') {
          res.on('finish', () => {
            result.onBackground().catch((err: any) => console.error('[RawNodeAdapter] Background task error:', err));
          });
        }
      } catch (error: any) {
        console.error('[RawNodeAdapter] Handler error:', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Internal error' }));
        }
      }
    };
  },
});


export function createRawNodeFileServingHandler(
  config: string | FileServingOptions,
  legacyOptions?: FileServingOptions
) {
  const isLegacy = typeof config === 'string';
  const rootDir = isLegacy ? config : config.rootDir;
  const options = isLegacy ? legacyOptions : config;

  const handler = new FileServingHandler(
    rootDir!,
    options?.database,
    options?.cacheMaxAge
  );

  const pathPrefix = options?.pathPrefix || '/uploads';

  return async (
    req: IncomingMessage,
    res: ServerResponse
  ) => {
    const protocol = req.headers['x-forwarded-proto'] === 'https' || (req.socket as any)?.encrypted ? 'https' : 'http';
    const pathname = new URL(
      req.url || '/',
      `${protocol}://${req.headers.host || 'localhost'}`
    ).pathname;

    if (!pathname.startsWith(pathPrefix)) {
      return false; // Not handled
    }

    const ref = pathname
      .slice(pathPrefix.length)
      .replace(/^\//, '');

    if (!ref) {
      return false;
    }

    const rangeHeader = req.headers.range;

    let startByte: number | undefined;
    let endByte: number | undefined;

    if (rangeHeader) {
      const match = rangeHeader.match(
        /bytes=(\d+)-(\d*)/
      );

      if (match) {
        startByte = parseInt(match[1], 10);

        if (match[2]) {
          endByte = parseInt(match[2], 10);
        }
      }
    }

    let bucketName: string | undefined = options?.bucketName;
    if (!bucketName && options?.strictBucketAccess) {
        bucketName = options.pathPrefix?.replace(/^\//, '');
    }

    const normalizedRes =
      new RawNodeNormalizedResponse(res);

    await handler.serveFile(
      ref,
      normalizedRes,
      startByte,
      endByte,
      req,
      bucketName,
      options?.onBeforeServe
    );

    return true; // Handled
  };
}