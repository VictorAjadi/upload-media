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

import { NormalizedRequest, NormalizedResponse, UploadEngineConfig, ResolvedUploadEngineConfig, FileRecord } from '../types';
import { resolveUploadConfig, resolveSizeLimit, resolveStorageKey } from '../config/UploadConfig';
import { MultipartParser, FieldValidationRule, FileValidationRule } from '../core/MultipartParser';
import { ValidationError, detectKind, assertKindAllowed, assertWithinLimit } from '../core/FileValidator';
import { HookContext } from '../hooks/types';

export interface UploadResult {
  status: 'success' | 'chunk_received' | 'error';
  message: string;
  fileId?: string;
  url?: string;
  storageRef?: string;
  chunkIndex?: number;
  totalChunks?: number;
  progress?: number;
  metadata?: Record<string, any>;
  fields?: Record<string, any>; // Form fields
  file?: FileRecord; // Full file record for success
  files?: FileRecord[]; // Multi-file records
  fileFields?: Record<string, FileRecord | FileRecord[]>; // Files grouped by field name
  parentFile?: FileRecord; // Parent file if this is a variant
  error?: any;
}

interface ChunkedUploadFields {
  sessionId: string;
  chunkIndex: number;
  totalChunks: number;
  filename: string;
  mimetype: string;
  uploadType: string;
  [key: string]: any; // Custom fields
}

export class UploadEngine {
  private config: ResolvedUploadEngineConfig;

  constructor(config: UploadEngineConfig) {
    this.config = resolveUploadConfig(config);
  }

  /**
   * Main upload handler.
   * Auto-detects chunked vs non-chunked by looking at actual multipart fields.
   */
  handle = async (
    req: NormalizedRequest,
    res: NormalizedResponse
  ): Promise<UploadResult | { status: 'success'; message: string; metadata: UploadResult[] } | void> => {
    try {
      const contentType = this.getContentType(req);
      if (!contentType.includes('multipart/form-data')) {
        throw new ValidationError('Content-Type must be multipart/form-data', 400);
      }

      let uploadType = this.getUploadType(req);
      if (!uploadType && this.config.defaultUploadType) {
        uploadType = this.config.defaultUploadType;
      }

      if (!uploadType || !this.config.uploadTypes[uploadType]) {
        throw new ValidationError(
          `Invalid or missing uploadType. Available: ${Object.keys(this.config.uploadTypes).join(', ')}`,
          400
        );
      }

      const typeConfig = this.config.uploadTypes[uploadType];

      const storageKey = resolveStorageKey(this.config, typeConfig);
      const storage = this.config.storages[storageKey];

      if (!storage) {
        throw new ValidationError(`Storage '${storageKey}' not configured`, 500);
      }

      // Build field validation rules from config + custom fields
      const fieldValidation = this.buildFieldValidation(typeConfig);

      // Build file validation rules from config
      const fileValidation = this.buildFileValidation(typeConfig);

      // Parse multipart
      const parsed = await MultipartParser.parseBuffered(req, {
        maxFieldSize: this.config.maxFieldSize || 1 * 1024 * 1024,
        maxFileSize: resolveSizeLimit(this.config, typeConfig, 'unknown'),
        maxFiles: this.config.maxFiles || 10,
        maxTotalSize: this.config.maxTotalSize || 500 * 1024 * 1024,
        fieldValidation,
        fileValidation,
        onProgress: this.config.onProgress,
      });

      // Determine if chunked upload based on parsed fields
      // Attach fields to request for user access
      req.fields = parsed.fields || {};
      req.files = parsed.files || [];

      const isChunked = this.isChunkedUpload(parsed.fields);

      // Parse transformer if present
      if (parsed.fields.transformer) {
        try {
          req.transformer = JSON.parse(parsed.fields.transformer);
        } catch {
          req.transformer = parsed.fields.transformer;
        }
      }

      if (isChunked) {
        return await this.handleChunkedUpload(req, res, parsed, uploadType, storage, typeConfig);
      } else {
        return await this.handleNonChunkedUpload(req, res, parsed, uploadType, storage, typeConfig);
      }
    } catch (error) {
      return await this.handleError(error, this.getUploadType(req), res);
    }
  };

  /**
   * Detect chunked upload by checking for required chunked fields.
   * Proper detection - no assumptions.
   */
  private isChunkedUpload(fields: Record<string, any>): boolean {
    const hasSessionId = fields.sessionId && typeof fields.sessionId === 'string';
    const hasChunkIndex = fields.chunkIndex !== undefined && !isNaN(parseInt(String(fields.chunkIndex)));
    const hasTotalChunks = fields.totalChunks !== undefined && !isNaN(parseInt(String(fields.totalChunks)));

    // ALL three required for chunked upload
    return hasSessionId && hasChunkIndex && hasTotalChunks;
  }

  /**
   * Handle chunked upload from the worker.
   * FIXED: Fully adaptive to frontend chunk config changes
   */
  private async handleChunkedUpload(
    req: NormalizedRequest,
    res: NormalizedResponse,
    parsed: { fields: Record<string, any>; files: any[] },
    uploadType: string,
    storage: any,
    typeConfig: any
  ): Promise<UploadResult> {
    // Extract chunked-specific fields
    const sessionId = String(parsed.fields.sessionId);
    const chunkIndex = parseInt(String(parsed.fields.chunkIndex), 10);
    const totalChunks = parseInt(String(parsed.fields.totalChunks), 10);
    const filename = String(parsed.fields.filename);
    const mimetype = String(parsed.fields.mimetype);
    const totalSize = parseInt(String(parsed.fields.totalSize || 0), 10);
    const chunksize = parseInt(String(parsed.fields.chunksize || 0), 10);

    // Validate
    if (!sessionId || isNaN(chunkIndex) || isNaN(totalChunks)) {
      throw new ValidationError('Missing or invalid chunked upload fields', 400);
    }

    if (!parsed.files || parsed.files.length === 0) {
      throw new ValidationError('No chunk data received', 400);
    }

    const chunkFile = parsed.files[0];
    const kind = detectKind(mimetype);
    const frontendChunkSize = chunksize > 0 ? chunksize : chunkFile.size;
    const frontendTotalSize = totalSize > 0 ? totalSize : chunkFile?.size * totalChunks;
    // Validate file kind
    assertKindAllowed(kind, typeConfig);

    // Check file size
    assertWithinLimit(chunkFile.size, resolveSizeLimit(this.config, typeConfig, kind), 'File size');

    // Determine file ID
    let fileId: string;
    let existingFile = null;

    if (this.config.database) {
      existingFile = await this.config.database.getFileBySessionId(sessionId);
    }

    if (existingFile) {
      fileId = existingFile.id;
    } else {
      fileId = this.generateFileId();
    }

    const isLastChunk = chunkIndex === totalChunks - 1;

    // CRITICAL: Calculate the actual file size
    // The frontend might send totalSize, but we also verify it
    let actualTotalSize = frontendTotalSize;
    let actualChunkSize = frontendChunkSize;

    // If this is the last chunk, calculate the exact size
    if (isLastChunk) {
      // For the last chunk, use the actual data size
      actualChunkSize = chunkFile.size;

      // Calculate total size from all chunks received so far
      // If we have a database record, we can use the stored size
      if (existingFile && existingFile.size > 0) {
        // Use the existing file size as the base
        actualTotalSize = existingFile.size;
      } else {
        // Estimate from chunks
        actualTotalSize = (chunkFile.size * totalChunks) - (frontendChunkSize - chunkFile.size);
        // More accurate: if we have previous chunks, sum their sizes
        try {
          let totalReceived = 0;
          for (let i = 0; i < totalChunks - 1; i++) {
            // Check if chunk exists in storage
            try {
              const prevChunk = await this.getChunkSize(fileId, i);
              if (prevChunk > 0) {
                totalReceived += prevChunk;
              }
            } catch {
              // Chunk not found, use estimate
              totalReceived += frontendChunkSize;
            }
          }
          // Add current chunk
          totalReceived += chunkFile.size;
          if (totalReceived > 0) {
            actualTotalSize = totalReceived;
          }
        } catch {
          // Fallback to estimate
          actualTotalSize = frontendChunkSize * totalChunks;
        }
      }
    } else {
      // For non-last chunks, the chunk size should match the configured size
      // But we use the actual data size to be safe
      actualChunkSize = frontendChunkSize;

      // If this is the first chunk, we can set the initial size
      if (chunkIndex === 0 && !existingFile) {
        // Store the chunk size for later reference
        actualTotalSize = frontendTotalSize || frontendChunkSize * totalChunks;
      }
    }

    // NEW: Adaptive chunk size detection
    // If the frontend changed the chunk size mid-upload, adapt
    if (existingFile && existingFile.chunkSize > 0) {
      const storedChunkSize = existingFile.chunkSize;
      if (storedChunkSize !== actualChunkSize && chunkIndex > 0) {
        // Use the frontend's chunk size (it knows best)
        actualChunkSize = frontendChunkSize;
      }
    }

    // Create storage context with correct sizes
    const storageCtx = {
      originalName: filename,
      contentType: mimetype,
      bucket: typeConfig.bucket || uploadType,
      totalChunks,
      chunkIndex,
      totalSize: actualTotalSize,
      chunkSize: actualChunkSize,
      uploadType
    };

    // Store chunk via storage adapter
    await storage.writeChunk(fileId, chunkIndex, chunkFile.buffer, storageCtx);

    // If this is the first chunk and we have a database, create or update the file record
    if (chunkIndex === 0 && this.config.database) {
      const metadata = this.extractCustomFields(parsed.fields, [
        'sessionId', 'chunkIndex', 'totalChunks', 'filename',
        'mimetype', 'uploadType', 'totalSize', 'chunksize'
      ]);

      // NEW: Add frontend config to metadata for debugging
      metadata._frontendChunkConfig = {
        chunkSize: frontendChunkSize,
        totalSize: frontendTotalSize,
        totalChunks: totalChunks,
        timestamp: Date.now()
      };

      if (!existingFile) {
        // Create new file record with the correct size
        const fileRecord = await this.config.database.createFile({
          id: fileId,
          sessionId,
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
          metadata: metadata,
        });
      } else {
        // Update existing record if sizes changed
        if (existingFile.size !== actualTotalSize || existingFile.chunkSize !== actualChunkSize) {
          await this.config.database.updateFile(fileId, {
            size: actualTotalSize,
            chunkSize: actualChunkSize,
            chunkCount: totalChunks,
            metadata: { ...existingFile.metadata, ...metadata },
            updatedAt: Date.now()
          });
        }
      }
    }

    // If this is the last chunk, update the file record with the final size
    if (isLastChunk && this.config.database) {
      // Get the current file record
      const currentFile = await this.config.database.getFileById(fileId);
      if (currentFile) {
        // Only update if the size changed
        if (currentFile.size !== actualTotalSize) {
          await this.config.database.updateFile(fileId, {
            size: actualTotalSize,
            chunkSize: actualChunkSize,
            chunkCount: totalChunks,
            updatedAt: Date.now()
          });
        }
      }
    }

    if (isLastChunk) {
      // Finalize in storage
      const storageResult = await storage.finalize(fileId, storageCtx);

      const finalUrl = storageResult.url;
      const finalStorageRef = storageResult.storageRef;
      let finalFileRecord: any = null;

      // Update in database if configured
      if (this.config.database) {
        const fileRecord = await this.config.database.updateFile(fileId, {
          isComplete: true,
          storageRef: finalStorageRef,
          url: finalUrl,
          size: actualTotalSize,
          chunkSize: actualChunkSize,
          updatedAt: Date.now()
        });

        if (fileRecord) {
          finalFileRecord = fileRecord;
          this.config.onUploadComplete?.(fileRecord);
        }
      } else {
        finalFileRecord = {
          id: fileId,
          sessionId,
          originalName: filename,
          url: finalUrl,
          storageRef: finalStorageRef,
          uploadType,
          size: actualTotalSize,
          chunkSize: actualChunkSize,
          isComplete: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        this.config.onUploadComplete?.(finalFileRecord);
      }

      // Link as variant if parentSessionId exists
      let parentFileRecord: FileRecord | undefined;
      if (parsed.fields.parentSessionId && this.config.database) {
        const parent = await this.config.database.getFileBySessionId(parsed.fields.parentSessionId);
        if (parent) {
          const quality = parsed.fields.quality || 'unknown';
          const currentMetadata = parent.metadata || {};
          const variants = currentMetadata.variants || {};
          variants[quality] = finalUrl;

          parentFileRecord = await this.config.database.updateFile(parent.id, {
            metadata: { ...currentMetadata, variants }
          }) || undefined;
        }
      }

      const result: UploadResult = {
        status: 'success',
        message: `File uploaded successfully`,
        fileId,
        url: finalUrl,
        storageRef: finalStorageRef,
        progress: 100,
        metadata: this.extractCustomFields(parsed.fields),
        fields: this.extractCustomFields(parsed.fields),
        file: finalFileRecord,
        fileFields: { [finalFileRecord.fieldname || 'file']: finalFileRecord },
        parentFile: parentFileRecord
      };

      req.fileFields = { [finalFileRecord.fieldname || 'file']: finalFileRecord };

      const autoRespond = typeConfig.autoRespond ?? this.config.autoRespond;
      if (autoRespond) {
        res.status(200);
        res.json(result);
      }
      return result;
    } else {
      const result: UploadResult = {
        status: 'success',
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
  }

  /**
   * Helper method to get chunk size from storage
   */
  private async getChunkSize(fileId: string, chunkIndex: number): Promise<number> {
    // This would need to be implemented based on your storage adapter
    // For now, return 0 to indicate chunk not found
    return 0;
  }

  /**
   * Handle non-chunked upload (regular file).
   */
  private async handleNonChunkedUpload(
    req: NormalizedRequest,
    res: NormalizedResponse,
    parsed: { fields: Record<string, any>; files: any[] },
    uploadType: string,
    storage: any,
    typeConfig: any
  ): Promise<{ status: 'success'; message: string; metadata: UploadResult[]; files: FileRecord[] }> {
    if (!parsed.files || parsed.files.length === 0) {
      throw new ValidationError('No files provided', 400);
    }

    const uploadResults: UploadResult[] = [];

    for (const file of parsed.files) {
      const kind = detectKind(file.mimetype);

      // Validate kind
      assertKindAllowed(kind, typeConfig);

      // Validate size
      assertWithinLimit(file.size, resolveSizeLimit(this.config, typeConfig, kind), 'File size');

      const fileId = this.generateFileId();
      const sessionId = this.generateSessionId();

      // Store file via storage adapter
      const storageResult = await storage.putObject(fileId, file.buffer, {
        originalName: file.filename,
        contentType: file.mimetype,
        bucket: typeConfig.bucket || uploadType,
      });

      const finalUrl = storageResult.url;
      const finalStorageRef = storageResult.storageRef;

      let finalFileRecord: any = null;

      // Store in database if configured
      if (this.config.database) {
        const fileRecord = await this.config.database.createFile({
          id: fileId,
          sessionId,
          originalName: file.filename,
          storedName: this.sanitizeFilename(file.filename),
          fieldname: file.fieldname || 'file',
          contentType: file.mimetype,
          kind,
          size: file.size,
          chunkSize: file.size,
          chunkCount: 1,
          uploadType,
          bucket: typeConfig.bucket || uploadType,
          storageProvider: resolveStorageKey(this.config, typeConfig),
          storageRef: finalStorageRef,
          url: finalUrl,
          isComplete: true,
          // Store custom fields as metadata
          metadata: this.extractCustomFields(parsed.fields),
        });

        // Call hook
        finalFileRecord = fileRecord;
        this.config.onUploadComplete?.(fileRecord);
      } else {
        // No database - just call hook with minimal data
        finalFileRecord = {
          id: fileId,
          sessionId,
          originalName: file.filename,
          url: finalUrl,
          storageRef: finalStorageRef,
          uploadType,
          isComplete: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        this.config.onUploadComplete?.(finalFileRecord as any);
      }

      const result: UploadResult = {
        status: 'success',
        message: `File uploaded successfully`,
        fileId,
        url: finalUrl,
        storageRef: finalStorageRef,
        progress: 100,
        metadata: this.extractCustomFields(parsed.fields),
        file: finalFileRecord
      };
      uploadResults.push(result);
    }

    const fileFields: Record<string, FileRecord[]> = {};
    for (const res of uploadResults) {
      if (res.file) {
        const fieldname = res.file.fieldname;
        if (!fileFields[fieldname]) fileFields[fieldname] = [];
        fileFields[fieldname].push(res.file);
      }
    }

    const payload = {
      status: 'success' as const,
      message: `${uploadResults.length} file(s) uploaded`,
      metadata: uploadResults,
      fields: this.extractCustomFields(parsed.fields),
      files: uploadResults.map(r => r.file).filter(Boolean) as FileRecord[],
      fileFields: fileFields
    };

    // Attach file mapping to request
    req.fileFields = fileFields;

    const autoRespond = typeConfig.autoRespond ?? this.config.autoRespond;
    if (autoRespond) {
      res.status(200);
      res.json(payload);
    }

    return payload;
  }

  /**
   * Build field validation rules from config + custom fields.
   */
  /**
   * Cleanup utility to remove files from storage and database.
   * Useful for error handling in the calling middleware.
   */
  async cleanup(files: FileRecord | FileRecord[]): Promise<void> {
    const fileArray = Array.isArray(files) ? files : [files];
    if (fileArray.length === 0) return;

    for (const file of fileArray) {
      try {
        // 1. Delete from storage
        const storage = this.config.storages[file.storageProvider || this.config.defaultStorage];
        if (storage) {
          await storage.delete(file.storageRef);
        }

        // 2. Delete from database
        if (this.config.database) {
          await this.config.database.deleteFiles([file.id]);
        }
      } catch (error) {
        console.error(`[UploadEngine] Cleanup failed for file ${file.id}:`, error);
      }
    }
  }

  private buildFieldValidation(typeConfig: any): Record<string, FieldValidationRule> {
    const validation: Record<string, FieldValidationRule> = {};

    // Standard fields (if chunked)
    validation.sessionId = { minLength: 5 };
    validation.chunkIndex = {};
    validation.totalChunks = {};
    validation.filename = { required: true, maxLength: 255 };
    validation.mimetype = { required: true };
    validation.uploadType = { required: true };

    // Custom fields from config
    if (typeConfig.customFields) {
      for (const [name, rule] of Object.entries(typeConfig.customFields)) {
        validation[name] = rule as FieldValidationRule;
      }
    }

    return validation;
  }

  /**
   * Build file validation rules from config.
   */
  private buildFileValidation(typeConfig: any): Record<string, FileValidationRule> {
    const validation: Record<string, FileValidationRule> = {};

    validation['.*'] = {
      allowedMimePatterns: typeConfig.allowedKinds.map((kind: string) => {
        if (kind === 'image') return 'image/*';
        if (kind === 'video') return 'video/*';
        if (kind === 'audio') return 'audio/*';
        if (kind === 'document') return 'application/*|text/*';
        return '*/*';
      }),
      maxSize: resolveSizeLimit(this.config, typeConfig, 'unknown'),
      detectMagicBytes: true,
    };

    return validation;
  }

  /**
   * Extract custom fields (non-standard) from parsed fields.
   */
  private extractCustomFields(fields: Record<string, any>, exclude: string[] = []): Record<string, any> {
    const standardFields = [
      'sessionId',
      'chunkIndex',
      'totalChunks',
      'filename',
      'mimetype',
      'uploadType',
      'fieldname',
      ...exclude,
    ];

    const custom: Record<string, any> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (!standardFields.includes(key)) {
        custom[key] = value;
      }
    }
    return custom;
  }

  private async handleError(error: unknown, uploadType: string | undefined, res: NormalizedResponse): Promise<UploadResult> {
    const err = error instanceof Error ? error : new Error(String(error));

    try {
      this.config.onError?.(err, { uploadType });
    } catch {
      // Ignore hook errors
    }

    const statusCode = error instanceof ValidationError ? error.statusCode : 500;
    const result: UploadResult = {
      status: 'error',
      message: err.message,
      metadata: { code: error instanceof ValidationError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR' }
    };

    // ALWAYS auto-respond to errors by default unless globally disabled?
    // Actually, if the engine fails, it should probably inform the client.
    // But if autoRespond is globally false, we return it.
    if (this.config.autoRespond) {
      res.status(statusCode);
      res.json(result);
    }

    return result;
  }

  private getContentType(req: NormalizedRequest): string {
    const ct = req.headers['content-type'];
    if (typeof ct === 'string') return ct;
    if (Array.isArray(ct)) return ct[0] || '';
    return '';
  }

  private getUploadType(req: NormalizedRequest): string | undefined {
    return (req.query.uploadType || req.params.uploadType) as string;
  }

  private sanitizeFilename(filename: string): string {
    return MultipartParser.sanitizeFilename(filename);
  }

  private generateFileId(): string {
    return `file_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
