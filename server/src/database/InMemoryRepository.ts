/**
 * @upload-media/server - InMemoryRepository
 *
 * A simple in-memory implementation of MetadataRepository, perfect for
 * testing, local development, or small deployments without a database.
 * Data is lost when the process exits.
 */

import {
  FileRecord,
  NewFileRecord,
  FileRecordPatch,
  FileQuery,
  ChunkRecord,
  MetadataRepository,
} from '../types';

export class InMemoryRepository implements MetadataRepository {
  private files = new Map<string, FileRecord>();
  private chunks = new Map<string, Buffer>(); // key = `fileId:chunkNumber`

  async createFile(file: NewFileRecord): Promise<FileRecord> {
    const id = file.id || `file_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const record: FileRecord = {
      ...file,
      id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.files.set(id, record);
    return record;
  }

  async getFileBySessionId(sessionId: string): Promise<FileRecord | null> {
    for (const file of this.files.values()) {
      if (file.sessionId === sessionId) return file;
    }
    return null;
  }

  async getFileById(id: string): Promise<FileRecord | null> {
    return this.files.get(id) || null;
  }

  async updateFile(id: string, patch: FileRecordPatch): Promise<FileRecord | null> {
    const file = this.files.get(id);
    if (!file) return null;

    const updated: FileRecord = {
      ...file,
      ...patch,
      updatedAt: Date.now(),
    };
    this.files.set(id, updated);
    return updated;
  }

  async findFiles(query: FileQuery): Promise<FileRecord[]> {
    let results = Array.from(this.files.values());

    if (query.sessionId) {
      results = results.filter((f) => f.sessionId === query.sessionId);
    }
    if (query.sessionIds && query.sessionIds.length > 0) {
      results = results.filter((f) => query.sessionIds!.includes(f.sessionId));
    }
    if (query.ids && query.ids.length > 0) {
      results = results.filter((f) => query.ids!.includes(f.id));
    }
    if (query.uploadType) {
      results = results.filter((f) => f.uploadType === query.uploadType);
    }
    if (query.bucket) {
      results = results.filter((f) => f.bucket === query.bucket);
    }
    if (query.userId) {
      results = results.filter((f) => f.userId === query.userId);
    }
    if (query.isComplete !== undefined) {
      results = results.filter((f) => f.isComplete === query.isComplete);
    }

    results.sort((a, b) => b.createdAt - a.createdAt);

    if (query.skip) results = results.slice(query.skip);
    if (query.limit) results = results.slice(0, query.limit);

    return results;
  }

  async deleteFiles(ids: string[]): Promise<number> {
    let deleted = 0;
    for (const id of ids) {
      if (this.files.delete(id)) deleted += 1;
    }
    return deleted;
  }

  async createChunk(chunk: ChunkRecord): Promise<void> {
    const key = `${chunk.fileId}:${chunk.chunkNumber}`;
    this.chunks.set(key, chunk.data);
  }

  async createChunks(chunks: ChunkRecord[]): Promise<void> {
    for (const chunk of chunks) {
      const key = `${chunk.fileId}:${chunk.chunkNumber}`;
      this.chunks.set(key, chunk.data);
    }
  }

  async getChunk(fileId: string, chunkNumber: number): Promise<Buffer | null> {
    const key = `${fileId}:${chunkNumber}`;
    return this.chunks.get(key) || null;
  }

  async deleteChunksByFileId(fileId: string): Promise<number> {
    let deleted = 0;
    const keysToDelete: string[] = [];

    for (const key of this.chunks.keys()) {
      if (key.startsWith(`${fileId}:`)) {
        keysToDelete.push(key);
        deleted += 1;
      }
    }

    for (const key of keysToDelete) {
      this.chunks.delete(key);
    }

    return deleted;
  }

  /**
   * Utility for testing: clear all data.
   */
  clear(): void {
    this.files.clear();
    this.chunks.clear();
  }

  /**
   * Utility for testing: get all files.
   */
  getAllFiles(): FileRecord[] {
    return Array.from(this.files.values());
  }
}
