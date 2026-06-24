/**
 * @upload-media/server - Core Type Definitions
 */

import { Readable } from 'stream';

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'unknown';
export type Quality = 'high' | 'medium' | 'low';

export interface SizeLimitMap {
  image?: number;
  video?: number;
  audio?: number;
  document?: number;
  default?: number;
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
  writeChunk(fileId: string, chunkNumber: number, data: Buffer, ctx: StorageContext): Promise<void>;
  finalize(fileId: string, ctx: StorageContext): Promise<StorageWriteResult>;
  readStream(ref: string, options?: StorageReadOptions): Promise<Readable>;
  delete(ref: string): Promise<void>;
  putObject?(fileId: string, data: Buffer, ctx: StorageContext): Promise<StorageWriteResult>;
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
  transformer?: any;
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
  thumbnailGenerator?: ThumbnailGenerator;
  onUploadComplete?: (file: FileRecord) => void | Promise<void>;
  onError?: (error: Error, context: { uploadType?: string; sessionId?: string }) => void;
  staleUploadRetentionMs?: number;

  // Missing properties that were in use but not in interface
  maxFieldSize?: number;
  maxFiles?: number;
  maxTotalSize?: number;
  onProgress?: (progress: any) => void;
  autoRespond?: boolean;
}

export interface ResolvedUploadEngineConfig extends Required<Pick<UploadEngineConfig, 'storages' | 'defaultStorage' | 'database' | 'uploadTypes'>> {
  cache?: CacheAdapter;
  cacheTtlSeconds: number;
  globalLimits: SizeLimitMap;
  globalChunkLimits: SizeLimitMap;
  thumbnailGenerator?: ThumbnailGenerator;
  onUploadComplete?: (file: FileRecord) => void | Promise<void>;
  onError?: (error: Error, context: { uploadType?: string; sessionId?: string }) => void;
  staleUploadRetentionMs: number;
  defaultUploadType?: string;
  maxFieldSize: number;
  maxFiles: number;
  maxTotalSize: number;
  onProgress?: (progress: any) => void;
  autoRespond: boolean;
  hooks?: import('./hooks/types').UploadHooks;
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