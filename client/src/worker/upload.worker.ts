/**
 * upload.worker.ts (v2)
 *
 * Simplified for backend-driven processing:
 * - No modification/transformation round-trips
 * - No thumbnail generation
 * - Just chunked upload with pause/resume/cancel
 */

/// <reference lib="webworker" />

declare const self: DedicatedWorkerGlobalScope;

function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  return `${randomStr}-${timestamp}`;
}

interface WorkerRuntimeConfig {
  chunkSizes: { video: number; audio: number; image: number; document: number; default: number };
  maxRetries: number;
  retryDelayMs: number;
  maxConcurrentUploads: number;
  dbName: string;
  dbVersion: number;
  tokenStrategy: 'message' | 'credentials';
  fetchCredentials: RequestCredentials;
}

let config: WorkerRuntimeConfig = {
  chunkSizes: {
    video: 2 * 1024 * 1024,
    audio: 2 * 1024 * 1024,
    image: 1 * 1024 * 1024,
    document: 1.5 * 1024 * 1024,
    default: 1 * 1024 * 1024,
  },
  maxRetries: 3,
  retryDelayMs: 1000,
  maxConcurrentUploads: 5,
  dbName: 'UploadDB',
  dbVersion: 3,
  tokenStrategy: 'message',
  fetchCredentials: 'same-origin',
};

function chunkSizeFor(fileType: string): number {
  if (fileType.startsWith('video/')) return config.chunkSizes.video;
  if (fileType.startsWith('audio/')) return config.chunkSizes.audio;
  if (fileType.startsWith('image/')) return config.chunkSizes.image;
  return config.chunkSizes.document || config.chunkSizes.default;
}

// ── Pending request maps ───────────────────────────────────────────────────────

const pendingTokenRequests: Array<{
  resolve: (token: string) => void;
  reject: (error: Error) => void;
  timestamp: number;
}> = [];

async function getAuthToken(): Promise<string> {
  if (config.tokenStrategy === 'credentials') {
    return '';
  }

  return new Promise((resolve, reject) => {
    const timestamp = Date.now();
    pendingTokenRequests.push({ resolve, reject, timestamp });

    self.postMessage({ type: 'request_token' });

    setTimeout(() => {
      const index = pendingTokenRequests.findIndex((r) => r.timestamp === timestamp);
      if (index !== -1) {
        pendingTokenRequests.splice(index, 1);
        reject(new Error('Token request timeout'));
      }
    }, 10000);
  });
}

function handleTokenResponse(message: any) {
  const pending = pendingTokenRequests.shift();
  if (!pending) return;

  if (message.token) pending.resolve(message.token);
  else pending.reject(new Error(message.error || 'No token available'));
}

// ── Upload status manager ──────────────────────────────────────────────────────

class UploadStatusManager {
  private statusMap: Map<string, { paused: boolean; cancelled: boolean }> = new Map();
  private abortControllers = new Map<string, AbortController>();

  setPaused(uploadId: string, paused: boolean) {
    const status = this.statusMap.get(uploadId) || { paused: false, cancelled: false };
    status.paused = paused;
    this.statusMap.set(uploadId, status);
  }

  setCancelled(uploadId: string, cancelled: boolean) {
    const status = this.statusMap.get(uploadId) || { paused: false, cancelled: false };
    status.cancelled = cancelled;
    this.statusMap.set(uploadId, status);
  }

  isPaused(uploadId: string): boolean {
    return this.statusMap.get(uploadId)?.paused || false;
  }

  isCancelled(uploadId: string): boolean {
    return this.statusMap.get(uploadId)?.cancelled || false;
  }

  setAbortController(uploadId: string, controller: AbortController) {
    this.abortControllers.set(uploadId, controller);
  }

  clearAbortController(uploadId: string) {
    this.abortControllers.delete(uploadId);
  }

  remove(uploadId: string) {
    this.statusMap.delete(uploadId);
    this.abortControllers.get(uploadId)?.abort();
    this.abortControllers.delete(uploadId);
  }
}

const statusManager = new UploadStatusManager();

// ── IndexedDB storage ──────────────────────────────────────────────────────────

class UploadStorage {
  private db: IDBDatabase | null = null;

  async init() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(config.dbName, config.dbVersion);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        this.db.onerror = () => { };
        resolve(this.db);
      };

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('chunks')) {
          db.createObjectStore('chunks', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('progress')) {
          const progressStore = db.createObjectStore('progress', { keyPath: 'uploadId' });
          progressStore.createIndex('status', 'status', { unique: false });
          progressStore.createIndex('lastUpdated', 'lastUpdated', { unique: false });
        }
      };
    });
  }

  async storeFile(uploadId: string, fileIndex: number, blob: Blob, metadata: Record<string, any>): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const tx = this.db.transaction(['files'], 'readwrite');
    const store = tx.objectStore('files');

    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      const request = store.put({
        id: `${uploadId}_file_${fileIndex}`,
        uploadId,
        fileIndex,
        blob,
        metadata: { ...metadata, size: blob.size, type: blob.type, lastModified: metadata.lastModified || Date.now() },
        timestamp: Date.now(),
      });
      request.onerror = () => reject(request.error);
    });
  }

  async getFile(uploadId: string, fileIndex: number) {
    if (!this.db) throw new Error('Database not initialized');

    const tx = this.db.transaction(['files'], 'readonly');
    const store = tx.objectStore('files');

    return new Promise<{ blob: Blob; metadata: Record<string, any> } | null>((resolve, reject) => {
      const request = store.get(`${uploadId}_file_${fileIndex}`);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async storeProgress(uploadId: string, progress: WorkerProgress): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    if (!uploadId) throw new Error('UploadId is required');

    const tx = this.db.transaction(['progress'], 'readwrite');
    const store = tx.objectStore('progress');

    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);

      const request = store.put({ ...progress, uploadId, lastUpdated: Date.now() });
      request.onerror = () => reject(request.error);
    });
  }

  async getProgress(uploadId: string): Promise<WorkerProgress> {
    if (!this.db) throw new Error('Database not initialized');

    const tx = this.db.transaction(['progress'], 'readonly');
    const store = tx.objectStore('progress');

    return new Promise<WorkerProgress>((resolve, reject) => {
      const request = store.get(uploadId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async deleteProgress(uploadId: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const tx = this.db.transaction(['progress'], 'readwrite');
    const store = tx.objectStore('progress');

    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      const request = store.delete(uploadId);
      request.onerror = () => reject(request.error);
    });
  }

  async getAllProgress(): Promise<WorkerProgress[]> {
    if (!this.db) throw new Error('Database not initialized');

    const tx = this.db.transaction(['progress'], 'readonly');
    const store = tx.objectStore('progress');

    return new Promise<WorkerProgress[]>((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async clearUpload(uploadId: string, finalize: boolean = false) {
    if (!this.db) return;

    try {
      let shouldClear = finalize;

      try {
        const progress = await this.getProgress(uploadId);
        if (!finalize && progress) {
          shouldClear = !progress.maxRetriesReached || progress.status === 'completed';
        }
      } catch {
        shouldClear = finalize;
      }

      if (!shouldClear) return;

      const stores: Array<'files' | 'chunks' | 'progress'> = ['files', 'chunks', 'progress'];

      for (const storeName of stores) {
        if (!this.db.objectStoreNames.contains(storeName)) continue;

        try {
          const tx = this.db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);

          await new Promise<void>((resolve) => {
            const cursorRequest = store.openCursor();

            cursorRequest.onerror = () => resolve();

            cursorRequest.onsuccess = (event) => {
              const cursor = (event.target as IDBRequest<IDBCursorWithValue>)?.result;
              if (cursor) {
                try {
                  if (cursor.value.uploadId === uploadId) cursor.delete();
                  cursor.continue();
                } catch {
                  resolve();
                }
              } else {
                resolve();
              }
            };
          });
        } catch {
          /* continue */
        }
      }
    } catch {
      /* swallow */
    }
  }
}

export type WorkerProgress =
  | {
    uploadId: string;
    fileCount: number;
    currentFileIndex: number;
    currentChunkIndex: number;
    completedFiles: number;
    allFilesSessionId: string[];
    overallProgress: string;
    startTime: number;
    filenames: string[];
    postData?: Record<string, any>;
    metadata?: any[];
    endpoint?: string;
    method?: string;
    uploadType?: string;
    status?: string;
    errorMessage?: string;
    lastUpdated?: number;
    retryCount?: number;
    maxRetriesReached?: boolean;
    transformer?: any;
  }
  | null;

const storage = new UploadStorage();
let storageReady = false;

// ── Retry wrapper ──────────────────────────────────────────────────────────────

async function withRetry<T>(operation: () => Promise<T>, uploadId: string, maxRetries = config.maxRetries): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (statusManager.isCancelled(uploadId)) throw new Error('Upload cancelled');

    if (statusManager.isPaused(uploadId)) {
      await new Promise<void>((resolve) => {
        const checkPause = () => {
          if (!statusManager.isPaused(uploadId)) resolve();
          else setTimeout(checkPause, 100);
        };
        checkPause();
      });

      if (statusManager.isCancelled(uploadId)) throw new Error('Upload cancelled during pause');
    }

    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      try {
        const progress = await storage.getProgress(uploadId);
        if (progress) {
          progress.retryCount = attempt;
          if (attempt >= maxRetries) progress.maxRetriesReached = true;
          await storage.storeProgress(uploadId, progress);
        }
      } catch {
        /* silent */
      }

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, config.retryDelayMs * attempt));
      }
    }
  }

  throw lastError || new Error('Operation failed after retries');
}

// ── Chunk upload ───────────────────────────────────────────────────────────────

async function uploadChunk(
  formData: FormData,
  endpoint: string,
  method: string,
  token: string,
  uploadId: string,
  signal?: AbortSignal
): Promise<{ data: any }> {
  return withRetry(async () => {
    if (statusManager.isCancelled(uploadId)) throw new Error('Upload cancelled');
    if (statusManager.isPaused(uploadId)) throw new Error('Upload paused');

    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(endpoint, {
      method: method.toUpperCase(),
      body: formData,
      headers,
      signal,
      credentials: config.fetchCredentials,
    });

    let data: any = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      throw new Error(data?.message || `Upload failed with status ${response.status}`);
    }

    return { data };
  }, uploadId, config.maxRetries);
}

// ── Core upload loop ───────────────────────────────────────────────────────────

async function processFilesUpload(
  uploadId: string,
  blobArray: Blob[],
  filenameArray: string[],
  uploadState: WorkerProgress,
  resumeUpload: boolean
) {
  if (!uploadState) return;

  const abortController = new AbortController();
  statusManager.setAbortController(uploadId, abortController);

  try {
    const fileCount = uploadState.fileCount || blobArray.length;

    for (let fileIndex = uploadState.currentFileIndex; fileIndex < fileCount; fileIndex++) {
      // Check for cancellation
      if (statusManager.isCancelled(uploadId)) {
        abortController.abort();
        break;
      }

      // Check for pause
      if (statusManager.isPaused(uploadId)) {
        uploadState.status = 'paused';
        await storage.storeProgress(uploadId, uploadState);
        self.postMessage({
          type: 'paused',
          uploadId,
          message: 'Upload paused',
          currentFileIndex: fileIndex,
          currentChunkIndex: uploadState.currentChunkIndex,
        });
        break;
      }

      // Get the blob for this file
      let currentBlob: Blob;
      if (storageReady) {
        const storedFile = await storage.getFile(uploadId, fileIndex);
        if (storedFile?.blob) {
          currentBlob = storedFile.blob;
        } else if (blobArray[fileIndex]) {
          currentBlob = blobArray[fileIndex];
        } else {
          throw new Error(`No file data available for index ${fileIndex}`);
        }
      } else {
        if (blobArray[fileIndex]) {
          currentBlob = blobArray[fileIndex];
        } else {
          throw new Error(`No file data available for index ${fileIndex}`);
        }
      }

      const currentFilename = filenameArray[fileIndex];
      const currentFileNumber = fileIndex + 1;

      // Get or create session ID
      let sessionId: string;
      if (fileIndex < uploadState.allFilesSessionId.length) {
        sessionId = uploadState.allFilesSessionId[fileIndex];
      } else {
        sessionId = generateSessionId();
        uploadState.allFilesSessionId = [...uploadState.allFilesSessionId, sessionId];
        await storage.storeProgress(uploadId, uploadState);
      }

      uploadState.currentFileIndex = fileIndex;
      uploadState.status = 'uploading';
      await storage.storeProgress(uploadId, uploadState);

      const chunkSize = chunkSizeFor(currentBlob.type);
      const totalChunks = Math.ceil(currentBlob.size / chunkSize);

      const startChunkIndex = resumeUpload && fileIndex === uploadState.currentFileIndex
        ? uploadState.currentChunkIndex
        : 0;

      for (let chunkIdx = startChunkIndex; chunkIdx < totalChunks; chunkIdx++) {
        // Check for cancellation
        if (statusManager.isCancelled(uploadId)) {
          abortController.abort();
          uploadState.status = 'cancelled';
          await storage.storeProgress(uploadId, uploadState);
          self.postMessage({
            type: 'cancelled',
            uploadId,
            message: 'Upload cancelled by user',
          });
          return;
        }

        // Check for pause
        if (statusManager.isPaused(uploadId)) {
          uploadState.currentChunkIndex = chunkIdx;
          uploadState.status = 'paused';
          await storage.storeProgress(uploadId, uploadState);
          self.postMessage({
            type: 'paused',
            uploadId,
            message: 'Upload paused',
            currentFileIndex: fileIndex,
            currentChunkIndex: chunkIdx,
            progress: uploadState.overallProgress,
          });
          return;
        }
        // Prepare chunk
        const start = chunkIdx * chunkSize;
        const end = Math.min(start + chunkSize, currentBlob.size);
        const chunk = currentBlob.slice(start, end);

        // Build FormData
        const formData = new FormData();
        formData.append('sessionId', sessionId);
        formData.append('chunkIndex', chunkIdx.toString());
        formData.append('totalChunks', totalChunks.toString());
        formData.append('file', new Blob([chunk], { type: currentBlob.type }), currentFilename);
        formData.append('mimetype', currentBlob.type);
        formData.append('chunksize', chunkSize.toString());
        formData.append('filename', currentFilename);
        formData.append('totalSize', currentBlob.size.toString());
        formData.append('uploadType', uploadState.uploadType || 'default');

        // Add transformer config if present
        if (uploadState.transformer) {
          formData.append('transformer', JSON.stringify(uploadState.transformer));
        }

        // Add metadata
        if (uploadState.metadata && uploadState.metadata.length > 0) {
          const metadata = uploadState.metadata[fileIndex];
          if (metadata) {
            Object.entries(metadata).forEach(([key, value]) => {
              if (typeof value === 'object') {
                formData.append(key, JSON.stringify(value));
              } else {
                formData.append(key, String(value));
              }
            });
          }
        }

        // Add post data
        if (uploadState.postData) {
          Object.entries(uploadState.postData).forEach(([key, value]) => {
            if (typeof value === 'object') {
              formData.append(key, JSON.stringify(value));
            } else {
              formData.append(key, String(value));
            }
          });
        }

        // Upload the chunk
        try {
          let token = '';
          try {
            token = await getAuthToken();
          } catch (error) {
            console.warn('[Worker] Token request failed, continuing without authentication');
          }

          const response = await uploadChunk(
            formData,
            uploadState.endpoint || '/api/upload',
            uploadState.method || 'POST',
            token,
            uploadId,
            abortController.signal
          );

          // ✅ FIX: Accept both 'success' and 'chunk_received' as valid responses
          const validStatuses = ['success', 'chunk_received'];
          if (!response?.data || !validStatuses.includes(response.data.status)) {
            throw new Error(response?.data?.message || 'Chunk upload failed');
          }

          // Update progress
          const progress = response.data.progress || ((chunkIdx + 1) / totalChunks) * 100;
          uploadState.currentChunkIndex = chunkIdx + 1;
          uploadState.status = 'uploading';
          uploadState.retryCount = 0;

          // Calculate file and total progress
          const fileProgress = ((chunkIdx + 1) / totalChunks) * 100;
          const totalProgress = (uploadState.completedFiles * 100 + fileProgress) / fileCount;
          uploadState.overallProgress = totalProgress.toFixed(1);

          await storage.storeProgress(uploadId, uploadState);

          // Send progress update
          self.postMessage({
            type: 'progress',
            uploadId,
            fileIndex,
            fileName: currentFilename,
            chunkIndex: chunkIdx + 1,
            totalChunks,
            fileProgress: fileProgress.toFixed(1),
            overallProgress: uploadState.overallProgress,
            currentFile: currentFileNumber,
            totalFiles: fileCount,
            status: response.data.status,
            response: response.data,
          });

          // ✅ If response is 'success', the upload is complete on server
          if (response.data.status === 'success') {
            uploadState.status = 'completed';
            uploadState.overallProgress = '100.0';
            uploadState.completedFiles = fileCount;
            await storage.storeProgress(uploadId, uploadState);

            self.postMessage({
              type: 'success',
              uploadId,
              status: 'success',
              message: response.data.message || `All ${fileCount} file(s) uploaded successfully.`,
              data: response.data,
              allFilesSessionId: uploadState.allFilesSessionId,
              fileRecord: response.data.file,
              url: response.data.url,
              thumbnailUrl: response.data.thumbnailUrl,
            });

            // Clean up
            try {
              await storage.clearUpload(uploadId, false);
              statusManager.remove(uploadId);
            } catch {
              /* silent */
            }

            return;
          }

          // Check if this was the last chunk
          const isLastChunk = chunkIdx === totalChunks - 1;
          const isLastFile = currentFileNumber === fileCount;

          if (isLastChunk && isLastFile) {
            // All chunks for all files uploaded
            uploadState.status = 'completed';
            uploadState.overallProgress = '100.0';
            uploadState.completedFiles += 1;
            await storage.storeProgress(uploadId, uploadState);

            self.postMessage({
              type: 'success',
              uploadId,
              status: 'success',
              message: response.data.message || `All ${fileCount} file(s) uploaded successfully.`,
              data: response.data,
              allFilesSessionId: uploadState.allFilesSessionId,
              fileRecord: response.data.file,
              url: response.data.url,
              thumbnailUrl: response.data.thumbnailUrl,
            });

            // Clean up
            try {
              await storage.clearUpload(uploadId, false);
              statusManager.remove(uploadId);
            } catch {
              /* silent */
            }

            return;
          }

          // If this was the last chunk of a file, increment completed files
          if (isLastChunk) {
            uploadState.completedFiles += 1;
            uploadState.currentChunkIndex = 0;
            await storage.storeProgress(uploadId, uploadState);
          }

        } catch (error) {
          // Handle specific error types
          if (error instanceof Error) {
            const errorMessage = error.message.toLowerCase();

            if (errorMessage.includes('paused')) {
              uploadState.currentChunkIndex = chunkIdx;
              uploadState.status = 'paused';
              await storage.storeProgress(uploadId, uploadState);
              self.postMessage({
                type: 'paused',
                uploadId,
                message: 'Upload paused',
                currentFileIndex: fileIndex,
                currentChunkIndex: chunkIdx,
                progress: uploadState.overallProgress,
              });
              return;
            }

            if (errorMessage.includes('cancelled')) {
              uploadState.status = 'cancelled';
              await storage.storeProgress(uploadId, uploadState);
              self.postMessage({
                type: 'cancelled',
                uploadId,
                message: 'Upload cancelled',
              });
              return;
            }

            // For other errors, throw to be handled by outer catch
            throw error;
          } else {
            throw error;
          }
        }
      }
    }
  } catch (error) {
    // Handle errors
    uploadState.status = 'error';
    uploadState.errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (uploadState.retryCount !== undefined && uploadState.retryCount >= config.maxRetries) {
      uploadState.maxRetriesReached = true;
    }

    await storage.storeProgress(uploadId, uploadState);

    if (uploadState.maxRetriesReached) {
      self.postMessage({
        type: 'max_retries_reached',
        uploadId,
        message: `Maximum retries reached. Upload data will be kept for 7 days.`,
        error: uploadState.errorMessage,
        retryCount: uploadState.retryCount,
        timestamp: Date.now(),
        canResume: true,
      });
    } else {
      self.postMessage({
        type: 'error',
        uploadId,
        message: uploadState.errorMessage,
        error: error instanceof Error ? error.stack : String(error),
        timestamp: Date.now(),
        canResume: true,
      });
    }
  } finally {
    statusManager.clearAbortController(uploadId);
  }
}
// ── Message handler ────────────────────────────────────────────────────────────

self.addEventListener('message', async (event: MessageEvent) => {
  try {
    if (event.data?.type === 'configure') {
      config = {
        ...config,
        ...event.data.config,
        chunkSizes: { ...config.chunkSizes, ...(event.data.config?.chunkSizes || {}) },
      };
      self.postMessage({ type: 'configured', config });
      return;
    }

    if (!storageReady) {
      try {
        await storage.init();
        storageReady = true;
      } catch (initError) {
        self.postMessage({
          type: 'init_error',
          message: 'Failed to initialize storage',
          error: initError instanceof Error ? initError.message : String(initError),
          uploadId: event.data.uploadId || null,
        });
        return;
      }
    }

    const { type, uploadId } = event.data;

    if (type === 'token_response') return handleTokenResponse(event.data);

    switch (type) {
      case 'pause':
        try {
          const progress = await storage.getProgress(uploadId);
          if (!progress) {
            self.postMessage({ type: 'pause_error', message: 'No upload found to pause', uploadId });
            return;
          }
          statusManager.setPaused(uploadId, true);
          progress.status = 'paused';
          await storage.storeProgress(uploadId, progress);
          self.postMessage({ type: 'paused', uploadId, message: 'Upload paused successfully' });
        } catch (error) {
          self.postMessage({
            type: 'pause_error',
            message: 'Failed to pause upload',
            uploadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;

      case 'resume':
        try {
          const progress = await storage.getProgress(uploadId);
          if (!progress) {
            self.postMessage({ type: 'resume_error', message: 'No upload found to resume', uploadId });
            return;
          }
          statusManager.setPaused(uploadId, false);
          progress.status = 'resuming';
          progress.lastUpdated = Date.now();
          progress.retryCount = 0;
          progress.maxRetriesReached = false;
          await storage.storeProgress(uploadId, progress);

          self.postMessage({
            type: 'resumed',
            uploadId,
            message: 'Upload resumed',
            currentFileIndex: progress.currentFileIndex,
            currentChunkIndex: progress.currentChunkIndex,
          });

          await processFilesUpload(uploadId, [], [], progress, true);
        } catch (error) {
          self.postMessage({
            type: 'resume_error',
            message: 'Failed to resume upload',
            uploadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;

      case 'cancel':
        try {
          const progress = await storage.getProgress(uploadId);
          if (!progress) {
            self.postMessage({ type: 'cancel_error', message: 'No upload found to cancel', uploadId });
            return;
          }
          statusManager.setCancelled(uploadId, true);
          progress.status = 'cancelled';
          progress.lastUpdated = Date.now();
          await storage.storeProgress(uploadId, progress);

          try {
            await storage.clearUpload(uploadId, true);
            statusManager.remove(uploadId);
          } catch {
            /* silent */
          }

          self.postMessage({ type: 'cancelled', uploadId, message: 'Upload cancelled' });
        } catch (error) {
          self.postMessage({
            type: 'cancel_error',
            message: 'Failed to cancel upload',
            uploadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;

      case 'clear_progress':
        try {
          const { uploadId: clearUploadId, uploadIds: clearUploadIds, clearType } = event.data;

          if (clearType === 'all') {
            const allProgress = await storage.getAllProgress();
            for (const p of allProgress) {
              if (p?.uploadId) {
                statusManager.setCancelled(p.uploadId, true);
                statusManager.remove(p.uploadId);
                await storage.clearUpload(p.uploadId, true);
              }
            }
            self.postMessage({ type: 'progress_cleared', message: 'All uploads cleared', clearType: 'all' });
          } else if (clearUploadIds && Array.isArray(clearUploadIds)) {
            for (const id of clearUploadIds) {
              statusManager.setCancelled(id, true);
              statusManager.remove(id);
              await storage.clearUpload(id, true);
            }
            self.postMessage({ type: 'progress_cleared', message: `Uploads cleared`, clearType });
          } else if (clearUploadId) {
            statusManager.setCancelled(clearUploadId, true);
            statusManager.remove(clearUploadId);
            await storage.clearUpload(clearUploadId, true);
            self.postMessage({ type: 'progress_cleared', message: 'Upload cleared', uploadId: clearUploadId });
          }
        } catch (error) {
          self.postMessage({
            type: 'clear_error',
            message: 'Failed to clear progress',
            uploadId: event.data.uploadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;

      case 'upload':
        try {
          const { uploadId: upId, blobArray, filenameArray, endpoint, method, postData, metadata, uploadType, transformer, resumeUpload = false } = event.data;

          let uploadState: WorkerProgress;

          if (resumeUpload) {
            uploadState = await storage.getProgress(upId);
            if (!uploadState) throw new Error('No resume data found');
            uploadState.status = 'resuming';
            uploadState.lastUpdated = Date.now();
            await storage.storeProgress(upId, uploadState);
          } else {
            const fileCount = blobArray?.length || 0;
            const filenames = filenameArray || [];

            if (fileCount === 0) throw new Error('No files provided');
            if (filenames.length !== fileCount) throw new Error('Mismatch between files and filenames');

            uploadState = {
              uploadId: upId,
              fileCount,
              currentFileIndex: 0,
              currentChunkIndex: 0,
              completedFiles: 0,
              allFilesSessionId: [],
              startTime: Date.now(),
              filenames,
              postData: postData || {},
              metadata: metadata || [],
              endpoint: endpoint || '/api/upload',
              method: method || 'POST',
              uploadType,
              status: 'initializing',
              overallProgress: '0.0',
              lastUpdated: Date.now(),
              retryCount: 0,
              maxRetriesReached: false,
              transformer
            };

            await storage.storeProgress(upId, uploadState);

            if (storageReady && blobArray) {
              for (let i = 0; i < blobArray.length; i++) {
                await storage.storeFile(upId, i, blobArray[i], {
                  name: filenames[i],
                  size: blobArray[i].size,
                  type: blobArray[i].type,
                  lastModified: Date.now(),
                  ...metadata?.[i],
                });
              }
            }

            self.postMessage({
              type: 'upload_started',
              uploadId: upId,
              message: 'Upload initialized',
              fileCount,
              filenames,
            });
          }

          await processFilesUpload(upId, blobArray || [], filenameArray || [], uploadState, resumeUpload);
        } catch (error) {
          const upId = event.data.uploadId;
          if (upId) {
            try {
              const p = await storage.getProgress(upId);
              if (p) {
                p.status = 'error';
                p.errorMessage = error instanceof Error ? error.message : 'Unknown error';
                p.lastUpdated = Date.now();
                if (p.retryCount && p.retryCount >= config.maxRetries) {
                  p.maxRetriesReached = true;
                }
                await storage.storeProgress(upId, p);
                if (!p.maxRetriesReached) statusManager.remove(upId);
              }
            } catch {
              /* silent */
            }
          }

          self.postMessage({
            type: 'error',
            uploadId: upId,
            message: error instanceof Error ? error.message : 'Upload failed',
            error: error instanceof Error ? error.stack : String(error),
            timestamp: Date.now(),
          });
        }
        return;

      default:
        return;
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
      uploadId: event.data.uploadId || null,
    });
  }
});

export { };