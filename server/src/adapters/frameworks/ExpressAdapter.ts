/**
 * @upload-media/server - ExpressAdapter
 *
 * Wraps a framework-agnostic UploadHandler into an Express middleware.
 * Converts Express req/res to NormalizedRequest/NormalizedResponse.
 */

// @ts-ignore
type Request = any;
// @ts-ignore
type Response = any;
// @ts-ignore
type NextFunction = any;
import { FileServingHandler } from '../../core/FileServingHandler';
import { NormalizedRequest, NormalizedResponse, UploadHandler, FrameworkAdapter, MetadataRepository } from '../../types';

class ExpressNormalizedRequest implements NormalizedRequest {
  headers: Record<string, string | string[] | undefined>;
  stream: any;
  query: Record<string, any>;
  params: Record<string, any>;
  user?: any;
  raw: Request;
  fields?: Record<string, any>;
  files?: any[];

  constructor(req: Request) {
    this.raw = req;
    this.headers = req.headers as Record<string, string | string[] | undefined>;
    this.stream = req;
    this.query = req.query;
    this.params = req.params;
    this.user = (req as any).user;
  }
}

class ExpressNormalizedResponse implements NormalizedResponse {
  private res: Response;

  constructor(res: Response) {
    this.res = res;
  }

  status(code: number): ExpressNormalizedResponse {
    this.res.status(code);
    return this;
  }

  json(body: any): void {
    this.res.json(body);
  }

  header(name: string, value: string): ExpressNormalizedResponse {
    this.res.header(name, value);
    return this;
  }

  async pipeFrom(stream: any): Promise<void> {
    return new Promise((resolve, reject) => {
      stream.on('error', reject);
      this.res.on('error', reject);
      this.res.on('finish', resolve);
      stream.pipe(this.res);
    });
  }

  end(): void {
    this.res.end();
  }

  get raw(): Response {
    return this.res;
  }
}

export const createExpressAdapter = (): FrameworkAdapter => ({
  name: 'express',
  wrap(handler: UploadHandler) {
    return async (req: Request, res: Response, next: NextFunction) => {
      const normalizedReq = new ExpressNormalizedRequest(req);
      const normalizedRes = new ExpressNormalizedResponse(res);

      try {
        const result = await handler(normalizedReq, normalizedRes);
        if (result !== undefined && !res.headersSent) {
          res.json(result);
        }
        if (result && typeof result.onBackground === 'function') {
          res.on('finish', () => {
            result.onBackground().catch((err: any) => console.error('[ExpressAdapter] Background task error:', err));
          });
        }
      } catch (error: any) {
        console.error('[ExpressAdapter] Handler error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: error.message });
        }
      }
    };
  },
});

export function createExpressFileServingMiddleware(
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
  // Support legacy signature (rootDir, options) and new signature (options)
  const isLegacy = typeof config === 'string';
  const rootDir = isLegacy ? config : config.rootDir;
  const options = isLegacy ? legacyOptions : config;

  const handler = new FileServingHandler(
    rootDir!, // Might be undefined, handled inserveFile
    options?.database,
    options?.cacheMaxAge
  );
  const pathPrefix = options?.pathPrefix;

  return (req: Request, res: Response, next: Function) => {
    // If a prefix is explicitly provided, we validate it.
    // Otherwise, we rely on the framework mount point (e.g. app.use('/cdn', ...))
    if (pathPrefix && !req.path.startsWith(pathPrefix)) {
      return next();
    }

    // Extract the reference: either strip the prefix or use the full sub-path
    const ref = pathPrefix 
      ? req.path.slice(pathPrefix.length).replace(/^\//, '')
      : req.path.replace(/^\//, '');

    if (!ref || ref === '/') {
      return next();
    }

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

    const normalizedRes = new ExpressNormalizedResponse(res);
    handler.serveFile(ref, normalizedRes, startByte, endByte);
  };
}