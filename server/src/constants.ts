/**
 * @upload-media/server - Constants & Defaults
 */

export const DEFAULT_CHUNK_SIZES = {
  video: 2 * 1024 * 1024,
  audio: 2 * 1024 * 1024,
  image: 1 * 1024 * 1024,
  document: 5 * 1024 * 1024,
  default: 1 * 1024 * 1024,
} as const;

export const QUALITY_MAPPINGS = {
  video: {
    high: { scale: '1920:1080', bitrate: '4M', crf: 21 },
    medium: { scale: '1280:720', bitrate: '2.5M', crf: 23 },
    low: { scale: '800:480', bitrate: '1M', crf: 28 }
  },
  image: {
    high: { quality: 90, maxWidth: 1920 },
    medium: { quality: 70, maxWidth: 1280 },
    low: { quality: 50, maxWidth: 800 }
  },
  audio: {
    high: { bitrate: '320k' },
    medium: { bitrate: '128k' },
    low: { bitrate: '64k' }
  }
} as const;

export const DEFAULT_SIZE_LIMITS = {
  video: 500 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
  image: 25 * 1024 * 1024,
  document: 1024 * 1024 * 1024,
  default: 100 * 1024 * 1024,
} as const;

export const THUMBNAIL_CHUNK_SIZE = 256 * 1024;
export const THUMBNAIL_SIZE_LIMIT = 1 * 1024 * 1024;
export const THUMBNAIL_DIMENSIONS = { width: 320, height: 180 };

export const SUPPORTED_MIME_TYPES = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif', 'image/bmp', 'image/tiff'],
  video: ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/x-flv', 'video/x-m4v'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/aac', 'audio/opus', 'audio/flac'],
  document: [
    'application/pdf',
    'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/html',
    'application/zip',
    'application/json'
  ],
} as const;

export const DEFAULT_QUALITY = 'medium';
export const DEFAULT_CACHE_TTL_SECONDS = 300; // 5 minutes
export const DEFAULT_STALE_UPLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const DEFAULT_CLEANUP_BATCH_SIZE = 100;
export const DEFAULT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const AUTH_CACHE_TTL_SECONDS = 5 * 60; // 5 minutes

/** Cache key prefixes — used by CachedRepository for tag-based invalidation */
export const CACHE_PREFIXES = {
  FILE_BY_ID: 'file:id:',
  FILE_BY_SESSION: 'file:session:',
  FILE_LIST: 'file:list:',
} as const;

export function getMimeKind(contentType: string): 'image' | 'video' | 'audio' | 'document' | 'unknown' {
  if (!contentType || !contentType.includes('/')) return 'unknown';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (
    contentType.startsWith('application/') ||
    contentType.startsWith('text/')
  ) {
    return 'document';
  }
  return 'unknown';
}
