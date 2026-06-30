/**
 * @upload-media/client - useUploadProgress Store (v3)
 *
 * Simplified for backend-driven processing:
 * - No modifyFile, processImage, processVideo, processAudio
 * - No thumbnail generation
 * - No modification/transformation round-trips to main thread
 * - Worker uploads chunks only, backend processes on finalize
 */

import { createStore } from 'zustand/vanilla';
import { persist, createJSONStorage } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
import {
  UploadProgress,
  FileUploadItem,
  WorkerMessage,
  UpdateProgressParams,
  TransformerConfig,
} from '../types';

enableMapSet();

const CHUNK_SIZES = {
  video: 2 * 1024 * 1024,
  audio: 2 * 1024 * 1024,
  image: 1 * 1024 * 1024,
  default: 5 * 1024 * 1024,
};

const MAX_CONCURRENT_UPLOADS = 5;
const MAX_RETRIES = 3;

function getChunkSizeForFileType(fileType: string): number {
  if (fileType.startsWith('video/')) return CHUNK_SIZES.video;
  if (fileType.startsWith('audio/')) return CHUNK_SIZES.audio;
  if (fileType.startsWith('image/')) return CHUNK_SIZES.image;
  return CHUNK_SIZES.default;
}

export interface UploadProgressState {
  uploads: UploadProgress[];
  activeWorkers: Map<string, Worker>;
  uploadQueue: Map<string, InitializeUploadParams>;
  concurrentUploads: number;

  addUpload: (params: AddUploadParams) => void;
  initializeUpload: (params: InitializeUploadParams) => void;
  updateProgress: (uploadId: string, params: UpdateProgressParams) => void;
  updateUploadProgress: (message: WorkerMessage) => void;
  finalizeUpload: (uploadId: string, success: boolean, data?: any, error?: string) => void;

  pauseUpload: (uploadId: string) => void;
  resumeUpload: (uploadId: string) => void;
  cancelUpload: (uploadId: string) => void;
  retryUpload: (uploadId: string) => void;

  removeUpload: (uploadId: string) => void;
  clearCompleted: () => Promise<void>;
  clearFailed: () => Promise<void>;
  clearAll: () => Promise<void>;

  checkForResumableUploads: () => Promise<void>;
  handleResumeResponse: (message: WorkerMessage) => void;

  createWorker: (uploadId: string) => Worker;
  terminateWorker: (uploadId: string) => void;
  terminateAllWorkers: () => void;

  processUploadQueue: () => void;
  enqueueUpload: (params: InitializeUploadParams) => void;
  getUpload: (uploadId: string) => UploadProgress | undefined;

  // Computed getters
  totalProgress: number;
  activeUploads: number;
  completedUploads: number;
  failedUploads: number;
  pausedUploads: number;
  hasUploads: boolean;
  hasActiveUploads: boolean;
  canResumeAnyUpload: boolean;
}

export interface AddUploadParams {
  uploadId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  endpoint: string;
  method?: string;
  postData?: Record<string, any>;
  metadata?: any[];
  uploadType: string;
}

export interface InitializeUploadParams {
  uploadId: string;
  blobs: Blob[];
  filenameArray: string[];
  endpoint: string;
  method?: string;
  postData?: Record<string, any>;
  metadata?: any[];
  uploadType: string;
  transformer?: TransformerConfig; // TransformerConfig from backend
}

const speedCalculators = new Map<string, { samples: Array<{ timestamp: number; progress: number }> }>();

export const useUploadProgress = createStore<UploadProgressState>()(
  persist(
    immer((set: (fn: (state: UploadProgressState) => void) => void, get: () => UploadProgressState) => ({
      uploads: [],
      activeWorkers: new Map(),
      uploadQueue: new Map(),
      concurrentUploads: 0,

      // ─── Public Methods ──────────────────────────────────────────────

      addUpload: (params) => {
        set((state) => {
          console.log(params)
          const newUpload: UploadProgress = {
            uploadId: params.uploadId,
            files: [
              {
                fileIndex: 0,
                fileName: params.fileName,
                fileSize: params.fileSize,
                fileType: params.fileType,
                progress: 0,
                chunkIndex: 0,
                totalChunks: 0,
                status: 'pending',
              },
            ],
            overallProgress: 0,
            status: 'initializing',
            startTime: Date.now(),
            canResume: false,
            allFilesSessionId: [],
            retryCount: 0,
            maxRetries: MAX_RETRIES,
            fileName: params.fileName,
            fileSize: params.fileSize,
            fileType: params.fileType,
            progress: 0,
            endpoint: params.endpoint,
            method: params.method,
            postData: params.postData,
            metadata: params.metadata,
            uploadType: params.uploadType,
          };
          console.log("newupload", newUpload)
          state.uploads = state.uploads.filter((u) => u.uploadId !== params.uploadId);
          state.uploads.push(newUpload);
          speedCalculators.set(params.uploadId, { samples: [] });
        });
      },

      initializeUpload: (params: InitializeUploadParams) => {
        get().enqueueUpload(params);
      },

      enqueueUpload: (params: InitializeUploadParams) => {
        set((state) => {
          state.uploadQueue.set(params.uploadId, params);
        });
        get().processUploadQueue();
      },

      processUploadQueue: () => {
        const { uploadQueue, concurrentUploads, uploads } = get();

        if (concurrentUploads >= MAX_CONCURRENT_UPLOADS) return;

        const nextUploadId = Array.from(uploadQueue.keys()).find((uploadId) => {
          const upload = uploads.find((u) => u.uploadId === uploadId);
          return !upload || upload?.status !== 'uploading';
        });

        if (!nextUploadId) return;

        const params = uploadQueue.get(nextUploadId);
        if (!params) return;

        set((state) => {
          state.uploadQueue.delete(nextUploadId);
          state.concurrentUploads += 1;
        });

        const { uploadId, blobs, endpoint, method, postData, metadata, filenameArray, uploadType, transformer } = params;

        set((state: UploadProgressState) => {
          state.uploads = state.uploads.filter((u) => u.uploadId !== uploadId);

          const fileItems: FileUploadItem[] = blobs.map((file, index) => ({
            fileIndex: index,
            fileName: filenameArray?.[index] ?? '',
            fileSize: file.size,
            fileType: file.type,
            progress: 0,
            chunkIndex: 0,
            totalChunks: Math.ceil(file.size / getChunkSizeForFileType(file.type)),
            status: 'pending',
            isProcessing: false,
            processingProgress: 0,
          }));

          const newUpload: UploadProgress = {
            uploadId,
            files: fileItems,
            overallProgress: 0,
            status: 'initializing',
            startTime: Date.now(),
            canResume: false,
            retryCount: 0,
            maxRetries: MAX_RETRIES,
            fileName: filenameArray?.[0] || '',
            fileSize: blobs[0]?.size || 0,
            fileType: blobs[0]?.type || '',
            progress: 0,
            endpoint,
            method,
            postData,
            metadata,
            uploadType,
            allFilesSessionId: [],
          };

          state.uploads.push(newUpload);
          speedCalculators.set(uploadId, { samples: [] });
        });

        const worker = get().createWorker(uploadId);
        worker.postMessage({
          type: 'upload',
          uploadId,
          blobArray: blobs,
          filenameArray: filenameArray,
          endpoint,
          method,
          postData,
          metadata,
          uploadType,
          transformer,
        });
      },

      // ─── Progress Updates ────────────────────────────────────────────

      updateProgress: (uploadId: string, params: UpdateProgressParams) => {
        set((state) => {
          const upload = state.uploads.find((u: any) => u.uploadId === uploadId);
          if (!upload) return;

          upload.overallProgress = params.progress;
          upload.progress = params.progress;

          if (params.status) upload.status = params.status;
          if (params.error) upload.error = params.error;
          if (params.speed !== undefined) upload.speed = params.speed;
          if (params.timeRemaining !== undefined) upload.timeRemaining = params.timeRemaining;

          if (upload.files.length === 1 && upload.files[0]) {
            upload.files[0].progress = params.progress;
            if (params.status) upload.files[0].status = params.status as any;
            if (params.error) upload.files[0].error = params.error;
          }

          // Speed calculation
          const calculator = speedCalculators.get(uploadId);
          if (calculator && params.progress < 100 && params.progress > 0) {
            const now = Date.now();
            calculator.samples.push({ timestamp: now, progress: params.progress });
            calculator.samples = calculator.samples.filter((s) => now - s.timestamp < 10000);

            if (calculator.samples.length >= 2) {
              const oldest = calculator.samples[0];
              const latest = calculator.samples[calculator.samples.length - 1];
              const timeDiff = (latest.timestamp - oldest.timestamp) / 1000;
              const progressDiff = latest.progress - oldest.progress;

              if (timeDiff > 0 && progressDiff > 0) {
                const speed = progressDiff / timeDiff;
                const remainingProgress = 100 - params.progress;
                upload.speed = speed;
                upload.timeRemaining = speed > 0 ? remainingProgress / speed : 0;
              }
            }
          }
        });
      },

      updateUploadProgress: (message: WorkerMessage) => {
        set((state) => {
          const upload = state.uploads.find((u: any) => u.uploadId === message.uploadId);
          if (!upload) return;

          const overallProgress = parseFloat(message.overallProgress || '0');
          upload.overallProgress = overallProgress;
          upload.progress = overallProgress;
          upload.status = 'uploading';

          if (typeof message.fileIndex === 'number' && upload.files[message.fileIndex]) {
            const file = upload.files[message.fileIndex];
            file.fileName = message.fileName || file.fileName;
            file.progress = parseFloat(message.fileProgress || '0');
            file.chunkIndex = message.chunkIndex || 0;
            file.totalChunks = message.totalChunks || 0;
            file.status = 'uploading';
          }

          // Speed calculation
          const calculator = speedCalculators.get(message.uploadId);
          if (calculator && overallProgress < 100 && overallProgress > 0) {
            const now = Date.now();
            calculator.samples.push({ timestamp: now, progress: overallProgress });
            calculator.samples = calculator.samples.filter((s) => now - s.timestamp < 10000);

            if (calculator.samples.length >= 2) {
              const oldest = calculator.samples[0];
              const latest = calculator.samples[calculator.samples.length - 1];
              const timeDiff = (latest.timestamp - oldest.timestamp) / 1000;
              const progressDiff = latest.progress - oldest.progress;

              if (timeDiff > 0 && progressDiff > 0) {
                const speed = progressDiff / timeDiff;
                const remainingProgress = 100 - overallProgress;
                upload.speed = speed;
                upload.timeRemaining = speed > 0 ? remainingProgress / speed : 0;
              }
            }
          }
        });
      },

      finalizeUpload: (uploadId, success, data, error) => {
        set((state) => {
          const upload = state.uploads.find((u: any) => u.uploadId === uploadId);
          if (!upload) return;

          upload.endTime = Date.now();
          upload.status = success ? 'completed' : 'failed';
          upload.overallProgress = success ? 100 : upload.overallProgress;
          upload.progress = success ? 100 : upload.progress;
          if (error) upload.error = error;

          upload.files.forEach((file: any) => {
            file.status = success ? 'completed' : file.status === 'completed' ? 'completed' : 'failed';
            file.progress = success ? 100 : file.progress;
            if (error && !success) file.error = error;
          });

          speedCalculators.delete(uploadId);
          state.concurrentUploads = Math.max(0, state.concurrentUploads - 1);
        });

        get().processUploadQueue();

        try {
          const worker = get().activeWorkers.get(uploadId);
          if (worker) {
            worker.postMessage({
              type: 'clear_progress',
              uploadId,
              success,
              data,
              error,
            });
          }
        } catch (error) {
          get().terminateWorker(uploadId);
        }
      },

      // ─── Upload Control ──────────────────────────────────────────────

      pauseUpload: (uploadId) => {
        set((state) => {
          const upload = state.uploads.find((u: any) => u.uploadId === uploadId);
          if (upload && upload?.status === 'uploading') {
            upload.status = 'paused';
            upload.canResume = true;
            upload.files.forEach((file: any) => {
              if (file?.status === 'uploading') file.status = 'paused';
            });
          }
        });

        try {
          const worker = get().activeWorkers.get(uploadId);
          if (worker) {
            worker.postMessage({
              type: 'pause',
              uploadId,
            });
          }
        } catch (error) {
          get().terminateWorker(uploadId);
        }
      },

      resumeUpload: (uploadId) => {
        const upload = get().getUpload(uploadId);
        if (!upload || upload?.status !== 'paused') return;

        set((state) => {
          const uploadToUpdate = state.uploads.find((u: any) => u.uploadId === uploadId);
          if (uploadToUpdate) {
            uploadToUpdate.status = 'uploading';
            uploadToUpdate.files.forEach((file: any) => {
              if (file.status === 'paused') file.status = 'uploading';
            });
            uploadToUpdate.error = undefined;
          }
        });

        speedCalculators.set(uploadId, { samples: [] });
        const worker = get().createWorker(uploadId);
        worker.postMessage({
          type: 'resume',
          uploadId,
        });
      },

      cancelUpload: (uploadId) => {
        set((state) => {
          const upload = state.uploads.find((u: any) => u.uploadId === uploadId);
          if (upload) {
            upload.status = 'cancelled';
            upload.files.forEach((file: any) => {
              if (file?.status !== 'completed') file.status = 'failed';
            });
            upload.error = 'Upload cancelled by user.';
            upload.canResume = false;
            state.concurrentUploads = Math.max(0, state.concurrentUploads - 1);
          }
        });

        try {
          const worker = get().activeWorkers.get(uploadId);
          if (worker) {
            worker.postMessage({
              type: 'cancel',
              uploadId,
            });
          }
        } catch (error) {
          get().terminateWorker(uploadId);
        }

        get().processUploadQueue();
      },

      retryUpload: (uploadId) => {
        const upload = get().getUpload(uploadId);
        if (!upload || upload.retryCount >= upload.maxRetries) return;

        set((state) => {
          const uploadToRetry = state.uploads.find((u: any) => u.uploadId === uploadId);
          if (uploadToRetry) {
            uploadToRetry.status = 'uploading';
            uploadToRetry.overallProgress = 0;
            uploadToRetry.progress = 0;
            uploadToRetry.error = undefined;
            uploadToRetry.retryCount += 1;
            uploadToRetry.startTime = Date.now();
            uploadToRetry.endTime = undefined;
            uploadToRetry.canResume = false;

            uploadToRetry.files.forEach((file: any) => {
              file.status = 'uploading';
              file.progress = 0;
              file.chunkIndex = 0;
              file.error = undefined;
            });
          }
        });

        speedCalculators.set(uploadId, { samples: [] });
        const worker = get().createWorker(uploadId);
        worker.postMessage({
          type: 'resume',
          uploadId,
        });
      },

      // ─── Cleanup ─────────────────────────────────────────────────────

      removeUpload: async (uploadId: string) => {
        get().terminateWorker(uploadId);
        const tempWorker = get().createWorker('cleanup-worker');
        try {
          tempWorker.postMessage({
            type: 'clear_progress',
            uploadId,
            clearType: 'single',
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (error) {
          tempWorker.terminate();
        }

        set((state) => {
          state.uploads = state.uploads.filter((u: any) => u.uploadId !== uploadId);
          state.concurrentUploads = Math.max(0, state.concurrentUploads - 1);
        });

        speedCalculators.delete(uploadId);
        get().processUploadQueue();
      },

      clearCompleted: async () => {
        const completedIds = get()
          .uploads.filter((u: any) => u?.status === 'completed')
          .map((u: any) => u.uploadId);

        if (completedIds.length > 0) {
          const worker = get().createWorker('cleanup-worker-completed');
          try {
            worker.postMessage({
              type: 'clear_progress',
              uploadIds: completedIds,
              clearType: 'completed',
            });
            await new Promise((resolve) => setTimeout(resolve, 100));
          } catch (error) {
            worker.terminate();
          }
        }

        set((state) => {
          state.uploads = state.uploads.filter((u: any) => u?.status !== 'completed');
        });

        completedIds.forEach((id) => speedCalculators.delete(id));
      },

      clearFailed: async () => {
        const failedIds = get()
          .uploads.filter((u: any) => u?.status === 'failed')
          .map((u: any) => u.uploadId);

        if (failedIds.length > 0) {
          const worker = get().createWorker('cleanup-worker-failed');
          try {
            worker.postMessage({
              type: 'clear_progress',
              uploadIds: failedIds,
              clearType: 'failed',
            });
            await new Promise((resolve) => setTimeout(resolve, 100));
          } catch (error) {
            worker.terminate();
          }
        }

        set((state) => {
          state.uploads = state.uploads.filter((u: any) => u?.status !== 'failed');
        });

        failedIds.forEach((id) => speedCalculators.delete(id));
      },

      clearAll: async () => {
        get().terminateAllWorkers();
        const worker = get().createWorker('cleanup-worker-all');
        try {
          worker.postMessage({
            type: 'clear_progress',
            clearType: 'all',
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (error) {
          worker.terminate();
        }

        set((state) => {
          state.uploads = [];
          state.uploadQueue = new Map();
          state.concurrentUploads = 0;
        });
        speedCalculators.clear();
      },

      // ─── Resumable Uploads ────────────────────────────────────────────

      checkForResumableUploads: async () => {
        try {
          if (typeof window !== 'undefined' && window?.indexedDB) {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const request = indexedDB.open('UploadDB', 3);
              request.onerror = () => reject(request.error);
              request.onsuccess = () => resolve(request.result);
              request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains('progress')) {
                  const store = db.createObjectStore('progress', { keyPath: 'uploadId' });
                  store.createIndex('status', 'status', { unique: false });
                  store.createIndex('lastUpdated', 'lastUpdated', { unique: false });
                }
                if (!db.objectStoreNames.contains('files')) {
                  db.createObjectStore('files', { keyPath: 'id' });
                }
              };
            });

            const progressRecords = await new Promise<any[]>((resolve, reject) => {
              const tx = db.transaction('progress', 'readonly');
              const store = tx.objectStore('progress');
              const request = store.getAll();
              request.onsuccess = () => resolve(request.result || []);
              request.onerror = () => reject(request.error);
            });

            set((state) => {
              progressRecords.forEach((record) => {
                if (!state.uploads.some((u: any) => u.uploadId === record.uploadId)) {
                  const files: FileUploadItem[] = [];

                  if (record.filenames?.length) {
                    record.filenames.forEach((name: string, index: number) => {
                      const metadata = record.metadata?.[index] || {};
                      const fileType = metadata.type?.split('/')[0] || 'default';
                      const chunkSize = CHUNK_SIZES[fileType as keyof typeof CHUNK_SIZES] || CHUNK_SIZES.default;
                      const fileSize = metadata.size || 0;
                      const totalChunks = Math.ceil(fileSize / chunkSize);

                      let progress = 0;
                      let status: any = 'paused';
                      let chunkIndex = 0;

                      if (index < (record.completedFiles || 0)) {
                        progress = 100;
                        status = 'completed';
                      } else if (index === (record.currentFileIndex || 0)) {
                        chunkIndex = record.currentChunkIndex || 0;
                        progress = totalChunks > 0 ? (chunkIndex / totalChunks) * 100 : 0;
                        status =
                          record?.status === 'paused'
                            ? 'paused'
                            : record?.status === 'uploading'
                              ? 'uploading'
                              : 'failed';
                      }

                      files.push({
                        fileIndex: index,
                        fileName: name,
                        fileSize,
                        fileType: metadata.type || '',
                        progress,
                        chunkIndex,
                        totalChunks,
                        status,
                        sessionId: record.allFilesSessionId?.[index],
                      });
                    });
                  }

                  const fileCount = record.fileCount || files.length;
                  const completedFiles = record.completedFiles || 0;
                  const overallProgress =
                    record.overallProgress !== undefined ? record.overallProgress : fileCount > 0 ? (completedFiles / fileCount) * 100 : 0;

                  state.uploads.push({
                    uploadId: record.uploadId,
                    files,
                    overallProgress,
                    status: record?.status || 'paused',
                    startTime: record.startTime || Date.now(),
                    canResume: true,
                    allFilesSessionId: record.allFilesSessionId || [],
                    retryCount: record.retryCount || 0,
                    maxRetries: record.maxRetries || MAX_RETRIES,
                    fileName: record.filenames?.[0] || '',
                    fileSize: record.fileSize || 0,
                    fileType: record.fileType || '',
                    progress: overallProgress,
                    endpoint: record.endpoint,
                    method: record.method,
                    postData: record.postData,
                    metadata: record.metadata,
                    uploadType: record.uploadType,
                  });
                }
              });
            });

            db.close();
          }
        } catch (error) {
          set((state) => {
            //@ts-ignore
            state.error = error instanceof Error ? error.message : 'Failed to load resumable uploads';
          });
        }
      },

      handleResumeResponse: (message: any) => {
        if (message.type === 'resume_available') {
          const { uploadId } = message;
          const worker = get().createWorker(uploadId);
          worker.postMessage({
            resumeUpload: true,
            type: 'upload',
            uploadId,
          });
        }
      },

      // ─── Worker Management ──────────────────────────────────────────

      createWorker: (uploadId) => {
        if (typeof Worker === 'undefined') {
          throw new Error('Web Workers not supported');
        }

        get().terminateWorker(uploadId);

        let worker: Worker;
        try {
          worker = new Worker(new URL('../dist/worker/upload.worker.mjs', import.meta.url), { type: 'module' });
        } catch (error) {
          console.warn('[Worker] Trying dev path...');
          try {
            worker = new Worker(new URL('../worker/upload.worker.ts', import.meta.url), { type: 'module' });
          } catch (fallbackError) {
            const errorMsg = `Failed to create worker: ${error instanceof Error ? error.message : String(error)}`;
            console.error('[Worker Creation Error]', errorMsg);
            get().finalizeUpload(uploadId, false, undefined, errorMsg);
            throw error;
          }
        }

        worker.onmessage = async (event) => {
          const message: WorkerMessage = event.data;

          switch (message.type) {
            case 'request_token':
              try {
                // Emit to your app's auth system
                const token = null; // Replace with actual token retrieval
                const workerInstance = get().activeWorkers.get(uploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: 'token_response',
                    token,
                  });
                }
              } catch (error) {
                const workerInstance = get().activeWorkers.get(uploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: 'token_response',
                    token: null,
                    error: error instanceof Error ? error.message : 'Failed to get token',
                  });
                }
              }
              break;

            case 'progress':
            case 'chunk_progress':
              get().updateUploadProgress(message);
              break;

            case 'success':
              get().finalizeUpload(uploadId, true, message.data);
              console.log('Upload successful:', message.message);
              break;

            case 'error':
              get().finalizeUpload(uploadId, false, undefined, message.message);
              if (message.canResume) {
                set((state: UploadProgressState) => {
                  const upload = state.uploads.find((u) => u.uploadId === uploadId);
                  if (upload) {
                    upload.canResume = true;
                    upload.status = 'paused';
                  }
                });
              }
              console.error('Upload error:', message.message);
              break;

            case 'init_error':
              get().finalizeUpload(uploadId, false, undefined, `Initialization error: ${message.message}`);
              console.error('Init error:', message.message);
              break;

            case 'max_retries_reached':
              get().finalizeUpload(uploadId, false, undefined, message.message);
              console.warn('Max retries reached:', message.message);
              break;

            case 'paused':
            case 'resumed':
            case 'cancelled':
            case 'upload_started':
              // Status changes, just update progress
              break;

            default:
              break;
          }
        };

        worker.onerror = (error) => {
          get().finalizeUpload(uploadId, false, undefined, `Worker error: ${error.message || 'Unknown error'}`);
          get().terminateWorker(uploadId);
        };

        set((state) => {
          state.activeWorkers.set(uploadId, worker);
        });

        return worker;
      },

      terminateWorker: (uploadId) => {
        const worker = get().activeWorkers.get(uploadId);
        if (worker) {
          worker.terminate();
          set((state) => {
            state.activeWorkers.delete(uploadId);
          });
        }
      },

      terminateAllWorkers: () => {
        get()
          .activeWorkers.forEach((worker) => worker.terminate());
        set((state) => {
          state.activeWorkers.clear();
        });
      },

      getUpload: (uploadId) => {
        return get().uploads.find((u) => u.uploadId === uploadId);
      },

      // ─── Computed Getters ────────────────────────────────────────────

      get totalProgress() {
        const { uploads } = get();
        if (uploads.length === 0) return 0;
        return uploads.reduce((sum: number, upload: UploadProgress) => sum + upload.overallProgress, 0) / uploads.length;
      },

      get activeUploads() {
        return get()
          .uploads.filter(
            (u) => u.status === 'uploading' || u.status === 'initializing' || u.status === 'processing'
          ).length;
      },

      get completedUploads() {
        return get().uploads.filter((u) => u.status === 'completed').length;
      },

      get failedUploads() {
        return get().uploads.filter((u) => u.status === 'failed').length;
      },

      get pausedUploads() {
        return get().uploads.filter((u) => u.status === 'paused').length;
      },

      get hasUploads() {
        return get().uploads.length > 0;
      },

      get hasActiveUploads() {
        return get().activeUploads > 0;
      },

      get canResumeAnyUpload() {
        return get().uploads.some((u) => u.canResume && u.status === 'paused');
      },
    })),
    {
      name: 'upload-progress-storage',
      storage: createJSONStorage(() => {
        if (typeof window !== 'undefined' && window?.localStorage) {
          return localStorage;
        }
        return {
          getItem: () => null,
          setItem: () => { },
          removeItem: () => { },
        };
      }),
      partialize: (state) => ({
        uploads: state.uploads.filter((u: any) => u?.status === 'paused' || u?.status === 'failed'),
      }),
    }
  )
);

export const useUploadActions = () => {
  const store = useUploadProgress.getState();
  return {
    addUpload: store.addUpload,
    initializeUpload: store.initializeUpload,
    updateProgress: store.updateProgress,
    pauseUpload: store.pauseUpload,
    resumeUpload: store.resumeUpload,
    cancelUpload: store.cancelUpload,
    retryUpload: store.retryUpload,
    removeUpload: store.removeUpload,
    clearCompleted: store.clearCompleted,
    clearFailed: store.clearFailed,
    clearAll: store.clearAll,
    checkForResumableUploads: store.checkForResumableUploads,
    createWorker: store.createWorker,
  };
};

export const cleanupUploadResources = () => {
  const { terminateAllWorkers } = useUploadProgress.getState();
  terminateAllWorkers();
  speedCalculators.clear();
};