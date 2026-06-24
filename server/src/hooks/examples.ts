/**
 * @upload-media/server - Hook Examples
 *
 * Reusable hook implementations for common patterns:
 * - Redis caching
 * - Logging
 * - File cleanup
 * - Custom validation
 */

import { DatabaseHooks, StorageHooks, HookContext } from './types';
import { FileRecord } from '../types';

/**
 * Redis cache hooks - check cache before querying, cache results after querying.
 * Works with any Redis client (ioredis, redis, node-redis).
 */
export function createRedisCacheHooks(redis: any): DatabaseHooks {
  return {
    beforeGetFileById: async (id, ctx) => {
      try {
        const cached = await redis.get(`file:${id}`);
        if (cached) return JSON.parse(cached);
      } catch (error) {
        console.error('[CacheHook] Failed to get from cache:', error);
      }
      return null;
    },

    afterGetFileById: async (file, ctx) => {
      if (!file) return null;
      try {
        await redis.set(`file:${file.id}`, JSON.stringify(file), 'EX', 300);
      } catch (error) {
        console.error('[CacheHook] Failed to set cache:', error);
      }
      return file;
    },

    beforeGetFileBySessionId: async (sessionId, ctx) => {
      try {
        const cached = await redis.get(`session:${sessionId}`);
        if (cached) return JSON.parse(cached);
      } catch {
        /* continue */
      }
      return null;
    },

    afterGetFileBySessionId: async (file, ctx) => {
      if (!file) return null;
      try {
        await redis.set(`session:${file.sessionId}`, JSON.stringify(file), 'EX', 300);
      } catch {
        /* continue */
      }
      return file;
    },

    beforeFindFiles: async (query, ctx) => {
      try {
        const key = `files:${JSON.stringify(query)}`;
        const cached = await redis.get(key);
        if (cached) return JSON.parse(cached);
      } catch {
        /* continue */
      }
      return null;
    },

    afterFindFiles: async (results, ctx) => {
      try {
        const key = `files:${JSON.stringify(ctx.originalQuery)}`;
        await redis.set(key, JSON.stringify(results), 'EX', 600);
      } catch {
        /* continue */
      }
      return results;
    },

    afterDeleteFiles: async (count, ctx) => {
      try {
        // Invalidate all file caches
        await redis.del(...(await redis.keys('file:*')));
        await redis.del(...(await redis.keys('session:*')));
        await redis.del(...(await redis.keys('files:*')));
      } catch {
        /* continue */
      }
      return count;
    },
  };
}

/**
 * Logging hooks - log all database operations for debugging/auditing.
 */
export function createLoggingHooks(logger: any = console): DatabaseHooks {
  return {
    afterCreateFile: async (file, ctx) => {
      logger.info(`[FileCreated] ${file.id} (${file.originalName}, ${file.size} bytes)`);
      return file;
    },

    afterGetFileById: async (file, ctx) => {
      if (file) {
        logger.debug(`[FileQueried] ${file.id}`);
      }
      return file;
    },

    afterFindFiles: async (results, ctx) => {
      logger.debug(`[FilesQueried] Found ${results.length} files`);
      return results;
    },

    afterUpdateFile: async (file, ctx) => {
      if (file) {
        logger.info(`[FileUpdated] ${file.id}`);
      }
      return file;
    },

    afterDeleteFiles: async (count, ctx) => {
      logger.info(`[FilesDeleted] ${count} files removed`);
      return count;
    },
  };
}

/**
 * Storage hooks for logging/metrics.
 */
export function createStorageLoggingHooks(logger: any = console): StorageHooks {
  return {
    afterWriteChunk: async (fileId, chunkNumber, ctx) => {
      logger.debug(`[ChunkWritten] ${fileId} chunk ${chunkNumber}`);
    },

    afterFinalize: async (result, ctx) => {
      logger.info(`[FileFinalized] → ${result.storageRef}`);
      return result;
    },

    afterDelete: async (ctx) => {
      logger.debug(`[FileDeleted]`);
    },
  };
}

/**
 * Validation hooks - enforce additional rules on file records.
 */
export function createValidationHooks(): DatabaseHooks {
  return {
    beforeCreateFile: async (file, ctx) => {
      // Enforce size limits
      if (file.size < 0) {
        throw new Error('File size cannot be negative');
      }

      if (file.chunkCount < 1) {
        throw new Error('File must have at least 1 chunk');
      }

      if (file.originalName.length > 255) {
        throw new Error('Filename too long (max 255 characters)');
      }

      return null; // Continue to actual create
    },

    beforeUpdateFile: async (id, patch, ctx) => {
      // Prevent certain fields from being updated
      if (patch.size && patch.size < 0) {
        throw new Error('Size cannot be negative');
      }

      return null;
    },
  };
}

/**
 * Cleanup hooks - auto-delete old/incomplete uploads after configured period.
 */
export function createAutoCleanupHooks(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): DatabaseHooks {
  return {
    afterFindFiles: async (results, ctx) => {
      const now = Date.now();
      const toDelete = results.filter((f) => {
        const age = now - f.createdAt;
        // Only auto-delete incomplete uploads
        return !f.isComplete && age > maxAgeMs;
      });

      if (toDelete.length > 0) {
        console.info(`[AutoCleanup] Removing ${toDelete.length} stale uploads`);
        // Would call deleteFiles here if we had access to the repo
      }

      return results;
    },
  };
}

/**
 * Metrics hooks - count operations for monitoring.
 */
export function createMetricsHooks(metrics: any): DatabaseHooks {
  return {
    afterCreateFile: async (file, ctx) => {
      metrics.increment('files.created');
      metrics.histogram('file.size.bytes', file.size);
      return file;
    },

    afterFindFiles: async (results, ctx) => {
      metrics.increment('files.queried');
      metrics.histogram('files.query.count', results.length);
      return results;
    },

    afterDeleteFiles: async (count, ctx) => {
      metrics.increment('files.deleted', count);
      return count;
    },
  };
}

/**
 * Custom transformation hook - add computed fields to files.
 */
export function createTransformationHooks(): DatabaseHooks {
  return {
    afterGetFileById: async (file, ctx) => {
      if (!file) return null;

      return {
        ...file,
        // Add computed fields
        ageSeconds: Math.floor((Date.now() - file.createdAt) / 1000),
        isExpired: Date.now() - file.createdAt > 30 * 24 * 60 * 60 * 1000, // 30 days
        progress: file.isComplete ? 100 : (file.chunkCount > 0 ? 0 : 0), // Placeholder
      };
    },
  };
}

/**
 * Chain multiple hooks together.
 * This patterns allows composing behaviors: e.g. [Logging, Caching, Validation]
 */
export function chainHooks(...hooks: (DatabaseHooks | undefined)[]): DatabaseHooks {
  const filteredHooks = hooks.filter((h) => h !== undefined) as DatabaseHooks[];

  return {
    beforeCreateFile: async (file, ctx) => {
      for (const hook of filteredHooks) {
        if (hook.beforeCreateFile) {
          const result = await hook.beforeCreateFile(file, ctx);
          if (result) return result;
        }
      }
      return null;
    },

    afterCreateFile: async (file, ctx) => {
      let current = file;
      for (const hook of filteredHooks) {
        if (hook.afterCreateFile) {
          current = await hook.afterCreateFile(current, ctx);
        }
      }
      return current;
    },

    beforeGetFileById: async (id, ctx) => {
      for (const hook of filteredHooks) {
        if (hook.beforeGetFileById) {
          const result = await hook.beforeGetFileById(id, ctx);
          if (result) return result;
        }
      }
      return null;
    },

    afterGetFileById: async (file, ctx) => {
      let current = file;
      for (const hook of filteredHooks) {
        if (hook.afterGetFileById) {
          current = await hook.afterGetFileById(current, ctx);
        }
      }
      return current;
    },

    beforeGetFileBySessionId: async (sessionId, ctx) => {
      for (const hook of filteredHooks) {
        if (hook.beforeGetFileBySessionId) {
          const result = await hook.beforeGetFileBySessionId(sessionId, ctx);
          if (result) return result;
        }
      }
      return null;
    },

    afterGetFileBySessionId: async (file, ctx) => {
      let current = file;
      for (const hook of filteredHooks) {
        if (hook.afterGetFileBySessionId) {
          current = await hook.afterGetFileBySessionId(current, ctx);
        }
      }
      return current;
    },

    beforeUpdateFile: async (id, patch, ctx) => {
      for (const hook of filteredHooks) {
        if (hook.beforeUpdateFile) {
          const result = await hook.beforeUpdateFile(id, patch, ctx);
          if (result) return result;
        }
      }
      return null;
    },

    afterUpdateFile: async (file, ctx) => {
      let current = file;
      for (const hook of filteredHooks) {
        if (hook.afterUpdateFile) {
          current = await hook.afterUpdateFile(current, ctx);
        }
      }
      return current;
    },

    beforeFindFiles: async (query, ctx) => {
      for (const hook of filteredHooks) {
        if (hook.beforeFindFiles) {
          const result = await hook.beforeFindFiles(query, ctx);
          if (result) return result;
        }
      }
      return null;
    },

    afterFindFiles: async (results, ctx) => {
      let current = results;
      for (const hook of filteredHooks) {
        if (hook.afterFindFiles) {
          current = await hook.afterFindFiles(current, ctx);
        }
      }
      return current;
    },

    beforeDeleteFiles: async (ids, ctx) => {
      for (const hook of filteredHooks) {
        if (hook.beforeDeleteFiles) {
          const result = await hook.beforeDeleteFiles(ids, ctx);
          if (result !== null && result !== undefined) return result;
        }
      }
      return null;
    },

    afterDeleteFiles: async (count, ctx) => {
      let current = count;
      for (const hook of filteredHooks) {
        if (hook.afterDeleteFiles) {
          current = await hook.afterDeleteFiles(current, ctx);
        }
      }
      return current;
    },
  };
}
