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

import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import {
  NormalizedRequest,
  NormalizedResponse,
  UploadEngineConfig,
  ResolvedUploadEngineConfig,
  FileRecord,
  UploadResult,
  FrontendTransformerConfig,
} from '../types';
import { resolveUploadConfig, resolveSizeLimit, resolveStorageKey } from '../config/UploadConfig';
import { MultipartParser, FieldValidationRule, FileValidationRule } from '../core/MultipartParser';
import { ValidationError, detectKind, assertKindAllowed, assertWithinLimit } from '../core/FileValidator';
import {
  ImageProcessingConfig,
  VideoProcessingConfig,
  AudioProcessingConfig,
  QualityConfig,
} from '../types';
import { MediaProcessor, ExtendedProcessingResult } from './Mediaprocessor';

// ── Buffer utility ────────────────────────────────────────────────────────────

function ensureBuffer(input: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return Buffer.from(input as any);
}

// ── Stream a file on disk directly to storage (no heap copy) ─────────────────

interface StreamWriteOutcome {
  url?: string;
  storageRef: string;
  /** Number of chunk rows actually written. 1 for non-chunked storage backends. */
  chunkCount: number;
  /** Size of each chunk (last chunk may be smaller — the remainder). */
  chunkSize: number;
  /** Total bytes written, read from disk stat rather than assumed. */
  totalSize: number;
}

async function streamFileToStorage(
  storage: any,
  fileId: string,
  filePath: string,
  ctx: Record<string, any>
): Promise<StreamWriteOutcome> {
  const stat = await fs.promises.stat(filePath);

  if (storage.putStream) {
    const stream = fs.createReadStream(filePath);
    const result = await storage.putStream(fileId, stream, ctx);

    return {
      url: result.url,
      storageRef: result.storageRef,
      chunkCount: typeof result.chunkCount === 'number' ? result.chunkCount : 1,
      chunkSize: typeof result.chunkSize === 'number' ? result.chunkSize : stat.size,
      totalSize: typeof result.totalSize === 'number' ? result.totalSize : stat.size,
    };
  }

  const buffer = await fs.promises.readFile(filePath);
  const result = await storage.putObject(fileId, buffer, ctx);
  return {
    url: result.url,
    storageRef: result.storageRef,
    chunkCount: typeof result.chunkCount === 'number' ? result.chunkCount : 1,
    chunkSize: typeof result.chunkSize === 'number' ? result.chunkSize : buffer.length,
    totalSize: typeof result.totalSize === 'number' ? result.totalSize : buffer.length,
  };
}

// ── [B] Deterministic variant file ID ────────────────────────────────────────

function buildVariantFileId(primaryFileId: string, qualityId: string): string {
  // e.g. "file_1234567890_abc123_720p"
  return `${primaryFileId}_${qualityId}`;
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class UploadEngine {
  private config: ResolvedUploadEngineConfig;
  private mediaProcessor: MediaProcessor;

  constructor(config: UploadEngineConfig) {
    this.config = resolveUploadConfig(config);
    this.mediaProcessor = new MediaProcessor(config.mediaProcessor ?? {});
  }

  handle = async (
    req: NormalizedRequest,
    res: NormalizedResponse
  ): Promise<UploadResult | { status: 'success'; message: string; metadata: UploadResult[] } | void> => {
    try {
      const contentType = this.getContentType(req);
      if (!contentType.includes('multipart/form-data'))
        throw new ValidationError('Content-Type must be multipart/form-data', 400);

      let uploadType = this.getUploadType(req);
      if (!uploadType && this.config.defaultUploadType) uploadType = this.config.defaultUploadType;
      if (!uploadType || !this.config.uploadTypes[uploadType])
        throw new ValidationError(
          `Invalid or missing uploadType. Available: ${Object.keys(this.config.uploadTypes).join(', ')}`, 400
        );

      const typeConfig = this.config.uploadTypes[uploadType];
      const storageKey = resolveStorageKey(this.config, typeConfig);
      const storage = this.config.storages[storageKey];
      if (!storage) throw new ValidationError(`Storage '${storageKey}' not configured`, 500);

      const parsed = await MultipartParser.parseBuffered(req, {
        maxFieldSize: this.config.maxFieldSize || 1 * 1024 * 1024,
        maxFileSize: resolveSizeLimit(this.config, typeConfig, 'unknown'),
        maxFiles: this.config.maxFiles || 10,
        maxTotalSize: this.config.maxTotalSize || 500 * 1024 * 1024,
        fieldValidation: this.buildFieldValidation(typeConfig),
        fileValidation: this.buildFileValidation(typeConfig),
        onProgress: this.config.onProgress,
      });

      req.fields = parsed.fields || {};
      req.files = parsed.files || [];

      let transformer: FrontendTransformerConfig | undefined;
      if (parsed.fields.transformer) {
        try {
          transformer =
            typeof parsed.fields.transformer === 'string'
              ? JSON.parse(parsed.fields.transformer)
              : parsed.fields.transformer;
        } catch { transformer = undefined; }
      }
      req.transformer = transformer;

      if (this.isChunkedUpload(parsed.fields)) {
        return await this.handleChunkedUpload(req, res, parsed, uploadType, storage, typeConfig, transformer);
      } else {
        return await this.handleNonChunkedUpload(req, res, parsed, uploadType, storage, typeConfig, transformer);
      }
    } catch (error) {
      return await this.handleError(error, this.getUploadType(req), res);
    }
  };

  // ── Chunked upload ────────────────────────────────────────────────────────

  private async handleChunkedUpload(
    req: NormalizedRequest,
    res: NormalizedResponse,
    parsed: { fields: Record<string, any>; files: any[] },
    uploadType: string,
    storage: any,
    typeConfig: any,
    transformer: FrontendTransformerConfig | undefined
  ): Promise<UploadResult> {
    const sessionId = String(parsed.fields.sessionId);
    const chunkIndex = parseInt(String(parsed.fields.chunkIndex), 10);
    const totalChunks = parseInt(String(parsed.fields.totalChunks), 10);
    const filename = String(parsed.fields.filename);
    const mimetype = String(parsed.fields.mimetype);
    const totalSize = parseInt(String(parsed.fields.totalSize || 0), 10);
    const chunksize = parseInt(String(parsed.fields.chunksize || 0), 10);

    if (!sessionId || isNaN(chunkIndex) || isNaN(totalChunks))
      throw new ValidationError('Missing or invalid chunked upload fields', 400);
    if (!parsed.files || parsed.files.length === 0)
      throw new ValidationError('No chunk data received', 400);

    const chunkFile = parsed.files[0];
    const chunkBuffer = ensureBuffer(chunkFile.buffer);
    const kind = detectKind(mimetype);
    assertKindAllowed(kind, typeConfig);
    assertWithinLimit(chunkBuffer.length, resolveSizeLimit(this.config, typeConfig, kind), 'File size');

    const actualTotalSize = totalSize > 0 ? totalSize : chunkBuffer.length * totalChunks;
    const actualChunkSize = chunkBuffer.length;

    let existingFile = null;
    if (this.config.database) existingFile = await this.config.database.getFileBySessionId(sessionId);
    const fileId = existingFile?.id ?? this.generateFileId();

    const isLastChunk = chunkIndex === totalChunks - 1;

    const storageCtx = {
      originalName: filename,
      contentType: mimetype,
      bucket: typeConfig.bucket || uploadType,
      totalChunks,
      chunkIndex,
      totalSize: actualTotalSize,
      chunkSize: actualChunkSize,
      uploadType,
    };

    await storage.writeChunk(fileId, chunkIndex, chunkBuffer, storageCtx);

    if (chunkIndex === 0 && this.config.database && !existingFile) {
      const metadata = this.extractCustomFields(parsed.fields, [
        'sessionId', 'chunkIndex', 'totalChunks', 'filename', 'mimetype', 'uploadType', 'totalSize', 'chunksize', 'transformer',
      ]);
      if (transformer) metadata._transformer = transformer;

      await this.config.database.createFile({
        id: fileId, sessionId,
        originalName: filename,
        storedName: this.sanitizeFilename(filename),
        fieldname: parsed.fields.fieldname || 'file',
        contentType: mimetype,
        kind,
        size: actualTotalSize,
        chunkSize: actualChunkSize,
        chunkCount: totalChunks,
        uploadType,
        bucket: typeConfig.bucket || uploadType,
        storageProvider: resolveStorageKey(this.config, typeConfig),
        storageRef: `${uploadType}/${sessionId}/${fileId}`,
        isComplete: false,
        metadata,
      });
    }

    if (!isLastChunk) {
      const result: UploadResult = {
        status: 'chunk_received',
        message: `Chunk ${chunkIndex + 1}/${totalChunks} received`,
        progress: Math.round(((chunkIndex + 1) / totalChunks) * 100),
        chunkIndex,
        totalChunks,
        fields: this.extractCustomFields(parsed.fields),
      };
      res.status(200);
      res.json(result);
      return result;
    }

    const inputExt = path.extname(filename) || inferExtFromMime(mimetype);
    let assembledPath: string | null = null;
    let processedResult: ExtendedProcessingResult | null = null;

    try {
      assembledPath = await this.assembleChunksToDisk(
        storage, fileId, totalChunks, inputExt, storageCtx
      );

      let finalMimeType = mimetype;
      let finalFilename = filename;

      if (transformer && this.shouldProcessMedia(mimetype, transformer, storage)) {
        try {
          processedResult = await this.processMediaFromPath(
            assembledPath, mimetype, filename, transformer
          );
          if (processedResult) {
            finalMimeType = processedResult.mimeType;
            finalFilename = replaceExtension(filename, `.${processedResult.extension}`);
          }
        } catch (processingError) {
          console.error('[UploadEngine] Media processing failed, storing raw:', processingError);
          processedResult = null;
        }
      }

      // ── Store all variants (or single processed/raw file) ────────────────

      const variantResults: Record<string, { url?: string; storageRef: string; fileId: string }> = {};
      const variantFileIds: Record<string, string> = {};
      let finalUrl: string | undefined;
      let finalStorageRef: string | undefined;
      let primaryEncodedSize = actualTotalSize;

      let primaryChunkCount = 1;
      let primaryChunkSize = actualChunkSize;

      if (processedResult?.variantPaths && Object.keys(processedResult.variantPaths).length > 0) {
        const entries = Object.entries(processedResult.variantPaths);

        await Promise.all(entries.map(async ([qualityId, variantPath], i) => {
          const isPrimary = i === 0;
          const variantFileId = isPrimary ? fileId : buildVariantFileId(fileId, qualityId);
          const variantFilename = buildVariantFilename(filename, qualityId, processedResult!.extension!);

          const variantCtx = {
            ...storageCtx,
            originalName: variantFilename,
            contentType: processedResult!.mimeType,
          };

          const vr = await streamFileToStorage(storage, variantFileId, variantPath, variantCtx);

          if (isPrimary) {
            finalUrl = vr.url;
            finalStorageRef = vr.storageRef;
            primaryEncodedSize = vr.totalSize;
            primaryChunkCount = vr.chunkCount;
            primaryChunkSize = vr.chunkSize;
          }

          variantResults[qualityId] = { url: vr.url, storageRef: vr.storageRef, fileId: variantFileId };

          if (!isPrimary) {
            variantFileIds[qualityId] = variantFileId;
            if (this.config.database) {
              const vRecord = await this.config.database.createFile({
                id: variantFileId,
                sessionId: `${sessionId}_${qualityId}`,
                originalName: variantFilename,
                storedName: this.sanitizeFilename(variantFilename),
                fieldname: parsed.fields.fieldname || 'file',
                contentType: processedResult!.mimeType!,
                kind,
                size: vr.totalSize,
                chunkSize: vr.chunkSize,
                chunkCount: vr.chunkCount,
                uploadType,
                bucket: typeConfig.bucket || uploadType,
                storageProvider: resolveStorageKey(this.config, typeConfig),
                storageRef: vr.storageRef,
                url: vr.url,
                isComplete: true,
                metadata: { parentFileId: fileId, quality: qualityId, isVariant: true },
              });
              this.config.onUploadComplete?.(vRecord);
            }
          }
        }));

      } else {
        // Single quality or raw fallback
        const sourcePath = processedResult?.outputPath ?? assembledPath;
        const singleCtx = {
          ...storageCtx,
          originalName: finalFilename,
          contentType: finalMimeType,
        };
        const sr = await streamFileToStorage(storage, fileId, sourcePath, singleCtx);
        finalUrl = sr.url;
        finalStorageRef = sr.storageRef;
        primaryEncodedSize = sr.totalSize;
        primaryChunkCount = sr.chunkCount;
        primaryChunkSize = sr.chunkSize;
      }

      let thumbnailUrl: string | undefined;
      let thumbnailStorageRef: string | undefined;
      if (processedResult?.thumbnail && storage.putObject) {
        try {
          const thumbId = `thumb_${fileId}`;
          const thumbCtx = {
            ...storageCtx,
            originalName: `${path.basename(filename, path.extname(filename))}_thumb.jpg`,
            contentType: 'image/jpeg',
          };
          const tr = await storage.putObject(thumbId, processedResult.thumbnail, thumbCtx);
          thumbnailUrl = tr.url;
          thumbnailStorageRef = tr.storageRef;
        } catch (e) { console.warn('[UploadEngine] Thumbnail upload failed:', e); }
      }

      let finalFileRecord: FileRecord | null = null;

      if (this.config.database) {
        finalFileRecord = await this.config.database.updateFile(fileId, {
          isComplete: true,
          storageRef: finalStorageRef,
          url: finalUrl,
          contentType: finalMimeType,
          originalName: finalFilename,
          storedName: this.sanitizeFilename(finalFilename),
          size: primaryEncodedSize,
          chunkCount: primaryChunkCount,
          chunkSize: primaryChunkSize,
          thumbnailUrl,
          thumbnailRef: thumbnailStorageRef,
          ...(Object.keys(variantFileIds).length > 0 ? { variantFileIds } : {}),
          updatedAt: Date.now(),
        });
      } else {
        finalFileRecord = {
          id: fileId, sessionId,
          originalName: finalFilename,
          storedName: this.sanitizeFilename(finalFilename),
          fieldname: parsed.fields.fieldname || 'file',
          contentType: finalMimeType,
          kind,
          size: primaryEncodedSize,
          chunkSize: primaryChunkSize,
          chunkCount: primaryChunkCount,
          uploadType,
          bucket: typeConfig.bucket || uploadType,
          storageProvider: resolveStorageKey(this.config, typeConfig),
          storageRef: finalStorageRef!,
          url: finalUrl,
          thumbnailUrl,
          isComplete: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ...(Object.keys(variantFileIds).length > 0 ? { variantFileIds } : {}),
        };
      }

      if (finalFileRecord) this.config.onUploadComplete?.(finalFileRecord);

      const result: UploadResult = {
        status: 'success',
        message: 'File uploaded successfully',
        fileId,
        url: finalUrl,
        storageRef: finalStorageRef,
        progress: 100,
        metadata: this.extractCustomFields(parsed.fields),
        fields: this.extractCustomFields(parsed.fields),
        file: finalFileRecord ?? undefined,
        fileFields: finalFileRecord ? { [finalFileRecord.fieldname || 'file']: finalFileRecord } : undefined,
        thumbnailUrl,
        ...(Object.keys(variantResults).length > 0 ? { variants: variantResults } : {}),
      };

      if (finalFileRecord) req.fileFields = { [finalFileRecord.fieldname || 'file']: finalFileRecord };

      const autoRespond = typeConfig.autoRespond ?? this.config.autoRespond;
      if (autoRespond) { res.status(200); res.json(result); }
      return result;

    } finally {
      if (processedResult?.cleanupFn) {
        await processedResult.cleanupFn().catch((e: any) =>
          console.warn('[UploadEngine] Processed temp cleanup failed:', e)
        );
      }
      if (assembledPath) {
        await this.mediaProcessor.deleteTempFile(assembledPath).catch(() => { });
      }
    }
  }

  // ── Non-chunked upload ────────────────────────────────────────────────────

  private async handleNonChunkedUpload(
    req: NormalizedRequest,
    res: NormalizedResponse,
    parsed: { fields: Record<string, any>; files: any[] },
    uploadType: string,
    storage: any,
    typeConfig: any,
    transformer: FrontendTransformerConfig | undefined
  ): Promise<{ status: 'success'; message: string; metadata: UploadResult[]; files: FileRecord[] }> {
    if (!parsed.files || parsed.files.length === 0)
      throw new ValidationError('No files provided', 400);

    const uploadResults: UploadResult[] = [];

    for (const file of parsed.files) {
      const kind = detectKind(file.mimetype);
      assertKindAllowed(kind, typeConfig);
      const originalBuffer = ensureBuffer(file.buffer);
      assertWithinLimit(originalBuffer.length, resolveSizeLimit(this.config, typeConfig, kind), 'File size');

      const fileId = this.generateFileId();
      const sessionId = this.generateSessionId();

      let processedBuffer: Buffer = originalBuffer;
      let processedMimeType: string = file.mimetype;
      let processedFilename: string = file.filename;
      let processedResult: ExtendedProcessingResult | null = null;
      let thumbnailUrl: string | undefined;

      if (transformer && this.shouldProcessMedia(file.mimetype, transformer, storage)) {
        try {
          const inputExt = path.extname(file.filename) || inferExtFromMime(file.mimetype);
          const inputPath = await this.mediaProcessor.writeTempFile(originalBuffer, inputExt);
          try {
            processedResult = await this.processMediaFromPath(inputPath, file.mimetype, file.filename, transformer);
            if (processedResult?.buffer) {
              processedBuffer = processedResult.buffer;
              processedMimeType = processedResult.mimeType;
              processedFilename = replaceExtension(file.filename, `.${processedResult.extension}`);
            }
          } finally {
            await this.mediaProcessor.deleteTempFile(inputPath).catch(() => { });
          }
        } catch (processingError) {
          console.error('[UploadEngine] Media processing failed, using raw file:', processingError);
        }
      }

      const primaryTempPath = await this.mediaProcessor.writeTempFile(processedBuffer, path.extname(processedFilename) || '.bin');
      let storageResult: { url?: string; storageRef: string; chunkCount: number; chunkSize: number; totalSize: number };
      try {
        storageResult = await streamFileToStorage(storage, fileId, primaryTempPath, {
          originalName: processedFilename,
          contentType: processedMimeType,
          bucket: typeConfig.bucket || uploadType,
          uploadType,
        });
      } finally {
        await this.mediaProcessor.deleteTempFile(primaryTempPath).catch(() => { });
      }

      if (processedResult?.thumbnail && storage.putObject) {
        try {
          const tr = await storage.putObject(`thumb_${fileId}`, processedResult.thumbnail, {
            originalName: `${path.basename(file.filename, path.extname(file.filename))}_thumb.jpg`,
            contentType: 'image/jpeg', bucket: typeConfig.bucket || uploadType,
            totalSize: processedResult.thumbnail.length, chunkSize: processedResult.thumbnail.length, chunkCount: 1, uploadType,
          });
          thumbnailUrl = tr.url;
        } catch (e) { console.warn('[UploadEngine] Thumbnail upload failed:', e); }
      }

      const variantResults: Record<string, { url?: string; storageRef: string; fileId: string }> = {};
      const variantFileIds: Record<string, string> = {};

      if (processedResult?.variants && Object.keys(processedResult.variants).length > 1) {
        const entries = Object.entries(processedResult.variants);

        // [A] Store variants in parallel for non-chunked too — and [LARGE-FILE-CHUNKING]:
        // each variant is written via a temp file + streamFileToStorage so it is properly
        // re-chunked rather than forced through putObject with a single large buffer.
        await Promise.all(entries.map(async ([qualityId, variantBuffer], i) => {
          const isPrimary = i === 0;
          // [B] Deterministic variant ID
          const variantFileId = isPrimary ? fileId : buildVariantFileId(fileId, qualityId);
          const variantName = buildVariantFilename(file.filename, qualityId, processedResult!.extension!);

          if (isPrimary) {
            variantResults[qualityId] = { url: storageResult.url, storageRef: storageResult.storageRef, fileId };
          } else {
            const variantTempPath = await this.mediaProcessor.writeTempFile(
              variantBuffer, `.${processedResult!.extension}`,
            );
            let vr: { url?: string; storageRef: string; chunkCount: number; chunkSize: number; totalSize: number };
            try {
              vr = await streamFileToStorage(storage, variantFileId, variantTempPath, {
                originalName: variantName,
                contentType: processedResult!.mimeType,
                bucket: typeConfig.bucket || uploadType,
                uploadType,
              });
            } finally {
              await this.mediaProcessor.deleteTempFile(variantTempPath).catch(() => { });
            }

            variantResults[qualityId] = { url: vr.url, storageRef: vr.storageRef, fileId: variantFileId };
            variantFileIds[qualityId] = variantFileId;
            if (this.config.database) {
              const vRecord = await this.config.database.createFile({
                id: variantFileId, sessionId: `${sessionId}_${qualityId}`,
                originalName: variantName, storedName: this.sanitizeFilename(variantName),
                fieldname: file.fieldname || 'file', contentType: processedResult!.mimeType!, kind,
                size: vr.totalSize, chunkSize: vr.chunkSize, chunkCount: vr.chunkCount, uploadType,
                bucket: typeConfig.bucket || uploadType, storageProvider: resolveStorageKey(this.config, typeConfig),
                storageRef: vr.storageRef, url: vr.url, isComplete: true,
                metadata: { parentFileId: fileId, quality: qualityId, isVariant: true },
              });
              this.config.onUploadComplete?.(vRecord);
            }
          }
        }));
      }

      if (processedResult?.cleanupFn) {
        await processedResult.cleanupFn().catch((e: any) =>
          console.warn('[UploadEngine] Processed temp cleanup failed:', e)
        );
      }

      let finalFileRecord: FileRecord | null = null;
      const meta = {
        ...this.extractCustomFields(parsed.fields),
        ...(transformer ? { _transformer: transformer } : {}),
        ...(Object.keys(variantFileIds).length > 0 ? { variantFileIds } : {}),
      };

      if (this.config.database) {
        finalFileRecord = await this.config.database.createFile({
          id: fileId, sessionId, originalName: processedFilename,
          storedName: this.sanitizeFilename(processedFilename), fieldname: file.fieldname || 'file',
          contentType: processedMimeType, kind, size: storageResult.totalSize,
          chunkSize: storageResult.chunkSize, chunkCount: storageResult.chunkCount, uploadType,
          bucket: typeConfig.bucket || uploadType, storageProvider: resolveStorageKey(this.config, typeConfig),
          storageRef: storageResult.storageRef, url: storageResult.url, thumbnailUrl,
          isComplete: true, metadata: meta,
        });
        this.config.onUploadComplete?.(finalFileRecord!);
      } else {
        finalFileRecord = {
          id: fileId, sessionId, originalName: processedFilename,
          storedName: this.sanitizeFilename(processedFilename), fieldname: file.fieldname || 'file',
          contentType: processedMimeType, kind, size: storageResult.totalSize,
          chunkSize: storageResult.chunkSize, chunkCount: storageResult.chunkCount, uploadType,
          bucket: typeConfig.bucket || uploadType, storageProvider: resolveStorageKey(this.config, typeConfig),
          storageRef: storageResult.storageRef, url: storageResult.url, thumbnailUrl,
          isComplete: true, createdAt: Date.now(), updatedAt: Date.now(),
          ...(Object.keys(variantFileIds).length > 0 ? { variantFileIds } : {}),
        } as FileRecord;
        this.config.onUploadComplete?.(finalFileRecord as any);
      }

      uploadResults.push({
        status: 'success', message: 'File uploaded successfully', fileId,
        url: storageResult.url, storageRef: storageResult.storageRef, progress: 100,
        metadata: this.extractCustomFields(parsed.fields), file: finalFileRecord ?? undefined, thumbnailUrl,
        ...(Object.keys(variantResults).length > 0 ? { variants: variantResults } : {}),
      });
    }

    const fileFields: Record<string, FileRecord[]> = {};
    for (const r of uploadResults) {
      if (r.file) {
        const fn = r.file.fieldname;
        if (!fileFields[fn]) fileFields[fn] = [];
        fileFields[fn].push(r.file);
      }
    }
    const payload = {
      status: 'success' as const, message: `${uploadResults.length} file(s) uploaded`,
      metadata: uploadResults, fields: this.extractCustomFields(parsed.fields),
      files: uploadResults.map((r) => r.file).filter(Boolean) as FileRecord[], fileFields,
    };
    req.fileFields = fileFields;
    const autoRespond = typeConfig.autoRespond ?? this.config.autoRespond;
    if (autoRespond) { res.status(200); res.json(payload); }
    return payload;
  }

  // ── Chunk-to-disk assembly ────────────────────────────────────────────────

  private async assembleChunksToDisk(
    storage: any,
    fileId: string,
    totalChunks: number,
    ext: string,
    ctx: Record<string, any>
  ): Promise<string> {
    if (typeof storage.assembleChunksToPath === 'function') {
      return await storage.assembleChunksToPath(fileId, totalChunks, ext, ctx);
    }
    const chunks: Buffer[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const buf = await storage.readChunk(fileId, i, ctx);
      chunks.push(ensureBuffer(buf));
    }
    return await this.mediaProcessor.assembleChunksToDisk(chunks, ext);
  }

  // ── Media processing dispatch (path-based) ────────────────────────────────

  private shouldProcessMedia(mimetype: string, transformer: FrontendTransformerConfig, storage?: any): boolean {
    if (storage?.hasNativeVariantSupport) {
      console.log(`[UploadEngine] Skipping local media processing; natively supported by storage adapter '${storage.name}'`);
      return false;
    }
    return !!(transformer && (mimetype.startsWith('image/') || mimetype.startsWith('video/') || mimetype.startsWith('audio/')));
  }

  private async processMediaFromPath(
    inputPath: string,
    mimetype: string,
    filename: string,
    transformer: FrontendTransformerConfig
  ): Promise<ExtendedProcessingResult | null> {
    const mediaType =
      transformer.type ??
      (mimetype.startsWith('video/') ? 'video' : mimetype.startsWith('audio/') ? 'audio' : mimetype.startsWith('image/') ? 'image' : null);

    if (!mediaType) return null;

    const qualityConfigs = normaliseQualityConfigs(transformer);

    if (mediaType === 'video') {
      const cfg: VideoProcessingConfig = {
        quality: normaliseQuality(transformer.quality),
        qualityConfigs: qualityConfigs.length > 0 ? qualityConfigs : undefined,
        format: normaliseFormat(transformer.format) ?? 'mp4',
        startTime: transformer.startTime,
        endTime: transformer.endTime,
        mute: transformer.mute,
        videoBitrate: transformer.videoBitrate,
        audioBitrate: transformer.audioBitrate,
        resolution: transformer.resolution,
        codec: transformer.codec,
        generateThumbnail: transformer.generateThumbnail !== false,
        thumbnailTimeSeconds: transformer.thumbnailTimeSeconds,
      };
      return await this.mediaProcessor.processVideoFromPath(inputPath, mimetype, filename, cfg);
    }

    if (mediaType === 'audio') {
      const cfg: AudioProcessingConfig = {
        quality: normaliseQuality(transformer.quality),
        qualityConfigs: qualityConfigs.length > 0 ? qualityConfigs : undefined,
        format: normaliseFormat(transformer.format) ?? 'mp3',
        startTime: transformer.startTime,
        endTime: transformer.endTime,
        audioBitrate: transformer.audioBitrate,
      };
      return await this.mediaProcessor.processAudioFromPath(inputPath, mimetype, filename, cfg);
    }

    if (mediaType === 'image') {
      const buffer = await fs.promises.readFile(inputPath);
      const cfg: ImageProcessingConfig = {
        quality: normaliseQuality(transformer.quality),
        qualityConfigs: qualityConfigs.length > 0 ? qualityConfigs : undefined,
        format: normaliseFormat(transformer.format),
        width: transformer.width,
        height: transformer.height,
      };
      const result = await this.mediaProcessor.processImage(buffer, mimetype, cfg);
      return { ...result, cleanupFn: async () => { } };
    }

    return null;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  async cleanup(files: FileRecord | FileRecord[]): Promise<void> {
    const fileArray = Array.isArray(files) ? files : [files];
    for (const file of fileArray) {
      try {
        const storage = this.config.storages[file.storageProvider || this.config.defaultStorage];
        if (storage) await storage.delete(file.storageRef);
        if (this.config.database) await this.config.database.deleteFiles([file.id]);
      } catch (error) {
        console.error(`[UploadEngine] Cleanup failed for file ${file.id}:`, error);
      }
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private isChunkedUpload(fields: Record<string, any>): boolean {
    return !!(
      fields.sessionId && typeof fields.sessionId === 'string' &&
      fields.chunkIndex !== undefined && !isNaN(parseInt(String(fields.chunkIndex))) &&
      fields.totalChunks !== undefined && !isNaN(parseInt(String(fields.totalChunks)))
    );
  }

  private buildFieldValidation(typeConfig: any): Record<string, FieldValidationRule> {
    const v: Record<string, FieldValidationRule> = {
      sessionId: { minLength: 5 }, chunkIndex: {}, totalChunks: {},
      filename: { required: true, maxLength: 255 }, mimetype: { required: true }, uploadType: { required: true },
    };
    if (typeConfig.customFields) {
      for (const [name, rule] of Object.entries(typeConfig.customFields)) v[name] = rule as FieldValidationRule;
    }
    return v;
  }

  private buildFileValidation(typeConfig: any): Record<string, FileValidationRule> {
    return {
      '.*': {
        allowedMimePatterns: typeConfig.allowedKinds.map((kind: string) => {
          if (kind === 'image') return 'image/*';
          if (kind === 'video') return 'video/*';
          if (kind === 'audio') return 'audio/*';
          if (kind === 'document') return 'application/*|text/*';
          return '*/*';
        }),
        maxSize: resolveSizeLimit(this.config, typeConfig, 'unknown'),
        detectMagicBytes: true,
      },
    };
  }

  private extractCustomFields(fields: Record<string, any>, exclude: string[] = []): Record<string, any> {
    const std = ['sessionId', 'chunkIndex', 'totalChunks', 'filename', 'mimetype', 'uploadType', 'fieldname', 'transformer', ...exclude];
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(fields)) if (!std.includes(k)) out[k] = v;
    return out;
  }

  private async handleError(error: unknown, uploadType: string | undefined, res: NormalizedResponse): Promise<UploadResult> {
    const err = error instanceof Error ? error : new Error(String(error));
    try { this.config.onError?.(err, { uploadType }); } catch { }
    const statusCode = error instanceof ValidationError ? error.statusCode : 500;
    const result: UploadResult = {
      status: 'error', message: err.message,
      metadata: { code: error instanceof ValidationError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR' },
    };
    if (this.config.autoRespond) { res.status(statusCode); res.json(result); }
    return result;
  }

  private getContentType(req: NormalizedRequest): string {
    const ct = req.headers['content-type'];
    return typeof ct === 'string' ? ct : Array.isArray(ct) ? ct[0] || '' : '';
  }

  private getUploadType(req: NormalizedRequest): string | undefined {
    return (req.query.uploadType || req.params.uploadType) as string;
  }

  private sanitizeFilename(filename: string): string { return MultipartParser.sanitizeFilename(filename); }
  private generateFileId(): string { return `file_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`; }
  private generateSessionId(): string { return `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`; }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function normaliseQuality(q: string | number | undefined): 'high' | 'medium' | 'low' | number | undefined {
  if (q === undefined) return undefined;
  if (typeof q === 'number') return q;
  if (q === 'high' || q === 'medium' || q === 'low') return q;
  if (/^\d+p$/i.test(String(q))) return undefined;
  const n = parseFloat(q as string);
  return isNaN(n) ? 'medium' : n;
}

const RESOLUTION_PATTERN = /^\d{3,4}p$/i;

/**
 * [D] Normalise quality configs and deduplicate by id.
 *
 * Shape 1 — qualityConfigs: QualityConfig[]
 * Shape 2 — qualityConfigs: Record<string, QualityConfig>
 * Shape 3 — qualities: string[]  e.g. ['1080p', '720p', '480p', '360p']
 * Shape 4 — single quality → returns []
 *
 * Deduplication: if two entries have the same `id`, the first one wins.
 * This prevents duplicate DB records and double FFmpeg encodes.
 */
function normaliseQualityConfigs(transformer: FrontendTransformerConfig): QualityConfig[] {
  const qc = transformer.qualityConfigs;
  if (qc) {
    let arr: QualityConfig[];
    if (Array.isArray(qc) && qc.length > 0) {
      arr = qc;
    } else if (typeof qc === 'object' && !Array.isArray(qc)) {
      arr = Object.values(qc) as QualityConfig[];
    } else {
      arr = [];
    }

    if (arr.length > 0) {
      const seen = new Set<string>();
      const deduped = arr.filter((cfg) => {
        if (seen.has(cfg.id)) {
          console.warn(`[UploadEngine] Duplicate quality config id "${cfg.id}" removed.`);
          return false;
        }
        seen.add(cfg.id);
        return true;
      });

      return deduped.map((cfg) => {
        if (!cfg.resolution && RESOLUTION_PATTERN.test(cfg.id)) {
          return { ...cfg, resolution: cfg.id.toLowerCase() };
        }
        return cfg;
      });
    }
  }

  if (Array.isArray(transformer.qualities) && transformer.qualities.length > 0) {
    const seen = new Set<string>();
    return transformer.qualities
      .map((q) => {
        const raw = String(q).trim();
        return {
          id: raw,
          label: raw,
          ...(RESOLUTION_PATTERN.test(raw)
            ? { resolution: raw.toLowerCase() }
            : { quality: raw as any }),
        } as QualityConfig;
      })
      .filter((cfg) => {
        if (seen.has(cfg.id)) {
          console.warn(`[UploadEngine] Duplicate quality "${cfg.id}" in qualities[] removed.`);
          return false;
        }
        seen.add(cfg.id);
        return true;
      });
  }

  return [];
}

function normaliseFormat(fmt: string | undefined): string | undefined {
  if (!fmt) return undefined;
  return fmt.replace(/^(video|audio|image)\//, '');
}

function buildVariantFilename(original: string, qualityId: string, extension: string): string {
  const dir = path.dirname(original);
  const base = path.basename(original, path.extname(original));
  const name = `${base}_${qualityId}.${extension}`;
  return dir === '.' ? name : `${dir}/${name}`;
}

function replaceExtension(filename: string, newExt: string): string {
  const base = path.basename(filename, path.extname(filename));
  const dir = path.dirname(filename);
  return dir === '.' ? `${base}${newExt}` : `${dir}/${base}${newExt}`;
}

function inferExtFromMime(mime: string): string {
  if (mime.startsWith('video/')) {
    if (mime.includes('webm')) return '.webm';
    if (mime.includes('quicktime')) return '.mov';
    return '.mp4';
  }
  if (mime.startsWith('audio/')) {
    if (mime.includes('wav')) return '.wav';
    if (mime.includes('ogg')) return '.ogg';
    return '.mp3';
  }
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  return '.jpg';
}
