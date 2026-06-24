// src/worker/upload.worker.ts
function generateSessionId() {
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  return `${randomStr}-${timestamp}`;
}
var config = {
  chunkSizes: {
    video: 2 * 1024 * 1024,
    audio: 2 * 1024 * 1024,
    image: 1 * 1024 * 1024,
    document: 1.5 * 1024 * 1024,
    default: 1 * 1024 * 1024
  },
  maxRetries: 3,
  retryDelayMs: 1e3,
  maxConcurrentUploads: 5,
  storageRetentionDays: 7,
  dbName: "UploadDB",
  dbVersion: 3,
  cleanupEndpoint: "/api/file",
  cleanupIntervalMs: 24 * 60 * 60 * 1e3,
  tokenStrategy: "message",
  fetchCredentials: "same-origin"
};
function chunkSizeFor(fileType) {
  if (fileType.startsWith("video/")) return config.chunkSizes.video;
  if (fileType.startsWith("audio/")) return config.chunkSizes.audio;
  if (fileType.startsWith("image/")) return config.chunkSizes.image;
  return config.chunkSizes.document || config.chunkSizes.default;
}
var pendingEncryptionRequests = /* @__PURE__ */ new Map();
var pendingThumbnails = /* @__PURE__ */ new Map();
var pendingModifications = /* @__PURE__ */ new Map();
var pendingTokenRequests = [];
async function encryptQueryString(str) {
  return new Promise((resolve, reject) => {
    const requestId = `encrypt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const timeout = setTimeout(() => {
      pendingEncryptionRequests.delete(requestId);
      reject(new Error("Encryption timeout"));
    }, 5e3);
    pendingEncryptionRequests.set(requestId, { resolve, reject, timeout });
    self.postMessage({ type: "request_encrypt", requestId, data: str });
  });
}
function handleEncryptionResponse(message) {
  const pending = pendingEncryptionRequests.get(message.requestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingEncryptionRequests.delete(message.requestId);
  if (message.encrypted) pending.resolve(message.encrypted);
  else pending.reject(new Error(message.error || "Encryption failed"));
}
async function getAuthToken() {
  if (config.tokenStrategy === "credentials") {
    return "";
  }
  return new Promise((resolve, reject) => {
    const timestamp = Date.now();
    pendingTokenRequests.push({ resolve, reject, timestamp });
    self.postMessage({ type: "request_token" });
    setTimeout(() => {
      const index = pendingTokenRequests.findIndex((r) => r.timestamp === timestamp);
      if (index !== -1) {
        pendingTokenRequests.splice(index, 1);
        reject(new Error("Token request timeout"));
      }
    }, 1e4);
  });
}
function handleTokenResponse(message) {
  const pending = pendingTokenRequests.shift();
  if (!pending) return;
  if (message.token) pending.resolve(message.token);
  else pending.reject(new Error(message.error || "No token available"));
}
function handleAuthRedirect() {
  self.postMessage({ type: "AUTH_REDIRECT", url: "/auth" });
}
var UploadQueue = class {
  queue = [];
  activeUploads = /* @__PURE__ */ new Set();
  processing = false;
  async enqueue(uploadId, data) {
    this.queue.push({ uploadId, data });
    if (!this.processing) this.processQueue();
  }
  async processQueue() {
    this.processing = true;
    while (this.queue.length > 0 || this.activeUploads.size > 0) {
      while (this.queue.length > 0 && this.activeUploads.size < config.maxConcurrentUploads) {
        const next = this.queue.shift();
        this.activeUploads.add(next.uploadId);
        this.processUpload(next.uploadId, next.data).finally(() => {
          this.activeUploads.delete(next.uploadId);
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.processing = false;
  }
  async processUpload(uploadId, data) {
    try {
      await handleUploadRequest(data);
    } catch (error) {
      self.postMessage({
        type: "error",
        uploadId,
        message: error instanceof Error ? error.message : "Upload failed",
        error: error instanceof Error ? error.stack : String(error),
        timestamp: Date.now()
      });
    }
  }
  getQueueStatus() {
    return {
      queued: this.queue.map((item) => item.uploadId),
      active: Array.from(this.activeUploads),
      processing: this.processing
    };
  }
};
var uploadQueue = new UploadQueue();
var UploadStatusManager = class {
  statusMap = /* @__PURE__ */ new Map();
  abortControllers = /* @__PURE__ */ new Map();
  setPaused(uploadId, paused) {
    const status = this.statusMap.get(uploadId) || { paused: false, cancelled: false };
    status.paused = paused;
    this.statusMap.set(uploadId, status);
  }
  setCancelled(uploadId, cancelled) {
    const status = this.statusMap.get(uploadId) || { paused: false, cancelled: false };
    status.cancelled = cancelled;
    this.statusMap.set(uploadId, status);
  }
  isPaused(uploadId) {
    return this.statusMap.get(uploadId)?.paused || false;
  }
  isCancelled(uploadId) {
    return this.statusMap.get(uploadId)?.cancelled || false;
  }
  setAbortController(uploadId, controller) {
    this.abortControllers.set(uploadId, controller);
  }
  clearAbortController(uploadId) {
    this.abortControllers.delete(uploadId);
  }
  getStatus(uploadId) {
    const status = this.statusMap.get(uploadId);
    if (!status) return "inactive";
    if (status.cancelled) return "cancelled";
    if (status.paused) return "paused";
    return "active";
  }
  remove(uploadId) {
    this.statusMap.delete(uploadId);
    this.abortControllers.get(uploadId)?.abort();
    this.abortControllers.delete(uploadId);
  }
};
var statusManager = new UploadStatusManager();
var UploadStorage = class {
  db = null;
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(config.dbName, config.dbVersion);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        this.db.onerror = () => {
        };
        resolve(this.db);
      };
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains("files")) {
          db.createObjectStore("files", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("chunks")) {
          db.createObjectStore("chunks", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("progress")) {
          const progressStore = db.createObjectStore("progress", { keyPath: "uploadId" });
          progressStore.createIndex("status", "status", { unique: false });
          progressStore.createIndex("lastUpdated", "lastUpdated", { unique: false });
        }
      };
    });
  }
  async storeFile(uploadId, fileIndex, blob, metadata) {
    if (!this.db) throw new Error("Database not initialized");
    const tx = this.db.transaction(["files"], "readwrite");
    const store = tx.objectStore("files");
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      const request = store.put({
        id: `${uploadId}_file_${fileIndex}`,
        uploadId,
        fileIndex,
        blob,
        metadata: { ...metadata, size: blob.size, type: blob.type, lastModified: metadata.lastModified || Date.now() },
        timestamp: Date.now()
      });
      request.onerror = () => reject(request.error);
    });
  }
  async getFile(uploadId, fileIndex) {
    if (!this.db) throw new Error("Database not initialized");
    const tx = this.db.transaction(["files"], "readonly");
    const store = tx.objectStore("files");
    return new Promise((resolve, reject) => {
      const request = store.get(`${uploadId}_file_${fileIndex}`);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }
  async updateFile(uploadId, fileIndex, blob, newMetadata) {
    if (!this.db) throw new Error("Database not initialized");
    const existingFile = await this.getFile(uploadId, fileIndex);
    if (!existingFile) throw new Error("File not found in storage");
    const tx = this.db.transaction(["files"], "readwrite");
    const store = tx.objectStore("files");
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      const updatedMetadata = {
        ...existingFile.metadata,
        ...newMetadata,
        size: blob.size,
        type: blob.type,
        lastModified: Date.now(),
        modified: true
      };
      const request = store.put({
        id: `${uploadId}_file_${fileIndex}`,
        uploadId,
        fileIndex,
        blob,
        metadata: updatedMetadata,
        timestamp: Date.now()
      });
      request.onerror = () => reject(request.error);
    });
  }
  async storeVariant(uploadId, fileIndex, quality, blob) {
    if (!this.db) throw new Error("Database not initialized");
    const tx = this.db.transaction(["files"], "readwrite");
    const store = tx.objectStore("files");
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      const request = store.put({
        id: `${uploadId}_file_${fileIndex}_${quality}`,
        uploadId,
        fileIndex,
        quality,
        blob,
        metadata: { size: blob.size, type: blob.type, lastModified: Date.now(), isVariant: true },
        timestamp: Date.now()
      });
      request.onerror = () => reject(request.error);
    });
  }
  async getVariant(uploadId, fileIndex, quality) {
    if (!this.db) throw new Error("Database not initialized");
    const tx = this.db.transaction(["files"], "readonly");
    const store = tx.objectStore("files");
    return new Promise((resolve, reject) => {
      const request = store.get(`${uploadId}_file_${fileIndex}_${quality}`);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }
  async storeProgress(uploadId, progress) {
    if (!this.db) throw new Error("Database not initialized");
    if (!uploadId) throw new Error("UploadId is required");
    if (!progress) throw new Error("Progress data is required");
    const tx = this.db.transaction(["progress"], "readwrite");
    const store = tx.objectStore("progress");
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      const request = store.put({ ...progress, uploadId, lastUpdated: Date.now() });
      request.onerror = () => reject(request.error);
    });
  }
  async getProgress(uploadId) {
    if (!this.db) throw new Error("Database not initialized");
    if (!uploadId) throw new Error("UploadId is required");
    const tx = this.db.transaction(["progress"], "readonly");
    const store = tx.objectStore("progress");
    return new Promise((resolve, reject) => {
      const request = store.get(uploadId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }
  async deleteProgress(uploadId) {
    if (!this.db) throw new Error("Database not initialized");
    const tx = this.db.transaction(["progress"], "readwrite");
    const store = tx.objectStore("progress");
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      const request = store.delete(uploadId);
      request.onerror = () => reject(request.error);
    });
  }
  async getAllProgress() {
    if (!this.db) throw new Error("Database not initialized");
    const tx = this.db.transaction(["progress"], "readonly");
    const store = tx.objectStore("progress");
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }
  async clearUpload(uploadId, finalize = false) {
    if (!this.db) return;
    try {
      let sessionIds = [];
      let shouldClear = finalize;
      try {
        const progress = await this.getProgress(uploadId);
        sessionIds = progress?.allFilesSessionId || [];
        if (!finalize && progress) {
          shouldClear = !progress.maxRetriesReached || progress.status === "completed";
        }
      } catch {
        shouldClear = finalize;
      }
      if (!shouldClear) return;
      const stores = ["files", "chunks", "progress"];
      for (const storeName of stores) {
        if (!this.db.objectStoreNames.contains(storeName)) continue;
        try {
          const tx = this.db.transaction(storeName, "readwrite");
          const store = tx.objectStore(storeName);
          await new Promise((resolve) => {
            const cursorRequest = store.openCursor();
            cursorRequest.onerror = () => resolve();
            cursorRequest.onsuccess = (event) => {
              const cursor = event.target?.result;
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
        }
      }
      if (finalize && sessionIds.length > 0) {
        await this.notifyServerCleanup(sessionIds);
      }
    } catch {
    }
  }
  async cleanupExpiredUploads() {
    if (!this.db) return;
    try {
      const allProgress = await this.getAllProgress();
      const now = Date.now();
      const retentionPeriod = config.storageRetentionDays * 24 * 60 * 60 * 1e3;
      for (const progress of allProgress) {
        if (!progress || !progress.uploadId) continue;
        const age = now - (progress.lastUpdated || progress.startTime);
        if (age > retentionPeriod) {
          await this.clearUpload(progress.uploadId, true);
        }
      }
    } catch {
    }
  }
  async notifyServerCleanup(sessionIds) {
    try {
      const token = await getAuthToken();
      const id = await encryptQueryString(JSON.stringify({ sessionIds }));
      await fetch(`${config.cleanupEndpoint}/${id}`, {
        method: "DELETE",
        credentials: config.fetchCredentials,
        headers: token ? { Authorization: `Bearer ${token}` } : void 0
      });
    } catch {
    }
  }
};
var storage = new UploadStorage();
var storageReady = false;
async function withRetry(operation, uploadId, maxRetries = config.maxRetries) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (statusManager.isCancelled(uploadId)) throw new Error("Upload cancelled");
    if (statusManager.isPaused(uploadId)) {
      await new Promise((resolve) => {
        const checkPause = () => {
          if (!statusManager.isPaused(uploadId)) resolve();
          else setTimeout(checkPause, 100);
        };
        checkPause();
      });
      if (statusManager.isCancelled(uploadId)) throw new Error("Upload cancelled during pause");
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
      }
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, config.retryDelayMs * attempt));
      }
    }
  }
  throw lastError || new Error("Operation failed after retries");
}
async function uploadChunk(formData, endpoint, method, token, uploadId, signal) {
  return withRetry(async () => {
    if (statusManager.isCancelled(uploadId)) throw new Error("Upload cancelled");
    if (statusManager.isPaused(uploadId)) throw new Error("Upload paused");
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(endpoint, {
      method: method.toUpperCase(),
      body: formData,
      headers,
      signal,
      credentials: config.fetchCredentials
    });
    let data = null;
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
async function requestModification(uploadId, fileIndex) {
  return new Promise((resolve, reject) => {
    const requestKey = `${uploadId}_${fileIndex}`;
    const timeout = setTimeout(() => {
      pendingModifications.delete(requestKey);
      reject(new Error("Modification timeout"));
    }, 3e5);
    pendingModifications.set(requestKey, { resolve, reject, timeout });
    self.postMessage({ type: "request_modification", uploadId, fileIndex });
  });
}
var pendingTransformations = /* @__PURE__ */ new Map();
async function requestTransformation(uploadId, fileIndex, config2) {
  return new Promise((resolve, reject) => {
    const requestKey = `${uploadId}_${fileIndex}_trans`;
    const timeout = setTimeout(() => {
      pendingTransformations.delete(requestKey);
      reject(new Error("Transformation timeout"));
    }, 3e5);
    pendingTransformations.set(requestKey, { resolve, reject, timeout });
    self.postMessage({ type: "request_transformation", uploadId, fileIndex, transformer: config2 });
  });
}
function handleTransformationResponse(message) {
  const requestKey = `${message.uploadId}_${message.fileIndex}_trans`;
  const pending = pendingTransformations.get(requestKey);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingTransformations.delete(requestKey);
  if (message.type === "transformation_complete") {
    (async () => {
      try {
        if (message.modifiedBlobs) {
          for (const [quality, blob] of Object.entries(message.modifiedBlobs)) {
            await storage.storeVariant(message.uploadId, message.fileIndex, quality, blob);
          }
        } else if (message.modifiedBlob) {
          await storage.updateFile(message.uploadId, message.fileIndex, message.modifiedBlob, {
            transformed: true,
            originalSize: message.modifiedBlob?.size
          });
        }
        const progress = await storage.getProgress(message.uploadId);
        if (progress && progress.transformerConfigs?.[message.fileIndex]) {
          progress.transformerConfigs[message.fileIndex].isTransformed = true;
          progress.transformerConfigs[message.fileIndex].needsTransformation = false;
          await storage.storeProgress(message.uploadId, progress);
        }
        pending.resolve(message.modifiedBlobs || message.modifiedBlob);
      } catch {
        pending.reject(new Error("Failed to store transformed file(s)"));
      }
    })();
  } else if (message.type === "transformation_error") {
    pending.reject(new Error(message.error || "Transformation failed"));
  }
}
function handleModificationResponse(message) {
  const requestKey = `${message.uploadId}_${message.fileIndex}`;
  const pending = pendingModifications.get(requestKey);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingModifications.delete(requestKey);
  if (message.type === "modification_complete") {
    (async () => {
      try {
        await storage.updateFile(message.uploadId, message.fileIndex, message.modifiedBlob, {
          modified: true,
          originalSize: message.modifiedBlob?.size
        });
        const progress = await storage.getProgress(message.uploadId);
        if (progress && progress.modificationConfigs?.[message.fileIndex]) {
          progress.modificationConfigs[message.fileIndex].isModified = true;
          progress.modificationConfigs[message.fileIndex].needsModification = false;
          await storage.storeProgress(message.uploadId, progress);
        }
        pending.resolve(message.modifiedBlob);
      } catch {
        pending.reject(new Error("Failed to store modified file"));
      }
    })();
  } else if (message.type === "modification_error") {
    pending.reject(new Error(message.error || "Modification failed"));
  }
}
async function requestThumbnailGeneration(uploadId, fileIndex) {
  return new Promise((resolve, reject) => {
    const requestKey = `${uploadId}_${fileIndex}_thumb`;
    const timeout = setTimeout(() => {
      pendingThumbnails.delete(requestKey);
      reject(new Error("Thumbnail generation timeout"));
    }, 3e4);
    pendingThumbnails.set(requestKey, { resolve, reject, timeout });
    self.postMessage({ type: "request_thumbnail", uploadId, fileIndex });
  });
}
function handleThumbnailResponse(message) {
  const requestKey = `${message.uploadId}_${message.fileIndex}_thumb`;
  const pending = pendingThumbnails.get(requestKey);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingThumbnails.delete(requestKey);
  if (message.type === "thumbnail_complete") {
    if (!message.thumbnailBase64) pending.reject(new Error("No thumbnail data received"));
    else pending.resolve(message.thumbnailBase64);
  } else if (message.type === "thumbnail_error") {
    pending.reject(new Error(message.error || "Thumbnail generation failed"));
  }
}
async function processFilesUpload(uploadId, blobArray, filenameArray, uploadState, resumeUpload) {
  if (!uploadState) return;
  const abortController = new AbortController();
  statusManager.setAbortController(uploadId, abortController);
  try {
    const fileCount = uploadState.fileCount || blobArray.length;
    for (let fileIndex = uploadState.currentFileIndex; fileIndex < fileCount; fileIndex++) {
      if (statusManager.isCancelled(uploadId)) {
        abortController.abort();
        break;
      }
      if (statusManager.isPaused(uploadId)) {
        uploadState.status = "paused";
        await storage.storeProgress(uploadId, uploadState);
        break;
      }
      let currentBlob;
      let currentFilename;
      let thumbnailBase64 = null;
      const modConfig = uploadState.modificationConfigs?.[fileIndex];
      const needsModification = modConfig?.needsModification && !modConfig?.isModified;
      if (needsModification) {
        uploadState.status = "modifying";
        uploadState.currentFileIndex = fileIndex;
        await storage.storeProgress(uploadId, uploadState);
        const modifiedBlob = await requestModification(uploadId, fileIndex);
        currentBlob = modifiedBlob;
        currentFilename = filenameArray[fileIndex];
        const refreshedState = await storage.getProgress(uploadId);
        if (refreshedState) uploadState.modificationConfigs = refreshedState.modificationConfigs;
      }
      const transConfig = uploadState.transformerConfigs?.[fileIndex];
      const needsTransformation = transConfig?.needsTransformation && !transConfig?.isTransformed;
      const itemsToUpload = [];
      if (needsTransformation) {
        uploadState.status = "transforming";
        await storage.storeProgress(uploadId, uploadState);
        const result = await requestTransformation(uploadId, fileIndex, transConfig.config);
        const refreshedState = await storage.getProgress(uploadId);
        if (refreshedState) uploadState.transformerConfigs = refreshedState.transformerConfigs;
        if (result && typeof result === "object" && !(result instanceof Blob)) {
          for (const [q, b] of Object.entries(result)) {
            itemsToUpload.push({ quality: q, blob: b });
          }
        } else {
          itemsToUpload.push({ blob: result });
        }
      } else if (storageReady) {
        const storedFile = await storage.getFile(uploadId, fileIndex);
        if (storedFile?.blob) {
          itemsToUpload.push({ blob: storedFile.blob });
        } else if (blobArray[fileIndex]) {
          itemsToUpload.push({ blob: blobArray[fileIndex] });
        } else {
          throw new Error(`No file data available for index ${fileIndex}`);
        }
      } else {
        if (blobArray[fileIndex]) {
          itemsToUpload.push({ blob: blobArray[fileIndex] });
        } else {
          throw new Error(`No file data available for index ${fileIndex}`);
        }
      }
      let sessionId;
      if (fileIndex < uploadState.allFilesSessionId.length) {
        sessionId = uploadState.allFilesSessionId[fileIndex];
      } else {
        sessionId = generateSessionId();
        uploadState.allFilesSessionId = [...uploadState.allFilesSessionId, sessionId];
        await storage.storeProgress(uploadId, uploadState);
      }
      for (let variantIndex = 0; variantIndex < itemsToUpload.length; variantIndex++) {
        const { blob: currentBlob2, quality } = itemsToUpload[variantIndex];
        const currentFilename2 = filenameArray[fileIndex];
        const currentFileNumber = fileIndex + 1;
        let variantSessionId;
        if (quality) {
          variantSessionId = `${sessionId}_${quality}`;
        } else {
          variantSessionId = sessionId;
        }
        uploadState.currentFileIndex = fileIndex;
        uploadState.status = "uploading";
        await storage.storeProgress(uploadId, uploadState);
        let fileType;
        let fieldName;
        if (currentBlob2.type.startsWith("video/")) {
          fileType = "video";
          fieldName = "video";
        } else if (currentBlob2.type.startsWith("audio/")) {
          fileType = "audio";
          fieldName = "audio";
        } else if (currentBlob2.type.startsWith("image/")) {
          fileType = "image";
          fieldName = "image";
        } else {
          fileType = "document";
          fieldName = "document";
        }
        const isFirstChunk = resumeUpload && fileIndex === uploadState.currentFileIndex ? uploadState.currentChunkIndex === 0 : true;
        if (fileType === "video" && isFirstChunk && !quality) {
          try {
            uploadState.status = "generating_thumbnail";
            await storage.storeProgress(uploadId, uploadState);
            thumbnailBase64 = await requestThumbnailGeneration(uploadId, fileIndex);
            uploadState.status = "uploading";
            await storage.storeProgress(uploadId, uploadState);
          } catch {
            thumbnailBase64 = null;
          }
        }
        const chunkSize = chunkSizeFor(currentBlob2.type);
        const totalChunks = Math.ceil(currentBlob2.size / chunkSize);
        const startChunkIndex = resumeUpload && fileIndex === uploadState.currentFileIndex ? uploadState.currentChunkIndex : 0;
        for (let i = startChunkIndex; i < totalChunks; i++) {
          if (statusManager.isCancelled(uploadId)) {
            abortController.abort();
            break;
          }
          if (statusManager.isPaused(uploadId)) {
            uploadState.currentChunkIndex = i;
            uploadState.status = "paused";
            await storage.storeProgress(uploadId, uploadState);
            break;
          }
          const start = i * chunkSize;
          const end = Math.min(start + chunkSize, currentBlob2.size);
          const chunk = currentBlob2.slice(start, end);
          const formData = new FormData();
          formData.append("sessionId", variantSessionId);
          formData.append("chunkIndex", i.toString());
          formData.append("totalChunks", totalChunks.toString());
          formData.append(
            uploadState.metadata?.[fileIndex]?.fieldname || fieldName,
            new Blob([chunk], { type: currentBlob2.type }),
            currentFilename2
          );
          formData.append("mimetype", currentBlob2.type);
          formData.append("chunksize", chunkSize.toString());
          formData.append("filename", currentFilename2);
          formData.append("fieldname", uploadState.metadata?.[fileIndex]?.fieldname || "");
          formData.append("postData", JSON.stringify(uploadState.postData || {}));
          formData.append("fileCount", fileCount.toString());
          formData.append("currentFileNumber", currentFileNumber.toString());
          formData.append("allFilesSessionId", JSON.stringify(uploadState.allFilesSessionId));
          formData.append("totalSize", currentBlob2.size.toString());
          formData.append("status", i === totalChunks - 1 ? "true" : "false");
          formData.append("originalFilename", currentFilename2);
          formData.append("uploadType", uploadState.uploadType || "default");
          if (quality) {
            formData.append("quality", quality);
            formData.append("parentSessionId", sessionId);
          }
          if (i === 0 && fileType === "video" && thumbnailBase64 && !quality) {
            formData.append("thumbnailBase64", thumbnailBase64);
          }
          if (i === 0 && uploadState.transformerConfigs?.[fileIndex]?.config) {
            formData.append("transformer", JSON.stringify(uploadState.transformerConfigs[fileIndex].config));
          }
          if ((uploadState.metadata || []).length > 0) {
            formData.append("metadata", JSON.stringify(uploadState.metadata?.[fileIndex]));
          }
          if (fileType === "video") {
            formData.append("startTime", uploadState.videoStartTime?.toString() || "");
            formData.append("endTime", uploadState.videoEndTime?.toString() || "");
            formData.append("fullDuration", uploadState.duration?.toString() || "");
          }
          try {
            let token = "";
            try {
              token = await getAuthToken();
            } catch (error) {
              console.warn("[Worker] Token request failed, continuing without authentication");
            }
            const response = await uploadChunk(
              formData,
              uploadState.endpoint || "/api/upload",
              uploadState.method || "POST",
              token,
              uploadId,
              abortController.signal
            );
            if (response?.data?.status !== "success") {
              throw new Error(response?.data?.message || "Chunk upload failed");
            }
            uploadState.currentChunkIndex = i + 1;
            uploadState.status = "uploading";
            uploadState.retryCount = 0;
            const fileProgress = (i + 1) / totalChunks * 100;
            const totalProgress = (uploadState.completedFiles * 100 + fileProgress) / fileCount;
            uploadState.overallProgress = totalProgress.toFixed(1);
            await storage.storeProgress(uploadId, uploadState);
            self.postMessage({
              type: "progress",
              uploadId,
              fileIndex,
              fileName: currentFilename2,
              chunkIndex: i + 1,
              totalChunks,
              fileProgress: fileProgress.toFixed(1),
              overallProgress: uploadState.overallProgress,
              currentFile: currentFileNumber,
              totalFiles: fileCount,
              quality: quality || null,
              hasThumbnail: fileType === "video" && i === 0 && thumbnailBase64 !== null
            });
            if (i === totalChunks - 1 && currentFileNumber === fileCount && variantIndex === itemsToUpload.length - 1) {
              uploadState.status = "completed";
              uploadState.overallProgress = "100.0";
              await storage.storeProgress(uploadId, uploadState);
              self.postMessage({
                type: "success",
                uploadId,
                status: "success",
                message: `All ${fileCount} file(s) and variants uploaded successfully.`,
                data: response.data,
                fileType,
                allFilesSessionId: uploadState.allFilesSessionId
              });
              try {
                await storage.clearUpload(uploadId, false);
                statusManager.remove(uploadId);
              } catch {
              }
              return;
            }
          } catch (error) {
            if (error instanceof Error && error.message.includes("paused")) {
              uploadState.currentChunkIndex = i;
              uploadState.status = "paused";
              await storage.storeProgress(uploadId, uploadState);
              self.postMessage({
                type: "upload_paused",
                uploadId,
                message: "Upload paused",
                error,
                currentFileIndex: fileIndex,
                currentChunkIndex: i
              });
              return;
            }
            if (error instanceof Error && error.message.includes("cancelled")) {
              uploadState.status = "cancelled";
              await storage.storeProgress(uploadId, uploadState);
              return;
            }
            throw error;
          }
        }
      }
      uploadState.completedFiles += 1;
      uploadState.currentChunkIndex = 0;
      uploadState.status = "uploading";
      await storage.storeProgress(uploadId, uploadState);
    }
  } catch (error) {
    uploadState.status = "error";
    uploadState.errorMessage = error instanceof Error ? error.message : "Unknown error";
    if (uploadState.retryCount && uploadState.retryCount >= config.maxRetries) {
      uploadState.maxRetriesReached = true;
    }
    await storage.storeProgress(uploadId, uploadState);
    if (!uploadState.maxRetriesReached) {
      throw error;
    } else {
      self.postMessage({
        type: "max_retries_reached",
        uploadId,
        message: `Maximum retries reached. Upload data will be kept for ${config.storageRetentionDays} days.`,
        error: error instanceof Error ? error.message : "Unknown error",
        retryCount: uploadState.retryCount,
        timestamp: Date.now()
      });
    }
  } finally {
    statusManager.clearAbortController(uploadId);
  }
}
self.addEventListener("message", async (event) => {
  try {
    if (event.data?.type === "configure") {
      config = {
        ...config,
        ...event.data.config,
        chunkSizes: { ...config.chunkSizes, ...event.data.config?.chunkSizes || {} }
      };
      self.postMessage({ type: "configured", config });
      return;
    }
    if (!storageReady) {
      try {
        await storage.init();
        storageReady = true;
        setInterval(() => {
          storage.cleanupExpiredUploads();
        }, config.cleanupIntervalMs);
      } catch (initError) {
        self.postMessage({
          type: "init_error",
          message: "Failed to initialize storage",
          error: initError instanceof Error ? initError.message : String(initError),
          uploadId: event.data.uploadId || null
        });
        return;
      }
    }
    const { type, uploadId } = event.data;
    if (type === "token_response") return handleTokenResponse(event.data);
    if (type === "encrypt_response") return handleEncryptionResponse(event.data);
    if (type === "modification_complete" || type === "modification_error") return handleModificationResponse(event.data);
    if (type === "thumbnail_complete" || type === "thumbnail_error") return handleThumbnailResponse(event.data);
    if (type === "transformation_complete" || type === "transformation_error") return handleTransformationResponse(event.data);
    switch (type) {
      case "pause":
        await handlePauseRequest(uploadId);
        return;
      case "resume":
        await handleResumeRequest(uploadId);
        return;
      case "cancel":
        await handleCancelRequest(uploadId);
        return;
      case "clear_progress":
        await handleClearRequest(event.data);
        return;
      case "get_thumbnail_data":
        await handleGetThumbnailDataRequest(event.data);
        return;
      case "get_file_data":
        await handleGetFileDataRequest(event.data);
        return;
      case "get_file_data_for_trans":
        await handleGetFileDataForTransRequest(event.data);
        return;
      case "get_all_progress":
        await handleGetAllProgressRequest();
        return;
      case "confirm_upload":
        self.postMessage({ type: "upload_confirmed", uploadId, state: statusManager.getStatus(uploadId) });
        return;
      case "upload":
        await uploadQueue.enqueue(uploadId, event.data);
        return;
      case "AUTH_REDIRECT":
        handleAuthRedirect();
        return;
      default:
        return;
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Unknown error",
      uploadId: event.data.uploadId || null
    });
  }
});
async function handleGetFileDataRequest(data) {
  const { uploadId, fileIndex } = data;
  try {
    const storedFile = await storage.getFile(uploadId, fileIndex);
    if (!storedFile) throw new Error("File not found in storage");
    const progress = await storage.getProgress(uploadId);
    const fileConfig = progress?.modificationConfigs?.[fileIndex]?.config;
    self.postMessage({ type: "send_file_data", uploadId, fileIndex, blob: storedFile.blob, config: fileConfig });
  } catch (error) {
    self.postMessage({
      type: "modification_error",
      uploadId,
      fileIndex,
      error: error instanceof Error ? error.message : "Failed to get file data"
    });
  }
}
async function handleGetFileDataForTransRequest(data) {
  const { uploadId, fileIndex, transformer } = data;
  try {
    const storedFile = await storage.getFile(uploadId, fileIndex);
    if (!storedFile) throw new Error("File not found in storage");
    self.postMessage({ type: "send_file_data_for_trans", uploadId, fileIndex, blob: storedFile.blob, transformer });
  } catch (error) {
    self.postMessage({
      type: "transformation_error",
      uploadId,
      fileIndex,
      error: error instanceof Error ? error.message : "Failed to get file data for transformation"
    });
  }
}
async function handlePauseRequest(uploadId) {
  try {
    const progress = await storage.getProgress(uploadId);
    if (!progress) {
      self.postMessage({ type: "pause_error", message: "No upload found to pause", uploadId, state: "inactive" });
      return;
    }
    statusManager.setPaused(uploadId, true);
    progress.status = "paused";
    await storage.storeProgress(uploadId, progress);
    self.postMessage({ type: "paused", uploadId, message: "Upload paused successfully", state: "paused" });
  } catch (error) {
    self.postMessage({
      type: "pause_error",
      message: "Failed to pause upload",
      uploadId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
async function handleResumeRequest(uploadId) {
  try {
    const progress = await storage.getProgress(uploadId);
    if (!progress) {
      self.postMessage({ type: "resume_error", message: "No upload found to resume", uploadId, resumeUpload: false });
      return;
    }
    if (progress.status !== "paused" && progress.status !== "error") {
      self.postMessage({
        type: "resume_error",
        message: `Cannot resume upload with status: ${progress.status}`,
        uploadId,
        resumeUpload: false
      });
      return;
    }
    progress.retryCount = 0;
    progress.maxRetriesReached = false;
    statusManager.setPaused(uploadId, false);
    progress.status = "resuming";
    progress.lastUpdated = Date.now();
    await storage.storeProgress(uploadId, progress);
    self.postMessage({
      type: "resumed",
      uploadId,
      message: "Upload resumed from previous state",
      currentFileIndex: progress.currentFileIndex,
      currentChunkIndex: progress.currentChunkIndex,
      overallProgress: progress.overallProgress,
      completedFiles: progress.completedFiles,
      totalFiles: progress.fileCount
    });
    await uploadQueue.enqueue(uploadId, { ...progress, resumeUpload: true, uploadId });
  } catch (error) {
    self.postMessage({
      type: "resume_error",
      message: "Failed to resume upload",
      error: error instanceof Error ? error.message : String(error),
      uploadId,
      resumeUpload: false
    });
  }
}
async function handleCancelRequest(uploadId) {
  try {
    const progress = await storage.getProgress(uploadId);
    if (!progress) {
      self.postMessage({ type: "cancel_error", message: "No upload found to cancel", uploadId });
      return;
    }
    statusManager.setCancelled(uploadId, true);
    progress.status = "cancelled";
    progress.lastUpdated = Date.now();
    await storage.storeProgress(uploadId, progress);
    try {
      await storage.clearUpload(uploadId, true);
      statusManager.remove(uploadId);
    } catch {
    }
    self.postMessage({ type: "cancelled", uploadId, message: "Upload cancelled successfully" });
  } catch (error) {
    self.postMessage({
      type: "cancel_error",
      message: "Failed to cancel upload",
      error: error instanceof Error ? error.message : String(error),
      uploadId
    });
  }
}
async function handleClearRequest(data) {
  try {
    const { clearType, uploadId, uploadIds } = data;
    if (clearType === "all") {
      const allProgress = await storage.getAllProgress();
      for (const progress of allProgress) {
        if (progress && progress.uploadId) {
          statusManager.setCancelled(progress.uploadId, true);
          statusManager.remove(progress.uploadId);
          await storage.clearUpload(progress.uploadId, true);
        }
      }
      self.postMessage({ type: "progress_cleared", message: "All uploads cleared successfully", clearType: "all" });
    } else if (uploadIds && Array.isArray(uploadIds)) {
      for (const id of uploadIds) {
        if (id) {
          statusManager.setCancelled(id, true);
          statusManager.remove(id);
          await storage.clearUpload(id, true);
        }
      }
      self.postMessage({ type: "progress_cleared", message: `${clearType} uploads cleared successfully`, clearType: "all" });
    } else if (uploadId) {
      const progress = await storage.getProgress(uploadId);
      if (!progress) {
        self.postMessage({ type: "clear_error", message: "No upload found to clear", uploadId });
        return;
      }
      statusManager.setCancelled(uploadId, true);
      statusManager.remove(uploadId);
      await storage.clearUpload(uploadId, true);
      self.postMessage({ type: "progress_cleared", message: "Upload cleared successfully", uploadId, clearType: "single" });
    } else {
      self.postMessage({ type: "clear_error", message: "Invalid clear request - missing uploadId or clearType", data });
    }
  } catch (error) {
    self.postMessage({
      type: "clear_error",
      message: "Failed to clear progress",
      error: error instanceof Error ? error.message : String(error),
      uploadId: data?.uploadId
    });
  }
}
async function handleGetAllProgressRequest() {
  try {
    const allProgress = await storage.getAllProgress();
    const validProgress = allProgress.filter((p) => p !== null).map((p) => ({ ...p, controllerState: statusManager.getStatus(p.uploadId) }));
    self.postMessage({ type: "all_progress", progress: validProgress, timestamp: Date.now() });
  } catch (error) {
    self.postMessage({
      type: "progress_error",
      message: "Failed to get progress data",
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
async function handleUploadRequest(data) {
  const {
    uploadId,
    blobArray,
    filenameArray,
    postData,
    metadata,
    modificationConfigs,
    endpoint,
    method,
    videoStartTime,
    videoEndTime,
    duration,
    uploadType,
    transformerConfigs,
    resumeUpload = false
  } = data;
  if (!uploadId) {
    self.postMessage({ type: "error", message: "Invalid uploadId provided", uploadId: null });
    return;
  }
  try {
    let uploadState;
    if (resumeUpload) {
      uploadState = await storage.getProgress(uploadId);
      if (!uploadState) throw new Error("No resume data found for upload");
      if (!uploadState.allFilesSessionId || uploadState.allFilesSessionId.length === 0) {
        throw new Error("Invalid resume data - missing session IDs");
      }
      uploadState.status = "resuming";
      uploadState.lastUpdated = Date.now();
      await storage.storeProgress(uploadId, uploadState);
      self.postMessage({
        type: "resumed",
        uploadId,
        message: "Upload resumed from previous state",
        currentFileIndex: uploadState.currentFileIndex,
        currentChunkIndex: uploadState.currentChunkIndex,
        overallProgress: uploadState.overallProgress,
        completedFiles: uploadState.completedFiles,
        totalFiles: uploadState.fileCount
      });
    } else {
      const fileCount = blobArray?.length || 0;
      const filenames = filenameArray || [];
      if (fileCount === 0) throw new Error("No files provided for upload");
      if (filenames.length !== fileCount) throw new Error("Mismatch between number of files and filenames");
      const existingProgress = await storage.getProgress(uploadId);
      if (existingProgress && existingProgress.status !== "completed" && existingProgress.status !== "error") {
        throw new Error(`Upload with ID ${uploadId} already exists with status: ${existingProgress.status}`);
      }
      uploadState = {
        uploadId,
        fileCount,
        currentFileIndex: 0,
        currentChunkIndex: 0,
        completedFiles: 0,
        allFilesSessionId: [],
        startTime: Date.now(),
        filenames,
        postData: postData || {},
        metadata: metadata || [],
        modificationConfigs: modificationConfigs || [],
        transformerConfigs: transformerConfigs || [],
        endpoint: endpoint || "/api/upload",
        method: method || "POST",
        videoStartTime,
        videoEndTime,
        duration,
        uploadType,
        status: "initializing",
        overallProgress: "0.0",
        lastUpdated: Date.now(),
        retryCount: 0,
        maxRetriesReached: false
      };
      await storage.storeProgress(uploadId, uploadState);
      if (storageReady && blobArray) {
        for (let i = 0; i < blobArray.length; i++) {
          await storage.storeFile(uploadId, i, blobArray[i], {
            name: filenames[i],
            size: blobArray[i].size,
            type: blobArray[i].type,
            lastModified: Date.now(),
            modified: false,
            ...metadata?.[i]
          });
        }
      }
      self.postMessage({
        type: "upload_started",
        uploadId,
        message: "Upload initialized successfully",
        fileCount,
        filenames,
        state: "initializing"
      });
    }
    await processFilesUpload(uploadId, blobArray || [], filenameArray || [], uploadState, resumeUpload);
  } catch (error) {
    if (uploadId) {
      try {
        const progress2 = await storage.getProgress(uploadId);
        if (progress2) {
          progress2.status = "error";
          progress2.errorMessage = error instanceof Error ? error.message : "Unknown error";
          progress2.lastUpdated = Date.now();
          if (progress2.retryCount && progress2.retryCount >= config.maxRetries) {
            progress2.maxRetriesReached = true;
          }
          await storage.storeProgress(uploadId, progress2);
          if (!progress2.maxRetriesReached) statusManager.remove(uploadId);
        }
      } catch {
      }
    }
    self.postMessage({
      type: "error",
      uploadId,
      message: error instanceof Error ? error.message : "Upload failed",
      error: error instanceof Error ? error.stack : String(error),
      timestamp: Date.now()
    });
    const progress = uploadId ? await storage.getProgress(uploadId).catch(() => null) : null;
    if (!progress?.maxRetriesReached) statusManager.remove(uploadId);
  }
}
async function handleGetThumbnailDataRequest(data) {
  const { uploadId, fileIndex } = data;
  try {
    const storedFile = await storage.getFile(uploadId, fileIndex);
    if (!storedFile) throw new Error("File not found in storage");
    self.postMessage({ type: "send_thumbnail_data", uploadId, fileIndex, blob: storedFile.blob });
  } catch (error) {
    self.postMessage({
      type: "thumbnail_error",
      uploadId,
      fileIndex,
      error: error instanceof Error ? error.message : "Failed to get file data"
    });
  }
}
