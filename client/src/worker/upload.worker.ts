/**
 * upload.worker.ts (v3)
 *
 * Stateless, hardware-optimized chunked upload worker.
 *
 * v3 changes:
 * - IndexedDB Storage Durability Shield (persistent storage request)
 * - Quota capacity monitoring before upload start
 * - Foundation for stateless token handshake (Phase 2)
 */

/// <reference lib="webworker" />

declare const self: DedicatedWorkerGlobalScope;

import {
  requestPersistentStorage,
  checkStorageCapacity,
  formatBytes,
  type DurabilityStatus,
} from './durability';

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
  mockNetworkDropRate?: number;
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
  mockNetworkDropRate: 0,
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
  private durabilityStatus: DurabilityStatus | null = null;

  async init() {
    // ── Storage Durability Shield ───────────────────────────────────────
    // Request persistent storage classification BEFORE opening IndexedDB.
    // This tells the browser's disk space manager to protect our records
    // from silent eviction under memory pressure. Without this, paused or
    // slow uploads can lose cached chunks mid-stream.
    try {
      this.durabilityStatus = await requestPersistentStorage();

      if (this.durabilityStatus.apiAvailable && !this.durabilityStatus.persisted) {
        self.postMessage({
          type: 'storage_warning',
          message: 'Browser denied persistent storage. Upload data may be evicted under memory pressure. ' +
            'Paused uploads are at risk of data loss on low-storage devices.',
          quota: this.durabilityStatus.quota,
          persisted: false,
        });
      }
    } catch (durabilityError) {
      // Non-fatal: if the durability check fails, we still proceed.
      // The upload will work, but without eviction protection.
      console.warn('[Worker] Storage durability check failed:', durabilityError);
    }

    // ── IndexedDB Open ─────────────────────────────────────────────────
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

  /**
   * Check whether the browser has enough storage capacity for a new upload.
   * Emits a warning message if headroom is insufficient but does NOT block
   * the upload — the caller decides policy.
   */
  async checkCapacityForUpload(totalBytes: number, uploadId: string): Promise<boolean> {
    const check = await checkStorageCapacity(totalBytes);

    if (!check.sufficient) {
      self.postMessage({
        type: 'storage_warning',
        uploadId,
        message: `Low storage: ${formatBytes(check.availableBytes)} available, ` +
          `but ${formatBytes(check.requiredBytes)} needed (2× safety margin for ${formatBytes(totalBytes)} upload). ` +
          `Upload will proceed, but resume data may be evicted if the device runs low on storage.`,
        availableBytes: check.availableBytes,
        requiredBytes: check.requiredBytes,
      });
      return false;
    }

    return true;
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
    completedChunksMap?: Record<string, boolean>;
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

    // Emulate network drops
    if (typeof config.mockNetworkDropRate === 'number' && config.mockNetworkDropRate > 0) {
      if (Math.random() < config.mockNetworkDropRate) {
        console.warn(`[Worker] Simulating mock network drop (rate: ${config.mockNetworkDropRate})`);
        throw new Error('Simulated network connection drop');
      }
    }

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
  uploadState: NonNullable<WorkerProgress>,
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

      // Step 1: Upload all chunks except the final chunk (totalChunks - 1) concurrently
      const chunksToUpload: number[] = [];
      const completedChunksMap = uploadState.completedChunksMap || {};
      uploadState.completedChunksMap = completedChunksMap;

      for (let chunkIdx = 0; chunkIdx < totalChunks - 1; chunkIdx++) {
        const isCompleted = resumeUpload && completedChunksMap[`${fileIndex}_${chunkIdx}`] === true;
        if (!isCompleted) {
          chunksToUpload.push(chunkIdx);
        }
      }

      if (chunksToUpload.length > 0) {
        const activePromises: Promise<void>[] = [];
        let nextQueueIndex = 0;
        let uploadError: any = null;

        const runWorker = async () => {
          while (nextQueueIndex < chunksToUpload.length && !uploadError) {
            if (statusManager.isCancelled(uploadId)) break;
            if (statusManager.isPaused(uploadId)) break;

            const currentQueueIndex = nextQueueIndex++;
            if (currentQueueIndex >= chunksToUpload.length) break;
            const chunkIdx = chunksToUpload[currentQueueIndex];

            const start = chunkIdx * chunkSize;
            const end = Math.min(start + chunkSize, currentBlob.size);
            const chunk = currentBlob.slice(start, end);

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

            if (uploadState.transformer) {
              formData.append('transformer', JSON.stringify(uploadState.transformer));
            }

            if (uploadState.metadata && uploadState.metadata.length > 0) {
              const metadataVal = uploadState.metadata[fileIndex];
              if (metadataVal) {
                Object.entries(metadataVal).forEach(([key, value]) => {
                  if (typeof value === 'object') {
                    formData.append(key, JSON.stringify(value));
                  } else {
                    formData.append(key, String(value));
                  }
                });
              }
            }

            if (uploadState.postData) {
              Object.entries(uploadState.postData).forEach(([key, value]) => {
                if (typeof value === 'object') {
                  formData.append(key, JSON.stringify(value));
                } else {
                  formData.append(key, String(value));
                }
              });
            }

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

              if (statusManager.isCancelled(uploadId) || statusManager.isPaused(uploadId)) {
                break;
              }

              const validStatuses = ['success', 'chunk_received'];
              if (!response?.data || !validStatuses.includes(response.data.status)) {
                throw new Error(response?.data?.message || 'Chunk upload failed');
              }

              completedChunksMap[`${fileIndex}_${chunkIdx}`] = true;
              uploadState.completedChunksMap = completedChunksMap;

              const fileProgress = (Object.keys(completedChunksMap).filter(k => k.startsWith(`${fileIndex}_`)).length / totalChunks) * 100;
              const totalProgress = (uploadState.completedFiles * 100 + fileProgress) / fileCount;
              uploadState.overallProgress = Math.min(totalProgress, 99.9).toFixed(1);
              uploadState.status = 'uploading';
              uploadState.retryCount = 0;

              // Shared/brief readwrite isolation transaction to commit chunk index completion
              await storage.storeProgress(uploadId, uploadState);

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

            } catch (err: any) {
              uploadError = err;
            }
          }
        };

        const concurrencyLimit = Math.min(config.maxConcurrentUploads || 5, chunksToUpload.length);
        for (let i = 0; i < concurrencyLimit; i++) {
          activePromises.push(runWorker());
        }

        await Promise.all(activePromises);

        if (uploadError) {
          throw uploadError;
        }
      }

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

      if (statusManager.isPaused(uploadId)) {
        uploadState.status = 'paused';
        await storage.storeProgress(uploadId, uploadState);
        self.postMessage({
          type: 'paused',
          uploadId,
          message: 'Upload paused',
          currentFileIndex: fileIndex,
          currentChunkIndex: 0,
          progress: uploadState.overallProgress,
        });
        return;
      }

      // Step 2: Upload the final chunk (N-1)
      const finalChunkIdx = totalChunks - 1;
      const isFinalChunkCompleted = resumeUpload && completedChunksMap[`${fileIndex}_${finalChunkIdx}`] === true;

      if (!isFinalChunkCompleted) {
        const start = finalChunkIdx * chunkSize;
        const end = Math.min(start + chunkSize, currentBlob.size);
        const chunk = currentBlob.slice(start, end);

        const formData = new FormData();
        formData.append('sessionId', sessionId);
        formData.append('chunkIndex', finalChunkIdx.toString());
        formData.append('totalChunks', totalChunks.toString());
        formData.append('file', new Blob([chunk], { type: currentBlob.type }), currentFilename);
        formData.append('mimetype', currentBlob.type);
        formData.append('chunksize', chunkSize.toString());
        formData.append('filename', currentFilename);
        formData.append('totalSize', currentBlob.size.toString());
        formData.append('uploadType', uploadState.uploadType || 'default');

        // Compute client-side SHA-256 for integrity verification
        let checksum = '';
        try {
          const arrayBuffer = await currentBlob.arrayBuffer();
          const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
          const hashArray = Array.from(new Uint8Array(hashBuffer));
          checksum = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (hashErr) {
          console.warn('[Worker] Failed to compute file cryptographic hash:', hashErr);
        }

        if (checksum) {
          formData.append('checksum', checksum);
          formData.append('signature', checksum);
        }

        if (uploadState.transformer) {
          formData.append('transformer', JSON.stringify(uploadState.transformer));
        }

        if (uploadState.metadata && uploadState.metadata.length > 0) {
          const metadataVal = uploadState.metadata[fileIndex];
          if (metadataVal) {
            Object.entries(metadataVal).forEach(([key, value]) => {
              if (typeof value === 'object') {
                formData.append(key, JSON.stringify(value));
              } else {
                formData.append(key, String(value));
              }
            });
          }
        }

        if (uploadState.postData) {
          Object.entries(uploadState.postData).forEach(([key, value]) => {
            if (typeof value === 'object') {
              formData.append(key, JSON.stringify(value));
            } else {
              formData.append(key, String(value));
            }
          });
        }

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

        if (statusManager.isCancelled(uploadId) || statusManager.isPaused(uploadId)) {
          return;
        }

        // Only explicitly check for errors, otherwise assume success for 2xx responses
        if (response?.data?.error || response?.data?.status === 'error') {
          throw new Error(response?.data?.message || response?.data?.error || 'Final chunk upload failed');
        }

        completedChunksMap[`${fileIndex}_${finalChunkIdx}`] = true;
        uploadState.completedChunksMap = completedChunksMap;

        const fileProgress = 100;
        const totalProgress = (uploadState.completedFiles * 100 + fileProgress) / fileCount;
        uploadState.overallProgress = Math.min(totalProgress, 100.0).toFixed(1);

        await storage.storeProgress(uploadId, uploadState);

        self.postMessage({
          type: 'progress',
          uploadId,
          fileIndex,
          fileName: currentFilename,
          chunkIndex: finalChunkIdx + 1,
          totalChunks,
          fileProgress: fileProgress.toFixed(1),
          overallProgress: uploadState.overallProgress,
          currentFile: currentFileNumber,
          totalFiles: fileCount,
          status: response.data.status,
          response: response.data,
        });

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

          try {
            await storage.clearUpload(uploadId, false);
            statusManager.remove(uploadId);
          } catch {}
          return;
        }
      }

      uploadState.completedFiles += 1;
      await storage.storeProgress(uploadId, uploadState);
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

            // ── Pre-upload capacity check ──────────────────────────────────
            // Sum total bytes across all files and verify the browser has
            // enough IndexedDB headroom to cache them for resume support.
            if (storageReady) {
              const totalUploadBytes = blobArray.reduce(
                (sum: number, blob: Blob) => sum + blob.size, 0
              );
              await storage.checkCapacityForUpload(totalUploadBytes, upId);
            }

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