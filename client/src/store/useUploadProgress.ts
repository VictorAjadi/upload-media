import { createStore } from 'zustand/vanilla';
import { persist, createJSONStorage } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
import { getUploadMediaConfig } from '../config';
import { VideoTrimmer } from '../hooks/useVideoTrimmer';
import { AudioTrimmer } from '../hooks/useAudioTrimmer';
import {
  UploadProgress,
  FileUploadItem,
  WorkerMessage,
  ModificationConfig,
  UpdateProgressParams
} from '../types';

enableMapSet();

const CHUNK_SIZES = {
  video: 2 * 1024 * 1024,
  audio: 2 * 1024 * 1024,
  image: 1 * 1024 * 1024,
  document: 5 * 1024 * 1024
};

const MAX_CONCURRENT_UPLOADS = 5;
const MAX_RETRIES = 3;

function getChunkSizeForFileType(fileType: string): number {
  if (fileType.startsWith('video/')) return CHUNK_SIZES.video;
  if (fileType.startsWith('audio/')) return CHUNK_SIZES.audio;
  if (fileType.startsWith('image/')) return CHUNK_SIZES.image;
  return CHUNK_SIZES.document;
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
  videoStartTime?: string;
  videoEndTime?: string;
  duration?: string;
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
  modificationConfigs?: ModificationConfig[];
  videoStartTime?: string;
  videoEndTime?: string;
  duration?: string;
  uploadType: string;
  transformer?: { quality?: number | 'high' | 'medium' | 'low'; auto?: boolean; format?: string };
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
  handleModificationRequest: (message: WorkerMessage) => void;

  pauseUpload: (uploadId: string) => void;
  resumeUpload: (uploadId: string) => void;
  cancelUpload: (uploadId: string) => void;
  retryUpload: (uploadId: string) => void;

  removeUpload: (uploadId: string) => void;
  clearCompleted: () => void;
  clearFailed: () => void;
  clearAll: () => void;

  checkForResumableUploads: () => Promise<void>;
  handleResumeResponse: (message: WorkerMessage) => void;

  createWorker: (uploadId: string) => Worker;
  terminateWorker: (uploadId: string) => void;
  terminateAllWorkers: () => void;

  processUploadQueue: () => void;
  enqueueUpload: (params: InitializeUploadParams) => void;

  modifyFile: (uploadId: string, fileIndex: number, blob: Blob, config: any) => Promise<Blob>;
  generateThumbnail: (uploadId: string, fileIndex: number, blob: Blob) => Promise<string>;
  handleThumbnailRequest: (message: WorkerMessage) => Promise<void>;
  handleTransformationRequest: (message: WorkerMessage) => Promise<void>;
  getUpload: (uploadId: string) => UploadProgress | undefined;

  totalProgress: number;
  activeUploads: number;
  completedUploads: number;
  failedUploads: number;
  pausedUploads: number;
  hasUploads: boolean;
  hasActiveUploads: boolean;
  canResumeAnyUpload: boolean;
}

const speedCalculators = new Map<string, { samples: Array<{ timestamp: number; progress: number }> }>();

export const useUploadProgress = createStore<UploadProgressState>()(
  persist(
    immer((set: (fn: (state: UploadProgressState) => void) => void, get: () => UploadProgressState) => ({
      uploads: [],
      activeWorkers: new Map(),
      uploadQueue: new Map(),
      concurrentUploads: 0,

      addUpload: (params) => {
        set((state) => {
          const newUpload: UploadProgress = {
            uploadId: params.uploadId,
            files: [{
              fileIndex: 0,
              fileName: params.fileName,
              fileSize: params.fileSize,
              fileType: params.fileType,
              progress: 0,
              chunkIndex: 0,
              totalChunks: 0,
              status: 'pending',
              needsModification: false,
              isModified: false
            }],
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
            videoStartTime: params.videoStartTime,
            videoEndTime: params.videoEndTime,
            duration: params.duration,
          };

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

        const nextUploadId = Array.from(uploadQueue.keys()).find(uploadId => {
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

        const { uploadId, blobs, endpoint, method, postData, metadata, videoStartTime, videoEndTime, duration, filenameArray, modificationConfigs, uploadType, transformer } = params;

        const transformerConfigs = blobs.map((_, index) => ({
          needsTransformation: transformer ? true : false,
          isTransformed: false,
          config: transformer
        }));

        set((state: UploadProgressState) => {
          state.uploads = state.uploads.filter((u) => u.uploadId !== uploadId);
          const { videoState } = getUploadMediaConfig();
          const { videos } = (videoState as any).getState();
          const fileItems: FileUploadItem[] = blobs.map((file, index) => ({
            fileIndex: index,
            fileName: filenameArray?.[index] ?? '',
            fileSize: file.size,
            fileType: file.type,
            progress: 0,
            chunkIndex: 0,
            totalChunks: Math.ceil(file.size / getChunkSizeForFileType(file.type)),
            status: 'pending',
            needsModification: modificationConfigs?.[index]?.needsModification || false,
            isModified: false,
            modificationProgress: 0,
            ...(videos[index] || {
              startTime: 0,
              endTime: null,
              isMuted: false,
              videoDuration: null
            }),
            needsTransformation: transformer ? true : false,
            isTransformed: false
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
            modificationConfigs,
            //@ts-ignore
            transformerConfigs,
            videoStartTime,
            videoEndTime,
            duration,
            uploadType,
            allFilesSessionId: []
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
          modificationConfigs,
          videoStartTime,
          videoEndTime,
          duration,
          uploadType,
          transformerConfigs
        });
      },

      handleThumbnailRequest: async (message: WorkerMessage) => {
        const { uploadId, fileIndex } = message;
        if (fileIndex === undefined) return;

        const upload = get().getUpload(uploadId);
        if (!upload) {
          const worker = get().activeWorkers.get(uploadId);
          if (worker) {
            worker.postMessage({
              type: 'thumbnail_error',
              uploadId,
              fileIndex,
              error: 'Upload not found'
            });
          }
          return;
        }

        set((state: UploadProgressState) => {
          const uploadToUpdate = state.uploads.find((u) => u.uploadId === uploadId);
          if (uploadToUpdate) {
            uploadToUpdate.status = 'generating_thumbnail';
            if (uploadToUpdate.files[fileIndex]) {
              uploadToUpdate.files[fileIndex].status = 'generating_thumbnail';
            }
          }
        });

        try {
          const worker = get().activeWorkers.get(uploadId);
          if (!worker) {
            throw new Error('Worker not found');
          }

          worker.postMessage({
            type: 'get_thumbnail_data',
            uploadId,
            fileIndex
          });
        } catch (error) {
          const worker = get().activeWorkers.get(uploadId);
          if (worker) {
            worker.postMessage({
              type: 'thumbnail_error',
              uploadId,
              fileIndex,
              error: error instanceof Error ? error.message : 'Failed to request thumbnail'
            });
          }
        }
      },

      generateThumbnail: async (uploadId: string, fileIndex: number, blob: Blob): Promise<string> => {
        const upload = get().getUpload(uploadId);
        if (!upload) throw new Error('Upload not found');

        try {
          const thumbnailBase64 = await generateVideoThumbnail(blob);

          set((state) => {
            const uploadToUpdate = state.uploads.find((u: any) => u.uploadId === uploadId);
            if (uploadToUpdate && uploadToUpdate.files[fileIndex]) {
              uploadToUpdate.files[fileIndex].status = 'uploading';
            }
          });

          return thumbnailBase64;
        } catch (error) {
          set((state) => {
            const uploadToUpdate = state.uploads.find((u: any) => u.uploadId === uploadId);
            if (uploadToUpdate && uploadToUpdate.files[fileIndex]) {
              uploadToUpdate.files[fileIndex].status = 'uploading';
            }
          });
          throw error;
        }
      },

      handleModificationRequest: async (message: WorkerMessage) => {
        const { uploadId, fileIndex } = message;
        if (fileIndex === undefined) return;

        const upload = get().getUpload(uploadId);
        if (!upload) {
          return;
        }

        set((state) => {
          const uploadToUpdate = state.uploads.find((u: any) => u.uploadId === uploadId);
          if (uploadToUpdate) {
            uploadToUpdate.status = 'modifying';
            uploadToUpdate.currentModifyingIndex = fileIndex;
            if (uploadToUpdate.files[fileIndex]) {
              uploadToUpdate.files[fileIndex].status = 'modifying';
            }
          }
        });

        try {
          const worker = get().activeWorkers.get(uploadId);
          if (!worker) {
            return;
          }

          worker.postMessage({
            type: 'get_file_data',
            uploadId,
            fileIndex
          });
        } catch (error) {
        }
      },

      handleTransformationRequest: async (message: WorkerMessage) => {
        const { uploadId, fileIndex, transformer } = message;
        if (fileIndex === undefined) return;

        const upload = get().getUpload(uploadId);
        if (!upload) return;

        set((state) => {
          const uploadToUpdate = state.uploads.find((u: any) => u.uploadId === uploadId);
          if (uploadToUpdate) {
            uploadToUpdate.status = 'transforming' as any;
            if (uploadToUpdate.files[fileIndex]) {
              uploadToUpdate.files[fileIndex].status = 'transforming' as any;
            }
          }
        });

        try {
          // Standard pattern: request file data from worker first if needed, 
          // but since the worker already called us with request_transformation, 
          // we might need to get the blob.
          // In the current architecture, we request file data from worker.
          const worker = get().activeWorkers.get(uploadId);
          if (worker) {
            worker.postMessage({
              type: 'get_file_data_for_trans', // New worker message type
              uploadId,
              fileIndex,
              transformer
            });
          }
        } catch (error) {
        }
      },

      modifyFile: async (uploadId: string, fileIndex: number, blob: Blob, config: any): Promise<Blob> => {
        const upload = get().getUpload(uploadId);
        if (!upload) throw new Error('Upload not found');

        set((state) => {
          const uploadToUpdate = state.uploads.find((u: any) => u.uploadId === uploadId);
          if (uploadToUpdate && uploadToUpdate.files[fileIndex]) {
            uploadToUpdate.files[fileIndex].modificationProgress = 0;
            uploadToUpdate.files[fileIndex].status = 'modifying';
          }
        });

        const updateStoreProgress = (progress: number) => {
          set((state) => {
            const uploadToUpdate = state.uploads.find((u: any) => u.uploadId === uploadId);
            if (uploadToUpdate && uploadToUpdate.files[fileIndex]) {
              uploadToUpdate.files[fileIndex].modificationProgress = progress;
            }
          });
        };

        try {
          const { customTransformer } = getUploadMediaConfig();
          if (customTransformer) {
            const customResult = await customTransformer(blob, config, updateStoreProgress);
            if (customResult instanceof Blob) {
              return customResult;
            } else if (typeof customResult === 'object' && customResult !== null) {
              // If it returns a map, pick the requested quality
              const qualityKey = config.quality?.toString() || 'medium';
              if ((customResult as any)[qualityKey]) {
                return (customResult as any)[qualityKey];
              }
            }
          }

          let modifiedBlob: Blob;

          if (config?.type === 'image' || blob.type.startsWith('image/')) {
            modifiedBlob = await processImage(blob, config.quality || 'medium', updateStoreProgress);
          } else if (config?.type === 'video' || blob.type.startsWith('video/')) {
            const uploadToUpdate = useUploadProgress.getState().uploads.find(u => u.uploadId === uploadId);
            if (!uploadToUpdate) throw new Error('Can not find upload data!');
            modifiedBlob = await processVideo(blob, config.quality || 'medium', config.videoKey || '0', uploadToUpdate.files[fileIndex], updateStoreProgress);
          } else if (config?.type === 'audio' || blob.type.startsWith('audio/')) {
            modifiedBlob = await processAudio(blob, config.quality || 'medium', updateStoreProgress);
          } else {
            // Default for documents or other types: return as is if no custom transformer provided
            modifiedBlob = blob;
          }

          set((state) => {
            const uploadToUpdate = state.uploads.find((u: any) => u.uploadId === uploadId);
            if (uploadToUpdate && uploadToUpdate.files[fileIndex]) {
              uploadToUpdate.files[fileIndex].isModified = true;
              uploadToUpdate.files[fileIndex].status = 'pending';
              uploadToUpdate.files[fileIndex].fileSize = modifiedBlob.size;
              uploadToUpdate.files[fileIndex].totalChunks = Math.ceil(
                modifiedBlob.size / getChunkSizeForFileType(modifiedBlob.type)
              );
              uploadToUpdate.files[fileIndex].modificationProgress = 100;
            }

            if (uploadToUpdate?.modificationConfigs?.[fileIndex]) {
              uploadToUpdate.modificationConfigs[fileIndex].isModified = true;
            }
          });

          return modifiedBlob;
        } catch (error) {
          set((state) => {
            const uploadToUpdate = state.uploads.find((u: any) => u.uploadId === uploadId);
            if (uploadToUpdate && uploadToUpdate.files[fileIndex]) {
              uploadToUpdate.files[fileIndex].status = 'failed';
              uploadToUpdate.files[fileIndex].error = error instanceof Error ? error.message : 'Modification failed';
            }
          });
          throw error;
        }
      },

      updateProgress: (uploadId, params) => {
        set((state) => {
          const upload = state.uploads.find((u: any) => u.uploadId === uploadId);
          if (!upload) return;

          upload.overallProgress = params.progress;
          upload.progress = params.progress;

          if (params?.status) upload.status = params?.status;
          if (params?.error) upload.error = params?.error;
          if (params?.speed !== undefined) upload.speed = params?.speed;
          if (params?.timeRemaining !== undefined) upload.timeRemaining = params?.timeRemaining;

          if (upload.files.length === 1 && upload.files[0]) {
            upload.files[0].progress = params.progress;
            if (params?.status) upload.files[0].status = params?.status as any;
            if (params?.error) upload.files[0].error = params?.error;
          }

          const calculator = speedCalculators.get(uploadId);
          if (calculator && params?.progress < 100) {
            const now = Date.now();
            calculator.samples.push({ timestamp: now, progress: params.progress });
            calculator.samples = calculator.samples.filter(s => now - s.timestamp < 10000);

            if (calculator.samples.length >= 2) {
              const oldest = calculator.samples[0];
              const latest = calculator.samples[calculator.samples.length - 1];
              const timeDiff = (latest.timestamp - oldest.timestamp) / 1000;
              const progressDiff = latest.progress - oldest.progress;

              if (timeDiff > 0) {
                const speed = progressDiff / timeDiff;
                const remainingProgress = 100 - params.progress;
                upload.speed = speed;
                upload.timeRemaining = speed > 0 ? remainingProgress / speed : 0;
              }
            }
          }
        });
      },

      updateUploadProgress: (message) => {
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

          const calculator = speedCalculators.get(message.uploadId);
          if (calculator && overallProgress < 100) {
            const now = Date.now();
            calculator.samples.push({ timestamp: now, progress: overallProgress });
            calculator.samples = calculator.samples.filter(s => now - s.timestamp < 10000);

            if (calculator.samples.length >= 2) {
              const oldest = calculator.samples[0];
              const latest = calculator.samples[calculator.samples.length - 1];
              const timeDiff = (latest.timestamp - oldest.timestamp) / 1000;
              const progressDiff = latest.progress - oldest.progress;

              if (timeDiff > 0) {
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
            file.status = success ? 'completed' : (file.status === 'completed' ? 'completed' : 'failed');
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
              error
            });
          }
        } catch (error) {
          get().terminateWorker(uploadId);
        }
      },

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
              uploadId
            });
          }
        } catch (error) {
          get().terminateWorker(uploadId);
        }
      },

      resumeUpload: (uploadId) => {
        const upload = get().getUpload(uploadId);
        if (!upload || upload?.status !== 'paused') {
          return;
        }

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
          uploadId
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
              uploadId
            });
          }
        } catch (error) {
          get().terminateWorker(uploadId);
        }

        get().processUploadQueue();
      },

      retryUpload: (uploadId) => {
        const upload = get().getUpload(uploadId);
        if (!upload || upload.retryCount >= upload.maxRetries) {
          return;
        }

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
          uploadId
        });
      },

      removeUpload: async (uploadId: string) => {
        get().terminateWorker(uploadId);
        const tempWorker = get().createWorker('cleanup-worker');
        try {
          tempWorker.postMessage({
            type: 'clear_progress',
            uploadId,
            clearType: 'single'
          });
          await new Promise(resolve => setTimeout(resolve, 100));
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
        const completedIds = get().uploads
          .filter((u: any) => u?.status === 'completed')
          .map((u: any) => u.uploadId);

        if (completedIds.length > 0) {
          const worker = get().createWorker('cleanup-worker-completed');
          try {
            worker.postMessage({
              type: 'clear_progress',
              uploadIds: completedIds,
              clearType: 'completed'
            });
            await new Promise(resolve => setTimeout(resolve, 100));
          } catch (error) {
            worker.terminate();
          }
        }

        set((state) => {
          state.uploads = state.uploads.filter((u: any) => u?.status !== 'completed');
        });

        completedIds.forEach(id => speedCalculators.delete(id));
      },

      clearFailed: async () => {
        const failedIds = get().uploads
          .filter((u: any) => u?.status === 'failed')
          .map((u: any) => u.uploadId);

        if (failedIds.length > 0) {
          const worker = get().createWorker('cleanup-worker-failed');
          try {
            worker.postMessage({
              type: 'clear_progress',
              uploadIds: failedIds,
              clearType: 'failed'
            });
            await new Promise(resolve => setTimeout(resolve, 100));
          } catch (error) {
            worker.terminate();
          }
        }

        set((state) => {
          state.uploads = state.uploads.filter((u: any) => u?.status !== 'failed');
        });

        failedIds.forEach(id => speedCalculators.delete(id));
      },

      clearAll: async () => {
        get().terminateAllWorkers();
        const worker = get().createWorker('cleanup-worker-all');
        try {
          worker.postMessage({
            type: 'clear_progress',
            clearType: 'all'
          });
          await new Promise(resolve => setTimeout(resolve, 100));
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
                      const fileType = metadata.type?.split('/')[0] || 'document';
                      const chunkSize = CHUNK_SIZES[fileType as keyof typeof CHUNK_SIZES] || CHUNK_SIZES.document;
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
                        status = record?.status === 'paused' ? 'paused' :
                          record?.status === 'uploading' ? 'uploading' : 'failed';
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
                        needsModification: record.modificationConfigs?.[index]?.needsModification || false,
                        isModified: record.modificationConfigs?.[index]?.isModified || false
                      });
                    });
                  }

                  const fileCount = record.fileCount || files.length;
                  const completedFiles = record.completedFiles || 0;
                  const overallProgress = record.overallProgress !== undefined ?
                    record.overallProgress :
                    fileCount > 0 ? (completedFiles / fileCount) * 100 : 0;

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
                    modificationConfigs: record.modificationConfigs,
                    videoStartTime: record.videoStartTime,
                    videoEndTime: record.videoEndTime,
                    duration: record.duration,
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

      createWorker: (uploadId) => {
        if (typeof Worker === 'undefined') {
          throw new Error('Web Workers not supported');
        }

        get().terminateWorker(uploadId);

        let worker: Worker;
        try {
          // Path to built worker file
          worker = new Worker(new URL('../dist/worker/upload.worker.mjs', import.meta.url), { type: 'module' });
        } catch (error) {
          // Fallback for development
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

        const { showToast } = getUploadMediaConfig();

        worker.onmessage = async (event) => {
          const message: WorkerMessage = event.data;

          switch (message.type) {
            case 'request_token':
              try {
                const { getCookie } = getUploadMediaConfig();
                const token = getCookie ? await getCookie() : null;
                const workerInstance = get().activeWorkers.get(uploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: 'token_response',
                    token
                  });
                }
              } catch (error) {
                const workerInstance = get().activeWorkers.get(uploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: 'token_response',
                    token: null,
                    error: error instanceof Error ? error.message : 'Failed to get token'
                  });
                }
              }
              break;

            case 'request_encrypt':
              try {
                const { encryptQueryString } = getUploadMediaConfig();
                const encrypted = encryptQueryString ? await encryptQueryString(message.data) : JSON.stringify(message.data);
                const workerInstance = get().activeWorkers.get(uploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: 'encrypt_response',
                    requestId: message.requestId,
                    encrypted
                  });
                }
              } catch (error) {
                const workerInstance = get().activeWorkers.get(uploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: 'encrypt_response',
                    requestId: message.requestId,
                    encrypted: null,
                    error: error instanceof Error ? error.message : 'Encryption failed'
                  });
                }
              }
              break;

            case 'AUTH_REDIRECT':
              if (typeof window !== 'undefined') {
                window.location.href = message.data?.url || '/auth';
              }
              break;

            case 'request_modification':
              get().handleModificationRequest(message);
              break;

            case 'request_thumbnail':
              get().handleThumbnailRequest(message);
              break;

            case 'request_transformation':
              get().handleTransformationRequest(message);
              break;

            case 'send_thumbnail_data':
              try {
                const { uploadId: reqUploadId, fileIndex, blob } = message;

                if (!blob) {
                  throw new Error('No blob received from worker');
                }

                let blobToProcess: Blob;
                if (blob instanceof Blob) {
                  blobToProcess = blob;
                } else if ((blob as any) instanceof ArrayBuffer) {
                  const upload = get().getUpload(reqUploadId);
                  const fileType = upload?.files[fileIndex!]?.fileType || 'video/mp4';
                  blobToProcess = new Blob([blob], { type: fileType });
                } else {
                  throw new Error('Invalid blob data received');
                }

                const thumbnailBase64 = await generateVideoThumbnail(blobToProcess);

                const workerInstance = get().activeWorkers.get(reqUploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: 'thumbnail_complete',
                    uploadId: reqUploadId,
                    fileIndex,
                    thumbnailBase64
                  });
                }

                set((state: UploadProgressState) => {
                  const uploadToUpdate = state.uploads.find((u) => u.uploadId === reqUploadId);
                  if (uploadToUpdate && uploadToUpdate.files[fileIndex!]) {
                    uploadToUpdate.files[fileIndex!].status = 'uploading';
                    uploadToUpdate.status = 'uploading';
                  }
                });
              } catch (error) {
                const { uploadId: reqUploadId, fileIndex } = message;
                const workerInstance = get().activeWorkers.get(reqUploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: 'thumbnail_error',
                    uploadId: reqUploadId,
                    fileIndex,
                    error: error instanceof Error ? error.message : 'Thumbnail generation failed'
                  });
                }

                set((state: UploadProgressState) => {
                  const uploadToUpdate = state.uploads.find((u) => u.uploadId === reqUploadId);
                  if (uploadToUpdate && uploadToUpdate.files[fileIndex!]) {
                    uploadToUpdate.files[fileIndex!].status = 'uploading';
                    uploadToUpdate.status = 'uploading';
                  }
                });
              }
              break;

            case 'send_file_data':
              try {
                const { uploadId: reqUploadId, fileIndex, blob, config } = message;

                if (!blob) {
                  throw new Error('No blob received from worker');
                }
                let blobToModify: Blob;
                if (blob instanceof Blob) {
                  blobToModify = blob;
                } else if ((blob as any) instanceof ArrayBuffer) {
                  const upload = get().getUpload(reqUploadId);
                  const fileType = upload?.files[fileIndex!]?.fileType || 'video/mp4';
                  blobToModify = new Blob([blob], { type: fileType });
                } else {
                  throw new Error('Invalid blob data received');
                }

                const modifiedBlob = await get().modifyFile(reqUploadId, fileIndex!, blobToModify, config);
                const workerInstance = get().activeWorkers.get(reqUploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: 'modification_complete',
                    uploadId: reqUploadId,
                    fileIndex,
                    modifiedBlob
                  });
                }
              } catch (error) {
                const { uploadId: errUploadId, fileIndex } = message;
                const workerInstance = get().activeWorkers.get(errUploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: 'modification_error',
                    uploadId: errUploadId,
                    fileIndex,
                    error: error instanceof Error ? error.message : 'Modification failed'
                  });
                }

                set((state: UploadProgressState) => {
                  const uploadToUpdate = state.uploads.find((u) => u.uploadId === errUploadId);
                  if (uploadToUpdate) {
                    uploadToUpdate.status = 'failed';
                    uploadToUpdate.error = error instanceof Error ? error.message : 'Modification failed';
                    if (uploadToUpdate.files[fileIndex!]) {
                      uploadToUpdate.files[fileIndex!].status = 'failed';
                      uploadToUpdate.files[fileIndex!].error = error instanceof Error ? error.message : 'Modification failed';
                    }
                  }
                });
              }
              break;

            case 'upload_started':
              break;

            case 'resumed':
              break;

            case 'upload_paused':
              break;

            case 'progress':
            case 'chunk_progress':
              get().updateUploadProgress(message);
              break;

            case 'success':
              get().finalizeUpload(uploadId, true, message.data);
              showToast.success(message.message || 'Upload completed successfully');
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
              showToast.error(message.message || 'Upload failed');
              break;

            case 'init_error':
              get().finalizeUpload(uploadId, false, undefined, `Initialization error: ${message.message}`);
              showToast.error(message.message || 'Failed to initialize upload');
              break;

            case 'paused':
              break;

            case 'cancelled':
              break;

            case 'clear_error':
              break;

            case 'finalize_error':
              break;

            case 'progress_cleared':
              break;

            case 'resume_available':
              get().handleResumeResponse(message);
              break;

            case 'no_resume_data':
              showToast.warning(`No resume data found for ${uploadId}.`);
              break;
            case 'max_retries_reached':
              get().finalizeUpload(uploadId, false, undefined, message.message);
              showToast.warning(message.message || 'Maximum retries reached');
              break;

            case 'pause_error':
              console.error('[Worker] Pause error:', message.message);
              showToast.error(`Failed to pause: ${message.message}`);
              break;

            case 'resume_error':
              console.error('[Worker] Resume error:', message.message);
              showToast.error(`Failed to resume: ${message.message}`);
              break;

            case 'cancel_error':
              console.error('[Worker] Cancel error:', message.message);
              showToast.error(`Failed to cancel: ${message.message}`);
              break;

            case 'progress_error':
              console.error('[Worker] Progress error:', message.message);
              break;
            case 'send_file_data_for_trans':
              try {
                const { uploadId: reqUploadId, fileIndex, blob, transformer } = message;
                if (!blob) throw new Error('No blob received');

                let blobToTransform: Blob;
                if (blob instanceof Blob) {
                  blobToTransform = blob;
                } else {
                  const upload = get().getUpload(reqUploadId);
                  const fileType = upload?.files[fileIndex!]?.fileType || 'image/jpeg';
                  blobToTransform = new Blob([blob], { type: fileType });
                }

                const qualities = transformer?.qualities || [transformer?.quality || 'medium'];
                const transformedResults: Record<string, Blob> = {};

                for (const q of qualities) {
                  const config = {
                    type: blobToTransform.type.startsWith('video/') ? 'video' : 'image',
                    quality: q,
                    ...transformer
                  };
                  transformedResults[q.toString()] = await get().modifyFile(reqUploadId, fileIndex!, blobToTransform, config);
                }

                const workerInstance = get().activeWorkers.get(reqUploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: 'transformation_complete',
                    uploadId: reqUploadId,
                    fileIndex,
                    modifiedBlobs: transformedResults,
                    modifiedBlob: transformedResults[qualities[0].toString()]
                  });
                }
              } catch (error) {
                const { uploadId: errUploadId, fileIndex } = message;
                const workerInstance = get().activeWorkers.get(errUploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: 'transformation_error',
                    uploadId: errUploadId,
                    fileIndex,
                    error: error instanceof Error ? error.message : 'Transformation failed'
                  });
                }
              }
              break;

            default:
              if (event.data?.data?.status && event.data?.data?.message) {
                if (event.data?.data?.status === 'success') {
                  showToast.success(`Message from upload: ${event.data?.data?.message}`);
                } else if (event.data?.data?.status === 'error' || event.data?.data?.status === 'fail') {
                  showToast.error(`Message from upload: ${event.data?.data?.message}`);
                }
              }
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
        get().activeWorkers.forEach(worker => worker.terminate());
        set((state) => {
          state.activeWorkers.clear();
        });
      },

      getUpload: (uploadId) => {
        return get().uploads.find((u) => u.uploadId === uploadId);
      },

      get totalProgress() {
        const { uploads } = get();
        if (uploads.length === 0) return 0;
        return uploads.reduce((sum: number, upload: UploadProgress) => sum + upload.overallProgress, 0) / uploads.length;
      },

      get activeUploads() {
        return get().uploads.filter((u) =>
          u.status === 'uploading' || u.status === 'initializing' || u.status === 'modifying'
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
      }
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
          removeItem: () => { }
        };
      }),
      partialize: (state) => ({
        uploads: state.uploads.filter((u: any) =>
          u?.status === 'paused' || u?.status === 'failed'
        )
      })
    }
  )
);

const processImage = async (
  file: Blob,
  quality: 'high' | 'medium' | 'low' | number,
  onProgress: (progress: number) => void
): Promise<Blob> => {
  if (file.type === 'image/gif') {
    onProgress(100);
    return new Blob([file], { type: file.type });
  }

  return new Promise<Blob>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      onProgress(20);
      const img = new Image();

      img.onload = () => {
        onProgress(40);
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        if (!ctx) {
          reject(new Error('Failed to get canvas context'));
          return;
        }

        let maxWidth, maxHeight, qualityLevel, isUpscaling = false, isDownscaling = false;
        const originalFormat = file.type; // Preserve original format

        if (typeof quality === 'number') {
          // Clamp numeric quality to 0-150 range and divide by 100 (gives 0-1.5)
          qualityLevel = Math.max(0, Math.min(150, quality)) / 100;
          maxWidth = 1280;
          maxHeight = 720;
        } else {
          switch (quality) {
            case 'high':
              maxWidth = 1920;
              maxHeight = 1080;
              qualityLevel = 0.95;
              break;
            case 'medium':
              maxWidth = 1280;
              maxHeight = 720;
              qualityLevel = 0.8;
              break;
            case 'low':
              maxWidth = 800;
              maxHeight = 600;
              qualityLevel = 0.6;
              break;
            default:
              maxWidth = 1280;
              maxHeight = 720;
              qualityLevel = 0.8;
          }
        }

        let width = img.width;
        let height = img.height;
        const originalWidth = img.width;
        const originalHeight = img.height;
        const originalPixels = originalWidth * originalHeight;

        // For high quality, gentle 1.2x enhancement only (no upscaling beyond that)
        if (quality === 'high' && (width < maxWidth || height < maxHeight)) {
          const scaleX = maxWidth / width;
          const scaleY = maxHeight / height;
          const enhancementFactor = Math.min(scaleX, scaleY, 1.2);

          if (enhancementFactor > 1) {
            width = Math.round(width * enhancementFactor);
            height = Math.round(height * enhancementFactor);
          }
        }

        // Downscale to max dimensions if exceeded
        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }

        const finalPixels = width * height;

        // Check if we're upscaling beyond original
        if (width > originalWidth || height > originalHeight) {
          isUpscaling = true;
          qualityLevel = 1.0; // Force full quality for upscaling
        }

        // Check if we're downscaling
        if (finalPixels < originalPixels) {
          isDownscaling = true;
        }

        // If no resizing and high quality, return original to avoid JPEG reencoding
        if (!isUpscaling && !isDownscaling && quality === 'high') {
          onProgress(100);
          resolve(file); // Return original blob unchanged
          return;
        }

        onProgress(60);
        canvas.width = width;
        canvas.height = height;

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);

        // Apply enhancement only if NOT pure upscaling (downscaling or slight enhancement)
        if (!isUpscaling || quality === 'high') {
          try {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            const original = new Uint8ClampedArray(data);

            // Multi-pass enhancement for +0.2 quality boost
            // Pass 1: Edge detection + sharpening
            const sharpenKernel = [0, -0.5, 0, -0.5, 3, -0.5, 0, -0.5, 0];
            const sharpenStrength = isUpscaling ? 0.5 : (isDownscaling ? 0.4 : 0.3);

            for (let y = 1; y < canvas.height - 1; y++) {
              for (let x = 1; x < canvas.width - 1; x++) {
                const idx = (y * canvas.width + x) * 4;

                for (let c = 0; c < 3; c++) {
                  let sum = 0;
                  let ki = 0;

                  for (let ky = -1; ky <= 1; ky++) {
                    for (let kx = -1; kx <= 1; kx++) {
                      const kidx = ((y + ky) * canvas.width + (x + kx)) * 4 + c;
                      sum += original[kidx] * sharpenKernel[ki++];
                    }
                  }

                  data[idx + c] = Math.max(0, Math.min(255,
                    Math.round(original[idx + c] * (1 - sharpenStrength) + sum * sharpenStrength)
                  ));
                }
              }
            }

            // Pass 2: Local contrast enhancement (boost mid-tones)
            for (let i = 0; i < data.length; i += 4) {
              for (let c = 0; c < 3; c++) {
                const val = data[i + c];
                const centered = val - 128;
                const boosted = centered * 1.1;
                data[i + c] = Math.max(0, Math.min(255, boosted + 128));
              }
            }

            ctx.putImageData(imageData, 0, 0);
          } catch (error) {
            console.warn('Image enhancement failed:', error);
          }
        }

        onProgress(80);

        // Use PNG for lossless output (preserves alpha), JPEG only for downscaled
        const outputFormat = isDownscaling ? 'image/jpeg' : (originalFormat === 'image/png' ? 'image/png' : 'image/webp');
        const encodingQuality = isDownscaling ? qualityLevel : 1.0; // Full quality if not downscaling

        canvas.toBlob((blob) => {
          onProgress(100);
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to create image blob'));
          }
        }, outputFormat, encodingQuality);
      };

      img.onerror = () => {
        reject(new Error('Failed to load image'));
      };

      img.src = e.target?.result as string;
    };

    reader.onerror = () => {
      reject(new Error('Failed to read image file'));
    };

    reader.readAsDataURL(file);
  });
};
const processVideo = async (
  file: Blob,
  quality: 'high' | 'low' | 'medium',
  videoKey: string,
  filedata: FileUploadItem,
  onProgress: (progress: number) => void
): Promise<Blob> => {
  const { videoState } = getUploadMediaConfig();
  const { clearVideoState } = (videoState as any).getState();
  const duration = filedata?.endTime || file.size / (1024 * 1024) * 0.1;

  const trimmer = new VideoTrimmer({
    onError(_error) {
      onProgress(0);
    },
    onComplete(_result) {
      onProgress(100);
    },
    onProgress(progress) {
      onProgress(progress);
    },
  });

  if (videoKey) {
    clearVideoState(videoKey);
  }
  const fileType = file.type;
  const lastModifiedDate = new Date().getTime();
  const main_file = new File([file], filedata.fileName, {
    type: fileType,
    lastModified: lastModifiedDate
  })
  return (await trimmer.trimVideo(main_file, {
    startTime: filedata?.startTime,
    endTime: filedata?.endTime,
    mute: filedata?.isMuted,
    quality,
    useFFmpeg: true,
    outputFormat: 'mp4'
  }));
};

const processAudio = async (
  file: Blob,
  quality: 'high' | 'low' | 'medium',
  onProgress: (progress: number) => void
): Promise<Blob> => {
  const trimmer = new AudioTrimmer({
    onProgress(progress) {
      onProgress(progress);
    },
    onError(error) {
      console.error('[AudioTrimmer Error]', error);
      onProgress(0);
    }
  });

  return await trimmer.trimAudio(file, {
    quality,
    useFFmpeg: true,
    outputFormat: 'mp3'
  });
};

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
    createWorker: store.createWorker
  };
};

export const cleanupUploadResources = () => {
  const { terminateAllWorkers } = useUploadProgress.getState();
  terminateAllWorkers();
  speedCalculators.clear();
};

async function generateVideoThumbnail(videoBlob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      reject(new Error('Failed to get canvas context'));
      return;
    }

    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    const cleanup = () => {
      URL.revokeObjectURL(video.src);
      video.remove();
      canvas.remove();
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Thumbnail generation timeout'));
    }, 30000); // 30 second timeout

    video.onloadedmetadata = () => {
      // Seek to 1 second or 10% of duration, whichever is smaller
      const seekTime = Math.min(5, video.duration * 0.5);
      video.currentTime = seekTime;
    };

    video.onseeked = () => {
      try {
        // Set canvas dimensions (320x180 for thumbnail)
        canvas.width = 320;
        canvas.height = 180;

        // Calculate scaling to cover the canvas
        const videoAspect = video.videoWidth / video.videoHeight;
        const canvasAspect = canvas.width / canvas.height;

        let sourceX = 0;
        let sourceY = 0;
        let sourceWidth = video.videoWidth;
        let sourceHeight = video.videoHeight;

        if (videoAspect > canvasAspect) {
          // Video is wider, crop sides
          sourceWidth = video.videoHeight * canvasAspect;
          sourceX = (video.videoWidth - sourceWidth) / 2;
        } else {
          // Video is taller, crop top/bottom
          sourceHeight = video.videoWidth / canvasAspect;
          sourceY = (video.videoHeight - sourceHeight) / 2;
        }

        // Draw video frame to canvas
        ctx.drawImage(
          video,
          sourceX, sourceY, sourceWidth, sourceHeight,
          0, 0, canvas.width, canvas.height
        );

        // Convert to base64 JPEG with quality optimization
        canvas.toBlob((blob) => {
          if (!blob) {
            cleanup();
            clearTimeout(timeout);
            reject(new Error('Failed to create thumbnail blob'));
            return;
          }

          // Check size and reduce quality if needed
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64 = reader.result as string;

            // If thumbnail is over 1MB, try lower quality
            if (blob.size > 1024 * 1024) {
              canvas.toBlob((optimizedBlob) => {
                if (!optimizedBlob) {
                  cleanup();
                  clearTimeout(timeout);
                  reject(new Error('Failed to optimize thumbnail'));
                  return;
                }

                const optimizedReader = new FileReader();
                optimizedReader.onloadend = () => {
                  cleanup();
                  clearTimeout(timeout);
                  resolve(optimizedReader.result as string);
                };
                optimizedReader.onerror = () => {
                  cleanup();
                  clearTimeout(timeout);
                  reject(new Error('Failed to read optimized thumbnail'));
                };
                optimizedReader.readAsDataURL(optimizedBlob);
              }, 'image/jpeg', 0.8); // Lower quality
            } else {
              cleanup();
              clearTimeout(timeout);
              resolve(base64);
            }
          };
          reader.onerror = () => {
            cleanup();
            clearTimeout(timeout);
            reject(new Error('Failed to read thumbnail'));
          };
          reader.readAsDataURL(blob);
        }, 'image/jpeg', 1); // Initial quality
      } catch (error) {
        cleanup();
        clearTimeout(timeout);
        reject(error);
      }
    };

    video.onerror = () => {
      cleanup();
      clearTimeout(timeout);
      reject(new Error('Failed to load video for thumbnail'));
    };

    video.src = URL.createObjectURL(videoBlob);
  });
}
