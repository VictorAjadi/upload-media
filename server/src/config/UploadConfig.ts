/**
 * @upload-media/server - Configuration Resolver
 *
 * Takes the partial config a developer writes and produces a fully
 * resolved, validated configuration with every optional field filled
 * in from sane defaults. This is the only place defaults live, so
 * behavior stays predictable as the framework grows.
 */

import {
  UploadEngineConfig,
  ResolvedUploadEngineConfig,
  UploadTypeConfig,
  SizeLimitMap,
  MediaKind,
} from '../types';
import {
  DEFAULT_CHUNK_SIZES,
  DEFAULT_SIZE_LIMITS,
  DEFAULT_CACHE_TTL_SECONDS,
  DEFAULT_STALE_UPLOAD_RETENTION_MS,
} from '../constants';

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(`[upload-media/server] Invalid configuration: ${message}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Resolve a user-provided engine config into a fully-populated one.
 * Throws ConfigValidationError on structurally invalid input — this
 * is intentionally strict so misconfiguration fails at boot, not at
 * the first real upload.
 */
export function resolveUploadConfig(config: UploadEngineConfig): ResolvedUploadEngineConfig {
  if (!config.database) {
    throw new ConfigValidationError(
      'a `database` (MetadataRepository) is required. Use one of the built-in adapters ' +
        '(MongooseRepository, SQLRepository, InMemoryRepository) or implement the interface yourself.'
    );
  }

  if (!config.storages || Object.keys(config.storages).length === 0) {
    throw new ConfigValidationError(
      'at least one entry in `storages` is required, e.g. { storages: { s3: new S3StorageAdapter(...) } }'
    );
  }

  if (!config.defaultStorage || !config.storages[config.defaultStorage]) {
    throw new ConfigValidationError(
      `\`defaultStorage\` ("${config.defaultStorage}") must reference a key present in \`storages\`. ` +
        `Available: ${Object.keys(config.storages).join(', ') || '(none)'}`
    );
  }

  if (!config.uploadTypes || Object.keys(config.uploadTypes).length === 0) {
    throw new ConfigValidationError(
      'at least one entry in `uploadTypes` is required, e.g. { uploadTypes: { post: { ... } } }'
    );
  }

  for (const [name, typeConfig] of Object.entries(config.uploadTypes)) {
    if (typeConfig.storage && !config.storages[typeConfig.storage]) {
      throw new ConfigValidationError(
        `uploadTypes.${name}.storage ("${typeConfig.storage}") does not reference a key present in \`storages\``
      );
    }
    if (!typeConfig.allowedKinds || typeConfig.allowedKinds.length === 0) {
      throw new ConfigValidationError(`uploadTypes.${name}.allowedKinds must list at least one media kind`);
    }
  }

  return {
    ...config,
    cacheTtlSeconds: config.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS,
    staleUploadRetentionMs: config.staleUploadRetentionMs ?? DEFAULT_STALE_UPLOAD_RETENTION_MS,
    globalLimits: { ...DEFAULT_SIZE_LIMITS, ...(config.globalLimits || {}) },
    globalChunkLimits: { ...DEFAULT_CHUNK_SIZES, ...(config.globalChunkLimits || {}) },
    maxFieldSize: config.maxFieldSize ?? 1024 * 1024, // 1MB
    maxFiles: config.maxFiles ?? 10,
    maxTotalSize: config.maxTotalSize ?? 500 * 1024 * 1024, // 500MB
    onProgress: config.onProgress,
    autoRespond: config.autoRespond ?? true,
  };
}

/**
 * Resolve the effective total-size limit for a given upload type + media kind,
 * falling back: uploadType.limits[kind] -> uploadType.limits.default ->
 * globalLimits[kind] -> globalLimits.default.
 */
export function resolveSizeLimit(
  config: ResolvedUploadEngineConfig,
  uploadType: UploadTypeConfig,
  kind: MediaKind
): number {
  return (
    pickLimit(uploadType.limits, kind) ??
    pickLimit(config.globalLimits, kind) ??
    DEFAULT_SIZE_LIMITS.default
  );
}

/**
 * Resolve the effective per-chunk size limit, same fallback strategy as above
 * but sourced from chunkLimits instead of limits.
 */
export function resolveChunkLimit(
  config: ResolvedUploadEngineConfig,
  uploadType: UploadTypeConfig,
  kind: MediaKind
): number {
  return (
    pickLimit(uploadType.chunkLimits, kind) ??
    pickLimit(config.globalChunkLimits, kind) ??
    DEFAULT_CHUNK_SIZES.default
  );
}

function pickLimit(map: SizeLimitMap | undefined, kind: MediaKind): number | undefined {
  if (!map) return undefined;
  if (kind !== 'unknown' && (map as any)[kind] !== undefined) {
    return (map as any)[kind];
  }
  return map.default;
}

/**
 * Look up which storage adapter should be used for a given upload type.
 */
export function resolveStorageKey(config: ResolvedUploadEngineConfig, uploadType: UploadTypeConfig): string {
  return uploadType.storage || config.defaultStorage;
}
