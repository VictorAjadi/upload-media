/**
 * @upload-media/server - H3Adapter
 *
 * Wraps a framework-agnostic UploadHandler into an H3 event handler.
 * Works with Nuxt, Nitro, and other H3-based frameworks.
 */

import path from 'path';
import fs from 'fs/promises';
import { Readable } from 'stream';

import {
  NormalizedRequest,
  NormalizedResponse,
  UploadHandler,
  FrameworkAdapter,
  MetadataRepository,
} from '../../types';

/**
 * Minimal H3-compatible event type.
 * We intentionally avoid importing from `h3`
 * so consumers are not forced to install it.
 */
export interface H3EventLike {
  node: {
    req: Readable & {
      headers: Record<string, string | string[] | undefined>;
      url?: string;
    };
    res: {
      statusCode: number;
      setHeader(name: string, value: string): void;
      end(body?: any): void;
    };
  };

  context: {
    params?: Record<string, any>;
    user?: any;
    [key: string]: any;
  };
}

const setResponseStatus = (
  event: H3EventLike,
  code: number
) => {
  event.node.res.statusCode = code;
};

const setResponseHeader = (
  event: H3EventLike,
  name: string,
  value: string
) => {
  event.node.res.setHeader(name, value);
};

const setHeader = setResponseHeader;

const send = (
  event: H3EventLike,
  body: any
) => {
  event.node.res.end(body);
};

const createError = ({
  statusCode,
  statusMessage,
}: {
  statusCode: number;
  statusMessage: string;
}) => {
  const err = new Error(statusMessage) as Error & {
    statusCode: number;
  };

  err.statusCode = statusCode;

  return err;
};

function getQuery(
  event: H3EventLike
): Record<string, any> {
  const url = new URL(
    event.node.req.url || '',
    'http://localhost'
  );

  return Object.fromEntries(
    url.searchParams.entries()
  );
}

class H3NormalizedRequest
  implements NormalizedRequest {
  headers: Record<
    string,
    string | string[] | undefined
  >;

  stream: Readable;

  query: Record<string, any>;

  params: Record<string, any>;

  user?: any;
  raw: H3EventLike;
  fields?: Record<string, any>;
  files?: any[];
  fileFields?: Record<string, any>;

  constructor(event: H3EventLike) {
    this.raw = event;

    this.headers =
      event.node.req.headers;

    this.stream = event.node.req;

    this.query = getQuery(event);

    this.params =
      event.context.params || {};

    this.user =
      event.context.user;
  }
}

class H3NormalizedResponse
  implements NormalizedResponse {
  private event: H3EventLike;

  private statusCode = 200;

  constructor(
    event: H3EventLike
  ) {
    this.event = event;
  }

  status(
    code: number
  ): H3NormalizedResponse {
    this.statusCode = code;

    setResponseStatus(
      this.event,
      code
    );

    return this;
  }

  json(body: any): void {
    setResponseHeader(
      this.event,
      'Content-Type',
      'application/json'
    );

    send(
      this.event,
      JSON.stringify(body)
    );
  }

  header(
    name: string,
    value: string
  ): H3NormalizedResponse {
    setResponseHeader(
      this.event,
      name,
      value
    );

    return this;
  }
  end(): void {
    send(this.event, '');
  }
  async pipeFrom(
    stream: Readable
  ): Promise<void> {
    setResponseHeader(
      this.event,
      'Content-Type',
      'application/octet-stream'
    );

    return new Promise(
      (resolve, reject) => {
        stream.on(
          'error',
          reject
        );

        stream.on(
          'end',
          resolve
        );

        stream.pipe(
          this.event.node
            .res as any
        );
      }
    );
  }

  get raw(): H3EventLike {
    return this.event;
  }
}

export const createH3Adapter =
  (): FrameworkAdapter => ({
    name: 'h3',

    wrap(
      handler: UploadHandler
    ) {
      return async (
        event: H3EventLike
      ) => {
        const normalizedReq =
          new H3NormalizedRequest(
            event
          );

        const normalizedRes =
          new H3NormalizedResponse(
            event
          );

        try {
          const result = await handler(
            normalizedReq,
            normalizedRes
          );
          if (result !== undefined) {
            normalizedRes.json(result);
          }
          if (result && typeof result.onBackground === 'function') {
            (event.node.res as any).on?.('finish', () => {
              result.onBackground().catch((err: any) => console.error('[H3Adapter] Background task error:', err));
            });
          }
        } catch (error: any) {
          console.error(
            '[H3Adapter] Handler error:',
            error
          );

          setResponseStatus(
            event,
            500
          );

          send(
            event,
            JSON.stringify({
              error:
                error instanceof
                  Error
                  ? error.message
                  : 'Internal error',
            })
          );
        }
      };
    },
  });

export class CreateH3FileServingHandler {
  constructor(
    private rootDir: string,

    private database?: MetadataRepository,

    private cacheMaxAge: string =
      '1d'
  ) { }

  async serveFile(
    ref: string,

    event: H3EventLike
  ): Promise<Buffer> {
    const fullPath =
      path.resolve(
        this.rootDir,
        ref
      );

    if (
      !fullPath.startsWith(
        path.resolve(
          this.rootDir
        )
      )
    ) {
      throw createError({
        statusCode: 403,

        statusMessage:
          'Forbidden',
      });
    }

    try {
      const stat =
        await fs.stat(
          fullPath
        );

      if (!stat.isFile()) {
        throw createError({
          statusCode: 404,

          statusMessage:
            'Not found',
        });
      }

      let mimeType =
        'application/octet-stream';

      if (this.database) {
        try {
          const fileId =
            this.extractFileId(
              ref
            );

          const fileRecord =
            await this.database.getFileById(
              fileId
            );

          if (
            fileRecord?.contentType
          ) {
            mimeType =
              fileRecord.contentType;
          }
        } catch (error) {
          console.warn(
            '[H3FileServing] DB lookup failed:',
            error
          );
        }
      }

      const fileBuffer =
        await fs.readFile(
          fullPath
        );

      setHeader(
        event,
        'Content-Type',
        mimeType
      );

      setHeader(
        event,
        'Content-Length',
        String(
          stat.size
        )
      );

      setHeader(
        event,
        'Cache-Control',
        `public, max-age=${this.getCacheSeconds()}`
      );

      return fileBuffer;
    } catch (error: any) {
      console.error(
        '[H3FileServing] Error:',
        error
      );

      if (
        error?.statusCode ===
        403 ||
        error?.statusCode ===
        404
      ) {
        throw error;
      }

      throw createError({
        statusCode: 500,

        statusMessage:
          'Internal server error',
      });
    }
  }

  private extractFileId(
    ref: string
  ): string {
    return path
      .basename(ref)
      .replace(
        /\.[^/.]+$/,
        ''
      );
  }

  private getCacheSeconds(): number {
    const match =
      this.cacheMaxAge.match(
        /^(\d+)([mhd]?)$/
      );

    if (!match) {
      return 86400;
    }

    const [
      ,
      num,
      unit,
    ] = match;

    const value =
      parseInt(
        num,
        10
      );

    switch (unit) {
      case 'm':
        return value * 60;

      case 'h':
        return value * 3600;

      case 'd':
        return value * 86400;

      default:
        return value;
    }
  }
}