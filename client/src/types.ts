
// ─── Upload status ───────────────────────────────────────────────────────────

export type UploadStatus =
  | 'pending'
  | 'initializing'
  | 'uploading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'processing' // server-side processing
  | 'error';

// ─── Quality ─────────────────────────────────────────────────────────────────

export type Quality = 'high' | 'medium' | 'low' | number;

export interface QualityConfig {
  id: string;
  label: string;
  quality?: Quality;
  resolution?: string;
  videoBitrate?: string;
  audioBitrate?: string;
  width?: number;
  height?: number;
  codec?: string;
  maxDimension?: number;
  format?: string;
  [key: string]: any;
}

// ─── Transformer config sent to backend ──────────────────────────────────────

export interface TransformerConfig {
  type?: 'image' | 'video' | 'audio';
  quality?: Quality;
  format?: string;
  qualityConfigs?: QualityConfig[];
  qualities?: string[];
  // Video/Audio trimming
  startTime?: number;
  endTime?: number;
  // Video specific
  mute?: boolean;
  videoBitrate?: string;
  resolution?: string;
  codec?: string;
  generateThumbnail?: boolean;
  thumbnailTimeSeconds?: number;
  // Audio specific
  audioBitrate?: string;
  // Image specific
  width?: number;
  height?: number;
  [key: string]: any;
}

// ─── Upload primitives ────────────────────────────────────────────────────────

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
  // Server-side processing info
  isProcessing?: boolean;
  processingProgress?: number;
  processedSize?: number;
}

export interface FileMetadata {
  size?: number;
  type?: string;
  fieldname?: string;
}

export interface UploadProgress {
  uploadId: string;
  files: FileUploadItem[];
  overallProgress: number;
  status: UploadStatus;
  responseData?: any;
  speed?: number;
  timeRemaining?: number;
  startTime: number;
  endTime?: number;
  canResume?: boolean;
  error?: string;
  retryCount: number;
  maxRetries: number;
  allFilesSessionId?: string[];
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  progress?: number;
  endpoint?: string;
  method?: string;
  postData?: Record<string, any>;
  metadata?: Array<FileMetadata>;
  uploadType?: string;
  mockNetworkDropRate?: number;
  headers?: Record<string, string>;
}

export interface UploadOptions {
  endpoint: string;
  method: 'POST' | 'PATCH';
  maxFiles?: number;
  concurrentUploads?: number;
  priority?: 'high' | 'normal' | 'low';
  uploadId?: string;
  postData?: Record<string, any>;
  uploadType?: string;
  metadata?: Array<FileMetadata>;
  // Server-side transformation config
  transformer?: TransformerConfig;
  mockNetworkDropRate?: number;
  headers?: Record<string, string>;
}

export interface UpdateProgressParams {
  progress: number;
  status?: UploadStatus;
  error?: string;
  speed?: number;
  timeRemaining?: number;
}

// ─── Worker messages ──────────────────────────────────────────────────────────

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
  status?: UploadStatus;
  message?: string;
  error?: string;
  data?: any;
  allFilesSessionId?: string[];
  canResume?: boolean;
  clearType?: 'all' | 'completed' | 'failed' | 'single';
  uploadIds?: string[];
  requestId?: string;
  headers?: Record<string, string>;
  [key: string]: any;
}

export interface UploadResult {
  status: 'success' | 'error';
  uploadId: string;
  message: string;
  data?: any;
  error?: string;
  allFilesSessionId?: string[];
}