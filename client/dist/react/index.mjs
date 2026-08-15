// src/hooks/useUpload.ts
import { useEffect, useCallback } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";

// src/store/useUploadProgress.ts
import { createStore } from "zustand/vanilla";
import { persist, createJSONStorage } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { enableMapSet } from "immer";
enableMapSet();
var CHUNK_SIZES = {
  video: 2 * 1024 * 1024,
  audio: 2 * 1024 * 1024,
  image: 1 * 1024 * 1024,
  default: 5 * 1024 * 1024
};
var MAX_CONCURRENT_UPLOADS = 5;
var MAX_RETRIES = 3;
function getChunkSizeForFileType(fileType) {
  if (fileType.startsWith("video/")) return CHUNK_SIZES.video;
  if (fileType.startsWith("audio/")) return CHUNK_SIZES.audio;
  if (fileType.startsWith("image/")) return CHUNK_SIZES.image;
  return CHUNK_SIZES.default;
}
var speedCalculators = /* @__PURE__ */ new Map();
var useUploadProgress = createStore()(
  persist(
    immer((set, get) => ({
      uploads: [],
      activeWorkers: /* @__PURE__ */ new Map(),
      uploadQueue: /* @__PURE__ */ new Map(),
      concurrentUploads: 0,
      // ─── Public Methods ──────────────────────────────────────────────
      addUpload: (params) => {
        set((state) => {
          console.log(params);
          const newUpload = {
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
                status: "pending"
              }
            ],
            overallProgress: 0,
            status: "initializing",
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
            headers: params.headers
          };
          console.log("newupload", newUpload);
          state.uploads = state.uploads.filter((u) => u.uploadId !== params.uploadId);
          state.uploads.push(newUpload);
          speedCalculators.set(params.uploadId, { samples: [] });
        });
      },
      initializeUpload: (params) => {
        get().enqueueUpload(params);
      },
      enqueueUpload: (params) => {
        set((state) => {
          state.uploadQueue.set(params.uploadId, params);
        });
        get().processUploadQueue();
      },
      processUploadQueue: () => {
        const { uploadQueue, concurrentUploads, uploads } = get();
        if (concurrentUploads >= MAX_CONCURRENT_UPLOADS) return;
        const nextUploadId = Array.from(uploadQueue.keys()).find((uploadId2) => {
          const upload = uploads.find((u) => u.uploadId === uploadId2);
          return !upload || upload?.status !== "uploading";
        });
        if (!nextUploadId) return;
        const params = uploadQueue.get(nextUploadId);
        if (!params) return;
        set((state) => {
          state.uploadQueue.delete(nextUploadId);
          state.concurrentUploads += 1;
        });
        const { uploadId, blobs, endpoint, method, postData, metadata, filenameArray, uploadType, transformer, mockNetworkDropRate, headers } = params;
        set((state) => {
          state.uploads = state.uploads.filter((u) => u.uploadId !== uploadId);
          const fileItems = blobs.map((file, index) => ({
            fileIndex: index,
            fileName: filenameArray?.[index] ?? "",
            fileSize: file.size,
            fileType: file.type,
            progress: 0,
            chunkIndex: 0,
            totalChunks: Math.ceil(file.size / getChunkSizeForFileType(file.type)),
            status: "pending",
            isProcessing: false,
            processingProgress: 0
          }));
          const newUpload = {
            uploadId,
            files: fileItems,
            overallProgress: 0,
            status: "initializing",
            startTime: Date.now(),
            canResume: false,
            retryCount: 0,
            maxRetries: MAX_RETRIES,
            fileName: filenameArray?.[0] || "",
            fileSize: blobs[0]?.size || 0,
            fileType: blobs[0]?.type || "",
            progress: 0,
            endpoint,
            method,
            postData,
            metadata,
            uploadType,
            allFilesSessionId: [],
            mockNetworkDropRate,
            headers
          };
          state.uploads.push(newUpload);
          speedCalculators.set(uploadId, { samples: [] });
        });
        const worker = get().createWorker(uploadId);
        if (typeof mockNetworkDropRate === "number") {
          worker.postMessage({
            type: "configure",
            config: { mockNetworkDropRate }
          });
        }
        worker.postMessage({
          type: "upload",
          uploadId,
          blobArray: blobs,
          filenameArray,
          endpoint,
          method,
          postData,
          metadata,
          uploadType,
          transformer,
          headers
        });
      },
      // ─── Progress Updates ────────────────────────────────────────────
      updateProgress: (uploadId, params) => {
        set((state) => {
          const upload = state.uploads.find((u) => u.uploadId === uploadId);
          if (!upload) return;
          upload.overallProgress = params.progress;
          upload.progress = params.progress;
          if (params.status) upload.status = params.status;
          if (params.error) upload.error = params.error;
          if (params.speed !== void 0) upload.speed = params.speed;
          if (params.timeRemaining !== void 0) upload.timeRemaining = params.timeRemaining;
          if (upload.files.length === 1 && upload.files[0]) {
            upload.files[0].progress = params.progress;
            if (params.status) upload.files[0].status = params.status;
            if (params.error) upload.files[0].error = params.error;
          }
          const calculator = speedCalculators.get(uploadId);
          if (calculator && params.progress < 100 && params.progress > 0) {
            const now = Date.now();
            calculator.samples.push({ timestamp: now, progress: params.progress });
            calculator.samples = calculator.samples.filter((s) => now - s.timestamp < 1e4);
            if (calculator.samples.length >= 2) {
              const oldest = calculator.samples[0];
              const latest = calculator.samples[calculator.samples.length - 1];
              const timeDiff = (latest.timestamp - oldest.timestamp) / 1e3;
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
      updateUploadProgress: (message) => {
        set((state) => {
          const upload = state.uploads.find((u) => u.uploadId === message.uploadId);
          if (!upload) return;
          const overallProgress = parseFloat(message.overallProgress || "0");
          upload.overallProgress = overallProgress;
          upload.progress = overallProgress;
          upload.status = "uploading";
          if (typeof message.fileIndex === "number" && upload.files[message.fileIndex]) {
            const file = upload.files[message.fileIndex];
            file.fileName = message.fileName || file.fileName;
            file.progress = parseFloat(message.fileProgress || "0");
            file.chunkIndex = message.chunkIndex || 0;
            file.totalChunks = message.totalChunks || 0;
            file.status = "uploading";
          }
          if (message.response) upload.responseData = message.response;
          const calculator = speedCalculators.get(message.uploadId);
          if (calculator && overallProgress < 100 && overallProgress > 0) {
            const now = Date.now();
            calculator.samples.push({ timestamp: now, progress: overallProgress });
            calculator.samples = calculator.samples.filter((s) => now - s.timestamp < 1e4);
            if (calculator.samples.length >= 2) {
              const oldest = calculator.samples[0];
              const latest = calculator.samples[calculator.samples.length - 1];
              const timeDiff = (latest.timestamp - oldest.timestamp) / 1e3;
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
          const upload = state.uploads.find((u) => u.uploadId === uploadId);
          if (!upload) return;
          upload.endTime = Date.now();
          upload.status = success ? "completed" : "failed";
          upload.overallProgress = success ? 100 : upload.overallProgress;
          upload.progress = success ? 100 : upload.progress;
          if (error) upload.error = error;
          if (data) upload.responseData = data;
          upload.files.forEach((file) => {
            file.status = success ? "completed" : file.status === "completed" ? "completed" : "failed";
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
              type: "clear_progress",
              uploadId,
              success,
              data,
              error
            });
          }
        } catch (error2) {
          get().terminateWorker(uploadId);
        }
      },
      // ─── Upload Control ──────────────────────────────────────────────
      pauseUpload: (uploadId) => {
        set((state) => {
          const upload = state.uploads.find((u) => u.uploadId === uploadId);
          if (upload && upload?.status === "uploading") {
            upload.status = "paused";
            upload.canResume = true;
            upload.files.forEach((file) => {
              if (file?.status === "uploading") file.status = "paused";
            });
          }
        });
        try {
          const worker = get().activeWorkers.get(uploadId);
          if (worker) {
            worker.postMessage({
              type: "pause",
              uploadId
            });
          }
        } catch (error) {
          get().terminateWorker(uploadId);
        }
      },
      resumeUpload: (uploadId) => {
        const upload = get().getUpload(uploadId);
        if (!upload || upload?.status !== "paused") return;
        set((state) => {
          const uploadToUpdate = state.uploads.find((u) => u.uploadId === uploadId);
          if (uploadToUpdate) {
            uploadToUpdate.status = "uploading";
            uploadToUpdate.files.forEach((file) => {
              if (file.status === "paused") file.status = "uploading";
            });
            uploadToUpdate.error = void 0;
          }
        });
        speedCalculators.set(uploadId, { samples: [] });
        const worker = get().createWorker(uploadId);
        if (upload && typeof upload.mockNetworkDropRate === "number") {
          worker.postMessage({
            type: "configure",
            config: { mockNetworkDropRate: upload.mockNetworkDropRate }
          });
        }
        worker.postMessage({
          type: "resume",
          uploadId
        });
      },
      cancelUpload: (uploadId) => {
        set((state) => {
          const upload = state.uploads.find((u) => u.uploadId === uploadId);
          if (upload) {
            upload.status = "cancelled";
            upload.files.forEach((file) => {
              if (file?.status !== "completed") file.status = "failed";
            });
            upload.error = "Upload cancelled by user.";
            upload.canResume = false;
            state.concurrentUploads = Math.max(0, state.concurrentUploads - 1);
          }
        });
        try {
          const worker = get().activeWorkers.get(uploadId);
          if (worker) {
            worker.postMessage({
              type: "cancel",
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
        if (!upload || upload.retryCount >= upload.maxRetries) return;
        set((state) => {
          const uploadToRetry = state.uploads.find((u) => u.uploadId === uploadId);
          if (uploadToRetry) {
            uploadToRetry.status = "uploading";
            uploadToRetry.overallProgress = 0;
            uploadToRetry.progress = 0;
            uploadToRetry.error = void 0;
            uploadToRetry.retryCount += 1;
            uploadToRetry.startTime = Date.now();
            uploadToRetry.endTime = void 0;
            uploadToRetry.canResume = false;
            uploadToRetry.files.forEach((file) => {
              file.status = "uploading";
              file.progress = 0;
              file.chunkIndex = 0;
              file.error = void 0;
            });
          }
        });
        speedCalculators.set(uploadId, { samples: [] });
        const worker = get().createWorker(uploadId);
        if (upload && typeof upload.mockNetworkDropRate === "number") {
          worker.postMessage({
            type: "configure",
            config: { mockNetworkDropRate: upload.mockNetworkDropRate }
          });
        }
        worker.postMessage({
          type: "resume",
          uploadId
        });
      },
      // ─── Cleanup ─────────────────────────────────────────────────────
      removeUpload: async (uploadId) => {
        get().terminateWorker(uploadId);
        const tempWorker = get().createWorker("cleanup-worker");
        try {
          tempWorker.postMessage({
            type: "clear_progress",
            uploadId,
            clearType: "single"
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (error) {
          tempWorker.terminate();
        }
        set((state) => {
          state.uploads = state.uploads.filter((u) => u.uploadId !== uploadId);
          state.concurrentUploads = Math.max(0, state.concurrentUploads - 1);
        });
        speedCalculators.delete(uploadId);
        get().processUploadQueue();
      },
      clearCompleted: async () => {
        const completedIds = get().uploads.filter((u) => u?.status === "completed").map((u) => u.uploadId);
        if (completedIds.length > 0) {
          const worker = get().createWorker("cleanup-worker-completed");
          try {
            worker.postMessage({
              type: "clear_progress",
              uploadIds: completedIds,
              clearType: "completed"
            });
            await new Promise((resolve) => setTimeout(resolve, 100));
          } catch (error) {
            worker.terminate();
          }
        }
        set((state) => {
          state.uploads = state.uploads.filter((u) => u?.status !== "completed");
        });
        completedIds.forEach((id) => speedCalculators.delete(id));
      },
      clearFailed: async () => {
        const failedIds = get().uploads.filter((u) => u?.status === "failed").map((u) => u.uploadId);
        if (failedIds.length > 0) {
          const worker = get().createWorker("cleanup-worker-failed");
          try {
            worker.postMessage({
              type: "clear_progress",
              uploadIds: failedIds,
              clearType: "failed"
            });
            await new Promise((resolve) => setTimeout(resolve, 100));
          } catch (error) {
            worker.terminate();
          }
        }
        set((state) => {
          state.uploads = state.uploads.filter((u) => u?.status !== "failed");
        });
        failedIds.forEach((id) => speedCalculators.delete(id));
      },
      clearAll: async () => {
        get().terminateAllWorkers();
        const worker = get().createWorker("cleanup-worker-all");
        try {
          worker.postMessage({
            type: "clear_progress",
            clearType: "all"
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (error) {
          worker.terminate();
        }
        set((state) => {
          state.uploads = [];
          state.uploadQueue = /* @__PURE__ */ new Map();
          state.concurrentUploads = 0;
        });
        speedCalculators.clear();
      },
      // ─── Resumable Uploads ────────────────────────────────────────────
      checkForResumableUploads: async () => {
        try {
          if (typeof window !== "undefined" && window?.indexedDB) {
            const db = await new Promise((resolve, reject) => {
              const request = indexedDB.open("UploadDB", 3);
              request.onerror = () => reject(request.error);
              request.onsuccess = () => resolve(request.result);
              request.onupgradeneeded = (event) => {
                const db2 = event.target.result;
                if (!db2.objectStoreNames.contains("progress")) {
                  const store = db2.createObjectStore("progress", { keyPath: "uploadId" });
                  store.createIndex("status", "status", { unique: false });
                  store.createIndex("lastUpdated", "lastUpdated", { unique: false });
                }
                if (!db2.objectStoreNames.contains("files")) {
                  db2.createObjectStore("files", { keyPath: "id" });
                }
              };
            });
            const progressRecords = await new Promise((resolve, reject) => {
              const tx = db.transaction("progress", "readonly");
              const store = tx.objectStore("progress");
              const request = store.getAll();
              request.onsuccess = () => resolve(request.result || []);
              request.onerror = () => reject(request.error);
            });
            set((state) => {
              progressRecords.forEach((record) => {
                if (!state.uploads.some((u) => u.uploadId === record.uploadId)) {
                  const files = [];
                  if (record.filenames?.length) {
                    record.filenames.forEach((name, index) => {
                      const metadata = record.metadata?.[index] || {};
                      const fileType = metadata.type?.split("/")[0] || "default";
                      const chunkSize = CHUNK_SIZES[fileType] || CHUNK_SIZES.default;
                      const fileSize = metadata.size || 0;
                      const totalChunks = Math.ceil(fileSize / chunkSize);
                      let progress = 0;
                      let status = "paused";
                      let chunkIndex = 0;
                      if (index < (record.completedFiles || 0)) {
                        progress = 100;
                        status = "completed";
                      } else if (index === (record.currentFileIndex || 0)) {
                        chunkIndex = record.currentChunkIndex || 0;
                        progress = totalChunks > 0 ? chunkIndex / totalChunks * 100 : 0;
                        status = record?.status === "paused" ? "paused" : record?.status === "uploading" ? "uploading" : "failed";
                      }
                      files.push({
                        fileIndex: index,
                        fileName: name,
                        fileSize,
                        fileType: metadata.type || "",
                        progress,
                        chunkIndex,
                        totalChunks,
                        status,
                        sessionId: record.allFilesSessionId?.[index]
                      });
                    });
                  }
                  const fileCount = record.fileCount || files.length;
                  const completedFiles = record.completedFiles || 0;
                  const overallProgress = record.overallProgress !== void 0 ? record.overallProgress : fileCount > 0 ? completedFiles / fileCount * 100 : 0;
                  state.uploads.push({
                    uploadId: record.uploadId,
                    files,
                    overallProgress,
                    status: record?.status || "paused",
                    startTime: record.startTime || Date.now(),
                    canResume: true,
                    allFilesSessionId: record.allFilesSessionId || [],
                    retryCount: record.retryCount || 0,
                    maxRetries: record.maxRetries || MAX_RETRIES,
                    fileName: record.filenames?.[0] || "",
                    fileSize: record.fileSize || 0,
                    fileType: record.fileType || "",
                    progress: overallProgress,
                    endpoint: record.endpoint,
                    method: record.method,
                    postData: record.postData,
                    metadata: record.metadata,
                    uploadType: record.uploadType,
                    headers: record.headers
                  });
                }
              });
            });
            db.close();
          }
        } catch (error) {
          set((state) => {
            state.error = error instanceof Error ? error.message : "Failed to load resumable uploads";
          });
        }
      },
      handleResumeResponse: (message) => {
        if (message.type === "resume_available") {
          const { uploadId } = message;
          const worker = get().createWorker(uploadId);
          worker.postMessage({
            resumeUpload: true,
            type: "upload",
            uploadId
          });
        }
      },
      // ─── Worker Management ──────────────────────────────────────────
      createWorker: (uploadId) => {
        if (typeof Worker === "undefined") {
          throw new Error("Web Workers not supported");
        }
        get().terminateWorker(uploadId);
        let worker;
        try {
          worker = new Worker(new URL("../dist/worker/upload.worker.mjs", import.meta.url), { type: "module" });
        } catch (error) {
          console.warn("[Worker] Trying dev path...");
          try {
            worker = new Worker(new URL("../worker/upload.worker.ts", import.meta.url), { type: "module" });
          } catch (fallbackError) {
            const errorMsg = `Failed to create worker: ${error instanceof Error ? error.message : String(error)}`;
            console.error("[Worker Creation Error]", errorMsg);
            get().finalizeUpload(uploadId, false, void 0, errorMsg);
            throw error;
          }
        }
        worker.onmessage = async (event) => {
          const message = event.data;
          switch (message.type) {
            case "request_token":
              try {
                const token = null;
                const workerInstance = get().activeWorkers.get(uploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: "token_response",
                    token
                  });
                }
              } catch (error) {
                const workerInstance = get().activeWorkers.get(uploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: "token_response",
                    token: null,
                    error: error instanceof Error ? error.message : "Failed to get token"
                  });
                }
              }
              break;
            case "progress":
            case "chunk_progress":
              get().updateUploadProgress(message);
              break;
            case "success":
              get().finalizeUpload(uploadId, true, message.data);
              console.log("Upload successful:", message.message);
              break;
            case "error":
              get().finalizeUpload(uploadId, false, void 0, message.message);
              if (message.canResume) {
                set((state) => {
                  const upload = state.uploads.find((u) => u.uploadId === uploadId);
                  if (upload) {
                    upload.canResume = true;
                    upload.status = "paused";
                  }
                });
              }
              console.error("Upload error:", message.message);
              break;
            case "init_error":
              get().finalizeUpload(uploadId, false, void 0, `Initialization error: ${message.message}`);
              console.error("Init error:", message.message);
              break;
            case "max_retries_reached":
              get().finalizeUpload(uploadId, false, void 0, message.message);
              console.warn("Max retries reached:", message.message);
              break;
            case "paused":
            case "resumed":
            case "cancelled":
            case "upload_started":
              break;
            default:
              break;
          }
        };
        worker.onerror = (error) => {
          get().finalizeUpload(uploadId, false, void 0, `Worker error: ${error.message || "Unknown error"}`);
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
        get().activeWorkers.forEach((worker) => worker.terminate());
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
        return uploads.reduce((sum, upload) => sum + upload.overallProgress, 0) / uploads.length;
      },
      get activeUploads() {
        return get().uploads.filter(
          (u) => u.status === "uploading" || u.status === "initializing" || u.status === "processing"
        ).length;
      },
      get completedUploads() {
        return get().uploads.filter((u) => u.status === "completed").length;
      },
      get failedUploads() {
        return get().uploads.filter((u) => u.status === "failed").length;
      },
      get pausedUploads() {
        return get().uploads.filter((u) => u.status === "paused").length;
      },
      get hasUploads() {
        return get().uploads.length > 0;
      },
      get hasActiveUploads() {
        return get().activeUploads > 0;
      },
      get canResumeAnyUpload() {
        return get().uploads.some((u) => u.canResume && u.status === "paused");
      }
    })),
    {
      name: "upload-progress-storage",
      storage: createJSONStorage(() => {
        if (typeof window !== "undefined" && window?.localStorage) {
          return localStorage;
        }
        return {
          getItem: () => null,
          setItem: () => {
          },
          removeItem: () => {
          }
        };
      }),
      partialize: (state) => ({
        uploads: state.uploads.filter((u) => u?.status === "paused" || u?.status === "failed")
      })
    }
  )
);

// src/utils/sessionId.ts
function generateSessionId() {
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  return `${randomStr}-${timestamp}`;
}

// src/hooks/useUpload.ts
function useUpload() {
  const {
    uploads,
    totalProgress,
    activeUploads,
    completedUploads,
    failedUploads,
    pausedUploads,
    hasUploads,
    hasActiveUploads,
    canResumeAnyUpload,
    // Actions (same as vanilla useUploadActions)
    addUpload,
    initializeUpload,
    updateProgress,
    pauseUpload,
    resumeUpload,
    cancelUpload,
    retryUpload,
    removeUpload,
    clearCompleted,
    clearFailed,
    clearAll,
    checkForResumableUploads,
    createWorker,
    terminateWorker,
    getUpload
  } = useStore(
    useUploadProgress,
    useShallow((state) => ({
      uploads: state.uploads,
      totalProgress: state.totalProgress,
      activeUploads: state.activeUploads,
      completedUploads: state.completedUploads,
      failedUploads: state.failedUploads,
      pausedUploads: state.pausedUploads,
      hasUploads: state.hasUploads,
      hasActiveUploads: state.hasActiveUploads,
      canResumeAnyUpload: state.canResumeAnyUpload,
      addUpload: state.addUpload,
      initializeUpload: state.initializeUpload,
      updateProgress: state.updateProgress,
      pauseUpload: state.pauseUpload,
      resumeUpload: state.resumeUpload,
      cancelUpload: state.cancelUpload,
      retryUpload: state.retryUpload,
      removeUpload: state.removeUpload,
      clearCompleted: state.clearCompleted,
      clearFailed: state.clearFailed,
      clearAll: state.clearAll,
      checkForResumableUploads: state.checkForResumableUploads,
      createWorker: state.createWorker,
      terminateWorker: state.terminateWorker,
      getUpload: state.getUpload
    }))
  );
  useEffect(() => {
    checkForResumableUploads().catch(console.error);
  }, [checkForResumableUploads]);
  const upload = useCallback(
    async (files, fieldnames, options) => {
      if (!files || files.length === 0) {
        throw new Error("No files provided");
      }
      if (files.length !== fieldnames.length) {
        throw new Error("Files and fieldnames length mismatch");
      }
      const uploadId = options.uploadId || generateSessionId();
      addUpload({
        uploadId,
        fileName: files[0]?.name || "",
        fileSize: files[0]?.size || 0,
        fileType: files[0]?.type || "",
        endpoint: options.endpoint || "/upload",
        method: options.method || "POST",
        postData: options.postData,
        metadata: options.metadata,
        uploadType: options.uploadType || "file",
        headers: options.headers
      });
      initializeUpload({
        uploadId,
        blobs: files,
        filenameArray: files.map((f) => f.name),
        endpoint: options.endpoint || "/upload",
        method: options.method || "POST",
        postData: options.postData,
        metadata: options.metadata,
        uploadType: options.uploadType || "file",
        transformer: options.transformer,
        headers: options.headers
      });
      return uploadId;
    },
    [addUpload, initializeUpload]
  );
  return {
    // State
    uploads,
    totalProgress,
    activeUploads,
    completedUploads,
    failedUploads,
    pausedUploads,
    hasUploads,
    hasActiveUploads,
    canResumeAnyUpload,
    upload,
    addUpload,
    initializeUpload,
    updateProgress,
    pauseUpload,
    resumeUpload,
    cancelUpload,
    retryUpload,
    removeUpload,
    clearCompleted,
    clearFailed,
    clearAll,
    checkForResumableUploads,
    createWorker,
    terminateWorker,
    getUpload,
    // Extra: low‑level worker termination for all
    terminateAllWorkers: useUploadProgress.getState().terminateAllWorkers
  };
}

// src/hooks/useUploadState.ts
import { useStore as useStore2 } from "zustand";
var useUploadProgress2 = (selector) => {
  return useStore2(useUploadProgress, selector);
};
function useUploadState(uploadId) {
  const uploads = useUploadProgress2((state) => state.uploads);
  const getUpload = useUploadProgress2((state) => state.getUpload);
  const totalProgress = useUploadProgress2((state) => state.totalProgress);
  const activeCount = useUploadProgress2((state) => state.activeUploads);
  const currentUpload = uploadId ? getUpload(uploadId) : uploads.find((u) => u.status === "uploading");
  return {
    currentUpload,
    allUploads: uploads,
    totalProgress,
    activeCount,
    isActive: currentUpload?.status === "uploading",
    isPaused: currentUpload?.status === "paused",
    isFailed: currentUpload?.status === "failed",
    isCompleted: currentUpload?.status === "completed"
  };
}
export {
  useUpload,
  useUploadProgress,
  useUploadState
};
