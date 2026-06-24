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

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      stream.on('data', (chunk) =>
        chunks.push(chunk)
      );

      stream.on('error', reject);

      stream.on('end', () => {
        this.body =
          Buffer.concat(chunks);

        resolve();
      });
    });
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


export class CreateNextjsFileServingHandler {
  constructor(
    private config: string | {
      rootDir?: string;
      cacheMaxAge?: string;
      database?: MetadataRepository;
    }
  ) { }

  async serveFile(ref: string): Promise<Response> {
    const config = this.config;
    const isString = typeof config === 'string';
    const rootDir = isString ? config : config.rootDir;
    const database = isString ? undefined : config.database;
    const cacheMaxAge = isString ? '1d' : (config.cacheMaxAge || '1d');

    const handler = new FileServingHandler(
      rootDir,
      database,
      cacheMaxAge
    );

    const bridge =
      new NextjsNormalizedResponse();

    await handler.serveFile(
      ref,
      bridge as any
    );

    return bridge.raw;
  }
}