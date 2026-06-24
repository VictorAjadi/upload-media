/**
 * @upload-media/server - SQLRepository
 *
 * Generic SQL adapter for Postgres, MySQL, or SQLite.
 * Uses a pluggable executor so you provide the actual query runner.
 * This lets you bring your own query builder (Knex, Drizzle, Raw SQL, etc).
 */

import {
  FileRecord,
  NewFileRecord,
  FileRecordPatch,
  FileQuery,
  ChunkRecord,
  MetadataRepository,
} from '../types';

export interface SQLExecutor {
  /**
   * Execute a parameterized query and return rows.
   * Placeholders are $1, $2, etc. (Postgres style) — the executor handles dialect conversion if needed.
   */
  query(sql: string, params: any[]): Promise<any[]>;
  /**
   * Execute a query that might not return rows (INSERT, UPDATE, DELETE).
   * Should return { affectedRows: number } or similar.
   */
  execute(sql: string, params: any[]): Promise<{ affectedRows: number }>;
}

export interface SQLRepositoryOptions {
  executor: SQLExecutor;
  filesTable?: string;
  chunksTable?: string;
  /** If true, assume database handles 'created_at' / 'updated_at' automatically (timestamps / CURRENT_TIMESTAMP) */
  autoTimestamps?: boolean;
  /** Database operation hooks */
  hooks?: import('../hooks/types').DatabaseHooks;
  /** Custom indexes to create on files table during createSchema() */
  fileIndexes?: string[][];
  /** Custom indexes to create on chunks table */
  chunkIndexes?: string[][];
}

export class SQLRepository implements MetadataRepository {
  private executor: SQLExecutor;
  private filesTable: string;
  private chunksTable: string;
  private autoTimestamps: boolean;
  private hooks?: import('../hooks/types').DatabaseHooks;
  private fileIndexes: string[][];
  private chunkIndexes: string[][];

  constructor(options: SQLRepositoryOptions) {
    this.executor = options.executor;
    this.filesTable = options.filesTable || 'upload_files';
    this.chunksTable = options.chunksTable || 'upload_chunks';
    this.autoTimestamps = options.autoTimestamps ?? true;
    this.hooks = options.hooks;
    this.fileIndexes = options.fileIndexes || [];
    this.chunkIndexes = options.chunkIndexes || [];
  }

  /**
   * Helper to create tables and baseline indexes.
   * Dialect agnostic (standard SQL).
   */
  async createSchema(): Promise<void> {
    // 1. Files Table
    await this.executor.execute(`
      CREATE TABLE IF NOT EXISTS ${this.filesTable} (
        id VARCHAR(255) PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL,
        original_name VARCHAR(255),
        stored_name VARCHAR(255),
        fieldname VARCHAR(255),
        content_type VARCHAR(255),
        kind VARCHAR(50),
        size BIGINT,
        chunk_size INT,
        chunk_count INT,
        upload_type VARCHAR(100),
        bucket VARCHAR(255),
        storage_provider VARCHAR(255),
        storage_ref TEXT,
        url TEXT,
        thumbnail_url TEXT,
        thumbnail_ref TEXT,
        user_id VARCHAR(255),
        is_complete BOOLEAN DEFAULT FALSE,
        metadata TEXT,
        created_at BIGINT,
        updated_at BIGINT
      )
    `, []);

    // 2. Chunks Table
    await this.executor.execute(`
      CREATE TABLE IF NOT EXISTS ${this.chunksTable} (
        file_id VARCHAR(255) NOT NULL,
        chunk_number INT NOT NULL,
        data BYTEA,
        created_at BIGINT,
        PRIMARY KEY (file_id, chunk_number)
      )
    `, []);

    // 3. Baseline Indexes
    await this.executor.execute(`CREATE INDEX IF NOT EXISTS idx_${this.filesTable}_session ON ${this.filesTable}(session_id)`, []);
    await this.executor.execute(`CREATE INDEX IF NOT EXISTS idx_${this.filesTable}_type ON ${this.filesTable}(upload_type)`, []);
    await this.executor.execute(`CREATE INDEX IF NOT EXISTS idx_${this.filesTable}_user ON ${this.filesTable}(user_id)`, []);

    // 4. Custom User Indexes
    for (const cols of this.fileIndexes) {
      const idxName = `idx_${this.filesTable}_${cols.join('_')}`;
      await this.executor.execute(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${this.filesTable}(${cols.join(',')})`, []);
    }
    for (const cols of this.chunkIndexes) {
      const idxName = `idx_${this.chunksTable}_${cols.join('_')}`;
      await this.executor.execute(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${this.chunksTable}(${cols.join(',')})`, []);
    }
  }

  private createHookContext(): import('../hooks/types').HookContext {
    return { timestamp: Date.now() };
  }

  async createFile(file: NewFileRecord): Promise<FileRecord> {
    const now = Date.now();
    const ctx = this.createHookContext();

    // Before hook
    if (this.hooks?.beforeCreateFile) {
      const result = await this.hooks.beforeCreateFile(file, ctx);
      if (result) return result;
    }

    const fields = [
      'id',
      'session_id',
      'original_name',
      'stored_name',
      'fieldname',
      'content_type',
      'kind',
      'size',
      'chunk_size',
      'chunk_count',
      'upload_type',
      'bucket',
      'storage_provider',
      'storage_ref',
      'url',
      'thumbnail_url',
      'thumbnail_ref',
      'user_id',
      'is_complete',
      'metadata',
      'created_at',
      'updated_at',
    ];

    const placeholders = fields.map((_, i) => `$${i + 1}`).join(',');
    const sql = `INSERT INTO ${this.filesTable} (${fields.join(',')}) VALUES (${placeholders}) RETURNING *`;

    const id = file.id || `file_${now}_${Math.random().toString(36).substring(2, 9)}`;
    const values = [
      id,
      file.sessionId,
      file.originalName,
      file.storedName,
      file.fieldname,
      file.contentType,
      file.kind,
      file.size,
      file.chunkSize,
      file.chunkCount,
      file.uploadType,
      file.bucket,
      file.storageProvider,
      file.storageRef,
      file.url,
      file.thumbnailUrl,
      file.thumbnailRef,
      file.userId,
      file.isComplete,
      file.metadata ? JSON.stringify(file.metadata) : null,
      now,
      now,
    ];

    const rows = await this.executor.query(sql, values);
    const record = this.rowToRecord(rows[0]);

    // After hook
    if (this.hooks?.afterCreateFile) {
      return this.hooks.afterCreateFile(record, ctx);
    }

    return record;
  }

  async getFileBySessionId(sessionId: string): Promise<FileRecord | null> {
    const sql = `SELECT * FROM ${this.filesTable} WHERE session_id = $1 LIMIT 1`;
    const rows = await this.executor.query(sql, [sessionId]);
    return rows.length ? this.rowToRecord(rows[0]) : null;
  }

  async getFileById(id: string): Promise<FileRecord | null> {
    const ctx = this.createHookContext();
    if (this.hooks?.beforeGetFileById) {
      const result = await this.hooks.beforeGetFileById(id, ctx);
      if (result) return result;
    }

    const sql = `SELECT * FROM ${this.filesTable} WHERE id = $1`;
    const rows = await this.executor.query(sql, [id]);
    const file = rows.length ? this.rowToRecord(rows[0]) : null;

    if (this.hooks?.afterGetFileById) {
      return this.hooks.afterGetFileById(file, ctx);
    }
    return file;
  }

  async updateFile(id: string, patch: FileRecordPatch): Promise<FileRecord | null> {
    const ctx = this.createHookContext();
    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    const fieldMap: Record<string, string> = {
      originalName: 'original_name',
      storedName: 'stored_name',
      contentType: 'content_type',
      chunkSize: 'chunk_size',
      chunkCount: 'chunk_count',
      uploadType: 'upload_type',
      storageProvider: 'storage_provider',
      storageRef: 'storage_ref',
      thumbnailUrl: 'thumbnail_url',
      thumbnailRef: 'thumbnail_ref',
      userId: 'user_id',
      isComplete: 'is_complete',
    };

    for (const [key, value] of Object.entries(patch)) {
      const dbField = fieldMap[key] || key;
      if (value !== undefined) {
        updates.push(`${dbField} = $${paramCount}`);
        values.push(typeof value === 'object' ? JSON.stringify(value) : value);
        paramCount += 1;
      }
    }

    if (updates.length === 0) {
      return this.getFileById(id);
    }

    updates.push(`updated_at = $${paramCount}`);
    values.push(Date.now());
    values.push(id);

    const sql = `UPDATE ${this.filesTable} SET ${updates.join(',')} WHERE id = $${paramCount + 1} RETURNING *`;
    const rows = await this.executor.query(sql, values);
    const file = rows.length ? this.rowToRecord(rows[0]) : null;

    if (this.hooks?.afterUpdateFile) {
      return this.hooks.afterUpdateFile(file, ctx);
    }
    return file;
  }

  async findFiles(query: FileQuery): Promise<FileRecord[]> {
    const ctx = this.createHookContext();
    const conditions: string[] = [];
    const params: any[] = [];
    let paramCount = 1;

    if (query.sessionId) {
      conditions.push(`session_id = $${paramCount}`);
      params.push(query.sessionId);
      paramCount += 1;
    }
    if (query.sessionIds && query.sessionIds.length > 0) {
      const placeholders = query.sessionIds.map(() => `$${paramCount++}`).join(',');
      conditions.push(`session_id IN (${placeholders})`);
      params.push(...query.sessionIds);
    }
    if (query.ids && query.ids.length > 0) {
      const placeholders = query.ids.map(() => `$${paramCount++}`).join(',');
      conditions.push(`id IN (${placeholders})`);
      params.push(...query.ids);
    }
    if (query.uploadType) {
      conditions.push(`upload_type = $${paramCount}`);
      params.push(query.uploadType);
      paramCount += 1;
    }
    if (query.userId) {
      conditions.push(`user_id = $${paramCount}`);
      params.push(query.userId);
      paramCount += 1;
    }
    if (query.isComplete !== undefined) {
      conditions.push(`is_complete = $${paramCount}`);
      params.push(query.isComplete);
      paramCount += 1;
    }

    let sql = `SELECT * FROM ${this.filesTable}`;
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    sql += ` ORDER BY created_at DESC`;

    if (query.limit) {
      sql += ` LIMIT $${paramCount}`;
      params.push(query.limit);
      paramCount += 1;
    }
    if (query.skip) {
      sql += ` OFFSET $${paramCount}`;
      params.push(query.skip);
      paramCount += 1;
    }

    const rows = await this.executor.query(sql, params);
    const results = rows.map((row: any) => this.rowToRecord(row));

    if (this.hooks?.afterFindFiles) {
      return this.hooks.afterFindFiles(results, ctx);
    }
    return results;
  }

  async deleteFiles(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const sql = `DELETE FROM ${this.filesTable} WHERE id IN (${placeholders})`;
    const result = await this.executor.execute(sql, ids);
    return result.affectedRows || 0;
  }

  async createChunk(chunk: ChunkRecord): Promise<void> {
    const sql = `INSERT INTO ${this.chunksTable} (file_id, chunk_number, data) VALUES ($1, $2, $3)`;
    await this.executor.execute(sql, [chunk.fileId, chunk.chunkNumber, chunk.data]);
  }

  async getChunk(fileId: string, chunkNumber: number): Promise<Buffer | null> {
    const sql = `SELECT data FROM ${this.chunksTable} WHERE file_id = $1 AND chunk_number = $2`;
    const rows = await this.executor.query(sql, [fileId, chunkNumber]);
    return rows.length ? rows[0].data : null;
  }

  async deleteChunksByFileId(fileId: string): Promise<number> {
    const sql = `DELETE FROM ${this.chunksTable} WHERE file_id = $1`;
    const result = await this.executor.execute(sql, [fileId]);
    return result.affectedRows || 0;
  }

  private rowToRecord(row: any): FileRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      originalName: row.original_name,
      storedName: row.stored_name,
      fieldname: row.fieldname,
      contentType: row.content_type,
      kind: row.kind,
      size: row.size,
      chunkSize: row.chunk_size,
      chunkCount: row.chunk_count,
      uploadType: row.upload_type,
      bucket: row.bucket,
      storageProvider: row.storage_provider,
      storageRef: row.storage_ref,
      url: row.url,
      thumbnailUrl: row.thumbnail_url,
      thumbnailRef: row.thumbnail_ref,
      userId: row.user_id,
      isComplete: row.is_complete,
      metadata: row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : undefined,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.getTime()
          : typeof row.created_at === 'number'
            ? row.created_at
            : Date.now(),
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at.getTime()
          : typeof row.updated_at === 'number'
            ? row.updated_at
            : Date.now(),
    };
  }
}
