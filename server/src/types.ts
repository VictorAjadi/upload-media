/**
 * @upload-media/server - Core Type Definitions
 */

import { Readable } from 'stream';

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'unknown';
// ── Types ─────────────────────────────────────────────────────────────────────
export type ResolutionLabel =
  | '2160p' | '4k'
  | '1440p' | '2k'
  | '1080p'
  | '720p'
  | '540p'
  | '480p'
  | '360p'
  | '240p'
  | '144p';

export type Quality = 'high' | 'medium' | 'low' | number;

export interface QualityConfig {
  id: string;
  label: string;
  quality?: Quality;
  resolution?: string;   // e.g. '1080p', '720p', '480p'
  videoBitrate?: string; // e.g. '4000k', '2500k'
  audioBitrate?: string; // e.g. '192k', '128k'
  width?: number;
  height?: number;
  codec?: string;
  maxDimension?: number;
  format?: string;
  crf?: number;
}
export interface VideoQualityConfig extends QualityConfig {
  resolution?: ResolutionLabel | string;
  crf?: number;
  videoBitrate?: string;
  audioBitrate?: string;
  codec?: string;
  preset?: ResolvedQuality['preset'];
  format?: string;
}
export interface ImageProcessingConfig {
  quality?: Quality;
  qualityConfig?: QualityConfig;
  qualityConfigs?: QualityConfig[];
  format?: string;
  width?: number;
  height?: number;
}

export interface VideoProcessingConfig {
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
  onProgress?: (progress: any) => void;
}

export interface AudioProcessingConfig {
  quality?: Quality;
  qualityConfig?: QualityConfig;
  qualityConfigs?: QualityConfig[];
  format?: string;
  startTime?: number;
  endTime?: number;
  audioBitrate?: string;
  onProgress?: (progress: any) => void;
}

export interface ProcessingResult {
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

export interface ProcessedMediaVariant {
  id: string; // e.g. "primary", "1080p", "720p"
  isPrimary: boolean;
  path: string;
  mimeType: string;
  extension: string;
  thumbnail?: Buffer; // Included on primary if generated
}

export interface MediaProcessorOptions {
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

// ── Quality resolution helpers ────────────────────────────────────────────────

export interface ResolvedQuality {
  width?: number;
  height?: number;
  videoBitrate?: string;
  audioBitrate?: string;
  crf?: number;
  /** FFmpeg -preset value derived from the encoding ladder. */
  preset?: 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow' | 'slower' | 'veryslow';
}
export interface SizeLimitMap {
  image?: number;
  video?: number;
  audio?: number;
  document?: number;
  default?: number;
}
// ── Result type ───────────────────────────────────────────────────────────────

export interface UploadResult {
  status: 'success' | 'chunk_received' | 'error';
  message: string;
  fileId?: string;
  url?: string;
  storageRef?: string;
  chunkIndex?: number;
  totalChunks?: number;
  progress?: number;
  isProcessing?: boolean;
  metadata?: Record<string, any>;
  fields?: Record<string, any>;
  file?: FileRecord;
  files?: FileRecord[];
  fileFields?: Record<string, FileRecord | FileRecord[]>;
  parentFile?: FileRecord;
  variants?: Record<string, { url?: string; storageRef: string; fileId: string }>;
  thumbnailUrl?: string;
  error?: any;
}

// ── Transformer config (as sent from frontend) ────────────────────────────────

export interface FrontendTransformerConfig {
  // ── Media type (inferred from mimetype if omitted) ──────────────────────
  type?: 'image' | 'video' | 'audio';

  // ── Quality — three accepted shapes (see above) ─────────────────────────

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

  // ── Format ───────────────────────────────────────────────────────────────
  /**
   * Output container format.
   * Accepts both plain ('mp4') and MIME-prefixed ('video/mp4') — server strips prefix.
   * Video defaults: 'mp4'. Audio defaults: 'mp3'. Image defaults: source format.
   */
  format?: string;

  // ── Video-specific ────────────────────────────────────────────────────────
  startTime?: number;   // Trim start in seconds
  endTime?: number;   // Trim end in seconds
  mute?: boolean;  // Strip audio track
  videoBitrate?: string;   // e.g. '2500k' — overrides ladder default
  audioBitrate?: string;   // e.g. '128k'  — overrides ladder default
  resolution?: ResolutionLabel | string; // Single-quality resolution override
  codec?: string;   // Video codec, default 'libx264'
  generateThumbnail?: boolean;  // Default true for video
  thumbnailTimeSeconds?: number;   // Seek time for thumbnail (default: 10% of duration)

  // ── Image-specific ────────────────────────────────────────────────────────
  width?: number;
  height?: number;

  // ── Misc / passthrough ────────────────────────────────────────────────────
  /** Unused by the server; safe to include arbitrary frontend metadata. */
  auto?: boolean;
  [key: string]: any;
}

export interface UploadTypeConfig {
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

export interface FileRecord {
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

export type NewFileRecord = Omit<FileRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };
export type FileRecordPatch = Partial<Omit<FileRecord, 'id'>>;

export interface ChunkRecord {
  fileId: string;
  chunkNumber: number;
  data: Buffer;
}

export interface FileQuery {
  sessionId?: string;
  sessionIds?: string[];
  ids?: string[];
  uploadType?: string;
  bucket?: string;
  userId?: string;
  isComplete?: boolean;
  limit?: number;
  skip?: number;
}

export interface MetadataRepository {
  createFile(file: NewFileRecord): Promise<FileRecord>;
  getFileBySessionId(sessionId: string): Promise<FileRecord | null>;
  getFileById(id: string): Promise<FileRecord | null>;
  updateFile(id: string, patch: FileRecordPatch): Promise<FileRecord | null>;
  findFiles(query: FileQuery): Promise<FileRecord[]>;
  deleteFiles(ids: string[]): Promise<number>;
  createChunk(chunk: ChunkRecord): Promise<void>;  // Made required
  createChunks?(chunks: ChunkRecord[]): Promise<void>;
  getChunk(fileId: string, chunkNumber: number): Promise<Buffer | null>;  // Made required
  deleteChunksByFileId(fileId: string): Promise<number>;  // Made required
}

export interface StorageWriteResult {
  storageRef: string;
  url?: string;
}

export interface StorageReadOptions {
  start?: number;
  end?: number;
}

export interface StorageContext {
  originalName: string;
  contentType: string;
  bucket: string;
  totalSize: number;
  chunkSize: number;
  chunkCount: number;
  uploadType: string;
}

export interface StorageAdapter {
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
  hasActiveMultipart?(fileId: string): boolean;
  abortMultipart?(fileId: string): Promise<void>;
}

export interface CacheAdapter {
  readonly name: string;
  get<T = any>(key: string): Promise<T | null>;
  set<T = any>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string | string[]): Promise<void>;
  has(key: string): Promise<boolean>;
  invalidatePrefix(prefix: string): Promise<void>;
  clear(): Promise<void>;
}

export interface NormalizedRequest {
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

export interface NormalizedResponse {
  status(code: number): NormalizedResponse;
  json(body: any): void;
  header(name: string, value: string): NormalizedResponse;
  pipeFrom(stream: Readable): Promise<void>;
  end(): void;
  raw: any;
}

export interface HandlerResult {
  [key: string]: any;
  onBackground?: () => void | Promise<void>;
}

export type UploadHandler = (req: NormalizedRequest, res: NormalizedResponse) => Promise<HandlerResult | any>;

export interface FrameworkAdapter<THandler = any> {
  readonly name: string;
  wrap(handler: UploadHandler): THandler;
}

export interface ThumbnailGenerator {
  generate(file: FileRecord, source: Readable | Buffer): Promise<Buffer | null>;
}

/**
 * @upload-media/server - Add to existing types.ts
 */

export interface UploadEngineConfig {
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
  onProcessingStart?: (fileId: string, sessionId: string, context?: any) => void | Promise<void>;
  onVariantComplete?: (variantFile: FileRecord, parentFileId: string) => void | Promise<void>;
  onError?: (error: Error, context: { uploadType?: string; sessionId?: string }) => void;
  staleUploadRetentionMs?: number;
  maxFieldSize?: number;
  maxFiles?: number;
  maxTotalSize?: number;
  onProgress?: (progress: any) => void;
  autoRespond?: boolean;
  // NEW: MediaProcessor configuration
  mediaProcessor?: MediaProcessorOptions;
  /**
   * Secret key for HMAC-signing stateless upload tokens.
   * Must be at least 32 characters for production use.
   *
   * This is NOT the same as your JWT/user auth secret.
   * This secret is used solely for the upload handshake token
   * that allows any server instance to validate incoming chunks
   * without querying a shared session store.
   *
   * IMPORTANT: In multi-node/cluster deployments, ALL instances
   * must share the same tokenSecret or tokens minted by one
   * node cannot be verified by another.
   *
   * If omitted, a random secret is generated at boot (single-node only).
   */
  tokenSecret?: string;
  /**
   * Default upload token lifetime in seconds.
   * Tokens expire after this duration, forcing the client to re-initiate.
   * Default: 3600 (1 hour).
   */
  tokenTtlSeconds?: number;
  /**
   * Interval in ms for the background janitor to sweep orphaned uploads.
   * Default: 24 hours. Set to 0 to disable the janitor.
   */
  janitorIntervalMs?: number;
}

export interface MediaProcessorOptions {
  tempDir?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  maxConcurrency?: number;
  timeoutMs?: number;
}

export interface ResolvedUploadEngineConfig extends Required<Pick<UploadEngineConfig, 'storages' | 'defaultStorage' | 'database' | 'uploadTypes'>> {
  cache?: CacheAdapter;
  cacheTtlSeconds: number;
  globalLimits: SizeLimitMap;
  globalChunkLimits: SizeLimitMap;
  thumbnailGenerator?: ThumbnailGenerator;
  onUploadComplete?: (file: FileRecord) => void | Promise<void>;
  onProcessingStart?: (fileId: string, sessionId: string, context?: any) => void | Promise<void>;
  onVariantComplete?: (variantFile: FileRecord, parentFileId: string) => void | Promise<void>;
  onError?: (error: Error, context: { uploadType?: string; sessionId?: string }) => void;
  staleUploadRetentionMs: number;
  defaultUploadType?: string;
  maxFieldSize: number;
  maxFiles: number;
  maxTotalSize: number;
  onProgress?: (progress: any) => void;
  autoRespond: boolean;
  hooks?: import('./hooks/types').UploadHooks;
  tokenSecret?: string;
  tokenTtlSeconds: number;
  janitorIntervalMs: number;
}

export interface IncomingChunkFields {
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

export interface UploadResultPayload {
  status: 'success' | 'chunk_received' | 'error';
  message: string;
  file?: FileRecord;
  chunkIndex?: number;
  totalChunks?: number;
}

export interface FileServingOptions {
  rootDir?: string;
  cacheMaxAge?: string;
  pathPrefix?: string;
  database?: MetadataRepository;
  strictBucketAccess?: boolean;
  bucketName?: string;
  onBeforeServe?: (file: FileRecord, req: any) => Promise<void> | void;
}