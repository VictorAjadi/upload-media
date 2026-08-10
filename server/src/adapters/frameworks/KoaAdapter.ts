/**
 * @upload-media/server - KoaAdapter
 *
 * Wraps a framework-agnostic UploadHandler into a Koa middleware.
 */

// @ts-ignore
type Context = any;
// @ts-ignore
type Next = any;
import { FileServingHandler } from '../../core/FileServingHandler';
import { NormalizedRequest, NormalizedResponse, UploadHandler, FrameworkAdapter, MetadataRepository } from '../../types';
import { Readable } from 'stream';

class KoaNormalizedRequest implements NormalizedRequest {
  headers: Record<string, string | string[] | undefined>;
  stream: Readable;
  query: Record<string, any>;
  params: Record<string, any>;
  user?: any;
  raw: Context;
  fields?: Record<string, any>;
  files?: any[];
  fileFields?: Record<string, any>;

  constructor(ctx: Context) {
    this.raw = ctx;
    this.headers = ctx.headers as Record<string, string | string[] | undefined>;
    this.stream = ctx.req as Readable;
    this.query = ctx.query;
    this.params = ctx.params;
    this.user = (ctx as any).state?.user;
  }
}

class KoaNormalizedResponse implements NormalizedResponse {
  private ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  status(code: number): KoaNormalizedResponse {
    this.ctx.status = code;
    return this;
  }

  json(body: any): void {
    this.ctx.body = body;
    this.ctx.type = 'application/json';
  }

  header(name: string, value: string): KoaNormalizedResponse {
    this.ctx.set(name, value);
    return this;
  }

  async pipeFrom(stream: Readable): Promise<void> {
    this.ctx.type = 'application/octet-stream';
    return new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      stream.on('end', resolve);
      this.ctx.body = stream;
    });
  }

  end(): void {
    // In Koa, we just return to stop the middleware chain
    // but the adapter can handle it.
  }

  get raw(): Context {
    return this.ctx;
  }
}

export const createKoaAdapter = (): FrameworkAdapter => ({
  name: 'koa',
  wrap(handler: UploadHandler) {
    return async (ctx: Context) => {
      const normalizedReq = new KoaNormalizedRequest(ctx);
      const normalizedRes = new KoaNormalizedResponse(ctx);

      try {
        const result = await handler(normalizedReq, normalizedRes);
        if (result !== undefined && !ctx.headerSent) {
          ctx.body = result;
          ctx.type = 'application/json';
        }
        if (result && typeof result.onBackground === 'function') {
          result.onBackground().catch((err: any) => console.error('[KoaAdapter] Background task error:', err));
        }
      } catch (error: any) {
        console.error('[KoaAdapter] Handler error:', error);
        if (!ctx.headerSent) {
          ctx.status = 500;
          ctx.body = { error: error.message };
        }
      }
    };
  },
});

export function createKoaFileServingMiddleware(
  config: string | {
    rootDir?: string;
    cacheMaxAge?: string;
    pathPrefix?: string;
    database?: MetadataRepository;
  },
  legacyOptions?: {
    cacheMaxAge?: string;
    pathPrefix?: string;
    database?: MetadataRepository;
  }) {
  const isLegacy = typeof config === 'string';
  const rootDir = isLegacy ? config : config.rootDir;
  const options = isLegacy ? legacyOptions : config;

  const handler = new FileServingHandler(
    rootDir!,
    options?.database,
    options?.cacheMaxAge
  );
  const pathPrefix = options?.pathPrefix;

  return async (ctx: Context, next: Next) => {
    if (pathPrefix && !ctx.path.startsWith(pathPrefix)) {
      return next();
    }

    const ref = pathPrefix 
      ? ctx.path.slice(pathPrefix.length).replace(/^\//, '')
      : ctx.path.replace(/^\//, '');

    if (!ref || ref === '/') {
      return next();
    }

    const rangeHeader = ctx.headers.range;
    let startByte: number | undefined;
    let endByte: number | undefined;

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        startByte = parseInt(match[1], 10);
        if (match[2]) {
          endByte = parseInt(match[2], 10);
        }
      }
    }

    const normalizedRes = new KoaNormalizedResponse(ctx);
    await handler.serveFile(ref, normalizedRes, startByte, endByte);
  };
}