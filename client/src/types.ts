/**
 * @upload-media/client - Type Definitions
 */

export type UploadStatus =
  | 'pending'
  | 'initializing'
  | 'uploading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'modifying'
  | 'generating_thumbnail'
  | 'error';

export interface UploadOptions {
  /** Upload endpoint URL */
  endpoint: string;

  /** HTTP method (POST or PATCH) */
  method: 'POST' | 'PATCH';

  /** Video/Image quality ('high', 'medium', 'low') */
  quality?: 'high' | 'medium' | 'low';

  /** Maximum number of files allowed */
  maxFiles?: number;

  /** Number of concurrent uploads */
  concurrentUploads?: number;

  /** Upload priority */
  priority?: 'high' | 'normal' | 'low';

  /** Whether to transform/process media */
  transform?: boolean;

  /** Custom upload ID */
  uploadId?: string;

  /** Additional form data to send */
  postData?: Record<string, any>;

  /** Request metadata */
  metadata?: Record<string, any>[];

  /** Video start time (for trimming) */
  videoStartTime?: number | string;

  /** Video end time (for trimming) */
  videoEndTime?: number | string;

  /** Video duration */
  duration?: string;

  /** Media transformation options */
  transformer?: {
    /** 0-100 quality for images, or specific quality type */
    quality?: number | 'high' | 'medium' | 'low';
    /** List of qualities to generate (multi-output) */
    qualities?: (number | 'high' | 'medium' | 'low')[];
    /** Auto-transform based on network or config */
    auto?: boolean;
    /** Output format if applicable */
    format?: string;
  };
}

export interface FileUploadItem {
  fileIndex: number;
  fileName: string;
  fileSize: number;
  fileType: string;
  progress: number;
  chunkIndex: number;
  totalChunks: number;
  status: UploadStatus;
  error?: string;
  sessionId?: string;
  needsModification?: boolean;
  isModified?: boolean;
  modificationProgress?: number;
  startTime?: number;
  endTime?: number | null;
  isMuted?: boolean;
  videoDuration?: number | null;
  needsTransformation?: boolean;
  isTransformed?: boolean;
}

export interface UploadProgress {
  uploadId: string;
  files: FileUploadItem[];
  overallProgress: number;
  status: UploadStatus;
  speed?: number;
  timeRemaining?: number;
  startTime: number;
  endTime?: number;
  canResume?: boolean;
  error?: string;
  retryCount: number;
  maxRetries: number;

  // Persistent Storage / Store fields
  allFilesSessionId?: string[];
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  progress?: number;
  endpoint?: string;
  method?: string;
  postData?: Record<string, any>;
  metadata?: any[];
  modificationConfigs?: any[];
  videoStartTime?: string;
  videoEndTime?: string;
  duration?: string;
  currentModifyingIndex?: number;
  uploadType?: string;
}

export interface WorkerMessage {
  type: string;
  uploadId: string;
  fileIndex?: number;
  fileName?: string;
  chunkIndex?: number;
  totalChunks?: number;
  progress?: string;
  overallProgress?: string;
  fileProgress?: string;
  chunkProgress?: string;
  status?: UploadStatus;
  message?: string;
  error?: string;
  data?: any;
  allFilesSessionId?: string[];
  canResume?: boolean;
  clearType?: 'all' | 'completed' | 'failed' | 'single';
  uploadIds?: string[];
  modifiedBlob?: Blob;
  blob?: Blob;
  config?: any;
  requestId?: string;
  [key: string]: any;
}

export interface UpdateProgressParams {
  progress: number;
  status?: UploadStatus;
  error?: string;
  speed?: number;
  timeRemaining?: number;
}

export interface ModificationConfig {
  needsModification: boolean;
  isModified?: boolean;
  config?: {
    type: 'image' | 'video';
    quality?: 'high' | 'medium' | 'low';
    videoKey?: string;
  };
}

export interface UploadResult {
  status: 'success' | 'error';
  uploadId: string;
  message: string;
  data?: any;
  error?: string;
  allFilesSessionId?: string[];
}
export interface TrimOptions {
  startTime?: number | null;
  endTime?: number | null;
  quality?: 'high' | 'medium' | 'low';
  mute?: boolean;
  onProgress?: (progress: number) => void;
  useFFmpeg?: boolean;
  outputFormat?: 'mp4' | 'webm' | 'mkv' | 'mov' | 'avi' | 'flv';
  fastMode?: boolean; // New option for faster processing
}

export interface EventCallbacks {
  onProgress?: (progress: number) => void;
  onError?: (error: string) => void;
  onComplete?: (result: Blob) => void;
  onCancel?: () => void;
}

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  frameRate: number;
  bitrate?: number;
  codec?: string;
  audioCodec?: string;
}

export interface AudioTrimOptions {
  startTime?: number | null;
  endTime?: number | null;
  quality?: 'high' | 'medium' | 'low';
  onProgress?: (progress: number) => void;
  useFFmpeg?: boolean;
  outputFormat?: 'mp3' | 'wav' | 'aac' | 'ogg' | 'm4a';
}

export interface AudioEventCallbacks {
  onProgress?: (progress: number) => void;
  onError?: (error: string) => void;
  onComplete?: (result: Blob) => void;
}