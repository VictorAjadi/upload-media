"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  UploadManager: () => UploadManager,
  cleanupUploadResources: () => cleanupUploadResources,
  getUploadMediaConfig: () => getUploadMediaConfig,
  setUploadMediaConfig: () => setUploadMediaConfig,
  useUploadActions: () => useUploadActions,
  useUploadProgress: () => useUploadProgress
});
module.exports = __toCommonJS(index_exports);

// src/config.ts
var currentConfig = {
  getCookie: () => null,
  encryptQueryString: (data) => JSON.stringify(data),
  showToast: {
    success: console.log,
    error: console.error,
    info: console.info,
    warning: console.warn
  },
  videoState: {
    getState: () => ({
      videos: {},
      clearVideoState: () => {
      }
    })
  }
};
var setUploadMediaConfig = (config) => {
  currentConfig = { ...currentConfig, ...config };
};
var getUploadMediaConfig = () => currentConfig;

// src/store/useUploadProgress.ts
var import_vanilla = require("zustand/vanilla");
var import_middleware = require("zustand/middleware");
var import_immer = require("zustand/middleware/immer");
var import_immer2 = require("immer");
var import_meta = {};
(0, import_immer2.enableMapSet)();
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
var useUploadProgress = (0, import_vanilla.createStore)()(
  (0, import_middleware.persist)(
    (0, import_immer.immer)((set, get) => ({
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
          worker = new Worker(new URL("../dist/worker/upload.worker.mjs", import_meta.url), { type: "module" });
        } catch (error) {
          console.warn("[Worker] Trying dev path...");
          try {
            worker = new Worker(new URL("../worker/upload.worker.ts", import_meta.url), { type: "module" });
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
      storage: (0, import_middleware.createJSONStorage)(() => {
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
var useUploadActions = () => {
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
var cleanupUploadResources = () => {
  const { terminateAllWorkers } = useUploadProgress.getState();
  terminateAllWorkers();
  speedCalculators.clear();
};

// src/utils/sessionId.ts
function generateSessionId() {
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  return `${randomStr}-${timestamp}`;
}

// src/constants.ts
var DEFAULT_CHUNK_SIZES = {
  video: 2 * 1024 * 1024,
  audio: 2 * 1024 * 1024,
  image: 1 * 1024 * 1024,
  document: 5 * 1024 * 1024,
  default: 1 * 1024 * 1024
};
var DEFAULT_MAX_RETRIES = 3;
var CHUNK_SIZES2 = DEFAULT_CHUNK_SIZES;
var MAX_RETRIES2 = DEFAULT_MAX_RETRIES;

// src/manager/UploadManager.ts
var import_meta2 = {};
var UploadManager = class {
  constructor(config = {}) {
    __publicField(this, "worker", null);
    __publicField(this, "uploads", /* @__PURE__ */ new Map());
    __publicField(this, "config");
    __publicField(this, "eventListeners", /* @__PURE__ */ new Map());
    this.config = {
      workerUrl: config.workerUrl || this.getDefaultWorkerUrl(),
      onProgress: config.onProgress || (() => {
      }),
      onComplete: config.onComplete || (() => {
      }),
      onError: config.onError || ((err) => console.error(err)),
      storageKey: config.storageKey || "upload-progress"
    };
    this.initializeWorker();
    this.restoreFromStorage();
  }
  /**
   * Get default worker URL based on environment and format
   */
  getDefaultWorkerUrl() {
    if (typeof window === "undefined") {
      return "";
    }
    try {
      if (typeof import_meta2 !== "undefined" && import_meta2.url) {
        try {
          return new URL("../dist/worker/upload.worker.mjs", import_meta2.url).href;
        } catch (e) {
          try {
            return new URL("../worker/upload.worker.ts", import_meta2.url).href;
          } catch (fallbackError) {
            return this.getWorkerUrlFallback();
          }
        }
      } else {
        return this.getWorkerUrlFallback();
      }
    } catch (error) {
      console.warn("Failed to get worker URL via import.meta, using fallback:", error);
      return this.getWorkerUrlFallback();
    }
  }
  /**
   * Fallback method to get worker URL without import.meta
   */
  getWorkerUrlFallback() {
    if (typeof document !== "undefined") {
      const scripts = document.getElementsByTagName("script");
      if (scripts.length > 0) {
        for (const script of scripts) {
          if (script.src && script.src.includes("upload-media")) {
            const baseUrl = script.src.substring(0, script.src.lastIndexOf("/") + 1);
            return `${baseUrl}worker/upload.worker.mjs`;
          }
        }
      }
    }
    return "/worker/upload.worker.mjs";
  }
  /**
   * Initialize and setup Web Worker
   */
  initializeWorker() {
    try {
      const workerUrl = this.config.workerUrl;
      if (!workerUrl) {
        console.warn("[Worker] No worker URL provided, skipping worker initialization");
        return;
      }
      try {
        this.worker = new Worker(workerUrl, { type: "module" });
      } catch (error) {
        console.warn("[Worker] Module worker failed, trying classic worker:", error);
        try {
          this.worker = new Worker(workerUrl);
        } catch (fallbackError) {
          console.error("[Worker] Classic worker also failed:", fallbackError);
          throw fallbackError;
        }
      }
      this.worker.onmessage = (event) => {
        this.handleWorkerMessage(event.data);
      };
      this.worker.onerror = (error) => {
        console.error("[Worker Error]", error);
        this.config.onError?.(new Error(`Worker error: ${error.message}`));
      };
    } catch (error) {
      console.error("[Worker] Failed to initialize worker:", error);
      this.config.onError?.(new Error("Worker initialization failed"));
    }
  }
  /**
   * Handle messages from Worker
   */
  handleWorkerMessage(message) {
    const { type, uploadId } = message;
    switch (type) {
      case "upload_started":
        this.emit("started", { uploadId, message: message.message });
        break;
      case "progress":
        this.updateProgress(uploadId, message);
        break;
      case "success":
        this.handleUploadSuccess(uploadId, message);
        break;
      case "error":
        this.handleUploadError(uploadId, message);
        break;
      case "paused":
        this.emit("paused", { uploadId });
        break;
      case "cancelled":
        this.emit("cancelled", { uploadId });
        break;
      case "request_token":
        this.handleTokenRequest();
        break;
      case "request_transformation":
        this.handleTransformationRequest(message);
        break;
      default:
        break;
    }
  }
  /**
   * Handle transformation request from worker
   */
  async handleTransformationRequest(message) {
  }
  /**
   * Upload files with optional chunking and resume support
   */
  async upload(files, fieldnames, options) {
    const uploadId = options.uploadId || generateSessionId();
    try {
      if (!files || files.length === 0) {
        throw new Error("No files provided");
      }
      if (files.length !== fieldnames.length) {
        throw new Error("Files and fieldnames length mismatch");
      }
      if (options.maxFiles && files.length > options.maxFiles) {
        throw new Error(`Maximum ${options.maxFiles} files allowed`);
      }
      const enhancedMetadata = options.metadata || [];
      fieldnames.forEach((name, i) => {
        if (!enhancedMetadata[i]) enhancedMetadata[i] = {};
        enhancedMetadata[i].fieldname = name;
        enhancedMetadata[i].size = files[i].size;
        enhancedMetadata[i].type = files[i].type;
      });
      const uploadProgress = {
        uploadId,
        files: files.map((file, index) => ({
          fileIndex: index,
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type,
          progress: 0,
          chunkIndex: 0,
          totalChunks: Math.ceil(file.size / (CHUNK_SIZES2[file.type.split("/")[0]] || 1024 * 1024)),
          status: "pending",
          needsModification: false,
          isModified: false
        })),
        overallProgress: 0,
        status: "initializing",
        startTime: Date.now(),
        retryCount: 0,
        maxRetries: MAX_RETRIES2,
        metadata: enhancedMetadata
        // store it in progress too!
      };
      this.uploads.set(uploadId, uploadProgress);
      this.saveToStorage();
      if (this.worker) {
        this.worker.postMessage({
          type: "upload",
          uploadId,
          blobArray: files,
          filenameArray: files.map((f) => f.name),
          ...options,
          metadata: enhancedMetadata
        });
      } else {
        console.warn("[Upload] Worker not available, upload will not proceed");
        throw new Error("Worker not initialized");
      }
      return {
        status: "success",
        uploadId,
        message: "Upload initialized"
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.config.onError?.(err);
      return {
        status: "error",
        uploadId,
        message: err.message,
        error: err.message
      };
    }
  }
  /**
   * Pause an active upload
   */
  pause(uploadId) {
    const upload = this.uploads.get(uploadId);
    if (!upload) return;
    upload.status = "paused";
    this.saveToStorage();
    if (this.worker) {
      this.worker.postMessage({
        type: "pause",
        uploadId
      });
    }
    this.config.onProgress?.(upload);
  }
  /**
   * Resume a paused upload
   */
  resume(uploadId) {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.status !== "paused") return;
    upload.status = "uploading";
    this.saveToStorage();
    if (this.worker) {
      this.worker.postMessage({
        type: "resume",
        uploadId
      });
    }
    this.config.onProgress?.(upload);
  }
  /**
   * Cancel an upload
   */
  cancel(uploadId) {
    const upload = this.uploads.get(uploadId);
    if (!upload) return;
    upload.status = "cancelled";
    if (this.worker) {
      this.worker.postMessage({
        type: "cancel",
        uploadId
      });
    }
    this.emit("cancelled", { uploadId });
  }
  /**
   * Remove upload from tracking
   */
  remove(uploadId) {
    this.uploads.delete(uploadId);
    this.saveToStorage();
  }
  /**
   * Get all uploads
   */
  getUploads() {
    return Array.from(this.uploads.values());
  }
  /**
   * Get specific upload
   */
  getUpload(uploadId) {
    return this.uploads.get(uploadId);
  }
  /**
   * Event listener support
   */
  on(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, /* @__PURE__ */ new Set());
    }
    this.eventListeners.get(event).add(callback);
    return () => {
      this.eventListeners.get(event)?.delete(callback);
    };
  }
  /**
   * Emit events
   */
  emit(event, data) {
    this.eventListeners.get(event)?.forEach((callback) => {
      callback(data);
    });
  }
  /**
   * Update upload progress
   */
  updateProgress(uploadId, message) {
    const upload = this.uploads.get(uploadId);
    if (!upload) return;
    if (message.overallProgress !== void 0) {
      upload.overallProgress = parseFloat(message.overallProgress);
    }
    if (message.status) {
      upload.status = message.status;
    }
    if (message.fileIndex !== void 0 && upload.files[message.fileIndex]) {
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
  handleUploadSuccess(uploadId, message) {
    const upload = this.uploads.get(uploadId);
    if (!upload) return;
    upload.status = "completed";
    upload.overallProgress = 100;
    upload.endTime = Date.now();
    upload.files.forEach((file) => {
      file.status = "completed";
      file.progress = 100;
    });
    this.saveToStorage();
    this.config.onProgress?.(upload);
    this.config.onComplete?.({
      status: "success",
      uploadId,
      message: message.message || "Upload completed",
      data: message.data,
      allFilesSessionId: message.allFilesSessionId
    });
  }
  /**
   * Handle upload error
   */
  handleUploadError(uploadId, message) {
    const upload = this.uploads.get(uploadId);
    if (!upload) return;
    upload.status = "failed";
    upload.error = message.message;
    upload.endTime = Date.now();
    this.saveToStorage();
    this.config.onProgress?.(upload);
    this.config.onError?.(new Error(message.message || "Upload failed"));
  }
  /**
   * Handle token request from worker
   */
  async handleTokenRequest() {
    this.emit("token_request", {});
  }
  /**
   * Provide token to worker
   */
  provideToken(token) {
    if (this.worker) {
      this.worker.postMessage({
        type: "token_response",
        token
      });
    }
  }
  /**
   * Save state to localStorage
   */
  saveToStorage() {
    try {
      const data = Array.from(this.uploads.entries());
      localStorage.setItem(this.config.storageKey, JSON.stringify(data));
    } catch (error) {
      console.warn("Failed to save to storage:", error);
    }
  }
  /**
   * Restore state from localStorage
   */
  restoreFromStorage() {
    try {
      const data = localStorage.getItem(this.config.storageKey);
      if (data) {
        const uploads = JSON.parse(data);
        uploads.forEach(([key, value]) => {
          if (["paused", "failed"].includes(value.status)) {
            this.uploads.set(key, value);
          }
        });
      }
    } catch (error) {
      console.warn("Failed to restore from storage:", error);
    }
  }
  /**
   * Set worker URL dynamically (useful for consumers)
   */
  setWorkerUrl(url) {
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
  destroy() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.uploads.clear();
    this.eventListeners.clear();
  }
};
