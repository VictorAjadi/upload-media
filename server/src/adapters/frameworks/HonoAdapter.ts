/**
 * @upload-media/server - HonoAdapter
 *
 * Wraps a framework-agnostic UploadHandler into a Hono middleware/handler.
 */

// @ts-ignore
import { Context } from 'hono';
import { NormalizedRequest, NormalizedResponse, UploadHandler, FrameworkAdapter, MetadataRepository } from '../../types';
import { Readable } from 'stream';
import { FileServingHandler } from '../../core/FileServingHandler';

class HonoNormalizedRequest implements NormalizedRequest {
  headers: Record<string, string | string[] | undefined>;
  stream: Readable;
  query: Record<string, any>;
  params: Record<string, any>;
  user?: any;
  raw: Context;
  fields?: Record<string, any>;
  files?: any[];

  constructor(ctx: Context) {
    this.raw = ctx;
    this.headers = {};
    ctx.req.raw.headers.forEach((v: string, k: string) => {
      this.headers[k.toLowerCase()] = v;
    });
    this.stream = ctx.req.raw.body as Readable;
    this.query = ctx.req.query() as Record<string, any>;
    this.params = ctx.req.param() as Record<string, any>;
    this.user = (ctx as any).user;
  }
}

class HonoNormalizedResponse implements NormalizedResponse {
  private ctx: Context;
  private statusCode: number = 200;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  status(code: number): HonoNormalizedResponse {
    this.statusCode = code;
    return this;
  }

  json(body: any): void {
    this.ctx.json(body, this.statusCode);
  }

  header(name: string, value: string): HonoNormalizedResponse {
    this.ctx.header(name, value);
    return this;
  }

  async pipeFrom(stream: Readable): Promise<void> {
    this.ctx.header('Content-Type', 'application/octet-stream');
    return new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      stream.on('end', resolve);
      // For Hono, write to response manually
      stream.pipe(this.ctx.raw.res);
    });
  }

  end(): void {
    // Hono doesn't have a direct res.end(), but we can set 
    // ctx.body to null or handle empty body
    this.ctx.body = null;
  }

  get raw(): Context {
    return this.ctx;
  }
}

export const createHonoAdapter = (): FrameworkAdapter => ({
  name: 'hono',
  wrap(handler: UploadHandler) {
    return async (ctx: Context) => {
      const normalizedReq = new HonoNormalizedRequest(ctx);
      const normalizedRes = new HonoNormalizedResponse(ctx);

      try {
        const result = await handler(normalizedReq, normalizedRes);
        if (result !== undefined && !ctx.headerSent) {
          ctx.body = result;
          ctx.type = 'application/json';
        }
        if (result && typeof result.onBackground === 'function') {
          // In Hono, we run it after the handler finishes
          result.onBackground().catch((err: any) => console.error('[HonoAdapter] Background task error:', err));
        }
      } catch (error: any) {
        ctx.status(500).json({ error: error instanceof Error ? error.message : 'Internal error' });
      }
    };
  },
});

export function createHonoFileServingMiddleware(
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

  return async (ctx: Context, next: Function) => {
    if (pathPrefix && !ctx.req.path.startsWith(pathPrefix)) {
      return next();
    }

    const ref = pathPrefix 
      ? ctx.req.path.slice(pathPrefix.length).replace(/^\//, '')
      : ctx.req.path.replace(/^\//, '');

    if (!ref || ref === '/') {
      return next();
    }

    const rangeHeader = ctx.req.header('range');
    let startByte: number | undefined;

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        startByte = parseInt(match[1], 10);
      }
    }

    const normalizedRes = new HonoNormalizedResponse(ctx);
    await handler.serveFile(ref, normalizedRes, startByte);
  };
}