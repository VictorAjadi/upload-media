/**
 * Session ID generation utility
 * Worker-safe ID generation without UUID library
 */

export function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const randomStr = 
    Math.random().toString(36).substring(2, 15) + 
    Math.random().toString(36).substring(2, 15);
  return `${randomStr}-${timestamp}`;
}

/**
 * Generate unique upload ID
 */
export function generateUploadId(): string {
  return `upload_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Generate unique file ID within an upload session
 */
export function generateFileId(uploadId: string, fileIndex: number): string {
  return `${uploadId}_file_${fileIndex}`;
}

/**
 * Generate chunk ID
 */
export function generateChunkId(fileId: string, chunkIndex: number): string {
  return `${fileId}_chunk_${chunkIndex}`;
}

/**
 * Generate thumbnail ID
 */
export function generateThumbnailId(sessionId: string): string {
  return `thumb_${sessionId}`;
}

/**
 * Create a request ID for tracking async operations
 */
export function generateRequestId(prefix = 'req'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
