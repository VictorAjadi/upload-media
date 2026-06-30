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
type ResolutionLabel = '2160p' | '4k' | '1440p' | '2k' | '1080p' | '720p' | '540p' | '480p' | '360p' | '240p' | '144p';
type Quality = 'high' | 'medium' | 'low' | number;
interface QualityConfig {
    id: string;
    label: string;
    quality?: Quality;
    resolution?: string;
    videoBitrate?: string;
    audioBitrate?: string;
    width?: number;
    height?: number;
    codec?: string;
    maxDimension?: number;
    format?: string;
    crf?: number;
}
interface VideoQualityConfig extends QualityConfig {
    resolution?: ResolutionLabel | string;
    crf?: number;
    videoBitrate?: string;
    audioBitrate?: string;
    codec?: string;
    preset?: ResolvedQuality['preset'];
    format?: string;
}
interface ImageProcessingConfig {
    quality?: Quality;
    qualityConfig?: QualityConfig;
    qualityConfigs?: QualityConfig[];
    format?: string;
    width?: number;
    height?: number;
}
interface VideoProcessingConfig {
    quality?: Quality;
    qualityConfig?: QualityConfig;
    qualityConfigs?: QualityConfig[];
    format?: string;
    startTime?: number;
    endTime?: number;
    mute?: boolean;
    videoBitrate?: string;
    audioBitrate?: string;
    resolution?: string;
    codec?: string;
    generateThumbnail?: boolean;
    thumbnailTimeSeconds?: number;
}
interface AudioProcessingConfig {
    quality?: Quality;
    qualityConfig?: QualityConfig;
    qualityConfigs?: QualityConfig[];
    format?: string;
    startTime?: number;
    endTime?: number;
    audioBitrate?: string;
}
interface ProcessingResult {
    /** Primary output buffer (single quality) */
    buffer?: Buffer;
    /** Multi-quality outputs keyed by QualityConfig.id */
    variants?: Record<string, Buffer>;
    /** Thumbnail as buffer (JPEG) */
    thumbnail?: Buffer;
    /** MIME type of the primary output */
    mimeType: string;
    /** File extension without dot */
    extension: string;
}
interface ResolvedQuality {
    width?: number;
    height?: number;
    videoBitrate?: string;
    audioBitrate?: string;
    crf?: number;
    /** FFmpeg -preset value derived from the encoding ladder. */
    preset?: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow' | 'slower' | 'veryslow';
}
interface SizeLimitMap {
    image?: number;
    video?: number;
    audio?: number;
    document?: number;
    default?: number;
}
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
    variants?: Record<string, {
        url?: string;
        storageRef: string;
        fileId: string;
    }>;
    thumbnailUrl?: string;
    error?: any;
}
interface FrontendTransformerConfig {
    type?: 'image' | 'video' | 'audio';
    /** Single named or numeric quality level. */
    quality?: 'high' | 'medium' | 'low' | number | string;
    /**
     * Resolution labels for multi-quality encode.
     * Each string must be a known resolution: '2160p' | '1440p' | '1080p' |
     * '720p' | '540p' | '480p' | '360p' | '240p'
     * The encoding ladder automatically assigns crf, bitrate, and preset.
     */
    qualities?: ResolutionLabel[];
    /**
     * Fully explicit per-variant configs.
     * Can be an array or a Record keyed by variant id.
     * Takes precedence over `qualities`.
     */
    qualityConfigs?: QualityConfig[] | Record<string, QualityConfig>;
    /**
     * Output container format.
     * Accepts both plain ('mp4') and MIME-prefixed ('video/mp4') — server strips prefix.
     * Video defaults: 'mp4'. Audio defaults: 'mp3'. Image defaults: source format.
     */
    format?: string;
    startTime?: number;
    endTime?: number;
    mute?: boolean;
    videoBitrate?: string;
    audioBitrate?: string;
    resolution?: ResolutionLabel | string;
    codec?: string;
    generateThumbnail?: boolean;
    thumbnailTimeSeconds?: number;
    width?: number;
    height?: number;
    /** Unused by the server; safe to include arbitrary frontend metadata. */
    auto?: boolean;
    [key: string]: any;
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
    readonly hasNativeVariantSupport?: boolean;
    writeChunk(fileId: string, chunkNumber: number, data: Buffer, ctx: StorageContext): Promise<void>;
    finalize(fileId: string, ctx: StorageContext): Promise<StorageWriteResult>;
    readStream(ref: string, options?: StorageReadOptions): Promise<Readable>;
    delete(ref: string): Promise<void>;
    putObject?(fileId: string, data: Buffer, ctx: StorageContext): Promise<StorageWriteResult>;
    putStream?(fileId: string, stream: Readable, ctx: StorageContext): Promise<StorageWriteResult>;
    assembleChunksToPath?(fileId: string, totalChunks: number, ext: string, ctx: StorageContext): Promise<string>;
    readChunk?(fileId: string, chunkNumber: number, ctx: StorageContext): Promise<Buffer>;
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
    transformer?: FrontendTransformerConfig;
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
/**
 * @upload-media/server - Add to existing types.ts
 */
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
    mediaProcessor?: MediaProcessorOptions;
}
interface MediaProcessorOptions {
    /** Directory for temporary files. Defaults to os.tmpdir() */
    tempDir?: string;
    /** Path to ffmpeg binary. If not set, uses system PATH */
    ffmpegPath?: string;
    /** Path to ffprobe binary */
    ffprobePath?: string;
    /** Max concurrent ffmpeg processes (default: 2) */
    maxConcurrency?: number;
    /** Timeout per processing job in ms (default: 10 minutes) */
    timeoutMs?: number;
}
interface MediaProcessorOptions {
    tempDir?: string;
    ffmpegPath?: string;
    ffprobePath?: string;
    maxConcurrency?: number;
    timeoutMs?: number;
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
 * @upload-media/server - UploadEngine v4
 *
 * Changes vs v3:
 *
 * [A] PARALLEL VARIANT ENCODING
 *     Variants are now encoded concurrently via Promise.all() inside
 *     MediaProcessor._encodeVideoFromPath(). The Semaphore already caps
 *     total concurrent FFmpeg processes across the whole process, so
 *     running all variants for one upload in parallel is safe — the
 *     semaphore is still held for the duration. Encoding time drops by
 *     ~(n-1)/n for n variants (e.g. 4 variants ≈ 75 % faster wall-clock).
 *
 * [B] DETERMINISTIC VARIANT FILE IDs
 *     Variant IDs are now `${fileId}_${qualityId}` (e.g.
 *     "file_1234_720p", "file_1234_480p"). This lets callers construct
 *     the ID for any quality level without a DB lookup, mirrors the
 *     YouTube-style URL pattern, and prevents duplicate quality variants
 *     (same qualityId → same derived fileId → upsert, not duplicate insert).
 *
 * [C] CHUNK-COUNT FIX FOR DATABASE ADAPTER
 *     After encoding, the primary variant is stored via putObject() which
 *     writes a single chunk (chunk 0). The updateFile() call now always
 *     sets chunkCount:1 and chunkSize:primarySize so FileServingHandler's
 *     ChunkReadStream does not try to read non-existent chunks 1..N.
 *     The original upload chunk rows for the raw file are still in the DB
 *     but are no longer referenced by the record's chunkCount.
 *
 * [D] DEDUP QUALITY CONFIGS
 *     normaliseQualityConfigs() deduplicates entries by id so callers
 *     cannot accidentally request the same quality twice.
 */

declare class UploadEngine {
    private config;
    private mediaProcessor;
    constructor(config: UploadEngineConfig);
    handle: (req: NormalizedRequest, res: NormalizedResponse) => Promise<UploadResult | {
        status: "success";
        message: string;
        metadata: UploadResult[];
    } | void>;
    private handleChunkedUpload;
    private handleNonChunkedUpload;
    private assembleChunksToDisk;
    private shouldProcessMedia;
    private processMediaFromPath;
    cleanup(files: FileRecord | FileRecord[]): Promise<void>;
    private isChunkedUpload;
    private buildFieldValidation;
    private buildFileValidation;
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
     * Helper method to check if a MIME type matches any of the given patterns
     */
    private static matchesMimePattern;
    /**
     * Detect MIME type from magic bytes.
     * Returns detected MIME type or 'application/octet-stream' if unknown.
     *
     * This method now handles both Buffer and Uint8Array inputs safely.
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

/**
 * @upload-media/server - LocalDiskStorageAdapter (fixed)
 *
 * Fixes applied:
 *
 * [1] writeChunk now writes each chunk to its own indexed file
 *     (e.g. <fileId>.chunk-000001) instead of blindly appending to a
 *     single .part file. This makes writes order-safe and retry-safe —
 *     a re-sent chunk just overwrites its own file with the same data.
 *
 * [2] fs.open(..., 'w') removed — it truncated the running file on
 *     every re-open (e.g. after a server restart mid-upload). Chunk
 *     files are now written with fs.writeFile which is atomic.
 *
 * [3] assembleChunksToPath() implemented. UploadEngine calls this
 *     first; it streams each chunk file to disk in order without ever
 *     loading the full file into heap. Falls back to UploadEngine's
 *     own buffer path only if this method is absent — which it no
 *     longer is, so the fallback readChunk crash path is avoided.
 *
 * [4] finalize() concatenates chunk files to the final path, then
 *     deletes the chunk files. Called by UploadEngine after
 *     assembleChunksToPath when no media processing is needed.
 *
 * [5] fileCtx map stores StorageContext per fileId so finalize() and
 *     assembleChunksToPath() can reconstruct paths without callers
 *     having to re-supply the context. Entries are cleaned up after use.
 */

interface LocalDiskStorageOptions {
    rootDir: string;
    publicBaseUrl?: string;
}
declare class LocalDiskStorageAdapter implements StorageAdapter {
    readonly name = "local-disk";
    private rootDir;
    private publicBaseUrl?;
    /** Remembers the StorageContext for each in-progress upload. */
    private fileCtx;
    constructor(options: LocalDiskStorageOptions);
    private ensureDir;
    /**
     * Path for an individual chunk file.
     * Zero-padded index keeps OS directory listings in order.
     */
    private chunkPath;
    /** Path for the final assembled file. */
    private finalPath;
    /** Temporary assembled path used during media processing. */
    private assembledPath;
    /**
     * Write one chunk to its own file (FIX [1] + [2]).
     * Writing is idempotent: retrying chunk N just overwrites the same file.
     */
    writeChunk(fileId: string, chunkNumber: number, data: Buffer, ctx: StorageContext): Promise<void>;
    /**
     * Stream all chunk files to a single assembled file on disk (FIX [3]).
     *
     * UploadEngine.assembleChunksToDisk() calls this first. Because it
     * exists on this adapter, the engine never falls through to the
     * missing readChunk() fallback.
     *
     * Returns the path of the assembled file so FFmpeg (or the engine's
     * single-quality path) can read directly from disk.
     */
    assembleChunksToPath(fileId: string, totalChunks: number, ext: string, ctx: StorageContext): Promise<string>;
    /**
     * Concatenate chunk files into the final stored file, then remove the
     * chunk files (FIX [4]). Called by UploadEngine when no media
     * processing transformer is provided.
     */
    finalize(fileId: string, ctx: StorageContext): Promise<StorageWriteResult>;
    putStream(fileId: string, stream: Readable, ctx: StorageContext): Promise<StorageWriteResult>;
    /** Single-shot write for non-chunked uploads. */
    putObject(fileId: string, data: Buffer, ctx: StorageContext): Promise<StorageWriteResult>;
    readStream(ref: string, options?: StorageReadOptions): Promise<Readable>;
    delete(ref: string): Promise<void>;
}

/**
 * @upload-media/server - DatabaseStorageAdapter v2
 *
 * FIX [STREAM-CHUNK]: putStream() implemented.
 *
 * Problem this fixes:
 *   UploadEngine's streamFileToStorage() prefers storage.putStream() when
 *   available, falling back to "read whole file into a Buffer, call
 *   putObject()" when it isn't. DatabaseStorageAdapter had no putStream,
 *   so EVERY encoded variant — no matter how large — was read fully into
 *   heap and written as a SINGLE chunk document (chunkNumber 0).
 *
 *   Two concrete failures from that:
 *     a) Heap exhaustion: large variants (hundreds of MB to GB) held fully
 *        in memory, and with parallel variant encoding several of these
 *        could be resident at once.
 *     b) MongoDB's 16MB BSON document size limit: any variant whose encoded
 *        size exceeds ~16MB cannot be written as a single chunk document at
 *        all — the insert fails outright on a real MongoDB deployment.
 *
 * Fix: putStream() now re-chunks the source stream into fixed-size pieces
 * (matching the ORIGINAL upload's chunkSize when available, so the file's
 * chunk geometry is consistent end-to-end) and writes each piece as its own
 * chunk document, exactly mirroring how the initial chunked upload itself
 * was stored. The final chunk is the remainder (e.g. for a 5MB file in 2MB
 * pieces: chunks of 2MB, 2MB, 1MB — NOT padded to 2MB).
 *
 * putStream() returns { storageRef, chunkCount, chunkSize, totalSize } so
 * the caller can persist accurate chunk metadata instead of assuming 1
 * chunk. This keeps FileServingHandler's ChunkReadStream — which already
 * assumes fixed chunkSize with a remainder-sized last chunk — working
 * unchanged; only the metadata written by the upload path needed fixing.
 *
 * Other fixes carried over from the previous revision:
 * [1] assembleChunksToPath() — streams chunk rows to a temp file on disk.
 * [2] finalize() — chunk rows are the source of truth, no-op move needed.
 * [3] StorageContext threaded through to all methods.
 * [4] putObject upsert semantics preserved for small/non-chunked files.
 */

interface DatabaseStorageOptions {
    database: MetadataRepository;
    /**
     * Number of chunks to pre-fetch ahead of the current read position
     * in ChunkReadStream. Defaults to 2.
     */
    prefetchCount?: number;
    /**
     * Directory used for temporary assembled files during media processing.
     * Defaults to os.tmpdir().
     */
    tempDir?: string;
    /**
     * Fallback chunk size (bytes) used by putStream() when the StorageContext
     * does not carry an original chunkSize to inherit (e.g. non-chunked /
     * single-shot uploads that still produce a large processed variant).
     * Defaults to 4MB — comfortably under MongoDB's 16MB BSON document limit
     * even after BSON/driver overhead.
     */
    defaultStreamChunkSize?: number;
}
/** Extended write result that callers can use to persist accurate chunk metadata. */
interface StreamWriteResult extends StorageWriteResult {
    chunkCount: number;
    chunkSize: number;
    totalSize: number;
}
/** Ensure we always hand back a proper Node.js Buffer. */
declare function toBuffer(input: Buffer | Uint8Array | ArrayBuffer | any): Buffer;
declare class DatabaseStorageAdapter implements StorageAdapter {
    readonly name = "database";
    private database;
    private prefetchCount;
    private tempDir;
    private defaultStreamChunkSize;
    constructor(options: DatabaseStorageOptions);
    writeChunk(fileId: string, chunkNumber: number, data: Buffer, ctx: StorageContext): Promise<void>;
    assembleChunksToPath(fileId: string, totalChunks: number, ext: string, ctx: StorageContext): Promise<string>;
    finalize(fileId: string, ctx: StorageContext): Promise<StorageWriteResult>;
    putObject(fileId: string, data: Buffer, ctx: StorageContext): Promise<StorageWriteResult>;
    /** Shared chunking logic for the in-memory guard-rail path in putObject(). */
    private writeBufferAsChunks;
    putStream(fileId: string, source: Readable, ctx: StorageContext): Promise<StreamWriteResult>;
    /**
     * Resolve the chunk size to use for re-chunking an outgoing stream.
     * Prefers the ORIGINAL upload's chunkSize (carried on StorageContext by
     * UploadEngine) so a variant's on-disk chunk geometry matches the source
     * file's. Falls back to defaultStreamChunkSize for non-chunked uploads.
     */
    private resolveChunkSize;
    readStream(ref: string, options?: StorageReadOptions): Promise<Readable>;
    delete(ref: string): Promise<void>;
}

/**
 * @upload-media/server - S3StorageAdapter (fixed)
 *
 * Fixes applied:
 *
 * [1] assembleChunksToPath() implemented. UploadEngine calls this on
 *     the last chunk. The adapter streams each buffered S3 part to a
 *     temp file on disk so FFmpeg can read from disk rather than
 *     holding the full file in heap. The in-progress multipart upload
 *     is NOT finalized here — the engine calls finalize() separately
 *     after media processing, which completes the S3 multipart upload
 *     via CompleteMultipartUploadCommand.
 *
 *     Because S3 does not expose already-uploaded parts for re-reading
 *     (without downloading the whole object), the adapter maintains a
 *     local part-buffer cache (partCache) in parallel so we can
 *     reconstruct the file for assembleChunksToPath without an extra
 *     S3 round-trip.
 *
 * [2] finalize() was already correct — it calls
 *     CompleteMultipartUploadCommand — but was never called by the
 *     engine. UploadEngine now calls finalize() after
 *     assembleChunksToPath + media processing (see UploadEngine fix).
 *     No change needed here; documented for clarity.
 *
 * [3] StorageContext (including ctx.chunkCount) is now threaded through
 *     all methods consistently.
 *
 * [4] partCache is cleared in finalize() and on abort to avoid unbounded
 *     memory growth for long-lived server processes with many uploads.
 */

interface S3StorageOptions {
    bucket: string;
    region: string;
    credentials?: {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
    };
    /** For S3-compatible providers (Cloudflare R2, MinIO, etc.) */
    endpoint?: string;
    forcePathStyle?: boolean;
    /** Public URL builder; defaults to AWS virtual-hosted-style URL. */
    buildPublicUrl?: (bucket: string, key: string) => string;
    /** Override how a logical fileId becomes an S3 object key. */
    buildKey?: (fileId: string, ctx: StorageContext) => string;
    /**
     * Minimum bytes to buffer before flushing an UploadPart.
     * Default: 5 MB (the S3 minimum for all but the last part).
     */
    minPartSize?: number;
    /** Pass an already-constructed S3Client to skip credential config. */
    client?: any;
    /**
     * Directory for temporary assembled files used during media processing.
     * Defaults to os.tmpdir().
     */
    tempDir?: string;
}
declare class S3StorageAdapter implements StorageAdapter {
    readonly name = "s3";
    private options;
    private _client;
    private minPartSize;
    private tempDir;
    /** Active multipart uploads keyed by fileId. */
    private uploads;
    /**
     * FIX [1]: Parallel cache of the raw engine-chunks (before S3-part
     * buffering) so assembleChunksToPath() can reconstruct the file
     * without downloading from S3.
     */
    private partCache;
    constructor(options: S3StorageOptions);
    private getClient;
    private loadCommands;
    private buildKey;
    private buildPublicUrl;
    private flushPart;
    writeChunk(fileId: string, chunkNumber: number, data: Buffer, ctx: StorageContext): Promise<void>;
    assembleChunksToPath(fileId: string, totalChunks: number, ext: string, ctx: StorageContext): Promise<string>;
    finalize(fileId: string, ctx: StorageContext): Promise<StorageWriteResult>;
    putStream(fileId: string, stream: Readable, ctx: StorageContext): Promise<StorageWriteResult>;
    putObject(fileId: string, data: Buffer, ctx: StorageContext): Promise<StorageWriteResult>;
    readStream(ref: string, options?: StorageReadOptions): Promise<Readable>;
    delete(ref: string): Promise<void>;
}

/**
 * @upload-media/server - CloudinaryStorageAdapter (fixed)
 *
 * Fixes applied:
 *
 * [1] assembleChunksToPath() implemented. UploadEngine calls this on
 *     the last chunk so FFmpeg can process the file from disk before
 *     the final upload goes to Cloudinary.
 *
 *     Cloudinary's upload_large_stream does not expose already-written
 *     chunks for re-reading, so the adapter maintains a local
 *     chunkCache (raw engine-chunks indexed by chunkNumber) in parallel.
 *     assembleChunksToPath() drains that cache in order into a temp
 *     file on disk and returns the path.
 *
 *     The Cloudinary stream is left open during media processing —
 *     finalize() ends the stream and waits for Cloudinary's confirmation
 *     once the (optionally re-encoded) file has been streamed in via
 *     putStream / putObject.
 *
 * [2] finalize() previously only ended the upload_large_stream and
 *     returned the result. It is now also called by UploadEngine after
 *     media processing, at which point the engine streams the processed
 *     file via putObject (or putStream). The pending upload started by
 *     writeChunk is therefore ABORTED in finalize() when the engine is
 *     going to re-upload a processed variant — detected by checking
 *     whether the caller supplies a ctx whose contentType differs from
 *     the one used to open the stream.
 *
 *     Simpler rule implemented here: UploadEngine always calls
 *     putObject/putStream for the final artifact after processing, so
 *     finalize() just aborts and removes any lingering stream rather
 *     than trying to complete it with raw bytes.
 *
 *     If no processing happens the engine calls finalize() directly and
 *     the stream IS completed normally.
 *
 * [3] chunkCache is cleared in finalize() and on abort (FIX [4] parity).
 *
 * [4] putStream() added. If the storage adapter exposes putStream(),
 *     UploadEngine prefers it for large processed files (zero heap copy).
 *     Cloudinary's upload_stream is used under the hood.
 *
 * [5] StorageContext is threaded through all methods for consistency.
 */

interface CloudinaryStorageOptions {
    cloudName: string;
    apiKey: string;
    apiSecret: string;
    /** Folder prefix for all uploads, e.g. "myapp/uploads" */
    folder?: string;
    /** Override how a fileId maps to a Cloudinary public_id */
    buildPublicId?: (fileId: string, ctx: StorageContext) => string;
    /** Pass an already-configured cloudinary instance (v1 or v2 API) */
    cloudinary?: any;
    /**
     * Directory for temporary assembled files used during media processing.
     * Defaults to os.tmpdir().
     */
    tempDir?: string;
}
declare class CloudinaryStorageAdapter implements StorageAdapter {
    readonly name = "cloudinary";
    readonly hasNativeVariantSupport = true;
    private options;
    private _cloudinary;
    private tempDir;
    /** Active upload_large_stream sessions keyed by fileId. */
    private pending;
    /**
     * FIX [1]: Raw engine-chunks cached so assembleChunksToPath() can
     * reconstruct the file without re-downloading from Cloudinary.
     */
    private chunkCache;
    constructor(options: CloudinaryStorageOptions);
    private getSdk;
    private resourceTypeFor;
    private buildPublicId;
    private getOrCreateUpload;
    writeChunk(fileId: string, chunkNumber: number, data: Buffer, ctx: StorageContext): Promise<void>;
    assembleChunksToPath(fileId: string, totalChunks: number, ext: string, ctx: StorageContext): Promise<string>;
    /** Destroy the pending upload_large_stream without completing it. */
    private _abortPending;
    finalize(fileId: string, ctx: StorageContext): Promise<StorageWriteResult>;
    putStream(fileId: string, stream: Readable, ctx: StorageContext): Promise<StorageWriteResult>;
    putObject(fileId: string, data: Buffer, ctx: StorageContext): Promise<StorageWriteResult>;
    readStream(ref: string, _options?: StorageReadOptions): Promise<Readable>;
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

export { AUTH_CACHE_TTL_SECONDS, type AudioProcessingConfig, CACHE_PREFIXES, type CacheAdapter, type ChunkRecord, CloudinaryStorageAdapter, type CloudinaryStorageOptions, ConfigValidationError, CreateH3FileServingHandler, CreateNextjsFileServingHandler, DEFAULT_CACHE_TTL_SECONDS, DEFAULT_CHUNK_SIZES, DEFAULT_CLEANUP_BATCH_SIZE, DEFAULT_CLEANUP_INTERVAL_MS, DEFAULT_QUALITY, DEFAULT_SIZE_LIMITS, DEFAULT_STALE_UPLOAD_RETENTION_MS, type DatabaseHooks, DatabaseStorageAdapter, type DatabaseStorageOptions, type FieldValidationRule, type FileInfo, type FileQuery, type FileRecord, type FileRecordPatch, type FileValidationRule, type FrameworkAdapter, type FrontendTransformerConfig, type H3EventLike, type HandlerResult, type HookContext, type ImageProcessingConfig, InMemoryRepository, type IncomingChunkFields, LocalDiskStorageAdapter, type LocalDiskStorageOptions, type MediaKind, type MediaProcessorOptions, type MetadataRepository, MongooseRepository, type MongooseRepositoryOptions, MultipartParser, type NewFileRecord, type NormalizedRequest, type NormalizedResponse, type ParseOptions, type ParsedFile, type ParsedMultipart, type ParserHooks, type ProcessingResult, QUALITY_MAPPINGS, type Quality, type QualityConfig, type ResolutionLabel, type ResolvedQuality, type ResolvedUploadEngineConfig, S3StorageAdapter, type S3StorageOptions, type SQLExecutor, SQLRepository, type SQLRepositoryOptions, SUPPORTED_MIME_TYPES, type SizeLimitMap, type StorageAdapter, type StorageContext, type StorageHooks, type StorageReadOptions, type StorageWriteResult, type StreamWriteResult, THUMBNAIL_CHUNK_SIZE, THUMBNAIL_DIMENSIONS, THUMBNAIL_SIZE_LIMIT, type ThumbnailGenerator, UploadEngine, type UploadEngineConfig, type UploadHandler, type UploadHooks, type UploadResult, type UploadResultPayload, type UploadTypeConfig, ValidationError, type VideoProcessingConfig, type VideoQualityConfig, assertKindAllowed, assertRequiredFields, assertWithinLimit, chainHooks, createAutoCleanupHooks, createElysiaAdapter, createElysiaFileServingHandler, createExpressAdapter, createExpressFileServingMiddleware, createFastifyAdapter, createFastifyFileServingPlugin, createH3Adapter, createHonoAdapter, createHonoFileServingMiddleware, createKoaAdapter, createKoaFileServingMiddleware, createLoggingHooks, createMetricsHooks, createNextjsAdapter, createRedisCacheHooks, createStorageLoggingHooks, createTransformationHooks, createValidationHooks, decryptQueryString, detectKind, generateRandomString, getMimeKind, hashString, parseBooleanFlag, parseIntSafe, parseJsonSafe, resolveChunkLimit, resolveSizeLimit, resolveStorageKey, resolveUploadConfig, signData, toBuffer, verifySignature };
