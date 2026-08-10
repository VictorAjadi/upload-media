/**
 * @upload-media/server - FastifyAdapter
 *
 * Wraps a framework-agnostic UploadHandler into a Fastify route handler.
 */

// @ts-ignore
type FastifyRequest = any;
// @ts-ignore
type FastifyReply = any;
// @ts-ignore
type FastifyInstance = any;
import { FileServingHandler } from '../../core/FileServingHandler';
import { NormalizedRequest, NormalizedResponse, UploadHandler, FrameworkAdapter, MetadataRepository } from '../../types';

class FastifyNormalizedRequest implements NormalizedRequest {
  headers: Record<string, string | string[] | undefined>;
  stream: any;
  query: Record<string, any>;
  params: Record<string, any>;
  user?: any;
  raw: FastifyRequest;
  fields?: Record<string, any>;
  files?: any[];
  fileFields?: Record<string, any>;

  constructor(req: FastifyRequest) {
    this.raw = req;
    this.headers = req.headers as Record<string, string | string[] | undefined>;
    this.stream = req.raw;
    this.query = req.query;
    this.params = req.params;
    this.user = (req as any).user;
  }
}

class FastifyNormalizedResponse implements NormalizedResponse {
  private reply: FastifyReply;
  private statusCode: number = 200;

  constructor(reply: FastifyReply) {
    this.reply = reply;
  }

  status(code: number): FastifyNormalizedResponse {
    this.statusCode = code;
    this.reply.status(code);
    return this;
  }

  json(body: any): void {
    this.reply.code(this.statusCode).send(body);
  }

  header(name: string, value: string): FastifyNormalizedResponse {
    this.reply.header(name, value);
    return this;
  }

  async pipeFrom(stream: any): Promise<void> {
    this.reply.type('application/octet-stream');
    return this.reply.send(stream);
  }

  end(): void {
    // Fastify handles response termination via reply.send()
  }

  get raw(): FastifyReply {
    return this.reply;
  }
}

export const createFastifyAdapter = (): FrameworkAdapter => ({
  name: 'fastify',
  wrap(handler: UploadHandler) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const normalizedReq = new FastifyNormalizedRequest(req);
      const normalizedRes = new FastifyNormalizedResponse(reply);

      try {
        const result = await handler(normalizedReq, normalizedRes);
        if (result !== undefined && !reply.sent) {
          reply.send(result);
        }
        if (result && typeof result.onBackground === 'function') {
          result.onBackground().catch((err: any) => console.error('[FastifyAdapter] Background task error:', err));
        }
      } catch (error: any) {
        console.error('[FastifyAdapter] Handler error:', error);
        if (!reply.sent) {
          reply.status(500).send({ error: error.message });
        }
      }
    };
  },
});

export function createFastifyFileServingPlugin(
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
  const pathPrefix = options?.pathPrefix || '/';

  return async (fastify: FastifyInstance) => {
    // Fastify uses route patterns, so the 'prefix' is part of the registration
    fastify.get(`${pathPrefix === '/' ? '' : pathPrefix}/*`, async (req: FastifyRequest, reply: FastifyReply) => {
      const ref = (req.params as any)['*'];

      const rangeHeader = req.headers.range;
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

      const normalizedRes = new FastifyNormalizedResponse(reply);
      await handler.serveFile(ref, normalizedRes, startByte, endByte);
    });
  };
}