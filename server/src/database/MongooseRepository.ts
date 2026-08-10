/**
 * @upload-media/server - MongooseRepository
 *
 * Implements MetadataRepository using Mongoose + MongoDB.
 * Handles both file records and chunks (if using DatabaseStorageAdapter).
 * Supports hooks for caching, logging, validation, transformation.
 */
//@ts-nocheck
import mongoose, { Schema, Model, Document } from 'mongoose';
import {
  FileRecord,
  NewFileRecord,
  FileRecordPatch,
  FileQuery,
  ChunkRecord,
  MetadataRepository,
} from '../types';
import { DatabaseHooks, HookContext } from '../hooks/types';

export interface MongooseRepositoryOptions {
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

export class MongooseRepository implements MetadataRepository {
  private fileModel: Model<any>;
  private chunkModel: Model<any>;
  private hooks?: DatabaseHooks;

  constructor(options: MongooseRepositoryOptions) {
    const {
      mongooseConnection,
      hooks,
      fileModel,
      chunkModel,
      fileSchemaExtensions,
      onFileSchemaInit,
      wrapFileModel,
      onChunkSchemaInit,
      wrapChunkModel
    } = options;
    this.hooks = hooks;

    // Initialize File Model
    if (fileModel) {
      this.fileModel = fileModel;
    } else {
      const model = MongooseRepository.getOrCreateFileModel(mongooseConnection, fileSchemaExtensions, onFileSchemaInit);
      this.fileModel = wrapFileModel ? wrapFileModel(model) : model;
    }

    // Initialize Chunk Model
    if (chunkModel) {
      this.chunkModel = chunkModel;
    } else {
      const model = MongooseRepository.getOrCreateChunkModel(mongooseConnection, onChunkSchemaInit);
      this.chunkModel = wrapChunkModel ? wrapChunkModel(model) : model;
    }
  }

  private static getOrCreateFileModel(connection: mongoose.Connection, extensions?: any, onInit?: (schema: Schema) => void): Model<any> {
    if (connection.models['File']) return connection.models['File'];

    const schemaDefinition = {
      id: { type: String, required: true, unique: true, index: true },
      sessionId: { type: String, required: true, index: true },
      originalName: String,
      storedName: String,
      fieldname: String,
      contentType: String,
      kind: String,
      size: Number,
      chunkSize: Number,
      chunkCount: Number,
      uploadType: { type: String, index: true },
      bucket: String,
      storageProvider: String,
      storageRef: String,
      url: String,
      thumbnailUrl: String,
      thumbnailRef: String,
      userId: { type: String, index: true },
      isComplete: { type: Boolean, default: false, index: true },
      metadata: Schema.Types.Mixed,
    };

    const fileSchema = new Schema(
      { ...schemaDefinition, ...(extensions || {}) },
      { timestamps: true }
    );

    fileSchema.index({ sessionId: 1, uploadType: 1 });
    fileSchema.index({ createdAt: -1 });

    if (onInit) onInit(fileSchema);

    return connection.model('File', fileSchema, 'uploads_files');
  }

  private static getOrCreateChunkModel(connection: mongoose.Connection, onInit?: (schema: Schema) => void): Model<any> {
    if (connection.models['Chunk']) return connection.models['Chunk'];

    const chunkSchema = new Schema(
      {
        fileId: { type: String, required: true, index: true },
        chunkNumber: { type: Number, required: true },
        data: Buffer,
      },
      { timestamps: true }
    );

    chunkSchema.index({ fileId: 1, chunkNumber: 1 }, { unique: true });

    if (onInit) onInit(chunkSchema);

    return connection.model('Chunk', chunkSchema, 'uploads_chunks');
  }

  private createHookContext(): HookContext {
    return { timestamp: Date.now() };
  }

  async createFile(file: NewFileRecord): Promise<FileRecord> {
    const ctx = this.createHookContext();

    // Before hook
    if (this.hooks?.beforeCreateFile) {
      const result = await this.hooks.beforeCreateFile(file, ctx);
      if (result) return result;
    }

    const doc = await this.fileModel.create({
      ...file,
      id: file.id || `file_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const record = this.docToRecord(doc);

    // After hook
    if (this.hooks?.afterCreateFile) {
      return this.hooks.afterCreateFile(record, ctx);
    }

    return record;
  }

  async getFileBySessionId(sessionId: string): Promise<FileRecord | null> {
    const ctx = this.createHookContext();
    ctx.metadata = { sessionId };

    // Before hook
    if (this.hooks?.beforeGetFileBySessionId) {
      const result = await this.hooks.beforeGetFileBySessionId(sessionId, ctx);
      if (result) return result;
    }

    const doc = await this.fileModel.findOne({ sessionId }).lean();
    const file = doc ? this.docToRecord(doc) : null;

    // After hook
    if (this.hooks?.afterGetFileBySessionId) {
      return this.hooks.afterGetFileBySessionId(file, ctx);
    }

    return file;
  }

  async getFileById(id: string): Promise<FileRecord | null> {
    const ctx = this.createHookContext();

    // Before hook
    if (this.hooks?.beforeGetFileById) {
      const result = await this.hooks.beforeGetFileById(id, ctx);
      if (result) return result;
    }

    const doc = await this.fileModel.findOne({ id }).lean();
    const file = doc ? this.docToRecord(doc) : null;

    // After hook
    if (this.hooks?.afterGetFileById) {
      return this.hooks.afterGetFileById(file, ctx);
    }

    return file;
  }

  async updateFile(id: string, patch: FileRecordPatch): Promise<FileRecord | null> {
    const ctx = this.createHookContext();

    // Before hook
    if (this.hooks?.beforeUpdateFile) {
      const result = await this.hooks.beforeUpdateFile(id, patch, ctx);
      if (result) return result;
    }

    const doc = await this.fileModel.findOneAndUpdate(
      { id },
      { ...patch, updatedAt: new Date() },
      { new: true }
    ).lean();
    const file = doc ? this.docToRecord(doc) : null;

    // After hook
    if (this.hooks?.afterUpdateFile) {
      return this.hooks.afterUpdateFile(file, ctx);
    }

    return file;
  }

  async findFiles(query: FileQuery): Promise<FileRecord[]> {
    const ctx = this.createHookContext();
    ctx.originalQuery = query;

    // Before hook
    if (this.hooks?.beforeFindFiles) {
      const result = await this.hooks.beforeFindFiles(query, ctx);
      if (result) return result;
    }

    const mongoQuery: Record<string, any> = {};

    if (query.sessionId) mongoQuery.sessionId = query.sessionId;
    if (query.sessionIds) mongoQuery.sessionId = { $in: query.sessionIds };
    if (query.ids) mongoQuery.id = { $in: query.ids };
    if (query.uploadType) mongoQuery.uploadType = query.uploadType;
    if (query.userId) mongoQuery.userId = query.userId;
    if (query.isComplete !== undefined) mongoQuery.isComplete = query.isComplete;

    let q = this.fileModel.find(mongoQuery).lean();

    if (query.skip) q = q.skip(query.skip);
    if (query.limit) q = q.limit(query.limit);

    const docs = await q.sort({ createdAt: -1 });
    const results = docs.map((doc: any) => this.docToRecord(doc));

    // After hook
    if (this.hooks?.afterFindFiles) {
      return this.hooks.afterFindFiles(results, ctx);
    }

    return results;
  }

  async deleteFiles(ids: string[]): Promise<number> {
    const ctx = this.createHookContext();

    // Before hook
    if (this.hooks?.beforeDeleteFiles) {
      const result = await this.hooks.beforeDeleteFiles(ids, ctx);
      if (result !== null && result !== undefined) return result;
    }

    const deleteResult = await this.fileModel.deleteMany({ id: { $in: ids } });
    const count = deleteResult.deletedCount || 0;

    // After hook
    if (this.hooks?.afterDeleteFiles) {
      return this.hooks.afterDeleteFiles(count, ctx);
    }

    return count;
  }

  async createChunk(chunk: ChunkRecord): Promise<void> {
    const ctx = this.createHookContext();

    let chunkToStore = chunk;

    // Before hook
    if (this.hooks?.beforeCreateChunk) {
      chunkToStore = await this.hooks.beforeCreateChunk(chunk, ctx);
    }

    // Use findOneAndUpdate with upsert to prevent duplicate key errors
    await this.chunkModel.findOneAndUpdate(
      {
        fileId: chunkToStore.fileId,
        chunkNumber: chunkToStore.chunkNumber
      },
      {
        $set: chunkToStore,
        $setOnInsert: { createdAt: new Date() }
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      }
    );

    // After hook
    if (this.hooks?.afterCreateChunk) {
      await this.hooks.afterCreateChunk(chunkToStore, ctx);
    }
  }

  async createChunks(chunks: ChunkRecord[]): Promise<void> {
    const ctx = this.createHookContext();
    const processedChunks: ChunkRecord[] = [];

    for (const chunk of chunks) {
      let chunkToStore = chunk;
      if (this.hooks?.beforeCreateChunk) {
        chunkToStore = await this.hooks.beforeCreateChunk(chunk, ctx);
      }
      processedChunks.push(chunkToStore);
    }

    const bulkOps = processedChunks.map((chunk) => ({
      updateOne: {
        filter: { fileId: chunk.fileId, chunkNumber: chunk.chunkNumber },
        update: {
          $set: chunk,
          $setOnInsert: { createdAt: new Date() },
        },
        upsert: true,
      },
    }));

    if (bulkOps.length > 0) {
      await this.chunkModel.bulkWrite(bulkOps, { ordered: false });
    }

    if (this.hooks?.afterCreateChunk) {
      for (const chunk of processedChunks) {
        await this.hooks.afterCreateChunk(chunk, ctx);
      }
    }
  }

  async getChunk(fileId: string, chunkNumber: number): Promise<Buffer | null> {
    const ctx = this.createHookContext();

    // Before hook
    if (this.hooks?.beforeGetChunk) {
      const result = await this.hooks.beforeGetChunk(fileId, chunkNumber, ctx);
      if (result) return result;
    }

    const doc = await this.chunkModel.findOne({ fileId, chunkNumber }).lean();
    const data = (doc as any)?.data || null;

    // After hook
    if (this.hooks?.afterGetChunk) {
      return this.hooks.afterGetChunk(data, ctx);
    }

    return data;
  }

  async deleteChunksByFileId(fileId: string): Promise<number> {
    const ctx = this.createHookContext();

    // Before hook
    if (this.hooks?.beforeDeleteChunksByFileId) {
      const result = await this.hooks.beforeDeleteChunksByFileId(fileId, ctx);
      if (result !== null && result !== undefined) return result;
    }

    const deleteResult = await this.chunkModel.deleteMany({ fileId });
    const count = deleteResult.deletedCount || 0;

    // After hook
    if (this.hooks?.afterDeleteChunksByFileId) {
      return this.hooks.afterDeleteChunksByFileId(count, ctx);
    }

    return count;
  }

  private docToRecord(doc: any): FileRecord {
    return {
      id: doc.id,
      sessionId: doc.sessionId,
      originalName: doc.originalName,
      storedName: doc.storedName,
      fieldname: doc.fieldname,
      contentType: doc.contentType,
      kind: doc.kind,
      size: doc.size,
      chunkSize: doc.chunkSize,
      chunkCount: doc.chunkCount,
      uploadType: doc.uploadType,
      bucket: doc.bucket,
      storageProvider: doc.storageProvider,
      storageRef: doc.storageRef,
      url: doc.url,
      thumbnailUrl: doc.thumbnailUrl,
      thumbnailRef: doc.thumbnailRef,
      userId: doc.userId,
      isComplete: doc.isComplete,
      metadata: doc.metadata,
      createdAt: doc.createdAt?.getTime() || Date.now(),
      updatedAt: doc.updatedAt?.getTime() || Date.now(),
    };
  }
}
