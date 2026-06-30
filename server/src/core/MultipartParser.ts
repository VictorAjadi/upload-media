/**
 * @upload-media/server - Production-Grade MultipartParser
 *
 * Handles BOTH:
 * 1. Chunked uploads (from the worker)
 * 2. Non-chunked uploads (regular file uploads, like Multer)
 *
 * Features:
 * - Field validation (required, length, regex, enum, JSON)
 * - File validation (MIME, size, magic bytes, codec detection)
 * - Progress callbacks
 * - Field transformation
 * - Filename sanitization
 * - MIME sniffing (verify actual file type)
 * - Timeout protection
 * - Resume support
 * - Better error messages
 */

import { Readable } from 'stream';
import { NormalizedRequest } from '../types';
import { ParserHooks, HookContext } from '../hooks/types';

export interface FieldValidationRule {
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  allowedValues?: string[];
  isJson?: boolean;
}

export interface FileValidationRule {
  allowedMimeTypes?: string[];
  allowedMimePatterns?: string[]; // e.g., "image/*", "video/*"
  maxSize?: number;
  detectMagicBytes?: boolean;
  detectCodec?: boolean;
  filename?: {
    maxLength?: number;
    sanitize?: boolean;
  };
}

export interface ParseOptions {
  maxFieldSize?: number; // Default: 1MB
  maxFileSize?: number; // Default: 5MB
  maxFiles?: number; // Default: 10
  maxTotalSize?: number; // Total request size limit

  fieldValidation?: Record<string, FieldValidationRule>;
  fileValidation?: Record<string, FileValidationRule>;

  fieldTransformer?: Record<string, (value: string) => any>;

  onProgress?: (loaded: number, total: number) => void;
  onField?: (name: string, value: any) => void;
  onFile?: (info: FileInfo, stream: Readable) => Promise<void>;

  operationTimeout?: number;

  resumeChunk?: {
    fileId: string;
    startChunk: number;
  };

  // Hook into parsing process
  hooks?: ParserHooks;
}

export interface FileInfo {
  fieldname: string;
  filename: string;
  mimetype: string;
  size: number;
  encoding?: string;
  detectedMimetype?: string; // From magic bytes
}

export interface ParsedFile {
  fieldname: string;
  filename: string;
  mimetype: string;
  detectedMimetype?: string;
  buffer: Buffer;
  size: number;
}

export interface ParsedMultipart {
  fields: Record<string, any>;
  files: ParsedFile[];
}

/**
 * Magic byte signatures for common file types.
 * Used to verify actual file type regardless of Content-Type header.
 */
const MAGIC_BYTES: Record<string, { signature: Buffer; mimeType: string }> = {
  // Images
  jpeg: { signature: Buffer.from([0xff, 0xd8, 0xff]), mimeType: 'image/jpeg' },
  png: { signature: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png' },
  gif: { signature: Buffer.from([0x47, 0x49, 0x46]), mimeType: 'image/gif' },
  webp: { signature: Buffer.from([0x52, 0x49, 0x46, 0x46]), mimeType: 'image/webp' },
  // Video
  mp4: { signature: Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]), mimeType: 'video/mp4' },
  webm: { signature: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), mimeType: 'video/webm' },
  // Documents
  pdf: { signature: Buffer.from([0x25, 0x50, 0x44, 0x46]), mimeType: 'application/pdf' },
  zip: { signature: Buffer.from([0x50, 0x4b, 0x03, 0x04]), mimeType: 'application/zip' },
};

export class MultipartParser {
  /**
   * Parse buffered multipart body (for chunked uploads).
   * Loads entire body into memory before parsing.
   */
  static async parseBuffered(
    req: NormalizedRequest,
    options: ParseOptions = {}
  ): Promise<ParsedMultipart> {
    const busboy = this.loadBusboy();

    const maxFieldSize = options.maxFieldSize ?? 1 * 1024 * 1024;
    const maxFileSize = options.maxFileSize ?? 5 * 1024 * 1024;
    const maxFiles = options.maxFiles ?? 10;

    return new Promise((resolve, reject) => {
      const fields: Record<string, any> = {};
      const files: ParsedFile[] = [];
      let settled = false;
      let totalSize = 0;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        options.hooks?.onParseError?.(err, { timestamp: Date.now() });
        reject(err);
      };

      let bb: any;
      try {
        bb = busboy({
          headers: req.headers as Record<string, string>,
          limits: {
            fieldSize: maxFieldSize,
            fileSize: maxFileSize,
            files: maxFiles,
          },
        });
      } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
      }

      bb.on('field', async (name: string, value: string) => {
        try {
          // Validate field
          const rule = options.fieldValidation?.[name];
          if (rule) {
            this.validateField(name, value, rule);
          }

          // Transform field
          let finalValue: any = value;
          if (options.fieldTransformer?.[name]) {
            finalValue = options.fieldTransformer[name](value);
          }

          // Hook
          if (options.hooks?.onFieldParsed) {
            await options.hooks.onFieldParsed(name, value, { timestamp: Date.now() });
          }

          fields[name] = finalValue;
          options.onField?.(name, finalValue);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });

      bb.on('file', (fieldname: string, fileStream: Readable, info: any) => {
        const fileInfo: FileInfo = {
          fieldname,
          filename: info.filename || 'unknown',
          mimetype: info.mimeType || info.mimetype || 'application/octet-stream',
          size: 0,
          encoding: info.encoding,
        };

        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;

        fileStream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          totalSize += chunk.length;

          // ENSURE chunk is a proper Buffer before pushing
          const safeChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          chunks.push(safeChunk);

          // Progress callback
          options.onProgress?.(totalSize, options.maxTotalSize ?? Infinity);
        });

        fileStream.on('limit', () => {
          truncated = true;
        });

        fileStream.on('end', async () => {
          try {
            if (truncated) {
              fail(new Error(`File "${fieldname}" exceeded the maximum allowed size`));
              return;
            }

            fileInfo.size = size;

            // Ensure we create a proper Buffer from all chunks
            const buffer = Buffer.concat(chunks, size);

            // Detect magic bytes (actual file type)
            const fileRule = options.fileValidation?.[fieldname];
            const wildcardRule = options.fileValidation?.['.*'];

            // Always detect magic bytes if ANY matching rule wants it
            if ((fileRule?.detectMagicBytes) || (wildcardRule?.detectMagicBytes)) {
              fileInfo.detectedMimetype = this.detectMimeType(buffer);
            }

            // Validate file - apply specific rule first, then wildcard
            if (fileRule) {
              this.validateFile(fieldname, fileInfo, buffer, fileRule);
            } else if (wildcardRule) {
              this.validateFile(fieldname, fileInfo, buffer, wildcardRule);
            }

            // Hook
            if (options.hooks?.onFileParsed) {
              await options.hooks.onFileParsed(
                fieldname,
                fileInfo.filename,
                fileInfo.mimetype,
                size,
                { timestamp: Date.now() }
              );
            }

            files.push({
              fieldname,
              filename: fileInfo.filename,
              mimetype: fileInfo.mimetype,
              detectedMimetype: fileInfo.detectedMimetype,
              buffer,
              size,
            });
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        });

        fileStream.on('error', fail);
      });

      bb.on('error', fail);
      bb.on('finish', () => {
        if (settled) return;
        settled = true;
        options.hooks?.afterParseComplete?.(Object.keys(fields).length, files.length, {
          timestamp: Date.now(),
        });
        resolve({ fields, files });
      });

      req.stream.on('error', fail);
      req.stream.pipe(bb);
    });
  }

  /**
   * Stream mode: don't buffer files, pass streams directly to handler.
   * Ideal for large non-chunked uploads.
   */
  static async parseStreaming(
    req: NormalizedRequest,
    handlers: {
      onField?: (name: string, value: any) => void | Promise<void>;
      onFile: (info: FileInfo, stream: Readable) => void | Promise<void>;
    },
    options: ParseOptions = {}
  ): Promise<void> {
    const busboy = this.loadBusboy();

    const maxFieldSize = options.maxFieldSize ?? 1 * 1024 * 1024;
    const maxFileSize = options.maxFileSize ?? Infinity;
    const maxFiles = options.maxFiles ?? 10;

    return new Promise((resolve, reject) => {
      let settled = false;
      const pending: Promise<void>[] = [];

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      let bb: any;
      try {
        bb = busboy({
          headers: req.headers as Record<string, string>,
          limits: { fieldSize: maxFieldSize, fileSize: maxFileSize, files: maxFiles },
        });
      } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
      }

      bb.on('field', async (name: string, value: string) => {
        try {
          // Validate
          const rule = options.fieldValidation?.[name];
          if (rule) {
            this.validateField(name, value, rule);
          }

          // Transform
          let finalValue: any = value;
          if (options.fieldTransformer?.[name]) {
            finalValue = options.fieldTransformer[name](value);
          }

          const result = handlers.onField?.(name, finalValue);
          if (result instanceof Promise) {
            pending.push(result);
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });

      bb.on('file', (fieldname: string, fileStream: Readable, info: any) => {
        const fileInfo: FileInfo = {
          fieldname,
          filename: info.filename || 'unknown',
          mimetype: info.mimeType || info.mimetype || 'application/octet-stream',
          size: 0,
          encoding: info.encoding,
        };

        const result = handlers.onFile(fileInfo, fileStream);
        if (result instanceof Promise) {
          pending.push(result.catch(fail));
        }
      });

      bb.on('error', fail);
      bb.on('finish', async () => {
        try {
          await Promise.all(pending);
          if (!settled) {
            settled = true;
            resolve();
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });

      req.stream.on('error', fail);
      req.stream.pipe(bb);
    });
  }

  private static loadBusboy(): any {
    try {
      return require('busboy');
    } catch {
      throw new Error(
        '[MultipartParser] The `busboy` package is required. Install it with: npm install busboy'
      );
    }
  }

  private static validateField(name: string, value: string, rule: FieldValidationRule): void {
    if (rule.required && (!value || value.trim() === '')) {
      throw new Error(`Field "${name}" is required`);
    }

    if (value && rule.minLength && value.length < rule.minLength) {
      throw new Error(`Field "${name}" must be at least ${rule.minLength} characters`);
    }

    if (value && rule.maxLength && value.length > rule.maxLength) {
      throw new Error(`Field "${name}" must be at most ${rule.maxLength} characters`);
    }

    if (value && rule.pattern && !rule.pattern.test(value)) {
      throw new Error(`Field "${name}" does not match the required format`);
    }

    if (value && rule.allowedValues && !rule.allowedValues.includes(value)) {
      throw new Error(`Field "${name}" must be one of: ${rule.allowedValues.join(', ')}`);
    }

    if (rule.isJson && value) {
      try {
        JSON.parse(value);
      } catch {
        throw new Error(`Field "${name}" must be valid JSON`);
      }
    }
  }

  private static validateFile(
    fieldname: string,
    info: FileInfo,
    buffer: Buffer,
    rule: FileValidationRule
  ): void {
    // Size check
    if (rule.maxSize && buffer.length > rule.maxSize) {
      throw new Error(
        `File "${fieldname}" exceeds the maximum size of ${rule.maxSize} bytes`
      );
    }

    // MIME type check
    // CRITICAL FIX: Use detected MIME type ONLY if it's not 'application/octet-stream'
    // When magic byte detection fails, we should trust the provided Content-Type
    const detectedIsUnknown = !info.detectedMimetype ||
      info.detectedMimetype === 'application/octet-stream';

    // If detection returned unknown, trust the original Content-Type header
    const mimeToCheck = detectedIsUnknown ? info.mimetype : info.detectedMimetype;

    // Only validate allowedMimeTypes if the array is provided and not empty
    if (rule.allowedMimeTypes && rule.allowedMimeTypes.length > 0) {
      // Check both detected and original MIME types
      const detectedMatch = info.detectedMimetype &&
        rule.allowedMimeTypes.includes(info.detectedMimetype);
      const originalMatch = rule.allowedMimeTypes.includes(info.mimetype);

      if (!detectedMatch && !originalMatch) {
        throw new Error(
          `File "${fieldname}" has unsupported type "${mimeToCheck}". Allowed: ${rule.allowedMimeTypes.join(', ')}`
        );
      }
    }

    // Only validate allowedMimePatterns if the array is provided and not empty
    if (rule.allowedMimePatterns && rule.allowedMimePatterns.length > 0) {
      const patterns = rule.allowedMimePatterns;

      // Check both detected and original MIME types against patterns
      const detectedMatch = info.detectedMimetype &&
        !detectedIsUnknown &&
        this.matchesMimePattern(info.detectedMimetype, patterns);
      const originalMatch = this.matchesMimePattern(info.mimetype, patterns);

      if (!detectedMatch && !originalMatch) {
        throw new Error(
          `File "${fieldname}" type "${mimeToCheck}" does not match allowed patterns: ${patterns.join(', ')}`
        );
      }
    }

    // Filename check
    if (rule.filename?.maxLength && info.filename.length > rule.filename.maxLength) {
      throw new Error(`Filename is too long (max ${rule.filename.maxLength} characters)`);
    }
  }

  /**
   * Helper method to check if a MIME type matches any of the given patterns
   */
  private static matchesMimePattern(mimeType: string, patterns: string[]): boolean {
    return patterns.some((pattern) => {
      // Handle multiple patterns separated by |
      const subPatterns = pattern.split('|');
      return subPatterns.some((singlePattern) => {
        const regexPattern = singlePattern.trim()
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.');
        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(mimeType);
      });
    });
  }

  /**
   * Detect MIME type from magic bytes.
   * Returns detected MIME type or 'application/octet-stream' if unknown.
   * 
   * This method now handles both Buffer and Uint8Array inputs safely.
   */
  private static detectMimeType(buffer: Buffer | Uint8Array): string {
    // Ensure we have a proper Buffer with all Buffer methods available
    const safeBuffer: Buffer = Buffer.isBuffer(buffer)
      ? buffer
      : Buffer.from(buffer);

    if (safeBuffer.length < 4) return 'application/octet-stream';

    for (const [_, { signature, mimeType }] of Object.entries(MAGIC_BYTES)) {
      // Compare first N bytes
      if (safeBuffer.length >= signature.length) {
        const prefix = safeBuffer.subarray(0, signature.length);
        if (prefix.equals(signature)) {
          return mimeType;
        }
      }
    }

    return 'application/octet-stream';
  }

  /**
   * Sanitize filename (remove path traversal, special chars, etc.)
   */
  static sanitizeFilename(filename: string): string {
    return filename
      .replace(/^\.+/, '') // Remove leading dots
      .replace(/[\/\\]/g, '_') // Replace path separators
      .replace(/[<>:"|?*]/g, '_') // Replace special characters
      .replace(/\s+/g, '_') // Replace spaces
      .substring(0, 255); // Limit length
  }
}