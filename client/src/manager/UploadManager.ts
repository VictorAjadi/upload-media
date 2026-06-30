/**
 * UploadManager - Core upload orchestration class
 * Handles file uploads with chunking, resume, and worker management
 */

import { UploadOptions, UploadProgress, UploadResult, WorkerMessage } from '../types';
import { generateSessionId } from '../utils/sessionId';
import { CHUNK_SIZES, MAX_RETRIES } from '../constants';

export interface UploadManagerConfig {
  workerUrl?: string;
  onProgress?: (progress: UploadProgress) => void;
  onComplete?: (result: UploadResult) => void;
  onError?: (error: Error) => void;
  storageKey?: string;
}

export class UploadManager {
  private worker: Worker | null = null;
  private uploads: Map<string, UploadProgress> = new Map();
  private config: Required<UploadManagerConfig>;
  private eventListeners: Map<string, Set<Function>> = new Map();

  constructor(config: UploadManagerConfig = {}) {
    this.config = {
      workerUrl: config.workerUrl || this.getDefaultWorkerUrl(),
      onProgress: config.onProgress || (() => { }),
      onComplete: config.onComplete || (() => { }),
      onError: config.onError || ((err) => console.error(err)),
      storageKey: config.storageKey || 'upload-progress',
    };

    this.initializeWorker();
    this.restoreFromStorage();
  }

  /**
   * Get default worker URL based on environment and format
   */
  private getDefaultWorkerUrl(): string {
    // Check if we're in a browser environment
    if (typeof window === 'undefined') {
      return '';
    }

    try {
      // For ESM modules with import.meta.url support
      if (typeof import.meta !== 'undefined' && import.meta.url) {
        // Try to use the built worker file
        try {
          // This works in ESM
          return new URL('../dist/worker/upload.worker.mjs', import.meta.url).href;
        } catch (e) {
          // Fallback for development
          try {
            return new URL('../worker/upload.worker.ts', import.meta.url).href;
          } catch (fallbackError) {
            // If import.meta.url fails, use the global approach
            return this.getWorkerUrlFallback();
          }
        }
      } else {
        // For CJS or environments without import.meta.url support
        return this.getWorkerUrlFallback();
      }
    } catch (error) {
      console.warn('Failed to get worker URL via import.meta, using fallback:', error);
      return this.getWorkerUrlFallback();
    }
  }

  /**
   * Fallback method to get worker URL without import.meta
   */
  private getWorkerUrlFallback(): string {
    // In browser, try to construct URL based on script location
    if (typeof document !== 'undefined') {
      const scripts = document.getElementsByTagName('script');
      if (scripts.length > 0) {
        // Try to find our script
        for (const script of scripts) {
          if (script.src && script.src.includes('upload-media')) {
            const baseUrl = script.src.substring(0, script.src.lastIndexOf('/') + 1);
            return `${baseUrl}worker/upload.worker.mjs`;
          }
        }
      }
    }

    // Last resort - relative URL that works in some cases
    return '/worker/upload.worker.mjs';
  }

  /**
   * Initialize and setup Web Worker
   */
  private initializeWorker(): void {
    try {
      const workerUrl = this.config.workerUrl;

      if (!workerUrl) {
        console.warn('[Worker] No worker URL provided, skipping worker initialization');
        return;
      }

      try {
        // Try with module type first (for ESM)
        this.worker = new Worker(workerUrl, { type: 'module' });
      } catch (error) {
        console.warn('[Worker] Module worker failed, trying classic worker:', error);
        // Fallback to classic worker
        try {
          this.worker = new Worker(workerUrl);
        } catch (fallbackError) {
          console.error('[Worker] Classic worker also failed:', fallbackError);
          throw fallbackError;
        }
      }

      this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        this.handleWorkerMessage(event.data);
      };

      this.worker.onerror = (error: ErrorEvent) => {
        console.error('[Worker Error]', error);
        this.config.onError?.(new Error(`Worker error: ${error.message}`));
      };

    } catch (error) {
      console.error('[Worker] Failed to initialize worker:', error);
      this.config.onError?.(new Error('Worker initialization failed'));
    }
  }

  /**
   * Handle messages from Worker
   */
  private handleWorkerMessage(message: WorkerMessage): void {
    const { type, uploadId } = message;

    switch (type) {
      case 'upload_started':
        this.emit('started', { uploadId, message: message.message });
        break;

      case 'progress':
        this.updateProgress(uploadId, message);
        break;

      case 'success':
        this.handleUploadSuccess(uploadId, message);
        break;

      case 'error':
        this.handleUploadError(uploadId, message);
        break;

      case 'paused':
        this.emit('paused', { uploadId });
        break;

      case 'cancelled':
        this.emit('cancelled', { uploadId });
        break;

      case 'request_token':
        this.handleTokenRequest();
        break;

      case 'request_transformation':
        this.handleTransformationRequest(message);
        break;

      default:
        break;
    }
  }

  /**
   * Handle transformation request from worker
   */
  private async handleTransformationRequest(message: WorkerMessage): Promise<void> {
    // This is just a stub for now, real implementation should be in useUploadProgress or similar
    // for consistency with handleModificationRequest.
  }

  /**
   * Upload files with optional chunking and resume support
   */
  async upload(
    files: File[],
    fieldnames: string[],
    options: UploadOptions
  ): Promise<UploadResult> {
    const uploadId = options.uploadId || generateSessionId();

    try {
      // Validation
      if (!files || files.length === 0) {
        throw new Error('No files provided');
      }

      if (files.length !== fieldnames.length) {
        throw new Error('Files and fieldnames length mismatch');
      }

      if (options.maxFiles && files.length > options.maxFiles) {
        throw new Error(`Maximum ${options.maxFiles} files allowed`);
      }

      // Merge fieldnames into metadata for worker use
      const enhancedMetadata = options.metadata || [];
      fieldnames.forEach((name, i) => {
        if (!enhancedMetadata[i]) enhancedMetadata[i] = {};
        enhancedMetadata[i].fieldname = name;
        enhancedMetadata[i].size = files[i].size;
        enhancedMetadata[i].type = files[i].type;
      });

      // Initialize upload progress
      const uploadProgress: UploadProgress = {
        uploadId,
        files: files.map((file, index) => ({
          fileIndex: index,
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type,
          progress: 0,
          chunkIndex: 0,
          totalChunks: Math.ceil(file.size / (CHUNK_SIZES[file.type.split('/')[0] as keyof typeof CHUNK_SIZES] || 1024 * 1024)),
          status: 'pending' as const,
          needsModification: false,
          isModified: false,
        })),
        overallProgress: 0,
        status: 'initializing',
        startTime: Date.now(),
        retryCount: 0,
        maxRetries: MAX_RETRIES,
        metadata: enhancedMetadata, // store it in progress too!
      };

      this.uploads.set(uploadId, uploadProgress);
      this.saveToStorage();

      // Send to worker
      if (this.worker) {
        this.worker.postMessage({
          type: 'upload',
          uploadId,
          blobArray: files,
          filenameArray: files.map(f => f.name),
          ...options,
          metadata: enhancedMetadata,
        });
      } else {
        console.warn('[Upload] Worker not available, upload will not proceed');
        throw new Error('Worker not initialized');
      }

      return {
        status: 'success',
        uploadId,
        message: 'Upload initialized',
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.config.onError?.(err);

      return {
        status: 'error',
        uploadId,
        message: err.message,
        error: err.message,
      };
    }
  }

  /**
   * Pause an active upload
   */
  pause(uploadId: string): void {
    const upload = this.uploads.get(uploadId);
    if (!upload) return;

    upload.status = 'paused';
    this.saveToStorage();

    if (this.worker) {
      this.worker.postMessage({
        type: 'pause',
        uploadId,
      });
    }

    this.config.onProgress?.(upload);
  }

  /**
   * Resume a paused upload
   */
  resume(uploadId: string): void {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.status !== 'paused') return;

    upload.status = 'uploading';
    this.saveToStorage();

    if (this.worker) {
      this.worker.postMessage({
        type: 'resume',
        uploadId,
      });
    }

    this.config.onProgress?.(upload);
  }

  /**
   * Cancel an upload
   */
  cancel(uploadId: string): void {
    const upload = this.uploads.get(uploadId);
    if (!upload) return;

    upload.status = 'cancelled';

    if (this.worker) {
      this.worker.postMessage({
        type: 'cancel',
        uploadId,
      });
    }

    this.emit('cancelled', { uploadId });
  }

  /**
   * Remove upload from tracking
   */
  remove(uploadId: string): void {
    this.uploads.delete(uploadId);
    this.saveToStorage();
  }

  /**
   * Get all uploads
   */
  getUploads(): UploadProgress[] {
    return Array.from(this.uploads.values());
  }

  /**
   * Get specific upload
   */
  getUpload(uploadId: string): UploadProgress | undefined {
    return this.uploads.get(uploadId);
  }

  /**
   * Event listener support
   */
  on(event: string, callback: Function): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }

    this.eventListeners.get(event)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.eventListeners.get(event)?.delete(callback);
    };
  }

  /**
   * Emit events
   */
  private emit(event: string, data: any): void {
    this.eventListeners.get(event)?.forEach((callback) => {
      callback(data);
    });
  }

  /**
   * Update upload progress
   */
  private updateProgress(uploadId: string, message: WorkerMessage): void {
    const upload = this.uploads.get(uploadId);
    if (!upload) return;

    if (message.overallProgress !== undefined) {
      upload.overallProgress = parseFloat(message.overallProgress as string);
    }

    if (message.status) {
      upload.status = message.status;
    }

    if (message.fileIndex !== undefined && upload.files[message.fileIndex]) {
      const file = upload.files[message.fileIndex];
      if (message.fileProgress) file.progress = parseFloat(message.fileProgress);
      if (message.status) file.status = message.status;
    }

    this.saveToStorage();
    this.config.onProgress?.(upload);
  }

  /**
   * Handle upload completion
   */
  private handleUploadSuccess(uploadId: string, message: WorkerMessage): void {
    const upload = this.uploads.get(uploadId);
    if (!upload) return;

    upload.status = 'completed';
    upload.overallProgress = 100;
    upload.endTime = Date.now();

    upload.files.forEach((file) => {
      file.status = 'completed';
      file.progress = 100;
    });

    this.saveToStorage();
    this.config.onProgress?.(upload);
    this.config.onComplete?.({
      status: 'success',
      uploadId,
      message: message.message || 'Upload completed',
      data: message.data,
      allFilesSessionId: message.allFilesSessionId,
    });
  }

  /**
   * Handle upload error
   */
  private handleUploadError(uploadId: string, message: WorkerMessage): void {
    const upload = this.uploads.get(uploadId);
    if (!upload) return;

    upload.status = 'failed';
    upload.error = message.message;
    upload.endTime = Date.now();

    this.saveToStorage();
    this.config.onProgress?.(upload);
    this.config.onError?.(new Error(message.message || 'Upload failed'));
  }

  /**
   * Handle token request from worker
   */
  private async handleTokenRequest(): Promise<void> {
    // Implement token retrieval based on your auth system
    // For now, emit event for parent app to handle
    this.emit('token_request', {});
  }

  /**
   * Provide token to worker
   */
  provideToken(token: string): void {
    if (this.worker) {
      this.worker.postMessage({
        type: 'token_response',
        token,
      });
    }
  }

  /**
   * Save state to localStorage
   */
  private saveToStorage(): void {
    try {
      const data = Array.from(this.uploads.entries());
      localStorage.setItem(this.config.storageKey, JSON.stringify(data));
    } catch (error) {
      console.warn('Failed to save to storage:', error);
    }
  }

  /**
   * Restore state from localStorage
   */
  private restoreFromStorage(): void {
    try {
      const data = localStorage.getItem(this.config.storageKey);
      if (data) {
        const uploads = JSON.parse(data);
        uploads.forEach(([key, value]: [string, UploadProgress]) => {
          // Only restore paused/failed uploads
          if (['paused', 'failed'].includes(value.status)) {
            this.uploads.set(key, value);
          }
        });
      }
    } catch (error) {
      console.warn('Failed to restore from storage:', error);
    }
  }

  /**
   * Set worker URL dynamically (useful for consumers)
   */
  setWorkerUrl(url: string): void {
    this.config.workerUrl = url;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initializeWorker();
  }

  /**
   * Cleanup and destroy
   */
  destroy(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    this.uploads.clear();
    this.eventListeners.clear();
  }
}