import { Readable } from 'stream';
import mongoose, { Model, Schema } from 'mongoose';
import { Context as Context$2 } from 'hono';

/**
 * @upload-media/server - Hook System Types
 *
 * Hooks are before/after middleware for database and storage operations.
 * Users can intercept any operation to add caching, logging, validation, transformation.
 */

interface HookContext {
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
interface DatabaseHooks {
    beforeCreateFile?: (file: any, ctx: HookContext) => Promise<FileRecord | null>;
    afterCreateFile?: (file: FileRecord, ctx: HookContext) => Promise<FileRecord>;
    beforeGetFileById?: (id: string, ctx: HookContext) => Promise<FileRecord | null>;
    afterGetFileById?: (file: FileRecord | null, ctx: HookContext) => Promise<FileRecord | null>;
    beforeGetFileBySessionId?: (sessionId: string, ctx: HookContext) => Promise<FileRecord | null>;
    afterGetFileBySessionId?: (file: FileRecord | null, ctx: HookContext) => Promise<FileRecord | null>;
    beforeUpdateFile?: (id: string, patch: FileRecordPatch, ctx: HookContext) => Promise<FileRecord | null>;
    afterUpdateFile?: (file: FileRecord | null, ctx: HookContext) => Promise<FileRecord | null>;
    beforeFindFiles?: (query: FileQuery, ctx: HookContext) => Promise<FileRecord[] | null>;
    afterFindFiles?: (results: FileRecord[], ctx: HookContext) => Promise<FileRecord[]>;
    beforeDeleteFiles?: (ids: string[], ctx: HookContext) => Promise<number | null>;
    afterDeleteFiles?: (count: number, ctx: HookContext) => Promise<number>;
    beforeCreateChunk?: (chunk: ChunkRecord, ctx: HookContext) => Promise<ChunkRecord>;
    afterCreateChunk?: (chunk: ChunkRecord, ctx: HookContext) => Promise<void>;
    beforeGetChunk?: (fileId: string, chunkNumber: number, ctx: HookContext) => Promise<Buffer | null>;
    afterGetChunk?: (data: Buffer | null, ctx: HookContext) => Promise<Buffer | null>;
    beforeDeleteChunksByFileId?: (fileId: string, ctx: HookContext) => Promise<number | null>;
    afterDeleteChunksByFileId?: (count: number, ctx: HookContext) => Promise<number>;
}
/**
 * Storage operation hooks.
 * - `before*` can return a value to short-circuit
 * - `after*` can transform the result
 */
interface StorageHooks {
    beforeWriteChunk?: (fileId: string, chunkNumber: number, data: Buffer, ctx: HookContext) => Promise<Buffer>;
    afterWriteChunk?: (fileId: string, chunkNumber: number, ctx: HookContext) => Promise<void>;
    beforeFinalize?: (fileId: string, ctx: HookContext) => Promise<boolean>;
    afterFinalize?: (result: any, ctx: HookContext) => Promise<any>;
    beforeReadStream?: (ref: string, options: any, ctx: HookContext) => Promise<any | null>;
    afterReadStream?: (stream: any, ctx: HookContext) => Promise<any>;
    beforeDelete?: (ref: string, ctx: HookContext) => Promise<boolean>;
    afterDelete?: (ctx: HookContext) => Promise<void>;
}
/**
 * Parser operation hooks.
 * Let users intercept multipart parsing for validation, transformation, etc.
 */
interface ParserHooks {
    beforeParseStart?: (contentType: string, ctx: HookContext) => Promise<void>;
    onFieldParsed?: (name: string, value: string, ctx: HookContext) => Promise<string>;
    onFileParsed?: (fieldname: string, filename: string, mimetype: string, size: number, ctx: HookContext) => Promise<void>;
    afterParseComplete?: (fieldCount: number, fileCount: number, ctx: HookContext) => Promise<void>;
    onParseError?: (error: Error, ctx: HookContext) => Promise<void>;
}
/**
 * Composite hooks object — databases, storage, parser all in one place.
 */
interface UploadHooks {
    database?: DatabaseHooks;
    storage?: StorageHooks;
    parser?: ParserHooks;
}

type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'unknown';
type Quality = 'high' | 'medium' | 'low';
interface SizeLimitMap {
    image?: number;
    video?: number;
    audio?: number;
    document?: number;
    default?: number;
}
interface UploadTypeConfig {
    name: string;
    allowedKinds: MediaKind[];
    limits: SizeLimitMap;
    chunkLimits?: SizeLimitMap;
    storage?: string;
    bucket?: string;
    thumbnails?: boolean;
    quality?: Quality;
    defaultMetadata?: Record<string, any>;
    autoRespond?: boolean;
}
interface FileRecord {
    id: string;
    sessionId: string;
    originalName: string;
    storedName: string;
    fieldname: string;
    contentType: string;
    kind: MediaKind;
    size: number;
    chunkSize: number;
    chunkCount: number;
    uploadType: string;
    bucket: string;
    storageProvider: string;
    storageRef: string;
    url?: string;
    thumbnailUrl?: string;
    thumbnailRef?: string;
    userId?: string | null;
    isComplete: boolean;
    metadata?: Record<string, any>;
    createdAt: number;
    updatedAt: number;
}
type NewFileRecord = Omit<FileRecord, 'id' | 'createdAt' | 'updatedAt'> & {
    id?: string;
};
type FileRecordPatch = Partial<Omit<FileRecord, 'id'>>;
interface ChunkRecord {
    fileId: string;
    chunkNumber: number;
    data: Buffer;
}
interface FileQuery {
    sessionId?: string;
    sessionIds?: string[];
    ids?: string[];
    uploadType?: string;
    userId?: string;
    isComplete?: boolean;
    limit?: number;
    skip?: number;
}
interface MetadataRepository {
    createFile(file: NewFileRecord): Promise<FileRecord>;
    getFileBySessionId(sessionId: string): Promise<FileRecord | null>;
    getFileById(id: string): Promise<FileRecord | null>;
    updateFile(id: string, patch: FileRecordPatch): Promise<FileRecord | null>;
    findFiles(query: FileQuery): Promise<FileRecord[]>;
    deleteFiles(ids: string[]): Promise<number>;
    createChunk(chunk: ChunkRecord): Promise<void>;
    getChunk(fileId: string, chunkNumber: number): Promise<Buffer | null>;
    deleteChunksByFileId(fileId: string): Promise<number>;
}
interface StorageWriteResult {
    storageRef: string;
    url?: string;
}
interface StorageReadOptions {
    start?: number;
    end?: number;
}
interface StorageContext {
    originalName: string;
    contentType: string;
    bucket: string;
    totalSize: number;
    chunkSize: number;
    chunkCount: number;
    uploadType: string;
}
interface StorageAdapter {
    readonly name: string;
    writeChunk(fileId: string, chunkNumber: number, data: Buffer, ctx: StorageContext): Promise<void>;
    finalize(fileId: string, ctx: StorageContext): Promise<StorageWriteResult>;
    readStream(ref: string, options?: StorageReadOptions): Promise<Readable>;
    delete(ref: string): Promise<void>;
    putObject?(fileId: string, data: Buffer, ctx: StorageContext): Promise<StorageWriteResult>;
}
interface CacheAdapter {
    readonly name: string;
    get<T = any>(key: string): Promise<T | null>;
    set<T = any>(key: string, value: T, ttlSeconds?: number): Promise<void>;
    del(key: string | string[]): Promise<void>;
    has(key: string): Promise<boolean>;
    invalidatePrefix(prefix: string): Promise<void>;
    clear(): Promise<void>;
}
interface NormalizedRequest {
    headers: Record<string, string | string[] | undefined>;
    stream: Readable;
    query: Record<string, any>;
    params: Record<string, any>;
    user?: any;
    raw: any;
    fields?: Record<string, any>;
    files?: any[];
    fileFields?: Record<string, any>;
    transformer?: any;
}
interface NormalizedResponse {
    status(code: number): NormalizedResponse;
    json(body: any): void;
    header(name: string, value: string): NormalizedResponse;
    pipeFrom(stream: Readable): Promise<void>;
    end(): void;
    raw: any;
}
interface HandlerResult {
    [key: string]: any;
    onBackground?: () => void | Promise<void>;
}
type UploadHandler = (req: NormalizedRequest, res: NormalizedResponse) => Promise<HandlerResult | any>;
interface FrameworkAdapter<THandler = any> {
    readonly name: string;
    wrap(handler: UploadHandler): THandler;
}
interface ThumbnailGenerator {
    generate(file: FileRecord, source: Readable | Buffer): Promise<Buffer | null>;
}
interface UploadEngineConfig {
    storages: Record<string, StorageAdapter>;
    defaultStorage: string;
    defaultUploadType?: string;
    database: MetadataRepository;
    cache?: CacheAdapter;
    cacheTtlSeconds?: number;
    uploadTypes: Record<string, UploadTypeConfig>;
    globalLimits?: SizeLimitMap;
    globalChunkLimits?: SizeLimitMap;
    thumbnailGenerator?: ThumbnailGenerator;
    onUploadComplete?: (file: FileRecord) => void | Promise<void>;
    onError?: (error: Error, context: {
        uploadType?: string;
        sessionId?: string;
    }) => void;
    staleUploadRetentionMs?: number;
    maxFieldSize?: number;
    maxFiles?: number;
    maxTotalSize?: number;
    onProgress?: (progress: any) => void;
    autoRespond?: boolean;
}
interface ResolvedUploadEngineConfig extends Required<Pick<UploadEngineConfig, 'storages' | 'defaultStorage' | 'database' | 'uploadTypes'>> {
    cache?: CacheAdapter;
    cacheTtlSeconds: number;
    globalLimits: SizeLimitMap;
    globalChunkLimits: SizeLimitMap;
    thumbnailGenerator?: ThumbnailGenerator;
    onUploadComplete?: (file: FileRecord) => void | Promise<void>;
    onError?: (error: Error, context: {
        uploadType?: string;
        sessionId?: string;
    }) => void;
    staleUploadRetentionMs: number;
    defaultUploadType?: string;
    maxFieldSize: number;
    maxFiles: number;
    maxTotalSize: number;
    onProgress?: (progress: any) => void;
    autoRespond: boolean;
    hooks?: UploadHooks;
}
interface IncomingChunkFields {
    sessionId: string;
    chunkIndex: number;
    totalChunks: number;
    filename: string;
    mimetype: string;
    chunksize: number;
    totalSize: number;
    fieldname: string;
    isLastChunk: boolean;
    fileCount: number;
    currentFileNumber: number;
    allFilesSessionId: string[];
    postData?: Record<string, any>;
    metadata?: Record<string, any>;
    thumbnailBase64?: string;
    uploadType: string;
    quality?: string;
    parentSessionId?: string;
}
interface UploadResultPayload {
    status: 'success' | 'chunk_received' | 'error';
    message: string;
    file?: FileRecord;
    chunkIndex?: number;
    totalChunks?: number;
}

/**
 * @upload-media/server - Constants & Defaults
 */
declare const DEFAULT_CHUNK_SIZES: {
    readonly video: number;
    readonly audio: number;
    readonly image: number;
    readonly document: number;
    readonly default: number;
};
declare const QUALITY_MAPPINGS: {
    readonly video: {
        readonly high: {
            readonly scale: "1920:1080";
            readonly bitrate: "4M";
            readonly crf: 21;
        };
        readonly medium: {
            readonly scale: "1280:720";
            readonly bitrate: "2.5M";
            readonly crf: 23;
        };
        readonly low: {
            readonly scale: "800:480";
            readonly bitrate: "1M";
            readonly crf: 28;
        };
    };
    readonly image: {
        readonly high: {
            readonly quality: 90;
            readonly maxWidth: 1920;
        };
        readonly medium: {
            readonly quality: 70;
            readonly maxWidth: 1280;
        };
        readonly low: {
            readonly quality: 50;
            readonly maxWidth: 800;
        };
    };
    readonly audio: {
        readonly high: {
            readonly bitrate: "320k";
        };
        readonly medium: {
            readonly bitrate: "128k";
        };
        readonly low: {
            readonly bitrate: "64k";
        };
    };
};
declare const DEFAULT_SIZE_LIMITS: {
    readonly video: number;
    readonly audio: number;
    readonly image: number;
    readonly document: number;
    readonly default: number;
};
declare const THUMBNAIL_CHUNK_SIZE: number;
declare const THUMBNAIL_SIZE_LIMIT: number;
declare const THUMBNAIL_DIMENSIONS: {
    width: number;
    height: number;
};
declare const SUPPORTED_MIME_TYPES: {
    readonly image: readonly ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/avif", "image/bmp", "image/tiff"];
    readonly video: readonly ["video/mp4", "video/webm", "video/quicktime", "video/x-msvideo", "video/x-matroska", "video/x-flv", "video/x-m4v"];
    readonly audio: readonly ["audio/mpeg", "audio/wav", "audio/ogg", "audio/webm", "audio/aac", "audio/opus", "audio/flac"];
    readonly document: readonly ["application/pdf", "text/plain", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/html", "application/zip", "application/json"];
};
declare const DEFAULT_QUALITY = "medium";
declare const DEFAULT_CACHE_TTL_SECONDS = 300;
declare const DEFAULT_STALE_UPLOAD_RETENTION_MS: number;
declare const DEFAULT_CLEANUP_BATCH_SIZE = 100;
declare const DEFAULT_CLEANUP_INTERVAL_MS: number;
declare const AUTH_CACHE_TTL_SECONDS: number;
/** Cache key prefixes — used by CachedRepository for tag-based invalidation */
declare const CACHE_PREFIXES: {
    readonly FILE_BY_ID: "file:id:";
    readonly FILE_BY_SESSION: "file:session:";
    readonly FILE_LIST: "file:list:";
};
declare function getMimeKind(contentType: string): 'image' | 'video' | 'audio' | 'document' | 'unknown';

/**
 * @upload-media/server - UploadEngine v2
 *
 * Production-grade orchestrator that:
 * ✓ Detects chunked vs non-chunked uploads properly (no assumptions)
 * ✓ Supports custom form fields (not locked to schema)
 * ✓ Works with or without database
 * ✓ Works with any storage (S3, Cloudinary, Local, Database)
 * ✓ Config-driven, not hardcoded limits
 * ✓ Full end-to-end validation
 * ✓ Proper hook integration
 */

interface UploadResult {
    status: 'success' | 'chunk_received' | 'error';
    message: string;
    fileId?: string;
    url?: string;
    storageRef?: string;
    chunkIndex?: number;
    totalChunks?: number;
    progress?: number;
    metadata?: Record<string, any>;
    fields?: Record<string, any>;
    file?: FileRecord;
    files?: FileRecord[];
    fileFields?: Record<string, FileRecord | FileRecord[]>;
    parentFile?: FileRecord;
    error?: any;
}
declare class UploadEngine {
    private config;
    constructor(config: UploadEngineConfig);
    /**
     * Main upload handler.
     * Auto-detects chunked vs non-chunked by looking at actual multipart fields.
     */
    handle: (req: NormalizedRequest, res: NormalizedResponse) => Promise<UploadResult | {
        status: "success";
        message: string;
        metadata: UploadResult[];
    } | void>;
    /**
     * Detect chunked upload by checking for required chunked fields.
     * Proper detection - no assumptions.
     */
    private isChunkedUpload;
    /**
     * Handle chunked upload from the worker.
     * FIXED: Fully adaptive to frontend chunk config changes
     */
    private handleChunkedUpload;
    /**
     * Helper method to get chunk size from storage
     */
    private getChunkSize;
    /**
     * Handle non-chunked upload (regular file).
     */
    private handleNonChunkedUpload;
    /**
     * Build field validation rules from config + custom fields.
     */
    /**
     * Cleanup utility to remove files from storage and database.
     * Useful for error handling in the calling middleware.
     */
    cleanup(files: FileRecord | FileRecord[]): Promise<void>;
    private buildFieldValidation;
    /**
     * Build file validation rules from config.
     */
    private buildFileValidation;
    /**
     * Extract custom fields (non-standard) from parsed fields.
     */
    private extractCustomFields;
    private handleError;
    private getContentType;
    private getUploadType;
    private sanitizeFilename;
    private generateFileId;
    private generateSessionId;
}

/**
 * @upload-media/server - FileValidator
 *
 * Pure, side-effect-free validation helpers. Kept separate from the
 * engine so they're trivially unit-testable and reusable from custom
 * framework adapters or scripts.
 */

declare class ValidationError extends Error {
    readonly statusCode: number;
    constructor(message: string, statusCode?: number);
}
declare function detectKind(contentType: string): MediaKind;
declare function assertKindAllowed(kind: MediaKind, uploadType: UploadTypeConfig): void;
declare function assertWithinLimit(size: number, limit: number, label: string): void;
declare function assertRequiredFields(fields: Record<string, any>, required: string[]): void;
declare function parseIntSafe(value: any, fallback?: number): number;
declare function parseJsonSafe<T = any>(value: any, fallback: T): T;
declare function parseBooleanFlag(value: any): boolean;

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

interface FieldValidationRule {
    required?: boolean;
    minLength?: number;
    maxLength?: number;
    pattern?: RegExp;
    allowedValues?: string[];
    isJson?: boolean;
}
interface FileValidationRule {
    allowedMimeTypes?: string[];
    allowedMimePatterns?: string[];
    maxSize?: number;
    detectMagicBytes?: boolean;
    detectCodec?: boolean;
    filename?: {
        maxLength?: number;
        sanitize?: boolean;
    };
}
interface ParseOptions {
    maxFieldSize?: number;
    maxFileSize?: number;
    maxFiles?: number;
    maxTotalSize?: number;
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
    hooks?: ParserHooks;
}
interface FileInfo {
    fieldname: string;
    filename: string;
    mimetype: string;
    size: number;
    encoding?: string;
    detectedMimetype?: string;
}
interface ParsedFile {
    fieldname: string;
    filename: string;
    mimetype: string;
    detectedMimetype?: string;
    buffer: Buffer;
    size: number;
}
interface ParsedMultipart {
    fields: Record<string, any>;
    files: ParsedFile[];
}
declare class MultipartParser {
    /**
     * Parse buffered multipart body (for chunked uploads).
     * Loads entire body into memory before parsing.
     */
    static parseBuffered(req: NormalizedRequest, options?: ParseOptions): Promise<ParsedMultipart>;
    /**
     * Stream mode: don't buffer files, pass streams directly to handler.
     * Ideal for large non-chunked uploads.
     */
    static parseStreaming(req: NormalizedRequest, handlers: {
        onField?: (name: string, value: any) => void | Promise<void>;
        onFile: (info: FileInfo, stream: Readable) => void | Promise<void>;
    }, options?: ParseOptions): Promise<void>;
    private static loadBusboy;
    private static validateField;
    private static validateFile;
    /**
     * Detect MIME type from magic bytes.
     * Returns detected MIME type or 'application/octet-stream' if unknown.
     */
    private static detectMimeType;
    /**
     * Sanitize filename (remove path traversal, special chars, etc.)
     */
    static sanitizeFilename(filename: string): string;
}

/**
 * @upload-media/server - Configuration Resolver
 *
 * Takes the partial config a developer writes and produces a fully
 * resolved, validated configuration with every optional field filled
 * in from sane defaults. This is the only place defaults live, so
 * behavior stays predictable as the framework grows.
 */

declare class ConfigValidationError extends Error {
    constructor(message: string);
}
/**
 * Resolve a user-provided engine config into a fully-populated one.
 * Throws ConfigValidationError on structurally invalid input — this
 * is intentionally strict so misconfiguration fails at boot, not at
 * the first real upload.
 */
declare function resolveUploadConfig(config: UploadEngineConfig): ResolvedUploadEngineConfig;
/**
 * Resolve the effective total-size limit for a given upload type + media kind,
 * falling back: uploadType.limits[kind] -> uploadType.limits.default ->
 * globalLimits[kind] -> globalLimits.default.
 */
declare function resolveSizeLimit(config: ResolvedUploadEngineConfig, uploadType: UploadTypeConfig, kind: MediaKind): number;
/**
 * Resolve the effective per-chunk size limit, same fallback strategy as above
 * but sourced from chunkLimits instead of limits.
 */
declare function resolveChunkLimit(config: ResolvedUploadEngineConfig, uploadType: UploadTypeConfig, kind: MediaKind): number;
/**
 * Look up which storage adapter should be used for a given upload type.
 */
declare function resolveStorageKey(config: ResolvedUploadEngineConfig, uploadType: UploadTypeConfig): string;

/**
 * @upload-media/server - InMemoryRepository
 *
 * A simple in-memory implementation of MetadataRepository, perfect for
 * testing, local development, or small deployments without a database.
 * Data is lost when the process exits.
 */

declare class InMemoryRepository implements MetadataRepository {
    private files;
    private chunks;
    createFile(file: NewFileRecord): Promise<FileRecord>;
    getFileBySessionId(sessionId: string): Promise<FileRecord | null>;
    getFileById(id: string): Promise<FileRecord | null>;
    updateFile(id: string, patch: FileRecordPatch): Promise<FileRecord | null>;
    findFiles(query: FileQuery): Promise<FileRecord[]>;
    deleteFiles(ids: string[]): Promise<number>;
    createChunk(chunk: ChunkRecord): Promise<void>;
    getChunk(fileId: string, chunkNumber: number): Promise<Buffer | null>;
    deleteChunksByFileId(fileId: string): Promise<number>;
    /**
     * Utility for testing: clear all data.
     */
    clear(): void;
    /**
     * Utility for testing: get all files.
     */
    getAllFiles(): FileRecord[];
}

/**
 * @upload-media/server - MongooseRepository
 *
 * Implements MetadataRepository using Mongoose + MongoDB.
 * Handles both file records and chunks (if using DatabaseStorageAdapter).
 * Supports hooks for caching, logging, validation, transformation.
 */

interface MongooseRepositoryOptions {
    mongooseConnection: mongoose.Connection;
    /** Custom model for files. Use this to provide a model wrapped by @mongoose-performance-cache */
    fileModel?: Model<any>;
    /** Custom model for chunks */
    chunkModel?: Model<any>;
    /** Extensions for the default file schema */
    fileSchemaExtensions?: any;
    /** Callback to modify the schema before model creation */
    onFileSchemaInit?: (schema: Schema) => void;
    /** Callback to wrap the model (e.g. with @mongoose-performance-cache) */
    wrapFileModel?: (model: Model<any>) => Model<any>;
    /** Callback to modify the chunk schema */
    onChunkSchemaInit?: (schema: Schema) => void;
    /** Callback to wrap the chunk model */
    wrapChunkModel?: (model: Model<any>) => Model<any>;
    /** Database operation hooks */
    hooks?: DatabaseHooks;
}
declare class MongooseRepository implements MetadataRepository {
    private fileModel;
    private chunkModel;
    private hooks?;
    constructor(options: MongooseRepositoryOptions);
    private static getOrCreateFileModel;
    private static getOrCreateChunkModel;
    private createHookContext;
    createFile(file: NewFileRecord): Promise<FileRecord>;
    getFileBySessionId(sessionId: string): Promise<FileRecord | null>;
    getFileById(id: string): Promise<FileRecord | null>;
    updateFile(id: string, patch: FileRecordPatch): Promise<FileRecord | null>;
    findFiles(query: FileQuery): Promise<FileRecord[]>;
    deleteFiles(ids: string[]): Promise<number>;
    createChunk(chunk: ChunkRecord): Promise<void>;
    getChunk(fileId: string, chunkNumber: number): Promise<Buffer | null>;
    deleteChunksByFileId(fileId: string): Promise<number>;
    private docToRecord;
}

interface SQLExecutor {
    /**
     * Execute a parameterized query and return rows.
     * Placeholders are $1, $2, etc. (Postgres style) — the executor handles dialect conversion if needed.
     */
    query(sql: string, params: any[]): Promise<any[]>;
    /**
     * Execute a query that might not return rows (INSERT, UPDATE, DELETE).
     * Should return { affectedRows: number } or similar.
     */
    execute(sql: string, params: any[]): Promise<{
        affectedRows: number;
    }>;
}
interface SQLRepositoryOptions {
    executor: SQLExecutor;
    filesTable?: string;
    chunksTable?: string;
    /** If true, assume database handles 'created_at' / 'updated_at' automatically (timestamps / CURRENT_TIMESTAMP) */
    autoTimestamps?: boolean;
    /** Database operation hooks */
    hooks?: DatabaseHooks;
    /** Custom indexes to create on files table during createSchema() */
    fileIndexes?: string[][];
    /** Custom indexes to create on chunks table */
    chunkIndexes?: string[][];
}
declare class SQLRepository implements MetadataRepository {
    private executor;
    private filesTable;
    private chunksTable;
    private autoTimestamps;
    private hooks?;
    private fileIndexes;
    private chunkIndexes;
    constructor(options: SQLRepositoryOptions);
    /**
     * Helper to create tables and baseline indexes.
     * Dialect agnostic (standard SQL).
     */
    createSchema(): Promise<void>;
    private createHookContext;
    createFile(file: NewFileRecord): Promise<FileRecord>;
    getFileBySessionId(sessionId: string): Promise<FileRecord | null>;
    getFileById(id: string): Promise<FileRecord | null>;
    updateFile(id: string, patch: FileRecordPatch): Promise<FileRecord | null>;
    findFiles(query: FileQuery): Promise<FileRecord[]>;
    deleteFiles(ids: string[]): Promise<number>;
    createChunk(chunk: ChunkRecord): Promise<void>;
    getChunk(fileId: string, chunkNumber: number): Promise<Buffer | null>;
    deleteChunksByFileId(fileId: string): Promise<number>;
    private rowToRecord;
}

interface LocalDiskStorageOptions {
    rootDir: string;
    publicBaseUrl?: string;
}
declare class LocalDiskStorageAdapter implements StorageAdapter {
    readonly name = "local-disk";
    private rootDir;
    private publicBaseUrl?;
    private openHandles;
    constructor(options: LocalDiskStorageOptions);
    private ensureDir;
    private partPath;
    private finalPath;
    writeChunk(fileId: string, chunkNumber: number, data: Buffer, ctx: StorageContext): Promise<void>;
    finalize(fileId: string, ctx: StorageContext): Promise<StorageWriteResult>;
    putObject(fileId: string, data: Buffer, ctx: StorageContext): Promise<StorageWriteResult>;
    readStream(ref: string, options?: StorageReadOptions): Promise<Readable>;
    delete(ref: string): Promise<void>;
}

/**
 * @upload-media/server - DatabaseStorageAdapter
 *
 * Stores chunk bytes directly in whichever database the developer has
 * already wired up via a MetadataRepository (Mongo, Postgres, MySQL,
 * SQLite...). This is the "no extra infra" option — good for small
 * apps or self-hosted setups where adding S3/Cloudinary is overkill.
 * Requires the repository to implement createChunk/getChunk/
 * deleteChunksByFileId (MongooseRepository, SQLRepository, and
 * InMemoryRepository all do).
 */

interface DatabaseStorageOptions {
    database: MetadataRepository;
    /** How many chunks to prefetch ahead while streaming reads (default 2) */
    prefetchCount?: number;
}
declare class DatabaseStorageAdapter implements StorageAdapter {
    readonly name = "database";
    private database;
    private prefetchCount;
    constructor(options: DatabaseStorageOptions);
    writeChunk(fileId: string, chunkNumber: number, data: Buffer): Promise<void>;
    finalize(fileId: string): Promise<StorageWriteResult>;
    putObject(fileId: string, data: Buffer, ctx: StorageContext): Promise<StorageWriteResult>;
    readStream(ref: string, options?: StorageReadOptions): Promise<Readable>;
    delete(ref: string): Promise<void>;
}

/**
 * @upload-media/server - S3StorageAdapter
 *
 * Uses S3's *real* multipart upload API (CreateMultipartUpload /
 * UploadPart / CompleteMultipartUpload) so chunks stream straight to
 * S3 instead of being assembled somewhere in between. Works against
 * AWS S3 or any S3-compatible provider (Cloudflare R2, MinIO,
 * DigitalOcean Spaces, Backblaze B2) via `endpoint` + `forcePathStyle`.
 *
 * S3 requires every part except the last to be >= 5MB. Client chunk
 * sizes are usually smaller than that (1-2MB), so this adapter buffers
 * incoming chunks internally and only calls UploadPart once the buffer
 * crosses the configured minimum — the client-side chunk size and the
 * S3 part size are therefore fully decoupled, and this "just works"
 * regardless of how the frontend is configured.
 */

interface S3StorageOptions {
    bucket: string;
    region: string;
    credentials?: {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
    };
    endpoint?: string;
    forcePathStyle?: boolean;
    /** Public URL builder, defaults to the AWS virtual-hosted-style URL */
    buildPublicUrl?: (bucket: string, key: string) => string;
    /** Override how a logical bucket/fileId becomes an S3 key */
    buildKey?: (fileId: string, ctx: StorageContext) => string;
    /** Minimum bytes to buffer before flushing an UploadPart (default 5MB, the S3 minimum) */
    minPartSize?: number;
    /** Pass an already-constructed S3Client instead of letting the adapter build one */
    client?: any;
}
declare class S3StorageAdapter implements StorageAdapter {
    readonly name = "s3";
    private options;
    private client;
    private uploads;
    constructor(options: S3StorageOptions);
    private minPartSize;
    private getClient;
    private buildKey;
    private buildPublicUrl;
    writeChunk(fileId: string, chunkNumber: number, data: Buffer, ctx: StorageContext): Promise<void>;
    private flushPart;
    private loadCommands;
    finalize(fileId: string, ctx: StorageContext): Promise<StorageWriteResult>;
    putObject(fileId: string, data: Buffer, ctx: StorageContext): Promise<StorageWriteResult>;
    readStream(ref: string, options?: StorageReadOptions): Promise<Readable>;
    delete(ref: string): Promise<void>;
}

/**
 * @upload-media/server - CloudinaryStorageAdapter
 *
 * Built on the official `cloudinary` SDK's `upload_large_stream`, which
 * implements Cloudinary's chunked-upload wire protocol correctly
 * (including retry semantics) — we don't reimplement that protocol by
 * hand. Each engine chunk is written into the stream as it arrives;
 * Cloudinary handles assembly server-side. `finalize()` closes the
 * stream and resolves once Cloudinary confirms the asset is ready.
 */

interface CloudinaryStorageOptions {
    cloudName: string;
    apiKey: string;
    apiSecret: string;
    /** Folder prefix for all uploads, e.g. "myapp/uploads" */
    folder?: string;
    /** Override how a fileId maps to a Cloudinary public_id */
    buildPublicId?: (fileId: string, ctx: StorageContext) => string;
    /** Pass an already-configured cloudinary instance (v1 or v2 API) instead */
    cloudinary?: any;
}
declare class CloudinaryStorageAdapter implements StorageAdapter {
    readonly name = "cloudinary";
    private options;
    private cloudinary;
    private pending;
    constructor(options: CloudinaryStorageOptions);
    private getSdk;
    private resourceTypeFor;
    private buildPublicId;
    private getOrCreateUpload;
    writeChunk(fileId: string, chunkNumber: number, data: Buffer, ctx: StorageContext): Promise<void>;
    finalize(fileId: string): Promise<StorageWriteResult>;
    putObject(fileId: string, data: Buffer, ctx: StorageContext): Promise<StorageWriteResult>;
    readStream(ref: string): Promise<Readable>;
    delete(ref: string): Promise<void>;
}

/**
 * @upload-media/server - ExpressAdapter
 *
 * Wraps a framework-agnostic UploadHandler into an Express middleware.
 * Converts Express req/res to NormalizedRequest/NormalizedResponse.
 */
type Request = any;
type Response$1 = any;

declare const createExpressAdapter: () => FrameworkAdapter;
declare function createExpressFileServingMiddleware(config: string | {
    rootDir?: string;
    cacheMaxAge?: string;
    pathPrefix?: string;
    database?: MetadataRepository;
}, legacyOptions?: {
    cacheMaxAge?: string;
    pathPrefix?: string;
    database?: MetadataRepository;
}): (req: Request, res: Response$1, next: Function) => any;

/**
 * @upload-media/server - KoaAdapter
 *
 * Wraps a framework-agnostic UploadHandler into a Koa middleware.
 */
type Context$1 = any;
type Next = any;

declare const createKoaAdapter: () => FrameworkAdapter;
declare function createKoaFileServingMiddleware(config: string | {
    rootDir?: string;
    cacheMaxAge?: string;
    pathPrefix?: string;
    database?: MetadataRepository;
}, legacyOptions?: {
    cacheMaxAge?: string;
    pathPrefix?: string;
    database?: MetadataRepository;
}): (ctx: Context$1, next: Next) => Promise<any>;

/**
 * @upload-media/server - FastifyAdapter
 *
 * Wraps a framework-agnostic UploadHandler into a Fastify route handler.
 */
type FastifyInstance = any;

declare const createFastifyAdapter: () => FrameworkAdapter;
declare function createFastifyFileServingPlugin(config: string | {
    rootDir?: string;
    cacheMaxAge?: string;
    pathPrefix?: string;
    database?: MetadataRepository;
}, legacyOptions?: {
    cacheMaxAge?: string;
    pathPrefix?: string;
    database?: MetadataRepository;
}): (fastify: FastifyInstance) => Promise<void>;

/**
 * @upload-media/server - HonoAdapter
 *
 * Wraps a framework-agnostic UploadHandler into a Hono middleware/handler.
 */

declare const createHonoAdapter: () => FrameworkAdapter;
declare function createHonoFileServingMiddleware(config: string | {
    rootDir?: string;
    cacheMaxAge?: string;
    pathPrefix?: string;
    database?: MetadataRepository;
}, legacyOptions?: {
    cacheMaxAge?: string;
    pathPrefix?: string;
    database?: MetadataRepository;
}): (ctx: Context$2, next: Function) => Promise<any>;

/**
 * @upload-media/server - H3Adapter
 *
 * Wraps a framework-agnostic UploadHandler into an H3 event handler.
 * Works with Nuxt, Nitro, and other H3-based frameworks.
 */

/**
 * Minimal H3-compatible event type.
 * We intentionally avoid importing from `h3`
 * so consumers are not forced to install it.
 */
interface H3EventLike {
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
declare const createH3Adapter: () => FrameworkAdapter;
declare class CreateH3FileServingHandler {
    private rootDir;
    private database?;
    private cacheMaxAge;
    constructor(rootDir: string, database?: MetadataRepository | undefined, cacheMaxAge?: string);
    serveFile(ref: string, event: H3EventLike): Promise<Buffer>;
    private extractFileId;
    private getCacheSeconds;
}

/**
 * @upload-media/server - ElysiaAdapter
 *
 * Framework-agnostic UploadHandler adapter for Elysia
 */
type Context = any;

/**
 * ----------------------------
 * Elysia Adapter
 * ----------------------------
 */
declare const createElysiaAdapter: () => FrameworkAdapter;
declare function createElysiaFileServingHandler(config: string | {
    rootDir?: string;
    cacheMaxAge?: string;
    pathPrefix?: string;
    database?: MetadataRepository;
}, legacyOptions?: {
    cacheMaxAge?: string;
    pathPrefix?: string;
    database?: MetadataRepository;
}): (ctx: Context) => Promise<Response | undefined>;

/**
 * @upload-media/server - NextjsAdapter
 *
 * Framework-agnostic UploadHandler wrapper for Next.js (App Router + Pages Router)
 */

declare const createNextjsAdapter: () => FrameworkAdapter;
declare class CreateNextjsFileServingHandler {
    private config;
    constructor(config: string | {
        rootDir?: string;
        cacheMaxAge?: string;
        database?: MetadataRepository;
    });
    serveFile(ref: string): Promise<Response>;
}

/**
 * @upload-media/server - Hook Examples
 *
 * Reusable hook implementations for common patterns:
 * - Redis caching
 * - Logging
 * - File cleanup
 * - Custom validation
 */

/**
 * Redis cache hooks - check cache before querying, cache results after querying.
 * Works with any Redis client (ioredis, redis, node-redis).
 */
declare function createRedisCacheHooks(redis: any): DatabaseHooks;
/**
 * Logging hooks - log all database operations for debugging/auditing.
 */
declare function createLoggingHooks(logger?: any): DatabaseHooks;
/**
 * Storage hooks for logging/metrics.
 */
declare function createStorageLoggingHooks(logger?: any): StorageHooks;
/**
 * Validation hooks - enforce additional rules on file records.
 */
declare function createValidationHooks(): DatabaseHooks;
/**
 * Cleanup hooks - auto-delete old/incomplete uploads after configured period.
 */
declare function createAutoCleanupHooks(maxAgeMs?: number): DatabaseHooks;
/**
 * Metrics hooks - count operations for monitoring.
 */
declare function createMetricsHooks(metrics: any): DatabaseHooks;
/**
 * Custom transformation hook - add computed fields to files.
 */
declare function createTransformationHooks(): DatabaseHooks;
/**
 * Chain multiple hooks together.
 * This patterns allows composing behaviors: e.g. [Logging, Caching, Validation]
 */
declare function chainHooks(...hooks: (DatabaseHooks | undefined)[]): DatabaseHooks;

/**
 * @upload-media/server - Encryption Utilities
 *
 * Decrypts the query strings encrypted by the frontend.
 * Works with both Node.js (crypto module) and Bun (bun:crypto or crypto APIs).
 *
 * Expected format: base64url(iv | tag | ciphertext)
 */
/**
 * Decrypt an AES-256-GCM encrypted query string.
 * Mirrors frontend encryption exactly: iv (12 bytes) | tag (16 bytes) | ciphertext.
 */
declare function decryptQueryString(token: string): string;
/**
 * Hash a string using SHA-256.
 */
declare function hashString(input: string): string;
/**
 * Generate a random hex string of specified byte length.
 */
declare function generateRandomString(byteLength?: number): string;
/**
 * Sign data using HMAC-SHA256.
 */
declare function signData(data: string, secret: string): string;
/**
 * Verify a signature created by signData.
 */
declare function verifySignature(data: string, secret: string, signature: string): boolean;

export { AUTH_CACHE_TTL_SECONDS, CACHE_PREFIXES, type CacheAdapter, type ChunkRecord, CloudinaryStorageAdapter, type CloudinaryStorageOptions, ConfigValidationError, CreateH3FileServingHandler, CreateNextjsFileServingHandler, DEFAULT_CACHE_TTL_SECONDS, DEFAULT_CHUNK_SIZES, DEFAULT_CLEANUP_BATCH_SIZE, DEFAULT_CLEANUP_INTERVAL_MS, DEFAULT_QUALITY, DEFAULT_SIZE_LIMITS, DEFAULT_STALE_UPLOAD_RETENTION_MS, type DatabaseHooks, DatabaseStorageAdapter, type DatabaseStorageOptions, type FieldValidationRule, type FileInfo, type FileQuery, type FileRecord, type FileRecordPatch, type FileValidationRule, type FrameworkAdapter, type H3EventLike, type HandlerResult, type HookContext, InMemoryRepository, type IncomingChunkFields, LocalDiskStorageAdapter, type LocalDiskStorageOptions, type MediaKind, type MetadataRepository, MongooseRepository, type MongooseRepositoryOptions, MultipartParser, type NewFileRecord, type NormalizedRequest, type NormalizedResponse, type ParseOptions, type ParsedFile, type ParsedMultipart, type ParserHooks, QUALITY_MAPPINGS, type Quality, type ResolvedUploadEngineConfig, S3StorageAdapter, type S3StorageOptions, type SQLExecutor, SQLRepository, type SQLRepositoryOptions, SUPPORTED_MIME_TYPES, type SizeLimitMap, type StorageAdapter, type StorageContext, type StorageHooks, type StorageReadOptions, type StorageWriteResult, THUMBNAIL_CHUNK_SIZE, THUMBNAIL_DIMENSIONS, THUMBNAIL_SIZE_LIMIT, type ThumbnailGenerator, UploadEngine, type UploadEngineConfig, type UploadHandler, type UploadHooks, type UploadResult, type UploadResultPayload, type UploadTypeConfig, ValidationError, assertKindAllowed, assertRequiredFields, assertWithinLimit, chainHooks, createAutoCleanupHooks, createElysiaAdapter, createElysiaFileServingHandler, createExpressAdapter, createExpressFileServingMiddleware, createFastifyAdapter, createFastifyFileServingPlugin, createH3Adapter, createHonoAdapter, createHonoFileServingMiddleware, createKoaAdapter, createKoaFileServingMiddleware, createLoggingHooks, createMetricsHooks, createNextjsAdapter, createRedisCacheHooks, createStorageLoggingHooks, createTransformationHooks, createValidationHooks, decryptQueryString, detectKind, generateRandomString, getMimeKind, hashString, parseBooleanFlag, parseIntSafe, parseJsonSafe, resolveChunkLimit, resolveSizeLimit, resolveStorageKey, resolveUploadConfig, signData, verifySignature };
