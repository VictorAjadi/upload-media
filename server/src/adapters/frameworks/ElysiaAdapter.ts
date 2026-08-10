/**
 * @upload-media/server - ElysiaAdapter
 *
 * Framework-agnostic UploadHandler adapter for Elysia
 */

type Context = any;

import { Readable } from 'stream';

import {
  NormalizedRequest,
  NormalizedResponse,
  UploadHandler,
  FrameworkAdapter,
  MetadataRepository,
} from '../../types';

import { FileServingHandler } from '../../core/FileServingHandler';

/**
 * Convert Web ReadableStream → Node Readable
 * Ensures compatibility with your core NormalizedRequest
 */
function toNodeReadable(
  stream: ReadableStream<Uint8Array> | null | undefined
): Readable {
  if (!stream) {
    return Readable.from([]);
  }

  return Readable.fromWeb(stream as any);
}

/**
 * ----------------------------
 * Normalized Request
 * ----------------------------
 */
class ElysiaNormalizedRequest
  implements NormalizedRequest {

  headers: Record<
    string,
    string | string[] | undefined
  >;

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

    this.headers = Object.fromEntries(
      ctx.request.headers.entries()
    );

    this.stream = toNodeReadable(
      ctx.request.body
    );

    this.query = Object.fromEntries(
      new URL(ctx.request.url).searchParams
    );

    this.params = ctx.params ?? {};

    this.user = ctx.user;
  }
}

/**
 * ----------------------------
 * Normalized Response
 * ----------------------------
 */
class ElysiaNormalizedResponse
  implements NormalizedResponse {

  private statusCode = 200;

  private headers: Record<string, string> = {};

  private body: any = null;

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(body: any): void {
    this.headers['Content-Type'] =
      'application/json';

    this.body = JSON.stringify(body);
  }

  header(name: string, value: string) {
    this.headers[name] = value;
    return this;
  }

  async pipeFrom(stream: Readable): Promise<void> {
    this.headers['Content-Type'] =
      this.headers['Content-Type'] ||
      'application/octet-stream';

    // Zero-Copy Content Delivery: convert Node.js Readable to Web ReadableStream
    this.body = Readable.toWeb(stream);
  }

  end(): void {
    // Elysia response is constructed at the end, so we can just set 
    // a flag if needed, but the current flow handles it.
  }

  get raw(): Response {
    return new Response(this.body, {
      status: this.statusCode,
      headers: this.headers,
    });
  }
}

/**
 * ----------------------------
 * Elysia Adapter
 * ----------------------------
 */
export const createElysiaAdapter =
  (): FrameworkAdapter => ({

    name: 'elysia',

    wrap(handler: UploadHandler) {
      return async (ctx: Context) => {

        const normalizedReq =
          new ElysiaNormalizedRequest(ctx);

        const normalizedRes =
          new ElysiaNormalizedResponse();

        try {
          const result = await handler(
            normalizedReq,
            normalizedRes
          );

          if (result !== undefined) {
            normalizedRes.json(result);
          }

          if (result && typeof result.onBackground === 'function') {
            result.onBackground().catch((err: any) => console.error('[ElysiaAdapter] Background task error:', err));
          }

          return normalizedRes.raw;

        } catch (error) {

          console.error(
            '[ElysiaAdapter] Handler error:',
            error
          );

          return new Response(
            JSON.stringify({
              error:
                error instanceof Error
                  ? error.message
                  : 'Internal error',
            }),
            {
              status: 500,
              headers: {
                'Content-Type':
                  'application/json',
              },
            }
          );
        }
      };
    },
  });

export function createElysiaFileServingHandler(
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
  }
) {
  const isLegacy = typeof config === 'string';
  const rootDir = isLegacy ? config : config.rootDir;
  const options = isLegacy ? legacyOptions : config;

  const handler = new FileServingHandler(
    rootDir!,
    options?.database,
    options?.cacheMaxAge
  );

  const pathPrefix = options?.pathPrefix;

  return async (ctx: Context) => {
    const pathname = new URL(
      ctx.request.url
    ).pathname;

    if (pathPrefix && !pathname.startsWith(pathPrefix)) {
      return;
    }

    const ref = pathPrefix
      ? pathname.slice(pathPrefix.length).replace(/^\//, '')
      : pathname.replace(/^\//, '');

    if (!ref || ref === '/') return;

    const rangeHeader =
      ctx.request.headers.get('range');

    let startByte: number | undefined;
    let endByte: number | undefined;

    if (rangeHeader) {
      const match =
        rangeHeader.match(
          /bytes=(\d+)-(\d*)/
        );

      if (match) {
        startByte = parseInt(match[1], 10);

        if (match[2]) {
          endByte = parseInt(match[2], 10);
        }
      }
    }

    const normalizedRes =
      new ElysiaNormalizedResponse();

    await handler.serveFile(
      ref,
      normalizedRes,
      startByte,
      endByte
    );

    return normalizedRes.raw;
  };
}