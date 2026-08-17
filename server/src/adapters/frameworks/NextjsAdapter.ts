/**
 * @upload-media/server - NextjsAdapter
 *
 * Framework-agnostic UploadHandler wrapper for Next.js (App Router + Pages Router)
 */

type NextRequest = any;

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
 * ----------------------------
 * Normalized Request
 * ----------------------------
 */
class NextjsNormalizedRequest
  implements NormalizedRequest {

  headers: Record<
    string,
    string | string[] | undefined
  >;

  stream: Readable;

  query: Record<string, any>;

  params: Record<string, any>;

  user?: any;
  raw: NextRequest;
  fields?: Record<string, any>;
  files?: any[];
  fileFields?: Record<string, any>;

  constructor(req: NextRequest) {
    this.raw = req;

    this.headers = Object.fromEntries(
      req.headers
    );

    this.stream =
      req.body as unknown as Readable;

    this.query = Object.fromEntries(
      new URL(req.url).searchParams
    );

    this.params = {};

    this.user = (req as any).user;
  }
}

class NextjsNormalizedResponse
  implements NormalizedResponse {

  private statusCode = 200;

  private headers: Record<string, string> = {};

  private body: any = null;

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(body: any): void {
    this.body = JSON.stringify(body);
    this.headers['Content-Type'] =
      'application/json';
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
    // Next.js response is constructed at the end
  }

  toResponse(): Response {
    return new Response(this.body, {
      status: this.statusCode,
      headers: this.headers,
    });
  }

  get raw(): Response {
    return this.toResponse();
  }
}

export const createNextjsAdapter =
  (): FrameworkAdapter => ({

    name: 'nextjs',

    wrap(handler: UploadHandler) {

      return async (req: NextRequest) => {

        const normalizedReq =
          new NextjsNormalizedRequest(req);

        const normalizedRes =
          new NextjsNormalizedResponse();

        try {
          const result = await handler(
            normalizedReq,
            normalizedRes
          );

          if (result !== undefined) {
             normalizedRes.json(result);
          }

          if (result && typeof result.onBackground === 'function') {
            result.onBackground().catch((err: any) => console.error('[NextjsAdapter] Background task error:', err));
          }

          return normalizedRes.raw;
        } catch (error: any) {

          console.error(
            '[NextjsAdapter] Handler error:',
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


import { FileServingOptions } from '../../types';

export class CreateNextjsFileServingHandler {
  private options: FileServingOptions;

  constructor(
    config: string | FileServingOptions,
    legacyOptions?: FileServingOptions
  ) {
    const isLegacy = typeof config === 'string';
    this.options = isLegacy ? { rootDir: config, ...legacyOptions } : config;
  }

  async serveFile(ref: string, req?: NextRequest): Promise<Response> {
    const handler = new FileServingHandler(
      this.options.rootDir,
      this.options.database,
      this.options.cacheMaxAge
    );

    const bridge =
      new NextjsNormalizedResponse();

    let startByte: number | undefined;
    let endByte: number | undefined;
    
    if (req) {
      const headers = req.headers;
      let rangeHeader: string | null = null;
      if (headers) {
        if (typeof headers.get === 'function') {
          rangeHeader = headers.get('range');
        } else {
          rangeHeader = headers.range || headers['range'];
        }
      }

      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          startByte = parseInt(match[1], 10);
          if (match[2]) {
            endByte = parseInt(match[2], 10);
          }
        }
      }
    }

    let bucketName: string | undefined = this.options?.bucketName;
    if (!bucketName && this.options?.strictBucketAccess) {
        bucketName = this.options.pathPrefix?.replace(/^\//, '');
    }

    await handler.serveFile(
      ref,
      bridge as any,
      startByte,
      endByte,
      req,
      bucketName,
      this.options.onBeforeServe
    );

    return bridge.raw;
  }
}