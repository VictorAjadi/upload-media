/**
 * @upload-media/client - Constants & Defaults
 *
 * Everything here is a *default*. Nothing is enforced — every value
 * can be overridden per-call via UploadManagerConfig / UploadOptions.
 * Media "kind" detection is prefix-based (image/*, video/*, audio/*,
 * application|text/* => document), exactly like the original app
 * code — there is no hardcoded allowlist of specific mime subtypes,
 * so any image/video/audio/document mimetype works out of the box.
 * If a project wants to *restrict* to a specific subtype list, pass
 * `allowedMimeTypes` in UploadOptions — that's opt-in, not default.
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
    high: {
      maxWidth: 1920,
      maxHeight: 1080,
      bitrate: '4M',
      crf: 21,
      preset: 'fast',
    },
    medium: {
      maxWidth: 1280,
      maxHeight: 720,
      bitrate: '2.5M',
      crf: 23,
      preset: 'fast',
    },
    low: {
      maxWidth: 800,
      maxHeight: 480,
      bitrate: '1M',
      crf: 28,
      preset: 'ultrafast',
    }
  },
  image: {
    high: {
      maxWidth: 1920,
      maxHeight: 1080,
      quality: 0.9,
    },
    medium: {
      maxWidth: 1280,
      maxHeight: 720,
      quality: 0.7,
    },
    low: {
      maxWidth: 800,
      maxHeight: 600,
      quality: 0.5,
    }
  },
  audio: {
    high: { bitrate: '320k' },
    medium: { bitrate: '128k' },
    low: { bitrate: '64k' }
  }
} as const;

export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RETRY_DELAY_MS = 1000;
export const DEFAULT_MAX_CONCURRENT_UPLOADS = 5;
export const DEFAULT_STORAGE_RETENTION_DAYS = 7;
export const DEFAULT_MAX_FILES = 20;

export const DEFAULT_VIDEO_QUALITY = 'medium' as const;
export const DEFAULT_IMAGE_QUALITY = 'medium' as const;

export const DEFAULT_THUMBNAIL_SIZE = { width: 320, height: 180 };

/**
 * Prefix-based kind detection — matches any mimetype under each
 * top-level type. This is intentionally permissive; it is how the
 * original app code detected media kind (`mimetype.startsWith('video/')`)
 * rather than maintaining a fixed allowlist of subtypes.
 */
export function detectMediaKind(mimetype: string): 'image' | 'video' | 'audio' | 'document' | 'unknown' {
  if (!mimetype) return 'unknown';
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  if (mimetype.startsWith('application/') || mimetype.startsWith('text/')) return 'document';
  return 'unknown';
}

/**
 * Optional reference lists, NOT enforced anywhere by default. Useful
 * if a project wants a starting point for an explicit allowlist via
 * `UploadOptions.allowedMimeTypes`, but the framework works with any
 * mimetype out of the box without this.
 */
export const REFERENCE_MIME_TYPES = {
  image: [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'image/avif', 'image/bmp', 'image/tiff', 'image/heic', 'image/heif',
  ],
  video: [
    'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo',
    'video/x-matroska', 'video/mpeg', 'video/ogg', 'video/3gpp',
    'video/x-flv', 'video/x-m4v', 'video/h264',
  ],
  audio: [
    'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/aac',
    'audio/flac', 'audio/mp4', 'audio/x-m4a', 'audio/opus', 'audio/vorbis',
  ],
  document: [
    'application/pdf', 'text/plain', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/html', 'application/json', 'application/zip',
  ],
} as const;

// Kept for backwards-compat with earlier draft — prefer detectMediaKind().
export const CHUNK_SIZES = DEFAULT_CHUNK_SIZES;
export const MAX_RETRIES = DEFAULT_MAX_RETRIES;
export const MAX_CONCURRENT_UPLOADS = DEFAULT_MAX_CONCURRENT_UPLOADS;
