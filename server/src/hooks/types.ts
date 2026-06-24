/**
 * @upload-media/server - Hook System Types
 *
 * Hooks are before/after middleware for database and storage operations.
 * Users can intercept any operation to add caching, logging, validation, transformation.
 */

import { FileRecord, FileRecordPatch, FileQuery, ChunkRecord } from '../types';

export interface HookContext {
  /** User ID from auth context (if available) */
  userId?: string;
  /** Upload type being processed */
  uploadType?: string;
  /** Server timestamp */
  timestamp: number;
  /** Custom metadata passed through */
  metadata?: Record<string, any>;
  /** Original request data (for logging/debugging) */
  originalQuery?: any;
}

/**
 * Database operation hooks.
 * - `before*` hooks can return a result to short-circuit the actual operation
 * - `after*` hooks receive the operation result and can transform it
 */
export interface DatabaseHooks {
  // File creation
  beforeCreateFile?: (
    file: any,
    ctx: HookContext
  ) => Promise<FileRecord | null>;
  afterCreateFile?: (
    file: FileRecord,
    ctx: HookContext
  ) => Promise<FileRecord>;

  // File retrieval by ID
  beforeGetFileById?: (
    id: string,
    ctx: HookContext
  ) => Promise<FileRecord | null>;
  afterGetFileById?: (
    file: FileRecord | null,
    ctx: HookContext
  ) => Promise<FileRecord | null>;

  // File retrieval by session ID
  beforeGetFileBySessionId?: (
    sessionId: string,
    ctx: HookContext
  ) => Promise<FileRecord | null>;
  afterGetFileBySessionId?: (
    file: FileRecord | null,
    ctx: HookContext
  ) => Promise<FileRecord | null>;

  // File update
  beforeUpdateFile?: (
    id: string,
    patch: FileRecordPatch,
    ctx: HookContext
  ) => Promise<FileRecord | null>;
  afterUpdateFile?: (
    file: FileRecord | null,
    ctx: HookContext
  ) => Promise<FileRecord | null>;

  // File query
  beforeFindFiles?: (
    query: FileQuery,
    ctx: HookContext
  ) => Promise<FileRecord[] | null>;
  afterFindFiles?: (
    results: FileRecord[],
    ctx: HookContext
  ) => Promise<FileRecord[]>;

  // File deletion
  beforeDeleteFiles?: (
    ids: string[],
    ctx: HookContext
  ) => Promise<number | null>;
  afterDeleteFiles?: (
    count: number,
    ctx: HookContext
  ) => Promise<number>;

  // Chunk operations
  beforeCreateChunk?: (
    chunk: ChunkRecord,
    ctx: HookContext
  ) => Promise<ChunkRecord>;
  afterCreateChunk?: (
    chunk: ChunkRecord,
    ctx: HookContext
  ) => Promise<void>;

  beforeGetChunk?: (
    fileId: string,
    chunkNumber: number,
    ctx: HookContext
  ) => Promise<Buffer | null>;
  afterGetChunk?: (
    data: Buffer | null,
    ctx: HookContext
  ) => Promise<Buffer | null>;

  beforeDeleteChunksByFileId?: (
    fileId: string,
    ctx: HookContext
  ) => Promise<number | null>;
  afterDeleteChunksByFileId?: (
    count: number,
    ctx: HookContext
  ) => Promise<number>;
}

/**
 * Storage operation hooks.
 * - `before*` can return a value to short-circuit
 * - `after*` can transform the result
 */
export interface StorageHooks {
  beforeWriteChunk?: (
    fileId: string,
    chunkNumber: number,
    data: Buffer,
    ctx: HookContext
  ) => Promise<Buffer>;
  afterWriteChunk?: (
    fileId: string,
    chunkNumber: number,
    ctx: HookContext
  ) => Promise<void>;

  beforeFinalize?: (
    fileId: string,
    ctx: HookContext
  ) => Promise<boolean>; // false to skip finalization

  afterFinalize?: (
    result: any,
    ctx: HookContext
  ) => Promise<any>;

  beforeReadStream?: (
    ref: string,
    options: any,
    ctx: HookContext
  ) => Promise<any | null>;

  afterReadStream?: (
    stream: any,
    ctx: HookContext
  ) => Promise<any>;

  beforeDelete?: (
    ref: string,
    ctx: HookContext
  ) => Promise<boolean>; // false to skip deletion

  afterDelete?: (
    ctx: HookContext
  ) => Promise<void>;
}

/**
 * Parser operation hooks.
 * Let users intercept multipart parsing for validation, transformation, etc.
 */
export interface ParserHooks {
  beforeParseStart?: (
    contentType: string,
    ctx: HookContext
  ) => Promise<void>;

  onFieldParsed?: (
    name: string,
    value: string,
    ctx: HookContext
  ) => Promise<string>;

  onFileParsed?: (
    fieldname: string,
    filename: string,
    mimetype: string,
    size: number,
    ctx: HookContext
  ) => Promise<void>;

  afterParseComplete?: (
    fieldCount: number,
    fileCount: number,
    ctx: HookContext
  ) => Promise<void>;

  onParseError?: (
    error: Error,
    ctx: HookContext
  ) => Promise<void>;
}

/**
 * Composite hooks object — databases, storage, parser all in one place.
 */
export interface UploadHooks {
  database?: DatabaseHooks;
  storage?: StorageHooks;
  parser?: ParserHooks;
}
