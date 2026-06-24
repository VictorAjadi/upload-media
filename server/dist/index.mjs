var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/constants.ts
var DEFAULT_CHUNK_SIZES = {
  video: 2 * 1024 * 1024,
  audio: 2 * 1024 * 1024,
  image: 1 * 1024 * 1024,
  document: 5 * 1024 * 1024,
  default: 1 * 1024 * 1024
};
var QUALITY_MAPPINGS = {
  video: {
    high: { scale: "1920:1080", bitrate: "4M", crf: 21 },
    medium: { scale: "1280:720", bitrate: "2.5M", crf: 23 },
    low: { scale: "800:480", bitrate: "1M", crf: 28 }
  },
  image: {
    high: { quality: 90, maxWidth: 1920 },
    medium: { quality: 70, maxWidth: 1280 },
    low: { quality: 50, maxWidth: 800 }
  },
  audio: {
    high: { bitrate: "320k" },
    medium: { bitrate: "128k" },
    low: { bitrate: "64k" }
  }
};
var DEFAULT_SIZE_LIMITS = {
  video: 500 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
  image: 25 * 1024 * 1024,
  document: 1024 * 1024 * 1024,
  default: 100 * 1024 * 1024
};
var THUMBNAIL_CHUNK_SIZE = 256 * 1024;
var THUMBNAIL_SIZE_LIMIT = 1 * 1024 * 1024;
var THUMBNAIL_DIMENSIONS = { width: 320, height: 180 };
var SUPPORTED_MIME_TYPES = {
  image: ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/avif", "image/bmp", "image/tiff"],
  video: ["video/mp4", "video/webm", "video/quicktime", "video/x-msvideo", "video/x-matroska", "video/x-flv", "video/x-m4v"],
  audio: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/webm", "audio/aac", "audio/opus", "audio/flac"],
  document: [
    "application/pdf",
    "text/plain",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/html",
    "application/zip",
    "application/json"
  ]
};
var DEFAULT_QUALITY = "medium";
var DEFAULT_CACHE_TTL_SECONDS = 300;
var DEFAULT_STALE_UPLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
var DEFAULT_CLEANUP_BATCH_SIZE = 100;
var DEFAULT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1e3;
var AUTH_CACHE_TTL_SECONDS = 5 * 60;
var CACHE_PREFIXES = {
  FILE_BY_ID: "file:id:",
  FILE_BY_SESSION: "file:session:",
  FILE_LIST: "file:list:"
};
function getMimeKind(contentType) {
  if (!contentType || !contentType.includes("/")) return "unknown";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("application/") || contentType.startsWith("text/")) {
    return "document";
  }
  return "unknown";
}

// src/config/UploadConfig.ts
var ConfigValidationError = class extends Error {
  constructor(message) {
    super(`[upload-media/server] Invalid configuration: ${message}`);
    this.name = "ConfigValidationError";
  }
};
function resolveUploadConfig(config) {
  if (!config.database) {
    throw new ConfigValidationError(
      "a `database` (MetadataRepository) is required. Use one of the built-in adapters (MongooseRepository, SQLRepository, InMemoryRepository) or implement the interface yourself."
    );
  }
  if (!config.storages || Object.keys(config.storages).length === 0) {
    throw new ConfigValidationError(
      "at least one entry in `storages` is required, e.g. { storages: { s3: new S3StorageAdapter(...) } }"
    );
  }
  if (!config.defaultStorage || !config.storages[config.defaultStorage]) {
    throw new ConfigValidationError(
      `\`defaultStorage\` ("${config.defaultStorage}") must reference a key present in \`storages\`. Available: ${Object.keys(config.storages).join(", ") || "(none)"}`
    );
  }
  if (!config.uploadTypes || Object.keys(config.uploadTypes).length === 0) {
    throw new ConfigValidationError(
      "at least one entry in `uploadTypes` is required, e.g. { uploadTypes: { post: { ... } } }"
    );
  }
  for (const [name, typeConfig] of Object.entries(config.uploadTypes)) {
    if (typeConfig.storage && !config.storages[typeConfig.storage]) {
      throw new ConfigValidationError(
        `uploadTypes.${name}.storage ("${typeConfig.storage}") does not reference a key present in \`storages\``
      );
    }
    if (!typeConfig.allowedKinds || typeConfig.allowedKinds.length === 0) {
      throw new ConfigValidationError(`uploadTypes.${name}.allowedKinds must list at least one media kind`);
    }
  }
  return {
    ...config,
    cacheTtlSeconds: config.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS,
    staleUploadRetentionMs: config.staleUploadRetentionMs ?? DEFAULT_STALE_UPLOAD_RETENTION_MS,
    globalLimits: { ...DEFAULT_SIZE_LIMITS, ...config.globalLimits || {} },
    globalChunkLimits: { ...DEFAULT_CHUNK_SIZES, ...config.globalChunkLimits || {} },
    maxFieldSize: config.maxFieldSize ?? 1024 * 1024,
    // 1MB
    maxFiles: config.maxFiles ?? 10,
    maxTotalSize: config.maxTotalSize ?? 500 * 1024 * 1024,
    // 500MB
    onProgress: config.onProgress,
    autoRespond: config.autoRespond ?? true
  };
}
function resolveSizeLimit(config, uploadType, kind) {
  return pickLimit(uploadType.limits, kind) ?? pickLimit(config.globalLimits, kind) ?? DEFAULT_SIZE_LIMITS.default;
}
function resolveChunkLimit(config, uploadType, kind) {
  return pickLimit(uploadType.chunkLimits, kind) ?? pickLimit(config.globalChunkLimits, kind) ?? DEFAULT_CHUNK_SIZES.default;
}
function pickLimit(map, kind) {
  if (!map) return void 0;
  if (kind !== "unknown" && map[kind] !== void 0) {
    return map[kind];
  }
  return map.default;
}
function resolveStorageKey(config, uploadType) {
  return uploadType.storage || config.defaultStorage;
}

// src/core/MultipartParser.ts
var MAGIC_BYTES = {
  // Images
  jpeg: { signature: Buffer.from([255, 216, 255]), mimeType: "image/jpeg" },
  png: { signature: Buffer.from([137, 80, 78, 71]), mimeType: "image/png" },
  gif: { signature: Buffer.from([71, 73, 70]), mimeType: "image/gif" },
  webp: { signature: Buffer.from([82, 73, 70, 70]), mimeType: "image/webp" },
  // Video
  mp4: { signature: Buffer.from([0, 0, 0, 32, 102, 116, 121, 112]), mimeType: "video/mp4" },
  webm: { signature: Buffer.from([26, 69, 223, 163]), mimeType: "video/webm" },
  // Documents
  pdf: { signature: Buffer.from([37, 80, 68, 70]), mimeType: "application/pdf" },
  zip: { signature: Buffer.from([80, 75, 3, 4]), mimeType: "application/zip" }
};
var MultipartParser = class {
  /**
   * Parse buffered multipart body (for chunked uploads).
   * Loads entire body into memory before parsing.
   */
  static async parseBuffered(req, options = {}) {
    const busboy = this.loadBusboy();
    const maxFieldSize = options.maxFieldSize ?? 1 * 1024 * 1024;
    const maxFileSize = options.maxFileSize ?? 5 * 1024 * 1024;
    const maxFiles = options.maxFiles ?? 10;
    return new Promise((resolve, reject) => {
      const fields = {};
      const files = [];
      let settled = false;
      let totalSize = 0;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        options.hooks?.onParseError?.(err, { timestamp: Date.now() });
        reject(err);
      };
      let bb;
      try {
        bb = busboy({
          headers: req.headers,
          limits: {
            fieldSize: maxFieldSize,
            fileSize: maxFileSize,
            files: maxFiles
          }
        });
      } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
      }
      bb.on("field", async (name, value) => {
        try {
          const rule = options.fieldValidation?.[name];
          if (rule) {
            this.validateField(name, value, rule);
          }
          let finalValue = value;
          if (options.fieldTransformer?.[name]) {
            finalValue = options.fieldTransformer[name](value);
          }
          if (options.hooks?.onFieldParsed) {
            await options.hooks.onFieldParsed(name, value, { timestamp: Date.now() });
          }
          fields[name] = finalValue;
          options.onField?.(name, finalValue);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      bb.on("file", (fieldname, fileStream, info) => {
        const fileInfo = {
          fieldname,
          filename: info.filename || "unknown",
          mimetype: info.mimeType || info.mimetype || "application/octet-stream",
          size: 0,
          encoding: info.encoding
        };
        const chunks = [];
        let size = 0;
        let truncated = false;
        fileStream.on("data", (chunk) => {
          size += chunk.length;
          totalSize += chunk.length;
          chunks.push(chunk);
          options.onProgress?.(totalSize, options.maxTotalSize ?? Infinity);
        });
        fileStream.on("limit", () => {
          truncated = true;
        });
        fileStream.on("end", async () => {
          try {
            if (truncated) {
              fail(new Error(`File "${fieldname}" exceeded the maximum allowed size`));
              return;
            }
            fileInfo.size = size;
            const buffer = Buffer.concat(chunks, size);
            if (options.fileValidation?.[fieldname]?.detectMagicBytes) {
              fileInfo.detectedMimetype = this.detectMimeType(buffer);
            }
            const rule = options.fileValidation?.[fieldname];
            if (rule) {
              this.validateFile(fieldname, fileInfo, buffer, rule);
            }
            if (options.hooks?.onFileParsed) {
              await options.hooks.onFileParsed(
                fieldname,
                fileInfo.filename,
                fileInfo.mimetype,
                size,
                { timestamp: Date.now() }
              );
            }
            files.push({
              fieldname,
              filename: fileInfo.filename,
              mimetype: fileInfo.mimetype,
              detectedMimetype: fileInfo.detectedMimetype,
              buffer,
              size
            });
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        });
        fileStream.on("error", fail);
      });
      bb.on("error", fail);
      bb.on("finish", () => {
        if (settled) return;
        settled = true;
        options.hooks?.afterParseComplete?.(Object.keys(fields).length, files.length, {
          timestamp: Date.now()
        });
        resolve({ fields, files });
      });
      req.stream.on("error", fail);
      req.stream.pipe(bb);
    });
  }
  /**
   * Stream mode: don't buffer files, pass streams directly to handler.
   * Ideal for large non-chunked uploads.
   */
  static async parseStreaming(req, handlers, options = {}) {
    const busboy = this.loadBusboy();
    const maxFieldSize = options.maxFieldSize ?? 1 * 1024 * 1024;
    const maxFileSize = options.maxFileSize ?? Infinity;
    const maxFiles = options.maxFiles ?? 10;
    return new Promise((resolve, reject) => {
      let settled = false;
      const pending = [];
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      let bb;
      try {
        bb = busboy({
          headers: req.headers,
          limits: { fieldSize: maxFieldSize, fileSize: maxFileSize, files: maxFiles }
        });
      } catch (error) {
        return fail(error instanceof Error ? error : new Error(String(error)));
      }
      bb.on("field", async (name, value) => {
        try {
          const rule = options.fieldValidation?.[name];
          if (rule) {
            this.validateField(name, value, rule);
          }
          let finalValue = value;
          if (options.fieldTransformer?.[name]) {
            finalValue = options.fieldTransformer[name](value);
          }
          const result = handlers.onField?.(name, finalValue);
          if (result instanceof Promise) {
            pending.push(result);
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      bb.on("file", (fieldname, fileStream, info) => {
        const fileInfo = {
          fieldname,
          filename: info.filename || "unknown",
          mimetype: info.mimeType || info.mimetype || "application/octet-stream",
          size: 0,
          encoding: info.encoding
        };
        const result = handlers.onFile(fileInfo, fileStream);
        if (result instanceof Promise) {
          pending.push(result.catch(fail));
        }
      });
      bb.on("error", fail);
      bb.on("finish", async () => {
        try {
          await Promise.all(pending);
          if (!settled) {
            settled = true;
            resolve();
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      req.stream.on("error", fail);
      req.stream.pipe(bb);
    });
  }
  static loadBusboy() {
    try {
      return __require("busboy");
    } catch {
      throw new Error(
        "[MultipartParser] The `busboy` package is required. Install it with: npm install busboy"
      );
    }
  }
  static validateField(name, value, rule) {
    if (rule.required && (!value || value.trim() === "")) {
      throw new Error(`Field "${name}" is required`);
    }
    if (value && rule.minLength && value.length < rule.minLength) {
      throw new Error(`Field "${name}" must be at least ${rule.minLength} characters`);
    }
    if (value && rule.maxLength && value.length > rule.maxLength) {
      throw new Error(`Field "${name}" must be at most ${rule.maxLength} characters`);
    }
    if (value && rule.pattern && !rule.pattern.test(value)) {
      throw new Error(`Field "${name}" does not match the required format`);
    }
    if (value && rule.allowedValues && !rule.allowedValues.includes(value)) {
      throw new Error(`Field "${name}" must be one of: ${rule.allowedValues.join(", ")}`);
    }
    if (rule.isJson && value) {
      try {
        JSON.parse(value);
      } catch {
        throw new Error(`Field "${name}" must be valid JSON`);
      }
    }
  }
  static validateFile(fieldname, info, buffer, rule) {
    if (rule.maxSize && buffer.length > rule.maxSize) {
      throw new Error(
        `File "${fieldname}" exceeds the maximum size of ${rule.maxSize} bytes`
      );
    }
    const mimeToCheck = info.detectedMimetype || info.mimetype;
    if (rule.allowedMimeTypes && !rule.allowedMimeTypes.includes(mimeToCheck)) {
      throw new Error(
        `File "${fieldname}" has unsupported type "${mimeToCheck}". Allowed: ${rule.allowedMimeTypes.join(", ")}`
      );
    }
    if (rule.allowedMimePatterns) {
      const matches = rule.allowedMimePatterns.some((pattern) => {
        const regex = new RegExp(`^${pattern.replace("*", ".*")}$`);
        return regex.test(mimeToCheck);
      });
      if (!matches) {
        throw new Error(
          `File "${fieldname}" type does not match allowed patterns: ${rule.allowedMimePatterns.join(", ")}`
        );
      }
    }
    if (rule.filename?.maxLength && info.filename.length > rule.filename.maxLength) {
      throw new Error(`Filename is too long (max ${rule.filename.maxLength} characters)`);
    }
  }
  /**
   * Detect MIME type from magic bytes.
   * Returns detected MIME type or 'application/octet-stream' if unknown.
   */
  static detectMimeType(buffer) {
    if (buffer.length < 4) return "application/octet-stream";
    for (const [_, { signature, mimeType }] of Object.entries(MAGIC_BYTES)) {
      if (buffer.subarray(0, signature.length).equals(signature)) {
        return mimeType;
      }
    }
    return "application/octet-stream";
  }
  /**
   * Sanitize filename (remove path traversal, special chars, etc.)
   */
  static sanitizeFilename(filename) {
    return filename.replace(/^\.+/, "").replace(/[\/\\]/g, "_").replace(/[<>:"|?*]/g, "_").replace(/\s+/g, "_").substring(0, 255);
  }
};

// src/core/FileValidator.ts
var ValidationError = class extends Error {
  statusCode;
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = statusCode;
  }
};
function detectKind(contentType) {
  return getMimeKind(contentType);
}
function assertKindAllowed(kind, uploadType) {
  if (!uploadType.allowedKinds.includes(kind)) {
    throw new ValidationError(
      `Media kind "${kind}" is not allowed for upload type "${uploadType.name}". Allowed kinds: ${uploadType.allowedKinds.join(", ")}`
    );
  }
}
function assertWithinLimit(size, limit, label) {
  if (size > limit) {
    const limitMb = (limit / (1024 * 1024)).toFixed(1);
    throw new ValidationError(`${label} exceeds the ${limitMb}MB limit`);
  }
}
function assertRequiredFields(fields, required) {
  const missing = required.filter((key) => fields[key] === void 0 || fields[key] === null || fields[key] === "");
  if (missing.length > 0) {
    throw new ValidationError(`Missing required field(s): ${missing.join(", ")}`);
  }
}
function parseIntSafe(value, fallback) {
  const parsed = typeof value === "number" ? value : parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    if (fallback !== void 0) return fallback;
    throw new ValidationError(`Expected a numeric value, received "${value}"`);
  }
  return parsed;
}
function parseJsonSafe(value, fallback) {
  if (value === void 0 || value === null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
function parseBooleanFlag(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

// src/core/UploadEngine.ts
var UploadEngine = class {
  config;
  constructor(config) {
    this.config = resolveUploadConfig(config);
  }
  /**
   * Main upload handler.
   * Auto-detects chunked vs non-chunked by looking at actual multipart fields.
   */
  handle = async (req, res) => {
    try {
      const contentType = this.getContentType(req);
      if (!contentType.includes("multipart/form-data")) {
        throw new ValidationError("Content-Type must be multipart/form-data", 400);
      }
      let uploadType = this.getUploadType(req);
      if (!uploadType && this.config.defaultUploadType) {
        uploadType = this.config.defaultUploadType;
      }
      if (!uploadType || !this.config.uploadTypes[uploadType]) {
        throw new ValidationError(
          `Invalid or missing uploadType. Available: ${Object.keys(this.config.uploadTypes).join(", ")}`,
          400
        );
      }
      const typeConfig = this.config.uploadTypes[uploadType];
      const storageKey = resolveStorageKey(this.config, typeConfig);
      const storage = this.config.storages[storageKey];
      if (!storage) {
        throw new ValidationError(`Storage '${storageKey}' not configured`, 500);
      }
      const fieldValidation = this.buildFieldValidation(typeConfig);
      const fileValidation = this.buildFileValidation(typeConfig);
      const parsed = await MultipartParser.parseBuffered(req, {
        maxFieldSize: this.config.maxFieldSize || 1 * 1024 * 1024,
        maxFileSize: resolveSizeLimit(this.config, typeConfig, "unknown"),
        maxFiles: this.config.maxFiles || 10,
        maxTotalSize: this.config.maxTotalSize || 500 * 1024 * 1024,
        fieldValidation,
        fileValidation,
        onProgress: this.config.onProgress
      });
      req.fields = parsed.fields || {};
      req.files = parsed.files || [];
      const isChunked = this.isChunkedUpload(parsed.fields);
      if (parsed.fields.transformer) {
        try {
          req.transformer = JSON.parse(parsed.fields.transformer);
        } catch {
          req.transformer = parsed.fields.transformer;
        }
      }
      if (isChunked) {
        return await this.handleChunkedUpload(req, res, parsed, uploadType, storage, typeConfig);
      } else {
        return await this.handleNonChunkedUpload(req, res, parsed, uploadType, storage, typeConfig);
      }
    } catch (error) {
      return await this.handleError(error, this.getUploadType(req), res);
    }
  };
  /**
   * Detect chunked upload by checking for required chunked fields.
   * Proper detection - no assumptions.
   */
  isChunkedUpload(fields) {
    const hasSessionId = fields.sessionId && typeof fields.sessionId === "string";
    const hasChunkIndex = fields.chunkIndex !== void 0 && !isNaN(parseInt(String(fields.chunkIndex)));
    const hasTotalChunks = fields.totalChunks !== void 0 && !isNaN(parseInt(String(fields.totalChunks)));
    return hasSessionId && hasChunkIndex && hasTotalChunks;
  }
  /**
   * Handle chunked upload from the worker.
   * FIXED: Fully adaptive to frontend chunk config changes
   */
  async handleChunkedUpload(req, res, parsed, uploadType, storage, typeConfig) {
    const sessionId = String(parsed.fields.sessionId);
    const chunkIndex = parseInt(String(parsed.fields.chunkIndex), 10);
    const totalChunks = parseInt(String(parsed.fields.totalChunks), 10);
    const filename = String(parsed.fields.filename);
    const mimetype = String(parsed.fields.mimetype);
    const totalSize = parseInt(String(parsed.fields.totalSize || 0), 10);
    const chunksize = parseInt(String(parsed.fields.chunksize || 0), 10);
    if (!sessionId || isNaN(chunkIndex) || isNaN(totalChunks)) {
      throw new ValidationError("Missing or invalid chunked upload fields", 400);
    }
    if (!parsed.files || parsed.files.length === 0) {
      throw new ValidationError("No chunk data received", 400);
    }
    const chunkFile = parsed.files[0];
    const kind = detectKind(mimetype);
    const frontendChunkSize = chunksize > 0 ? chunksize : chunkFile.size;
    const frontendTotalSize = totalSize > 0 ? totalSize : chunkFile?.size * totalChunks;
    assertKindAllowed(kind, typeConfig);
    assertWithinLimit(chunkFile.size, resolveSizeLimit(this.config, typeConfig, kind), "File size");
    let fileId;
    let existingFile = null;
    if (this.config.database) {
      existingFile = await this.config.database.getFileBySessionId(sessionId);
    }
    if (existingFile) {
      fileId = existingFile.id;
    } else {
      fileId = this.generateFileId();
    }
    const isLastChunk = chunkIndex === totalChunks - 1;
    let actualTotalSize = frontendTotalSize;
    let actualChunkSize = frontendChunkSize;
    if (isLastChunk) {
      actualChunkSize = chunkFile.size;
      if (existingFile && existingFile.size > 0) {
        actualTotalSize = existingFile.size;
      } else {
        actualTotalSize = chunkFile.size * totalChunks - (frontendChunkSize - chunkFile.size);
        try {
          let totalReceived = 0;
          for (let i = 0; i < totalChunks - 1; i++) {
            try {
              const prevChunk = await this.getChunkSize(fileId, i);
              if (prevChunk > 0) {
                totalReceived += prevChunk;
              }
            } catch {
              totalReceived += frontendChunkSize;
            }
          }
          totalReceived += chunkFile.size;
          if (totalReceived > 0) {
            actualTotalSize = totalReceived;
          }
        } catch {
          actualTotalSize = frontendChunkSize * totalChunks;
        }
      }
    } else {
      actualChunkSize = frontendChunkSize;
      if (chunkIndex === 0 && !existingFile) {
        actualTotalSize = frontendTotalSize || frontendChunkSize * totalChunks;
      }
    }
    if (existingFile && existingFile.chunkSize > 0) {
      const storedChunkSize = existingFile.chunkSize;
      if (storedChunkSize !== actualChunkSize && chunkIndex > 0) {
        actualChunkSize = frontendChunkSize;
      }
    }
    const storageCtx = {
      originalName: filename,
      contentType: mimetype,
      bucket: typeConfig.bucket || uploadType,
      totalChunks,
      chunkIndex,
      totalSize: actualTotalSize,
      chunkSize: actualChunkSize,
      uploadType
    };
    await storage.writeChunk(fileId, chunkIndex, chunkFile.buffer, storageCtx);
    if (chunkIndex === 0 && this.config.database) {
      const metadata = this.extractCustomFields(parsed.fields, [
        "sessionId",
        "chunkIndex",
        "totalChunks",
        "filename",
        "mimetype",
        "uploadType",
        "totalSize",
        "chunksize"
      ]);
      metadata._frontendChunkConfig = {
        chunkSize: frontendChunkSize,
        totalSize: frontendTotalSize,
        totalChunks,
        timestamp: Date.now()
      };
      if (!existingFile) {
        const fileRecord = await this.config.database.createFile({
          id: fileId,
          sessionId,
          originalName: filename,
          storedName: this.sanitizeFilename(filename),
          fieldname: parsed.fields.fieldname || "file",
          contentType: mimetype,
          kind,
          size: actualTotalSize,
          chunkSize: actualChunkSize,
          chunkCount: totalChunks,
          uploadType,
          bucket: typeConfig.bucket || uploadType,
          storageProvider: resolveStorageKey(this.config, typeConfig),
          storageRef: `${uploadType}/${sessionId}/${fileId}`,
          isComplete: false,
          metadata
        });
      } else {
        if (existingFile.size !== actualTotalSize || existingFile.chunkSize !== actualChunkSize) {
          await this.config.database.updateFile(fileId, {
            size: actualTotalSize,
            chunkSize: actualChunkSize,
            chunkCount: totalChunks,
            metadata: { ...existingFile.metadata, ...metadata },
            updatedAt: Date.now()
          });
        }
      }
    }
    if (isLastChunk && this.config.database) {
      const currentFile = await this.config.database.getFileById(fileId);
      if (currentFile) {
        if (currentFile.size !== actualTotalSize) {
          await this.config.database.updateFile(fileId, {
            size: actualTotalSize,
            chunkSize: actualChunkSize,
            chunkCount: totalChunks,
            updatedAt: Date.now()
          });
        }
      }
    }
    if (isLastChunk) {
      const storageResult = await storage.finalize(fileId, storageCtx);
      const finalUrl = storageResult.url;
      const finalStorageRef = storageResult.storageRef;
      let finalFileRecord = null;
      if (this.config.database) {
        const fileRecord = await this.config.database.updateFile(fileId, {
          isComplete: true,
          storageRef: finalStorageRef,
          url: finalUrl,
          size: actualTotalSize,
          chunkSize: actualChunkSize,
          updatedAt: Date.now()
        });
        if (fileRecord) {
          finalFileRecord = fileRecord;
          this.config.onUploadComplete?.(fileRecord);
        }
      } else {
        finalFileRecord = {
          id: fileId,
          sessionId,
          originalName: filename,
          url: finalUrl,
          storageRef: finalStorageRef,
          uploadType,
          size: actualTotalSize,
          chunkSize: actualChunkSize,
          isComplete: true,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        this.config.onUploadComplete?.(finalFileRecord);
      }
      let parentFileRecord;
      if (parsed.fields.parentSessionId && this.config.database) {
        const parent = await this.config.database.getFileBySessionId(parsed.fields.parentSessionId);
        if (parent) {
          const quality = parsed.fields.quality || "unknown";
          const currentMetadata = parent.metadata || {};
          const variants = currentMetadata.variants || {};
          variants[quality] = finalUrl;
          parentFileRecord = await this.config.database.updateFile(parent.id, {
            metadata: { ...currentMetadata, variants }
          }) || void 0;
        }
      }
      const result = {
        status: "success",
        message: `File uploaded successfully`,
        fileId,
        url: finalUrl,
        storageRef: finalStorageRef,
        progress: 100,
        metadata: this.extractCustomFields(parsed.fields),
        fields: this.extractCustomFields(parsed.fields),
        file: finalFileRecord,
        fileFields: { [finalFileRecord.fieldname || "file"]: finalFileRecord },
        parentFile: parentFileRecord
      };
      req.fileFields = { [finalFileRecord.fieldname || "file"]: finalFileRecord };
      const autoRespond = typeConfig.autoRespond ?? this.config.autoRespond;
      if (autoRespond) {
        res.status(200);
        res.json(result);
      }
      return result;
    } else {
      const result = {
        status: "success",
        message: `Chunk ${chunkIndex + 1}/${totalChunks} received`,
        progress: Math.round((chunkIndex + 1) / totalChunks * 100),
        chunkIndex,
        totalChunks,
        fields: this.extractCustomFields(parsed.fields)
      };
      res.status(200);
      res.json(result);
      return result;
    }
  }
  /**
   * Helper method to get chunk size from storage
   */
  async getChunkSize(fileId, chunkIndex) {
    return 0;
  }
  /**
   * Handle non-chunked upload (regular file).
   */
  async handleNonChunkedUpload(req, res, parsed, uploadType, storage, typeConfig) {
    if (!parsed.files || parsed.files.length === 0) {
      throw new ValidationError("No files provided", 400);
    }
    const uploadResults = [];
    for (const file of parsed.files) {
      const kind = detectKind(file.mimetype);
      assertKindAllowed(kind, typeConfig);
      assertWithinLimit(file.size, resolveSizeLimit(this.config, typeConfig, kind), "File size");
      const fileId = this.generateFileId();
      const sessionId = this.generateSessionId();
      const storageResult = await storage.putObject(fileId, file.buffer, {
        originalName: file.filename,
        contentType: file.mimetype,
        bucket: typeConfig.bucket || uploadType
      });
      const finalUrl = storageResult.url;
      const finalStorageRef = storageResult.storageRef;
      let finalFileRecord = null;
      if (this.config.database) {
        const fileRecord = await this.config.database.createFile({
          id: fileId,
          sessionId,
          originalName: file.filename,
          storedName: this.sanitizeFilename(file.filename),
          fieldname: file.fieldname || "file",
          contentType: file.mimetype,
          kind,
          size: file.size,
          chunkSize: file.size,
          chunkCount: 1,
          uploadType,
          bucket: typeConfig.bucket || uploadType,
          storageProvider: resolveStorageKey(this.config, typeConfig),
          storageRef: finalStorageRef,
          url: finalUrl,
          isComplete: true,
          // Store custom fields as metadata
          metadata: this.extractCustomFields(parsed.fields)
        });
        finalFileRecord = fileRecord;
        this.config.onUploadComplete?.(fileRecord);
      } else {
        finalFileRecord = {
          id: fileId,
          sessionId,
          originalName: file.filename,
          url: finalUrl,
          storageRef: finalStorageRef,
          uploadType,
          isComplete: true,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        this.config.onUploadComplete?.(finalFileRecord);
      }
      const result = {
        status: "success",
        message: `File uploaded successfully`,
        fileId,
        url: finalUrl,
        storageRef: finalStorageRef,
        progress: 100,
        metadata: this.extractCustomFields(parsed.fields),
        file: finalFileRecord
      };
      uploadResults.push(result);
    }
    const fileFields = {};
    for (const res2 of uploadResults) {
      if (res2.file) {
        const fieldname = res2.file.fieldname;
        if (!fileFields[fieldname]) fileFields[fieldname] = [];
        fileFields[fieldname].push(res2.file);
      }
    }
    const payload = {
      status: "success",
      message: `${uploadResults.length} file(s) uploaded`,
      metadata: uploadResults,
      fields: this.extractCustomFields(parsed.fields),
      files: uploadResults.map((r) => r.file).filter(Boolean),
      fileFields
    };
    req.fileFields = fileFields;
    const autoRespond = typeConfig.autoRespond ?? this.config.autoRespond;
    if (autoRespond) {
      res.status(200);
      res.json(payload);
    }
    return payload;
  }
  /**
   * Build field validation rules from config + custom fields.
   */
  /**
   * Cleanup utility to remove files from storage and database.
   * Useful for error handling in the calling middleware.
   */
  async cleanup(files) {
    const fileArray = Array.isArray(files) ? files : [files];
    if (fileArray.length === 0) return;
    for (const file of fileArray) {
      try {
        const storage = this.config.storages[file.storageProvider || this.config.defaultStorage];
        if (storage) {
          await storage.delete(file.storageRef);
        }
        if (this.config.database) {
          await this.config.database.deleteFiles([file.id]);
        }
      } catch (error) {
        console.error(`[UploadEngine] Cleanup failed for file ${file.id}:`, error);
      }
    }
  }
  buildFieldValidation(typeConfig) {
    const validation = {};
    validation.sessionId = { minLength: 5 };
    validation.chunkIndex = {};
    validation.totalChunks = {};
    validation.filename = { required: true, maxLength: 255 };
    validation.mimetype = { required: true };
    validation.uploadType = { required: true };
    if (typeConfig.customFields) {
      for (const [name, rule] of Object.entries(typeConfig.customFields)) {
        validation[name] = rule;
      }
    }
    return validation;
  }
  /**
   * Build file validation rules from config.
   */
  buildFileValidation(typeConfig) {
    const validation = {};
    validation[".*"] = {
      allowedMimePatterns: typeConfig.allowedKinds.map((kind) => {
        if (kind === "image") return "image/*";
        if (kind === "video") return "video/*";
        if (kind === "audio") return "audio/*";
        if (kind === "document") return "application/*|text/*";
        return "*/*";
      }),
      maxSize: resolveSizeLimit(this.config, typeConfig, "unknown"),
      detectMagicBytes: true
    };
    return validation;
  }
  /**
   * Extract custom fields (non-standard) from parsed fields.
   */
  extractCustomFields(fields, exclude = []) {
    const standardFields = [
      "sessionId",
      "chunkIndex",
      "totalChunks",
      "filename",
      "mimetype",
      "uploadType",
      "fieldname",
      ...exclude
    ];
    const custom = {};
    for (const [key, value] of Object.entries(fields)) {
      if (!standardFields.includes(key)) {
        custom[key] = value;
      }
    }
    return custom;
  }
  async handleError(error, uploadType, res) {
    const err = error instanceof Error ? error : new Error(String(error));
    try {
      this.config.onError?.(err, { uploadType });
    } catch {
    }
    const statusCode = error instanceof ValidationError ? error.statusCode : 500;
    const result = {
      status: "error",
      message: err.message,
      metadata: { code: error instanceof ValidationError ? "VALIDATION_ERROR" : "INTERNAL_ERROR" }
    };
    if (this.config.autoRespond) {
      res.status(statusCode);
      res.json(result);
    }
    return result;
  }
  getContentType(req) {
    const ct = req.headers["content-type"];
    if (typeof ct === "string") return ct;
    if (Array.isArray(ct)) return ct[0] || "";
    return "";
  }
  getUploadType(req) {
    return req.query.uploadType || req.params.uploadType;
  }
  sanitizeFilename(filename) {
    return MultipartParser.sanitizeFilename(filename);
  }
  generateFileId() {
    return `file_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
};

// src/database/InMemoryRepository.ts
var InMemoryRepository = class {
  files = /* @__PURE__ */ new Map();
  chunks = /* @__PURE__ */ new Map();
  // key = `fileId:chunkNumber`
  async createFile(file) {
    const id = file.id || `file_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const record = {
      ...file,
      id,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.files.set(id, record);
    return record;
  }
  async getFileBySessionId(sessionId) {
    for (const file of this.files.values()) {
      if (file.sessionId === sessionId) return file;
    }
    return null;
  }
  async getFileById(id) {
    return this.files.get(id) || null;
  }
  async updateFile(id, patch) {
    const file = this.files.get(id);
    if (!file) return null;
    const updated = {
      ...file,
      ...patch,
      updatedAt: Date.now()
    };
    this.files.set(id, updated);
    return updated;
  }
  async findFiles(query) {
    let results = Array.from(this.files.values());
    if (query.sessionId) {
      results = results.filter((f) => f.sessionId === query.sessionId);
    }
    if (query.sessionIds && query.sessionIds.length > 0) {
      results = results.filter((f) => query.sessionIds.includes(f.sessionId));
    }
    if (query.ids && query.ids.length > 0) {
      results = results.filter((f) => query.ids.includes(f.id));
    }
    if (query.uploadType) {
      results = results.filter((f) => f.uploadType === query.uploadType);
    }
    if (query.userId) {
      results = results.filter((f) => f.userId === query.userId);
    }
    if (query.isComplete !== void 0) {
      results = results.filter((f) => f.isComplete === query.isComplete);
    }
    results.sort((a, b) => b.createdAt - a.createdAt);
    if (query.skip) results = results.slice(query.skip);
    if (query.limit) results = results.slice(0, query.limit);
    return results;
  }
  async deleteFiles(ids) {
    let deleted = 0;
    for (const id of ids) {
      if (this.files.delete(id)) deleted += 1;
    }
    return deleted;
  }
  async createChunk(chunk) {
    const key = `${chunk.fileId}:${chunk.chunkNumber}`;
    this.chunks.set(key, chunk.data);
  }
  async getChunk(fileId, chunkNumber) {
    const key = `${fileId}:${chunkNumber}`;
    return this.chunks.get(key) || null;
  }
  async deleteChunksByFileId(fileId) {
    let deleted = 0;
    const keysToDelete = [];
    for (const key of this.chunks.keys()) {
      if (key.startsWith(`${fileId}:`)) {
        keysToDelete.push(key);
        deleted += 1;
      }
    }
    for (const key of keysToDelete) {
      this.chunks.delete(key);
    }
    return deleted;
  }
  /**
   * Utility for testing: clear all data.
   */
  clear() {
    this.files.clear();
    this.chunks.clear();
  }
  /**
   * Utility for testing: get all files.
   */
  getAllFiles() {
    return Array.from(this.files.values());
  }
};

// src/database/MongooseRepository.ts
import { Schema } from "mongoose";
var MongooseRepository = class _MongooseRepository {
  fileModel;
  chunkModel;
  hooks;
  constructor(options) {
    const {
      mongooseConnection,
      hooks,
      fileModel,
      chunkModel,
      fileSchemaExtensions,
      onFileSchemaInit,
      wrapFileModel,
      onChunkSchemaInit,
      wrapChunkModel
    } = options;
    this.hooks = hooks;
    if (fileModel) {
      this.fileModel = fileModel;
    } else {
      const model = _MongooseRepository.getOrCreateFileModel(mongooseConnection, fileSchemaExtensions, onFileSchemaInit);
      this.fileModel = wrapFileModel ? wrapFileModel(model) : model;
    }
    if (chunkModel) {
      this.chunkModel = chunkModel;
    } else {
      const model = _MongooseRepository.getOrCreateChunkModel(mongooseConnection, onChunkSchemaInit);
      this.chunkModel = wrapChunkModel ? wrapChunkModel(model) : model;
    }
  }
  static getOrCreateFileModel(connection, extensions, onInit) {
    if (connection.models["File"]) return connection.models["File"];
    const schemaDefinition = {
      id: { type: String, required: true, unique: true, index: true },
      sessionId: { type: String, required: true, index: true },
      originalName: String,
      storedName: String,
      fieldname: String,
      contentType: String,
      kind: String,
      size: Number,
      chunkSize: Number,
      chunkCount: Number,
      uploadType: { type: String, index: true },
      bucket: String,
      storageProvider: String,
      storageRef: String,
      url: String,
      thumbnailUrl: String,
      thumbnailRef: String,
      userId: { type: String, index: true },
      isComplete: { type: Boolean, default: false, index: true },
      metadata: Schema.Types.Mixed
    };
    const fileSchema = new Schema(
      { ...schemaDefinition, ...extensions || {} },
      { timestamps: true }
    );
    fileSchema.index({ sessionId: 1, uploadType: 1 });
    fileSchema.index({ createdAt: -1 });
    if (onInit) onInit(fileSchema);
    return connection.model("File", fileSchema, "uploads_files");
  }
  static getOrCreateChunkModel(connection, onInit) {
    if (connection.models["Chunk"]) return connection.models["Chunk"];
    const chunkSchema = new Schema(
      {
        fileId: { type: String, required: true, index: true },
        chunkNumber: { type: Number, required: true },
        data: Buffer
      },
      { timestamps: true }
    );
    chunkSchema.index({ fileId: 1, chunkNumber: 1 }, { unique: true });
    if (onInit) onInit(chunkSchema);
    return connection.model("Chunk", chunkSchema, "uploads_chunks");
  }
  createHookContext() {
    return { timestamp: Date.now() };
  }
  async createFile(file) {
    const ctx = this.createHookContext();
    if (this.hooks?.beforeCreateFile) {
      const result = await this.hooks.beforeCreateFile(file, ctx);
      if (result) return result;
    }
    const doc = await this.fileModel.create({
      ...file,
      id: file.id || `file_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      createdAt: /* @__PURE__ */ new Date(),
      updatedAt: /* @__PURE__ */ new Date()
    });
    const record = this.docToRecord(doc);
    if (this.hooks?.afterCreateFile) {
      return this.hooks.afterCreateFile(record, ctx);
    }
    return record;
  }
  async getFileBySessionId(sessionId) {
    const ctx = this.createHookContext();
    ctx.metadata = { sessionId };
    if (this.hooks?.beforeGetFileBySessionId) {
      const result = await this.hooks.beforeGetFileBySessionId(sessionId, ctx);
      if (result) return result;
    }
    const doc = await this.fileModel.findOne({ sessionId }).lean();
    const file = doc ? this.docToRecord(doc) : null;
    if (this.hooks?.afterGetFileBySessionId) {
      return this.hooks.afterGetFileBySessionId(file, ctx);
    }
    return file;
  }
  async getFileById(id) {
    const ctx = this.createHookContext();
    if (this.hooks?.beforeGetFileById) {
      const result = await this.hooks.beforeGetFileById(id, ctx);
      if (result) return result;
    }
    const doc = await this.fileModel.findOne({ id }).lean();
    const file = doc ? this.docToRecord(doc) : null;
    if (this.hooks?.afterGetFileById) {
      return this.hooks.afterGetFileById(file, ctx);
    }
    return file;
  }
  async updateFile(id, patch) {
    const ctx = this.createHookContext();
    if (this.hooks?.beforeUpdateFile) {
      const result = await this.hooks.beforeUpdateFile(id, patch, ctx);
      if (result) return result;
    }
    const doc = await this.fileModel.findOneAndUpdate(
      { id },
      { ...patch, updatedAt: /* @__PURE__ */ new Date() },
      { new: true }
    ).lean();
    const file = doc ? this.docToRecord(doc) : null;
    if (this.hooks?.afterUpdateFile) {
      return this.hooks.afterUpdateFile(file, ctx);
    }
    return file;
  }
  async findFiles(query) {
    const ctx = this.createHookContext();
    ctx.originalQuery = query;
    if (this.hooks?.beforeFindFiles) {
      const result = await this.hooks.beforeFindFiles(query, ctx);
      if (result) return result;
    }
    const mongoQuery = {};
    if (query.sessionId) mongoQuery.sessionId = query.sessionId;
    if (query.sessionIds) mongoQuery.sessionId = { $in: query.sessionIds };
    if (query.ids) mongoQuery.id = { $in: query.ids };
    if (query.uploadType) mongoQuery.uploadType = query.uploadType;
    if (query.userId) mongoQuery.userId = query.userId;
    if (query.isComplete !== void 0) mongoQuery.isComplete = query.isComplete;
    let q = this.fileModel.find(mongoQuery).lean();
    if (query.skip) q = q.skip(query.skip);
    if (query.limit) q = q.limit(query.limit);
    const docs = await q.sort({ createdAt: -1 });
    const results = docs.map((doc) => this.docToRecord(doc));
    if (this.hooks?.afterFindFiles) {
      return this.hooks.afterFindFiles(results, ctx);
    }
    return results;
  }
  async deleteFiles(ids) {
    const ctx = this.createHookContext();
    if (this.hooks?.beforeDeleteFiles) {
      const result = await this.hooks.beforeDeleteFiles(ids, ctx);
      if (result !== null && result !== void 0) return result;
    }
    const deleteResult = await this.fileModel.deleteMany({ id: { $in: ids } });
    const count = deleteResult.deletedCount || 0;
    if (this.hooks?.afterDeleteFiles) {
      return this.hooks.afterDeleteFiles(count, ctx);
    }
    return count;
  }
  async createChunk(chunk) {
    const ctx = this.createHookContext();
    let chunkToStore = chunk;
    if (this.hooks?.beforeCreateChunk) {
      chunkToStore = await this.hooks.beforeCreateChunk(chunk, ctx);
    }
    await this.chunkModel.create(chunkToStore);
    if (this.hooks?.afterCreateChunk) {
      await this.hooks.afterCreateChunk(chunkToStore, ctx);
    }
  }
  async getChunk(fileId, chunkNumber) {
    const ctx = this.createHookContext();
    if (this.hooks?.beforeGetChunk) {
      const result = await this.hooks.beforeGetChunk(fileId, chunkNumber, ctx);
      if (result) return result;
    }
    const doc = await this.chunkModel.findOne({ fileId, chunkNumber }).lean();
    const data = doc?.data || null;
    if (this.hooks?.afterGetChunk) {
      return this.hooks.afterGetChunk(data, ctx);
    }
    return data;
  }
  async deleteChunksByFileId(fileId) {
    const ctx = this.createHookContext();
    if (this.hooks?.beforeDeleteChunksByFileId) {
      const result = await this.hooks.beforeDeleteChunksByFileId(fileId, ctx);
      if (result !== null && result !== void 0) return result;
    }
    const deleteResult = await this.chunkModel.deleteMany({ fileId });
    const count = deleteResult.deletedCount || 0;
    if (this.hooks?.afterDeleteChunksByFileId) {
      return this.hooks.afterDeleteChunksByFileId(count, ctx);
    }
    return count;
  }
  docToRecord(doc) {
    return {
      id: doc.id,
      sessionId: doc.sessionId,
      originalName: doc.originalName,
      storedName: doc.storedName,
      fieldname: doc.fieldname,
      contentType: doc.contentType,
      kind: doc.kind,
      size: doc.size,
      chunkSize: doc.chunkSize,
      chunkCount: doc.chunkCount,
      uploadType: doc.uploadType,
      bucket: doc.bucket,
      storageProvider: doc.storageProvider,
      storageRef: doc.storageRef,
      url: doc.url,
      thumbnailUrl: doc.thumbnailUrl,
      thumbnailRef: doc.thumbnailRef,
      userId: doc.userId,
      isComplete: doc.isComplete,
      metadata: doc.metadata,
      createdAt: doc.createdAt?.getTime() || Date.now(),
      updatedAt: doc.updatedAt?.getTime() || Date.now()
    };
  }
};

// src/database/SQLRepository.ts
var SQLRepository = class {
  executor;
  filesTable;
  chunksTable;
  autoTimestamps;
  hooks;
  fileIndexes;
  chunkIndexes;
  constructor(options) {
    this.executor = options.executor;
    this.filesTable = options.filesTable || "upload_files";
    this.chunksTable = options.chunksTable || "upload_chunks";
    this.autoTimestamps = options.autoTimestamps ?? true;
    this.hooks = options.hooks;
    this.fileIndexes = options.fileIndexes || [];
    this.chunkIndexes = options.chunkIndexes || [];
  }
  /**
   * Helper to create tables and baseline indexes.
   * Dialect agnostic (standard SQL).
   */
  async createSchema() {
    await this.executor.execute(`
      CREATE TABLE IF NOT EXISTS ${this.filesTable} (
        id VARCHAR(255) PRIMARY KEY,
        session_id VARCHAR(255) NOT NULL,
        original_name VARCHAR(255),
        stored_name VARCHAR(255),
        fieldname VARCHAR(255),
        content_type VARCHAR(255),
        kind VARCHAR(50),
        size BIGINT,
        chunk_size INT,
        chunk_count INT,
        upload_type VARCHAR(100),
        bucket VARCHAR(255),
        storage_provider VARCHAR(255),
        storage_ref TEXT,
        url TEXT,
        thumbnail_url TEXT,
        thumbnail_ref TEXT,
        user_id VARCHAR(255),
        is_complete BOOLEAN DEFAULT FALSE,
        metadata TEXT,
        created_at BIGINT,
        updated_at BIGINT
      )
    `, []);
    await this.executor.execute(`
      CREATE TABLE IF NOT EXISTS ${this.chunksTable} (
        file_id VARCHAR(255) NOT NULL,
        chunk_number INT NOT NULL,
        data BYTEA,
        created_at BIGINT,
        PRIMARY KEY (file_id, chunk_number)
      )
    `, []);
    await this.executor.execute(`CREATE INDEX IF NOT EXISTS idx_${this.filesTable}_session ON ${this.filesTable}(session_id)`, []);
    await this.executor.execute(`CREATE INDEX IF NOT EXISTS idx_${this.filesTable}_type ON ${this.filesTable}(upload_type)`, []);
    await this.executor.execute(`CREATE INDEX IF NOT EXISTS idx_${this.filesTable}_user ON ${this.filesTable}(user_id)`, []);
    for (const cols of this.fileIndexes) {
      const idxName = `idx_${this.filesTable}_${cols.join("_")}`;
      await this.executor.execute(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${this.filesTable}(${cols.join(",")})`, []);
    }
    for (const cols of this.chunkIndexes) {
      const idxName = `idx_${this.chunksTable}_${cols.join("_")}`;
      await this.executor.execute(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${this.chunksTable}(${cols.join(",")})`, []);
    }
  }
  createHookContext() {
    return { timestamp: Date.now() };
  }
  async createFile(file) {
    const now = Date.now();
    const ctx = this.createHookContext();
    if (this.hooks?.beforeCreateFile) {
      const result = await this.hooks.beforeCreateFile(file, ctx);
      if (result) return result;
    }
    const fields = [
      "id",
      "session_id",
      "original_name",
      "stored_name",
      "fieldname",
      "content_type",
      "kind",
      "size",
      "chunk_size",
      "chunk_count",
      "upload_type",
      "bucket",
      "storage_provider",
      "storage_ref",
      "url",
      "thumbnail_url",
      "thumbnail_ref",
      "user_id",
      "is_complete",
      "metadata",
      "created_at",
      "updated_at"
    ];
    const placeholders = fields.map((_, i) => `$${i + 1}`).join(",");
    const sql = `INSERT INTO ${this.filesTable} (${fields.join(",")}) VALUES (${placeholders}) RETURNING *`;
    const id = file.id || `file_${now}_${Math.random().toString(36).substring(2, 9)}`;
    const values = [
      id,
      file.sessionId,
      file.originalName,
      file.storedName,
      file.fieldname,
      file.contentType,
      file.kind,
      file.size,
      file.chunkSize,
      file.chunkCount,
      file.uploadType,
      file.bucket,
      file.storageProvider,
      file.storageRef,
      file.url,
      file.thumbnailUrl,
      file.thumbnailRef,
      file.userId,
      file.isComplete,
      file.metadata ? JSON.stringify(file.metadata) : null,
      now,
      now
    ];
    const rows = await this.executor.query(sql, values);
    const record = this.rowToRecord(rows[0]);
    if (this.hooks?.afterCreateFile) {
      return this.hooks.afterCreateFile(record, ctx);
    }
    return record;
  }
  async getFileBySessionId(sessionId) {
    const sql = `SELECT * FROM ${this.filesTable} WHERE session_id = $1 LIMIT 1`;
    const rows = await this.executor.query(sql, [sessionId]);
    return rows.length ? this.rowToRecord(rows[0]) : null;
  }
  async getFileById(id) {
    const ctx = this.createHookContext();
    if (this.hooks?.beforeGetFileById) {
      const result = await this.hooks.beforeGetFileById(id, ctx);
      if (result) return result;
    }
    const sql = `SELECT * FROM ${this.filesTable} WHERE id = $1`;
    const rows = await this.executor.query(sql, [id]);
    const file = rows.length ? this.rowToRecord(rows[0]) : null;
    if (this.hooks?.afterGetFileById) {
      return this.hooks.afterGetFileById(file, ctx);
    }
    return file;
  }
  async updateFile(id, patch) {
    const ctx = this.createHookContext();
    const updates = [];
    const values = [];
    let paramCount = 1;
    const fieldMap = {
      originalName: "original_name",
      storedName: "stored_name",
      contentType: "content_type",
      chunkSize: "chunk_size",
      chunkCount: "chunk_count",
      uploadType: "upload_type",
      storageProvider: "storage_provider",
      storageRef: "storage_ref",
      thumbnailUrl: "thumbnail_url",
      thumbnailRef: "thumbnail_ref",
      userId: "user_id",
      isComplete: "is_complete"
    };
    for (const [key, value] of Object.entries(patch)) {
      const dbField = fieldMap[key] || key;
      if (value !== void 0) {
        updates.push(`${dbField} = $${paramCount}`);
        values.push(typeof value === "object" ? JSON.stringify(value) : value);
        paramCount += 1;
      }
    }
    if (updates.length === 0) {
      return this.getFileById(id);
    }
    updates.push(`updated_at = $${paramCount}`);
    values.push(Date.now());
    values.push(id);
    const sql = `UPDATE ${this.filesTable} SET ${updates.join(",")} WHERE id = $${paramCount + 1} RETURNING *`;
    const rows = await this.executor.query(sql, values);
    const file = rows.length ? this.rowToRecord(rows[0]) : null;
    if (this.hooks?.afterUpdateFile) {
      return this.hooks.afterUpdateFile(file, ctx);
    }
    return file;
  }
  async findFiles(query) {
    const ctx = this.createHookContext();
    const conditions = [];
    const params = [];
    let paramCount = 1;
    if (query.sessionId) {
      conditions.push(`session_id = $${paramCount}`);
      params.push(query.sessionId);
      paramCount += 1;
    }
    if (query.sessionIds && query.sessionIds.length > 0) {
      const placeholders = query.sessionIds.map(() => `$${paramCount++}`).join(",");
      conditions.push(`session_id IN (${placeholders})`);
      params.push(...query.sessionIds);
    }
    if (query.ids && query.ids.length > 0) {
      const placeholders = query.ids.map(() => `$${paramCount++}`).join(",");
      conditions.push(`id IN (${placeholders})`);
      params.push(...query.ids);
    }
    if (query.uploadType) {
      conditions.push(`upload_type = $${paramCount}`);
      params.push(query.uploadType);
      paramCount += 1;
    }
    if (query.userId) {
      conditions.push(`user_id = $${paramCount}`);
      params.push(query.userId);
      paramCount += 1;
    }
    if (query.isComplete !== void 0) {
      conditions.push(`is_complete = $${paramCount}`);
      params.push(query.isComplete);
      paramCount += 1;
    }
    let sql = `SELECT * FROM ${this.filesTable}`;
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += ` ORDER BY created_at DESC`;
    if (query.limit) {
      sql += ` LIMIT $${paramCount}`;
      params.push(query.limit);
      paramCount += 1;
    }
    if (query.skip) {
      sql += ` OFFSET $${paramCount}`;
      params.push(query.skip);
      paramCount += 1;
    }
    const rows = await this.executor.query(sql, params);
    const results = rows.map((row) => this.rowToRecord(row));
    if (this.hooks?.afterFindFiles) {
      return this.hooks.afterFindFiles(results, ctx);
    }
    return results;
  }
  async deleteFiles(ids) {
    if (ids.length === 0) return 0;
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const sql = `DELETE FROM ${this.filesTable} WHERE id IN (${placeholders})`;
    const result = await this.executor.execute(sql, ids);
    return result.affectedRows || 0;
  }
  async createChunk(chunk) {
    const sql = `INSERT INTO ${this.chunksTable} (file_id, chunk_number, data) VALUES ($1, $2, $3)`;
    await this.executor.execute(sql, [chunk.fileId, chunk.chunkNumber, chunk.data]);
  }
  async getChunk(fileId, chunkNumber) {
    const sql = `SELECT data FROM ${this.chunksTable} WHERE file_id = $1 AND chunk_number = $2`;
    const rows = await this.executor.query(sql, [fileId, chunkNumber]);
    return rows.length ? rows[0].data : null;
  }
  async deleteChunksByFileId(fileId) {
    const sql = `DELETE FROM ${this.chunksTable} WHERE file_id = $1`;
    const result = await this.executor.execute(sql, [fileId]);
    return result.affectedRows || 0;
  }
  rowToRecord(row) {
    return {
      id: row.id,
      sessionId: row.session_id,
      originalName: row.original_name,
      storedName: row.stored_name,
      fieldname: row.fieldname,
      contentType: row.content_type,
      kind: row.kind,
      size: row.size,
      chunkSize: row.chunk_size,
      chunkCount: row.chunk_count,
      uploadType: row.upload_type,
      bucket: row.bucket,
      storageProvider: row.storage_provider,
      storageRef: row.storage_ref,
      url: row.url,
      thumbnailUrl: row.thumbnail_url,
      thumbnailRef: row.thumbnail_ref,
      userId: row.user_id,
      isComplete: row.is_complete,
      metadata: row.metadata ? typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata : void 0,
      createdAt: row.created_at instanceof Date ? row.created_at.getTime() : typeof row.created_at === "number" ? row.created_at : Date.now(),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.getTime() : typeof row.updated_at === "number" ? row.updated_at : Date.now()
    };
  }
};

// src/adapters/storage/LocalDiskStorageAdapter.ts
import { createReadStream, promises as fs } from "fs";
import * as path from "path";
var LocalDiskStorageAdapter = class {
  name = "local-disk";
  rootDir;
  publicBaseUrl;
  openHandles = /* @__PURE__ */ new Map();
  constructor(options) {
    this.rootDir = options.rootDir;
    this.publicBaseUrl = options.publicBaseUrl;
  }
  async ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
  }
  // ✅ FIXED: Include file extension
  partPath(fileId, ctx) {
    const ext = ctx.originalName ? path.extname(ctx.originalName) : "";
    const filename = `${fileId}${ext}.part`;
    return path.join(this.rootDir, ctx.bucket || "default", filename);
  }
  // ✅ FIXED: Include file extension
  finalPath(fileId, ctx) {
    const ext = ctx.originalName ? path.extname(ctx.originalName) : "";
    const filename = `${fileId}${ext}`;
    return path.join(this.rootDir, ctx.bucket || "default", filename);
  }
  async writeChunk(fileId, chunkNumber, data, ctx) {
    const filePath = this.partPath(fileId, ctx);
    let handle = this.openHandles.get(fileId);
    if (!handle) {
      await this.ensureDir(path.dirname(filePath));
      handle = await fs.open(filePath, "w");
      this.openHandles.set(fileId, handle);
    }
    await handle.appendFile(data);
  }
  async finalize(fileId, ctx) {
    const handle = this.openHandles.get(fileId);
    if (handle) {
      await handle.close();
      this.openHandles.delete(fileId);
    }
    const partPath = this.partPath(fileId, ctx);
    const finalPath = this.finalPath(fileId, ctx);
    await this.ensureDir(path.dirname(finalPath));
    try {
      await fs.rename(partPath, finalPath);
    } catch (error) {
      console.error(`Failed to finalize upload: ${partPath} \u2192 ${finalPath}`, error);
      throw error;
    }
    const ref = path.relative(this.rootDir, finalPath);
    return {
      storageRef: ref,
      url: this.publicBaseUrl ? `${this.publicBaseUrl.replace(/\/$/, "")}/${ref}` : void 0
    };
  }
  async putObject(fileId, data, ctx) {
    const finalPath = this.finalPath(fileId, ctx);
    await this.ensureDir(path.dirname(finalPath));
    await fs.writeFile(finalPath, data);
    const ref = path.relative(this.rootDir, finalPath);
    return {
      storageRef: ref,
      url: this.publicBaseUrl ? `${this.publicBaseUrl.replace(/\/$/, "")}/${ref}` : void 0
    };
  }
  async readStream(ref, options) {
    const fullPath = path.join(this.rootDir, ref);
    return createReadStream(fullPath, {
      start: options?.start,
      end: options?.end
    });
  }
  async delete(ref) {
    const fullPath = path.join(this.rootDir, ref);
    await fs.unlink(fullPath).catch(() => {
    });
  }
};

// src/adapters/storage/DatabaseStorageAdapter.ts
import { Readable } from "stream";
var DatabaseStorageAdapter = class {
  name = "database";
  database;
  prefetchCount;
  constructor(options) {
    if (!options.database.createChunk || !options.database.getChunk) {
      throw new Error(
        "[DatabaseStorageAdapter] The provided MetadataRepository does not implement createChunk/getChunk \u2014 DatabaseStorageAdapter cannot be used with it."
      );
    }
    this.database = options.database;
    this.prefetchCount = options.prefetchCount ?? 2;
  }
  async writeChunk(fileId, chunkNumber, data) {
    await this.database.createChunk({ fileId, chunkNumber, data });
  }
  async finalize(fileId) {
    return { storageRef: fileId };
  }
  async putObject(fileId, data, ctx) {
    await this.database.createChunk({ fileId, chunkNumber: 0, data });
    return { storageRef: fileId };
  }
  async readStream(ref, options) {
    const file = await this.database.getFileById(ref);
    if (!file) {
      throw new Error(`[DatabaseStorageAdapter] No file record found for ref "${ref}"`);
    }
    const startByte = options?.start ?? 0;
    const endByte = options?.end ?? file.size - 1;
    const startChunk = Math.floor(startByte / file.chunkSize);
    const endChunk = Math.floor(endByte / file.chunkSize);
    return new ChunkReadStream({
      database: this.database,
      fileId: ref,
      chunkSize: file.chunkSize,
      fileSize: file.size,
      startChunk,
      endChunk,
      startByte,
      endByte,
      prefetchCount: this.prefetchCount
    });
  }
  async delete(ref) {
    if (this.database.deleteChunksByFileId) {
      await this.database.deleteChunksByFileId(ref);
    }
  }
};
var ChunkReadStream = class extends Readable {
  current;
  opts;
  prefetch = /* @__PURE__ */ new Map();
  reading = false;
  constructor(opts) {
    super({ highWaterMark: 1024 * 1024 });
    this.opts = opts;
    this.current = opts.startChunk;
  }
  fetchChunk(chunkNumber) {
    return this.opts.database.getChunk(this.opts.fileId, chunkNumber);
  }
  prefetchAhead() {
    for (let i = 1; i <= this.opts.prefetchCount; i++) {
      const num = this.current + i;
      if (num > this.opts.endChunk || this.prefetch.has(num)) continue;
      this.prefetch.set(num, this.fetchChunk(num));
    }
  }
  chunkActualSize(chunkNumber) {
    const isLast = chunkNumber === Math.ceil(this.opts.fileSize / this.opts.chunkSize) - 1;
    if (!isLast) return this.opts.chunkSize;
    const remainder = this.opts.fileSize % this.opts.chunkSize;
    return remainder > 0 ? remainder : this.opts.chunkSize;
  }
  async _read() {
    if (this.reading) return;
    if (this.current > this.opts.endChunk) {
      this.push(null);
      return;
    }
    this.reading = true;
    try {
      let buffer = this.prefetch.has(this.current) ? await this.prefetch.get(this.current) : await this.fetchChunk(this.current);
      this.prefetch.delete(this.current);
      if (!buffer) {
        this.destroy(new Error(`Missing chunk ${this.current} for file ${this.opts.fileId}`));
        return;
      }
      const isFirst = this.current === Math.floor(this.opts.startByte / this.opts.chunkSize);
      const isLast = this.current === Math.floor(this.opts.endByte / this.opts.chunkSize);
      const actualSize = this.chunkActualSize(this.current);
      let sliceStart = 0;
      let sliceEnd = Math.min(actualSize, buffer.length);
      if (isFirst) sliceStart = this.opts.startByte % this.opts.chunkSize;
      if (isLast) sliceEnd = Math.min(sliceEnd, this.opts.endByte % this.opts.chunkSize + 1);
      this.push(buffer.subarray(sliceStart, sliceEnd));
      this.current += 1;
      this.reading = false;
      if (this.current <= this.opts.endChunk) {
        this.prefetchAhead();
        setImmediate(() => this._read());
      }
    } catch (error) {
      this.reading = false;
      this.destroy(error);
    }
  }
  _destroy(error, callback) {
    this.prefetch.clear();
    callback(error);
  }
};

// src/adapters/storage/S3StorageAdapter.ts
var MIN_S3_PART_SIZE = 5 * 1024 * 1024;
var S3StorageAdapter = class {
  name = "s3";
  options;
  client;
  uploads = /* @__PURE__ */ new Map();
  constructor(options) {
    this.options = options;
    this.minPartSize = options.minPartSize ?? MIN_S3_PART_SIZE;
  }
  minPartSize;
  async getClient() {
    if (this.options.client) return this.options.client;
    if (this.client) return this.client;
    let S3Client;
    try {
      ({ S3Client } = __require("@aws-sdk/client-s3"));
    } catch {
      throw new Error(
        '[upload-media/server] S3StorageAdapter requires "@aws-sdk/client-s3". Install it with: npm install @aws-sdk/client-s3'
      );
    }
    this.client = new S3Client({
      region: this.options.region,
      credentials: this.options.credentials,
      endpoint: this.options.endpoint,
      forcePathStyle: this.options.forcePathStyle
    });
    return this.client;
  }
  buildKey(fileId, ctx) {
    if (this.options.buildKey) return this.options.buildKey(fileId, ctx);
    return `${ctx.bucket}/${fileId}`;
  }
  buildPublicUrl(key) {
    if (this.options.buildPublicUrl) return this.options.buildPublicUrl(this.options.bucket, key);
    if (this.options.endpoint) {
      return `${this.options.endpoint.replace(/\/$/, "")}/${this.options.bucket}/${key}`;
    }
    return `https://${this.options.bucket}.s3.${this.options.region}.amazonaws.com/${key}`;
  }
  async writeChunk(fileId, chunkNumber, data, ctx) {
    const sdk = await this.loadCommands();
    const client = await this.getClient();
    let state = this.uploads.get(fileId);
    if (!state) {
      const key = this.buildKey(fileId, ctx);
      const created = await client.send(
        new sdk.CreateMultipartUploadCommand({
          Bucket: this.options.bucket,
          Key: key,
          ContentType: ctx.contentType
        })
      );
      state = {
        uploadId: created.UploadId,
        key,
        partNumber: 1,
        parts: [],
        buffer: [],
        bufferedBytes: 0
      };
      this.uploads.set(fileId, state);
    }
    state.buffer.push(data);
    state.bufferedBytes += data.length;
    if (state.bufferedBytes >= this.minPartSize) {
      await this.flushPart(state, sdk, client, false);
    }
  }
  async flushPart(state, sdk, client, isFinal) {
    if (state.bufferedBytes === 0 && !isFinal) return;
    if (state.bufferedBytes === 0 && isFinal && state.parts.length > 0) return;
    const body = Buffer.concat(state.buffer, state.bufferedBytes);
    state.buffer = [];
    state.bufferedBytes = 0;
    const result = await client.send(
      new sdk.UploadPartCommand({
        Bucket: this.options.bucket,
        Key: state.key,
        UploadId: state.uploadId,
        PartNumber: state.partNumber,
        Body: body
      })
    );
    state.parts.push({ ETag: result.ETag, PartNumber: state.partNumber });
    state.partNumber += 1;
  }
  async loadCommands() {
    try {
      return __require("@aws-sdk/client-s3");
    } catch {
      throw new Error(
        '[upload-media/server] S3StorageAdapter requires "@aws-sdk/client-s3". Install it with: npm install @aws-sdk/client-s3'
      );
    }
  }
  async finalize(fileId, ctx) {
    const sdk = await this.loadCommands();
    const client = await this.getClient();
    const state = this.uploads.get(fileId);
    if (!state) {
      throw new Error(`[S3StorageAdapter] No active multipart upload found for fileId "${fileId}"`);
    }
    await this.flushPart(state, sdk, client, true);
    await client.send(
      new sdk.CompleteMultipartUploadCommand({
        Bucket: this.options.bucket,
        Key: state.key,
        UploadId: state.uploadId,
        MultipartUpload: { Parts: state.parts }
      })
    );
    this.uploads.delete(fileId);
    return {
      storageRef: state.key,
      url: this.buildPublicUrl(state.key)
    };
  }
  async putObject(fileId, data, ctx) {
    const sdk = await this.loadCommands();
    const client = await this.getClient();
    const key = this.buildKey(fileId, ctx);
    await client.send(
      new sdk.PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: data,
        ContentType: ctx.contentType
      })
    );
    return { storageRef: key, url: this.buildPublicUrl(key) };
  }
  async readStream(ref, options) {
    const sdk = await this.loadCommands();
    const client = await this.getClient();
    const range = options?.start !== void 0 || options?.end !== void 0 ? `bytes=${options?.start ?? 0}-${options?.end ?? ""}` : void 0;
    const result = await client.send(
      new sdk.GetObjectCommand({
        Bucket: this.options.bucket,
        Key: ref,
        Range: range
      })
    );
    return result.Body;
  }
  async delete(ref) {
    const sdk = await this.loadCommands();
    const client = await this.getClient();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: this.options.bucket, Key: ref }));
  }
};

// src/adapters/storage/CloudinaryStorageAdapter.ts
var CloudinaryStorageAdapter = class {
  name = "cloudinary";
  options;
  cloudinary;
  pending = /* @__PURE__ */ new Map();
  constructor(options) {
    this.options = options;
  }
  getSdk() {
    if (this.cloudinary) return this.cloudinary;
    if (this.options.cloudinary) {
      this.cloudinary = this.options.cloudinary;
      return this.cloudinary;
    }
    let cloudinary;
    try {
      cloudinary = __require("cloudinary").v2;
    } catch {
      throw new Error(
        '[upload-media/server] CloudinaryStorageAdapter requires the "cloudinary" package. Install it with: npm install cloudinary'
      );
    }
    cloudinary.config({
      cloud_name: this.options.cloudName,
      api_key: this.options.apiKey,
      api_secret: this.options.apiSecret,
      secure: true
    });
    this.cloudinary = cloudinary;
    return cloudinary;
  }
  resourceTypeFor(contentType) {
    if (contentType.startsWith("image/")) return "image";
    if (contentType.startsWith("video/") || contentType.startsWith("audio/")) return "video";
    return "raw";
  }
  buildPublicId(fileId, ctx) {
    if (this.options.buildPublicId) return this.options.buildPublicId(fileId, ctx);
    const folder = this.options.folder ? `${this.options.folder}/${ctx.bucket}` : ctx.bucket;
    return `${folder}/${fileId}`;
  }
  getOrCreateUpload(fileId, ctx) {
    let entry = this.pending.get(fileId);
    if (entry) return entry;
    const cloudinary = this.getSdk();
    const publicId = this.buildPublicId(fileId, ctx);
    let resolveDone;
    let rejectDone;
    const done = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const stream = cloudinary.uploader.upload_large_stream(
      {
        public_id: publicId,
        resource_type: this.resourceTypeFor(ctx.contentType),
        use_filename: true,
        unique_filename: false,
        chunk_size: 6 * 1024 * 1024
        // Cloudinary's internal chunking granularity
      },
      (error, result) => {
        if (error) rejectDone(error);
        else resolveDone(result);
      }
    );
    entry = { stream, done };
    this.pending.set(fileId, entry);
    return entry;
  }
  async writeChunk(fileId, chunkNumber, data, ctx) {
    const { stream } = this.getOrCreateUpload(fileId, ctx);
    const canContinue = stream.write(data);
    if (!canContinue) {
      await new Promise((resolve) => stream.once("drain", resolve));
    }
  }
  async finalize(fileId) {
    const entry = this.pending.get(fileId);
    if (!entry) {
      throw new Error(`[CloudinaryStorageAdapter] No active upload found for fileId "${fileId}"`);
    }
    entry.stream.end();
    const result = await entry.done;
    this.pending.delete(fileId);
    return {
      storageRef: result.public_id,
      url: result.secure_url
    };
  }
  async putObject(fileId, data, ctx) {
    const cloudinary = this.getSdk();
    const publicId = this.buildPublicId(fileId, ctx);
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          public_id: publicId,
          resource_type: this.resourceTypeFor(ctx.contentType),
          use_filename: true,
          unique_filename: false
        },
        (error, res) => error ? reject(error) : resolve(res)
      );
      stream.end(data);
    });
    return { storageRef: result.public_id, url: result.secure_url };
  }
  async readStream(ref) {
    const cloudinary = this.getSdk();
    const https = __require("https");
    const signedUrl = cloudinary.url(ref, { secure: true, resource_type: "auto" });
    return new Promise((resolve, reject) => {
      https.get(signedUrl, (response) => resolve(response)).on("error", reject);
    });
  }
  async delete(ref) {
    const cloudinary = this.getSdk();
    await cloudinary.uploader.destroy(ref, { resource_type: "auto" });
  }
};

// src/core/FileServingHandler.ts
import { createReadStream as createReadStream2 } from "fs";
import { promises as fs2 } from "fs";
import * as path2 from "path";
import { Readable as Readable2 } from "stream";
var FALLBACK_MIME_TYPES = {
  ".txt": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp"
};
var PREFETCH_COUNT = 2;
var FileServingHandler = class {
  constructor(rootDir, database, cacheMaxAge = "1d") {
    this.rootDir = rootDir;
    this.database = database;
    this.cacheMaxAge = cacheMaxAge;
  }
  rootDir;
  database;
  cacheMaxAge;
  async serveFile(ref, res, startByte, endByte) {
    try {
      const fileId = this.extractFileId(ref);
      if (!this.database) {
        await this.serveFromDisk(ref, res, startByte, endByte);
        return;
      }
      const fileRecord = await this.database.getFileById(fileId);
      if (!fileRecord) {
        res.status(404);
        res.json({ error: "File metadata not found" });
        return;
      }
      switch (fileRecord.storageProvider) {
        case "database":
          await this.serveFromDatabase(fileRecord, res, startByte, endByte);
          break;
        case "local":
        case "disk":
          await this.serveFromDisk(fileRecord.storageRef || fileId, res, startByte, endByte, fileRecord);
          break;
        default:
          if (fileRecord.url && fileRecord.url.startsWith("http")) {
            res.status(302);
            res.header("Location", fileRecord.url);
            res.header("X-Served-By", "upload-media-proxy-redirect");
            res.end();
          } else {
            await this.serveFromDatabase(fileRecord, res, startByte, endByte);
          }
      }
    } catch (error) {
      this.handleError(error, res);
    }
  }
  async serveFromDisk(ref, res, start, end, file) {
    if (!this.rootDir) {
      throw new Error("rootDir is required for local disk serving");
    }
    let fullPath;
    if (ref.includes("/") || ref.includes("\\")) {
      fullPath = path2.join(this.rootDir, ref);
    } else {
      const uploadType = file?.uploadType || "avatar";
      fullPath = path2.join(this.rootDir, uploadType, ref);
      if (!await this.fileExists(fullPath)) {
        fullPath = path2.join(this.rootDir, ref);
      }
    }
    if (!fullPath.startsWith(this.rootDir)) {
      res.status(403);
      res.json({ error: "Forbidden - Path traversal detected" });
      return;
    }
    try {
      const stat = await fs2.stat(fullPath);
      const mimeType = file?.contentType || this.getMimeTypeFromExtension(fullPath);
      this.setHeaders(res, mimeType, stat.size, stat.ino, stat.mtime);
      if (start !== void 0 && end !== void 0) {
        res.status(206);
        res.header("Content-Range", `bytes ${start}-${end}/${stat.size}`);
        res.header("Content-Length", String(end - start + 1));
        const stream = createReadStream2(fullPath, { start, end });
        await res.pipeFrom(stream);
      } else {
        res.status(200);
        res.header("Content-Length", String(stat.size));
        const stream = createReadStream2(fullPath);
        await res.pipeFrom(stream);
      }
    } catch (err) {
      if (err.code === "ENOENT") {
        res.status(404);
        res.json({ error: "File not found on disk" });
      } else {
        throw err;
      }
    }
  }
  async fileExists(filePath) {
    try {
      await fs2.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
  async serveFromDatabase(file, res, start, end) {
    const database = this.database;
    if (!database || !database.getChunk) {
      throw new Error("Database repository does not support chunk serving");
    }
    const chunkSize = file.chunkSize || 2 * 1024 * 1024;
    const fileSize = file.size;
    const startByte = start ?? 0;
    const endByte = end ?? fileSize - 1;
    if (startByte < 0 || startByte >= fileSize || endByte < 0 || endByte >= fileSize || startByte > endByte) {
      console.warn(`\u26A0\uFE0F Invalid range: ${startByte}-${endByte} for file size ${fileSize}`);
      res.status(416);
      res.header("Content-Range", `bytes */${fileSize}`);
      res.end();
      return;
    }
    const totalBytes = endByte - startByte + 1;
    this.setHeaders(res, file.contentType, fileSize, file.id, new Date(file.updatedAt || Date.now()));
    if (start !== void 0 && start > 0) {
      res.status(206);
      res.header("Content-Range", `bytes ${startByte}-${endByte}/${fileSize}`);
    } else {
      res.status(200);
    }
    res.header("Content-Length", String(totalBytes));
    const startChunk = Math.floor(startByte / chunkSize);
    const endChunk = Math.floor(endByte / chunkSize);
    let clientDisconnected = false;
    let streamDestroyed = false;
    const onClientDisconnect = () => {
      clientDisconnected = true;
    };
    const mediaStream = new OptimizedDatabaseMediaStream(
      database,
      file.id,
      startChunk,
      endChunk,
      chunkSize,
      startByte,
      endByte,
      fileSize
    );
    mediaStream.on("error", (error) => {
      streamDestroyed = true;
      if (!clientDisconnected && !res.raw.headersSent && res.raw.writable) {
        try {
          res.status(500).json({ error: "Stream error: " + error.message });
        } catch (e) {
        }
      }
    });
    mediaStream.on("close", () => {
      streamDestroyed = true;
    });
    const rawRes = res.raw;
    rawRes.on("close", onClientDisconnect);
    try {
      if (rawRes.destroyed || rawRes.writableEnded || !rawRes.writable) {
        mediaStream.destroy();
        return;
      }
      await res.pipeFrom(mediaStream);
    } catch (err) {
      if (!rawRes.headersSent) {
        try {
          res.status(500).json({ error: "Error streaming file" });
        } catch (e) {
        }
      }
    } finally {
      rawRes.removeListener("close", onClientDisconnect);
      if (!streamDestroyed) mediaStream.destroy();
    }
  }
  setHeaders(res, mimeType, size, id, mtime) {
    res.header("Content-Type", mimeType);
    res.header("Cache-Control", `public, max-age=${this.getCacheSeconds()}`);
    res.header("ETag", this.generateETag(id, mtime));
    res.header("Accept-Ranges", "bytes");
    res.header("Access-Control-Allow-Origin", "*");
  }
  handleError(error, res) {
    if (error instanceof Error) {
      if (error.message.includes("ENOENT") || error.message.includes("not found")) {
        res.status(404);
        res.json({ error: "File not found" });
      } else if (error.message.includes("Forbidden")) {
        res.status(403);
        res.json({ error: "Forbidden" });
      } else {
        res.status(500);
        res.json({ error: "Internal server error", details: error.message });
      }
    } else {
      res.status(500);
      res.json({ error: "Internal server error" });
    }
  }
  extractFileId(ref) {
    if (!ref) return "";
    const parts = ref.split("/");
    let filename = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    filename = filename.replace(/\.[^/.]+$/, "");
    return filename || ref;
  }
  getMimeTypeFromExtension(fullPath) {
    const ext = path2.extname(fullPath).toLowerCase();
    if (FALLBACK_MIME_TYPES[ext]) {
      return FALLBACK_MIME_TYPES[ext];
    }
    if (ext.match(/^\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i)) {
      return `image/${ext.slice(1).replace("jpg", "jpeg")}`;
    }
    if (ext.match(/^\.(mp4|webm|mov|avi|mkv|flv|wmv|m4v)$/i)) {
      return `video/${ext.slice(1)}`;
    }
    if (ext.match(/^\.(mp3|wav|m4a|aac|flac|ogg)$/i)) {
      return `audio/${ext.slice(1)}`;
    }
    return "application/octet-stream";
  }
  getCacheSeconds() {
    const match = this.cacheMaxAge.match(/(\d+)([mhd]?)/);
    if (!match) return 86400;
    const [, num, unit] = match;
    const value = parseInt(num, 10);
    switch (unit) {
      case "m":
        return value * 60;
      case "h":
        return value * 3600;
      case "d":
        return value * 86400;
      default:
        return value;
    }
  }
  generateETag(inode, mtime) {
    return `"${inode}-${mtime.getTime()}"`;
  }
};
var OptimizedDatabaseMediaStream = class extends Readable2 {
  currentChunk;
  endChunk;
  fileId;
  fileChunkSize;
  startOffset;
  endOffset;
  fileSize;
  totalChunks;
  destroyed = false;
  isReading = false;
  prefetchQueue = /* @__PURE__ */ new Map();
  prefetchInProgress = false;
  database;
  constructor(database, fileId, startChunk, endChunk, fileChunkSize, startOffset, endOffset, fileSize) {
    super({
      highWaterMark: 1024 * 1024,
      objectMode: false,
      autoDestroy: true
    });
    this.database = database;
    this.fileId = fileId;
    this.currentChunk = startChunk;
    this.endChunk = endChunk;
    this.fileChunkSize = fileChunkSize;
    this.startOffset = startOffset;
    this.endOffset = endOffset;
    this.fileSize = fileSize;
    this.totalChunks = Math.ceil(fileSize / fileChunkSize);
  }
  /**
   * Calculate the actual size of a chunk based on file size and chunk size
   * This is the CORRECT way to calculate chunk sizes
   */
  getChunkActualSize(chunkNumber) {
    const isLastChunk = chunkNumber === this.totalChunks - 1;
    if (isLastChunk) {
      const remainder = this.fileSize % this.fileChunkSize;
      return remainder > 0 ? remainder : this.fileChunkSize;
    }
    return this.fileChunkSize;
  }
  /**
   * Get the starting byte of a chunk
   */
  getChunkStartByte(chunkNumber) {
    return chunkNumber * this.fileChunkSize;
  }
  async fetchChunk(chunkNumber) {
    try {
      const chunkData = await this.database.getChunk(this.fileId, chunkNumber);
      if (!chunkData) {
        console.warn(`\u26A0\uFE0F Missing chunk ${chunkNumber} for file ${this.fileId}`);
        return null;
      }
      const buffer = this.normalizeBuffer(chunkData);
      if (!buffer || buffer.length === 0) {
        console.warn(`\u26A0\uFE0F Chunk ${chunkNumber} is empty or invalid`);
        return null;
      }
      const expectedSize = this.getChunkActualSize(chunkNumber);
      if (buffer.length !== expectedSize) {
        console.warn(`\u26A0\uFE0F Chunk ${chunkNumber}: expected ${expectedSize} bytes, got ${buffer.length} bytes`);
      }
      return {
        buffer,
        chunkNumber
      };
    } catch (error) {
      console.error(`Error fetching chunk ${chunkNumber}:`, error);
      return null;
    }
  }
  normalizeBuffer(input) {
    if (!input) return null;
    if (Buffer.isBuffer(input)) {
      return input;
    }
    if (input && typeof input === "object" && input._bsontype === "Binary") {
      if (input.buffer) {
        return Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer);
      }
      try {
        return Buffer.from(input);
      } catch {
        return null;
      }
    }
    if (input && typeof input === "object" && input.buffer) {
      if (Buffer.isBuffer(input.buffer)) {
        return input.buffer;
      }
      if (ArrayBuffer.isView(input.buffer)) {
        return Buffer.from(input.buffer.buffer, input.buffer.byteOffset, input.buffer.byteLength);
      }
      if (input.buffer instanceof ArrayBuffer) {
        return Buffer.from(input.buffer);
      }
      try {
        return Buffer.from(input.buffer);
      } catch {
      }
    }
    if (ArrayBuffer.isView(input)) {
      return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    }
    if (typeof input === "string") {
      return Buffer.from(input, "utf-8");
    }
    try {
      const converted = Buffer.from(input);
      return converted && converted.length > 0 ? converted : null;
    } catch {
      return null;
    }
  }
  prefetchChunks() {
    if (this.prefetchInProgress || this.destroyed) {
      return;
    }
    this.prefetchInProgress = true;
    for (let i = 1; i <= PREFETCH_COUNT; i++) {
      const prefetchChunkNum = this.currentChunk + i;
      if (prefetchChunkNum > this.endChunk) {
        break;
      }
      if (this.prefetchQueue.has(prefetchChunkNum)) {
        continue;
      }
      const prefetchPromise = this.fetchChunk(prefetchChunkNum);
      this.prefetchQueue.set(prefetchChunkNum, prefetchPromise);
      prefetchPromise.finally(() => {
        setTimeout(() => {
          if (this.prefetchQueue.has(prefetchChunkNum)) {
            this.prefetchQueue.delete(prefetchChunkNum);
          }
        }, 2e3);
      });
    }
    this.prefetchInProgress = false;
  }
  async _read() {
    if (this.destroyed || this.isReading) {
      return;
    }
    if (this.currentChunk > this.endChunk) {
      this.push(null);
      this.cleanup();
      return;
    }
    this.isReading = true;
    try {
      let chunkData = null;
      if (this.prefetchQueue.has(this.currentChunk)) {
        chunkData = await this.prefetchQueue.get(this.currentChunk);
        this.prefetchQueue.delete(this.currentChunk);
      } else {
        chunkData = await this.fetchChunk(this.currentChunk);
      }
      if (!chunkData) {
        this.isReading = false;
        this.destroy(new Error(`Missing chunk ${this.currentChunk} for file ${this.fileId}`));
        return;
      }
      if (this.destroyed) {
        chunkData = null;
        this.isReading = false;
        return;
      }
      const chunkStartByte = this.getChunkStartByte(this.currentChunk);
      const actualChunkSize = this.getChunkActualSize(this.currentChunk);
      let sliceStart = 0;
      let sliceEnd = actualChunkSize;
      if (this.currentChunk === Math.floor(this.startOffset / this.fileChunkSize)) {
        sliceStart = this.startOffset - chunkStartByte;
      }
      if (this.currentChunk === Math.floor(this.endOffset / this.fileChunkSize)) {
        const endInChunk = this.endOffset - chunkStartByte;
        sliceEnd = endInChunk + 1;
      }
      sliceStart = Math.max(0, Math.min(sliceStart, chunkData.buffer.length));
      sliceEnd = Math.max(0, Math.min(sliceEnd, chunkData.buffer.length));
      if (sliceStart >= sliceEnd) {
        this.currentChunk++;
        this.isReading = false;
        setImmediate(() => this._read());
        return;
      }
      const dataToSend = chunkData.buffer.subarray(sliceStart, sliceEnd);
      const canPush = this.push(dataToSend);
      chunkData = null;
      this.currentChunk++;
      this.isReading = false;
      if (!this.destroyed && this.currentChunk <= this.endChunk) {
        this.prefetchChunks();
      }
      if (canPush && this.currentChunk <= this.endChunk && !this.destroyed) {
        setImmediate(() => this._read());
      }
    } catch (error) {
      this.isReading = false;
      if (!this.destroyed) {
        this.destroy(error);
      }
    }
  }
  cleanup() {
    if (this.prefetchQueue.size > 0) {
      this.prefetchQueue.clear();
    }
    this.prefetchQueue = /* @__PURE__ */ new Map();
  }
  _destroy(error, callback) {
    this.destroyed = true;
    this.isReading = false;
    this.cleanup();
    callback(error);
  }
};

// src/adapters/frameworks/ExpressAdapter.ts
var ExpressNormalizedRequest = class {
  headers;
  stream;
  query;
  params;
  user;
  raw;
  fields;
  files;
  constructor(req) {
    this.raw = req;
    this.headers = req.headers;
    this.stream = req;
    this.query = req.query;
    this.params = req.params;
    this.user = req.user;
  }
};
var ExpressNormalizedResponse = class {
  res;
  constructor(res) {
    this.res = res;
  }
  status(code) {
    this.res.status(code);
    return this;
  }
  json(body) {
    this.res.json(body);
  }
  header(name, value) {
    this.res.header(name, value);
    return this;
  }
  async pipeFrom(stream) {
    return new Promise((resolve, reject) => {
      stream.on("error", reject);
      this.res.on("error", reject);
      this.res.on("finish", resolve);
      stream.pipe(this.res);
    });
  }
  end() {
    this.res.end();
  }
  get raw() {
    return this.res;
  }
};
var createExpressAdapter = () => ({
  name: "express",
  wrap(handler) {
    return async (req, res, next) => {
      const normalizedReq = new ExpressNormalizedRequest(req);
      const normalizedRes = new ExpressNormalizedResponse(res);
      try {
        const result = await handler(normalizedReq, normalizedRes);
        if (result !== void 0 && !res.headersSent) {
          res.json(result);
        }
        if (result && typeof result.onBackground === "function") {
          res.on("finish", () => {
            result.onBackground().catch((err) => console.error("[ExpressAdapter] Background task error:", err));
          });
        }
      } catch (error) {
        console.error("[ExpressAdapter] Handler error:", error);
        if (!res.headersSent) {
          res.status(500).json({ error: error.message });
        }
      }
    };
  }
});
function createExpressFileServingMiddleware(config, legacyOptions) {
  const isLegacy = typeof config === "string";
  const rootDir = isLegacy ? config : config.rootDir;
  const options = isLegacy ? legacyOptions : config;
  const handler = new FileServingHandler(
    rootDir,
    // Might be undefined, handled inserveFile
    options?.database,
    options?.cacheMaxAge
  );
  const pathPrefix = options?.pathPrefix;
  return (req, res, next) => {
    if (pathPrefix && !req.path.startsWith(pathPrefix)) {
      return next();
    }
    const ref = pathPrefix ? req.path.slice(pathPrefix.length).replace(/^\//, "") : req.path.replace(/^\//, "");
    if (!ref || ref === "/") {
      return next();
    }
    const rangeHeader = req.headers.range;
    let startByte;
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        startByte = parseInt(match[1], 10);
      }
    }
    const normalizedRes = new ExpressNormalizedResponse(res);
    handler.serveFile(ref, normalizedRes, startByte);
  };
}

// src/adapters/frameworks/KoaAdapter.ts
var KoaNormalizedRequest = class {
  headers;
  stream;
  query;
  params;
  user;
  raw;
  fields;
  files;
  fileFields;
  constructor(ctx) {
    this.raw = ctx;
    this.headers = ctx.headers;
    this.stream = ctx.req;
    this.query = ctx.query;
    this.params = ctx.params;
    this.user = ctx.state?.user;
  }
};
var KoaNormalizedResponse = class {
  ctx;
  constructor(ctx) {
    this.ctx = ctx;
  }
  status(code) {
    this.ctx.status = code;
    return this;
  }
  json(body) {
    this.ctx.body = body;
    this.ctx.type = "application/json";
  }
  header(name, value) {
    this.ctx.set(name, value);
    return this;
  }
  async pipeFrom(stream) {
    this.ctx.type = "application/octet-stream";
    return new Promise((resolve, reject) => {
      stream.on("error", reject);
      stream.on("end", resolve);
      this.ctx.body = stream;
    });
  }
  end() {
  }
  get raw() {
    return this.ctx;
  }
};
var createKoaAdapter = () => ({
  name: "koa",
  wrap(handler) {
    return async (ctx) => {
      const normalizedReq = new KoaNormalizedRequest(ctx);
      const normalizedRes = new KoaNormalizedResponse(ctx);
      try {
        const result = await handler(normalizedReq, normalizedRes);
        if (result !== void 0 && !ctx.headerSent) {
          ctx.body = result;
          ctx.type = "application/json";
        }
        if (result && typeof result.onBackground === "function") {
          result.onBackground().catch((err) => console.error("[KoaAdapter] Background task error:", err));
        }
      } catch (error) {
        console.error("[KoaAdapter] Handler error:", error);
        if (!ctx.headerSent) {
          ctx.status = 500;
          ctx.body = { error: error.message };
        }
      }
    };
  }
});
function createKoaFileServingMiddleware(config, legacyOptions) {
  const isLegacy = typeof config === "string";
  const rootDir = isLegacy ? config : config.rootDir;
  const options = isLegacy ? legacyOptions : config;
  const handler = new FileServingHandler(
    rootDir,
    options?.database,
    options?.cacheMaxAge
  );
  const pathPrefix = options?.pathPrefix;
  return async (ctx, next) => {
    if (pathPrefix && !ctx.path.startsWith(pathPrefix)) {
      return next();
    }
    const ref = pathPrefix ? ctx.path.slice(pathPrefix.length).replace(/^\//, "") : ctx.path.replace(/^\//, "");
    if (!ref || ref === "/") {
      return next();
    }
    const rangeHeader = ctx.headers.range;
    let startByte;
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        startByte = parseInt(match[1], 10);
      }
    }
    const normalizedRes = new KoaNormalizedResponse(ctx);
    await handler.serveFile(ref, normalizedRes, startByte);
  };
}

// src/adapters/frameworks/FastifyAdapter.ts
var FastifyNormalizedRequest = class {
  headers;
  stream;
  query;
  params;
  user;
  raw;
  fields;
  files;
  fileFields;
  constructor(req) {
    this.raw = req;
    this.headers = req.headers;
    this.stream = req.raw;
    this.query = req.query;
    this.params = req.params;
    this.user = req.user;
  }
};
var FastifyNormalizedResponse = class {
  reply;
  statusCode = 200;
  constructor(reply) {
    this.reply = reply;
  }
  status(code) {
    this.statusCode = code;
    this.reply.status(code);
    return this;
  }
  json(body) {
    this.reply.code(this.statusCode).send(body);
  }
  header(name, value) {
    this.reply.header(name, value);
    return this;
  }
  async pipeFrom(stream) {
    this.reply.type("application/octet-stream");
    return this.reply.send(stream);
  }
  end() {
  }
  get raw() {
    return this.reply;
  }
};
var createFastifyAdapter = () => ({
  name: "fastify",
  wrap(handler) {
    return async (req, reply) => {
      const normalizedReq = new FastifyNormalizedRequest(req);
      const normalizedRes = new FastifyNormalizedResponse(reply);
      try {
        const result = await handler(normalizedReq, normalizedRes);
        if (result !== void 0 && !reply.sent) {
          reply.send(result);
        }
        if (result && typeof result.onBackground === "function") {
          result.onBackground().catch((err) => console.error("[FastifyAdapter] Background task error:", err));
        }
      } catch (error) {
        console.error("[FastifyAdapter] Handler error:", error);
        if (!reply.sent) {
          reply.status(500).send({ error: error.message });
        }
      }
    };
  }
});
function createFastifyFileServingPlugin(config, legacyOptions) {
  const isLegacy = typeof config === "string";
  const rootDir = isLegacy ? config : config.rootDir;
  const options = isLegacy ? legacyOptions : config;
  const handler = new FileServingHandler(
    rootDir,
    options?.database,
    options?.cacheMaxAge
  );
  const pathPrefix = options?.pathPrefix || "/";
  return async (fastify) => {
    fastify.get(`${pathPrefix === "/" ? "" : pathPrefix}/*`, async (req, reply) => {
      const ref = req.params["*"];
      const rangeHeader = req.headers.range;
      let startByte;
      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          startByte = parseInt(match[1], 10);
        }
      }
      const normalizedRes = new FastifyNormalizedResponse(reply);
      await handler.serveFile(ref, normalizedRes, startByte);
    });
  };
}

// src/adapters/frameworks/HonoAdapter.ts
var HonoNormalizedRequest = class {
  headers;
  stream;
  query;
  params;
  user;
  raw;
  fields;
  files;
  constructor(ctx) {
    this.raw = ctx;
    this.headers = {};
    ctx.req.raw.headers.forEach((v, k) => {
      this.headers[k.toLowerCase()] = v;
    });
    this.stream = ctx.req.raw.body;
    this.query = ctx.req.query();
    this.params = ctx.req.param();
    this.user = ctx.user;
  }
};
var HonoNormalizedResponse = class {
  ctx;
  statusCode = 200;
  constructor(ctx) {
    this.ctx = ctx;
  }
  status(code) {
    this.statusCode = code;
    return this;
  }
  json(body) {
    this.ctx.json(body, this.statusCode);
  }
  header(name, value) {
    this.ctx.header(name, value);
    return this;
  }
  async pipeFrom(stream) {
    this.ctx.header("Content-Type", "application/octet-stream");
    return new Promise((resolve, reject) => {
      stream.on("error", reject);
      stream.on("end", resolve);
      stream.pipe(this.ctx.raw.res);
    });
  }
  end() {
    this.ctx.body = null;
  }
  get raw() {
    return this.ctx;
  }
};
var createHonoAdapter = () => ({
  name: "hono",
  wrap(handler) {
    return async (ctx) => {
      const normalizedReq = new HonoNormalizedRequest(ctx);
      const normalizedRes = new HonoNormalizedResponse(ctx);
      try {
        const result = await handler(normalizedReq, normalizedRes);
        if (result !== void 0 && !ctx.headerSent) {
          ctx.body = result;
          ctx.type = "application/json";
        }
        if (result && typeof result.onBackground === "function") {
          result.onBackground().catch((err) => console.error("[HonoAdapter] Background task error:", err));
        }
      } catch (error) {
        ctx.status(500).json({ error: error instanceof Error ? error.message : "Internal error" });
      }
    };
  }
});
function createHonoFileServingMiddleware(config, legacyOptions) {
  const isLegacy = typeof config === "string";
  const rootDir = isLegacy ? config : config.rootDir;
  const options = isLegacy ? legacyOptions : config;
  const handler = new FileServingHandler(
    rootDir,
    options?.database,
    options?.cacheMaxAge
  );
  const pathPrefix = options?.pathPrefix;
  return async (ctx, next) => {
    if (pathPrefix && !ctx.req.path.startsWith(pathPrefix)) {
      return next();
    }
    const ref = pathPrefix ? ctx.req.path.slice(pathPrefix.length).replace(/^\//, "") : ctx.req.path.replace(/^\//, "");
    if (!ref || ref === "/") {
      return next();
    }
    const rangeHeader = ctx.req.header("range");
    let startByte;
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        startByte = parseInt(match[1], 10);
      }
    }
    const normalizedRes = new HonoNormalizedResponse(ctx);
    await handler.serveFile(ref, normalizedRes, startByte);
  };
}

// src/adapters/frameworks/H3Adapter.ts
import path3 from "path";
import fs3 from "fs/promises";
var setResponseStatus = (event, code) => {
  event.node.res.statusCode = code;
};
var setResponseHeader = (event, name, value) => {
  event.node.res.setHeader(name, value);
};
var setHeader = setResponseHeader;
var send = (event, body) => {
  event.node.res.end(body);
};
var createError = ({
  statusCode,
  statusMessage
}) => {
  const err = new Error(statusMessage);
  err.statusCode = statusCode;
  return err;
};
function getQuery(event) {
  const url = new URL(
    event.node.req.url || "",
    "http://localhost"
  );
  return Object.fromEntries(
    url.searchParams.entries()
  );
}
var H3NormalizedRequest = class {
  headers;
  stream;
  query;
  params;
  user;
  raw;
  fields;
  files;
  fileFields;
  constructor(event) {
    this.raw = event;
    this.headers = event.node.req.headers;
    this.stream = event.node.req;
    this.query = getQuery(event);
    this.params = event.context.params || {};
    this.user = event.context.user;
  }
};
var H3NormalizedResponse = class {
  event;
  statusCode = 200;
  constructor(event) {
    this.event = event;
  }
  status(code) {
    this.statusCode = code;
    setResponseStatus(
      this.event,
      code
    );
    return this;
  }
  json(body) {
    setResponseHeader(
      this.event,
      "Content-Type",
      "application/json"
    );
    send(
      this.event,
      JSON.stringify(body)
    );
  }
  header(name, value) {
    setResponseHeader(
      this.event,
      name,
      value
    );
    return this;
  }
  end() {
    send(this.event, "");
  }
  async pipeFrom(stream) {
    setResponseHeader(
      this.event,
      "Content-Type",
      "application/octet-stream"
    );
    return new Promise(
      (resolve, reject) => {
        stream.on(
          "error",
          reject
        );
        stream.on(
          "end",
          resolve
        );
        stream.pipe(
          this.event.node.res
        );
      }
    );
  }
  get raw() {
    return this.event;
  }
};
var createH3Adapter = () => ({
  name: "h3",
  wrap(handler) {
    return async (event) => {
      const normalizedReq = new H3NormalizedRequest(
        event
      );
      const normalizedRes = new H3NormalizedResponse(
        event
      );
      try {
        const result = await handler(
          normalizedReq,
          normalizedRes
        );
        if (result !== void 0) {
          normalizedRes.json(result);
        }
        if (result && typeof result.onBackground === "function") {
          event.node.res.on?.("finish", () => {
            result.onBackground().catch((err) => console.error("[H3Adapter] Background task error:", err));
          });
        }
      } catch (error) {
        console.error(
          "[H3Adapter] Handler error:",
          error
        );
        setResponseStatus(
          event,
          500
        );
        send(
          event,
          JSON.stringify({
            error: error instanceof Error ? error.message : "Internal error"
          })
        );
      }
    };
  }
});
var CreateH3FileServingHandler = class {
  constructor(rootDir, database, cacheMaxAge = "1d") {
    this.rootDir = rootDir;
    this.database = database;
    this.cacheMaxAge = cacheMaxAge;
  }
  rootDir;
  database;
  cacheMaxAge;
  async serveFile(ref, event) {
    const fullPath = path3.resolve(
      this.rootDir,
      ref
    );
    if (!fullPath.startsWith(
      path3.resolve(
        this.rootDir
      )
    )) {
      throw createError({
        statusCode: 403,
        statusMessage: "Forbidden"
      });
    }
    try {
      const stat = await fs3.stat(
        fullPath
      );
      if (!stat.isFile()) {
        throw createError({
          statusCode: 404,
          statusMessage: "Not found"
        });
      }
      let mimeType = "application/octet-stream";
      if (this.database) {
        try {
          const fileId = this.extractFileId(
            ref
          );
          const fileRecord = await this.database.getFileById(
            fileId
          );
          if (fileRecord?.contentType) {
            mimeType = fileRecord.contentType;
          }
        } catch (error) {
          console.warn(
            "[H3FileServing] DB lookup failed:",
            error
          );
        }
      }
      const fileBuffer = await fs3.readFile(
        fullPath
      );
      setHeader(
        event,
        "Content-Type",
        mimeType
      );
      setHeader(
        event,
        "Content-Length",
        String(
          stat.size
        )
      );
      setHeader(
        event,
        "Cache-Control",
        `public, max-age=${this.getCacheSeconds()}`
      );
      return fileBuffer;
    } catch (error) {
      console.error(
        "[H3FileServing] Error:",
        error
      );
      if (error?.statusCode === 403 || error?.statusCode === 404) {
        throw error;
      }
      throw createError({
        statusCode: 500,
        statusMessage: "Internal server error"
      });
    }
  }
  extractFileId(ref) {
    return path3.basename(ref).replace(
      /\.[^/.]+$/,
      ""
    );
  }
  getCacheSeconds() {
    const match = this.cacheMaxAge.match(
      /^(\d+)([mhd]?)$/
    );
    if (!match) {
      return 86400;
    }
    const [
      ,
      num,
      unit
    ] = match;
    const value = parseInt(
      num,
      10
    );
    switch (unit) {
      case "m":
        return value * 60;
      case "h":
        return value * 3600;
      case "d":
        return value * 86400;
      default:
        return value;
    }
  }
};

// src/adapters/frameworks/ElysiaAdapter.ts
import { Readable as Readable3 } from "stream";
function toNodeReadable(stream) {
  if (!stream) {
    return Readable3.from([]);
  }
  return Readable3.fromWeb(stream);
}
var ElysiaNormalizedRequest = class {
  headers;
  stream;
  query;
  params;
  user;
  raw;
  fields;
  files;
  fileFields;
  constructor(ctx) {
    this.raw = ctx;
    this.headers = Object.fromEntries(
      ctx.request.headers.entries()
    );
    this.stream = toNodeReadable(
      ctx.request.body
    );
    this.query = Object.fromEntries(
      new URL(ctx.request.url).searchParams
    );
    this.params = ctx.params ?? {};
    this.user = ctx.user;
  }
};
var ElysiaNormalizedResponse = class {
  statusCode = 200;
  headers = {};
  body = null;
  status(code) {
    this.statusCode = code;
    return this;
  }
  json(body) {
    this.headers["Content-Type"] = "application/json";
    this.body = JSON.stringify(body);
  }
  header(name, value) {
    this.headers[name] = value;
    return this;
  }
  async pipeFrom(stream) {
    this.headers["Content-Type"] = this.headers["Content-Type"] || "application/octet-stream";
    return new Promise((resolve, reject) => {
      const chunks = [];
      stream.on(
        "data",
        (chunk) => chunks.push(chunk)
      );
      stream.on("error", reject);
      stream.on("end", () => {
        this.body = Buffer.concat(chunks);
        resolve();
      });
    });
  }
  end() {
  }
  get raw() {
    return new Response(this.body, {
      status: this.statusCode,
      headers: this.headers
    });
  }
};
var createElysiaAdapter = () => ({
  name: "elysia",
  wrap(handler) {
    return async (ctx) => {
      const normalizedReq = new ElysiaNormalizedRequest(ctx);
      const normalizedRes = new ElysiaNormalizedResponse();
      try {
        const result = await handler(
          normalizedReq,
          normalizedRes
        );
        if (result !== void 0) {
          normalizedRes.json(result);
        }
        if (result && typeof result.onBackground === "function") {
          result.onBackground().catch((err) => console.error("[ElysiaAdapter] Background task error:", err));
        }
        return normalizedRes.raw;
      } catch (error) {
        console.error(
          "[ElysiaAdapter] Handler error:",
          error
        );
        return new Response(
          JSON.stringify({
            error: error instanceof Error ? error.message : "Internal error"
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }
    };
  }
});
function createElysiaFileServingHandler(config, legacyOptions) {
  const isLegacy = typeof config === "string";
  const rootDir = isLegacy ? config : config.rootDir;
  const options = isLegacy ? legacyOptions : config;
  const handler = new FileServingHandler(
    rootDir,
    options?.database,
    options?.cacheMaxAge
  );
  const pathPrefix = options?.pathPrefix;
  return async (ctx) => {
    const pathname = new URL(
      ctx.request.url
    ).pathname;
    if (pathPrefix && !pathname.startsWith(pathPrefix)) {
      return;
    }
    const ref = pathPrefix ? pathname.slice(pathPrefix.length).replace(/^\//, "") : pathname.replace(/^\//, "");
    if (!ref || ref === "/") return;
    const rangeHeader = ctx.request.headers.get("range");
    let startByte;
    let endByte;
    if (rangeHeader) {
      const match = rangeHeader.match(
        /bytes=(\d+)-(\d*)/
      );
      if (match) {
        startByte = parseInt(match[1], 10);
        if (match[2]) {
          endByte = parseInt(match[2], 10);
        }
      }
    }
    const normalizedRes = new ElysiaNormalizedResponse();
    await handler.serveFile(
      ref,
      normalizedRes,
      startByte,
      endByte
    );
    return normalizedRes.raw;
  };
}

// src/adapters/frameworks/NextjsAdapter.ts
var NextjsNormalizedRequest = class {
  headers;
  stream;
  query;
  params;
  user;
  raw;
  fields;
  files;
  fileFields;
  constructor(req) {
    this.raw = req;
    this.headers = Object.fromEntries(
      req.headers
    );
    this.stream = req.body;
    this.query = Object.fromEntries(
      new URL(req.url).searchParams
    );
    this.params = {};
    this.user = req.user;
  }
};
var NextjsNormalizedResponse = class {
  statusCode = 200;
  headers = {};
  body = null;
  status(code) {
    this.statusCode = code;
    return this;
  }
  json(body) {
    this.body = JSON.stringify(body);
    this.headers["Content-Type"] = "application/json";
  }
  header(name, value) {
    this.headers[name] = value;
    return this;
  }
  async pipeFrom(stream) {
    this.headers["Content-Type"] = this.headers["Content-Type"] || "application/octet-stream";
    return new Promise((resolve, reject) => {
      const chunks = [];
      stream.on(
        "data",
        (chunk) => chunks.push(chunk)
      );
      stream.on("error", reject);
      stream.on("end", () => {
        this.body = Buffer.concat(chunks);
        resolve();
      });
    });
  }
  end() {
  }
  toResponse() {
    return new Response(this.body, {
      status: this.statusCode,
      headers: this.headers
    });
  }
  get raw() {
    return this.toResponse();
  }
};
var createNextjsAdapter = () => ({
  name: "nextjs",
  wrap(handler) {
    return async (req) => {
      const normalizedReq = new NextjsNormalizedRequest(req);
      const normalizedRes = new NextjsNormalizedResponse();
      try {
        const result = await handler(
          normalizedReq,
          normalizedRes
        );
        if (result !== void 0) {
          normalizedRes.json(result);
        }
        if (result && typeof result.onBackground === "function") {
          result.onBackground().catch((err) => console.error("[NextjsAdapter] Background task error:", err));
        }
        return normalizedRes.raw;
      } catch (error) {
        console.error(
          "[NextjsAdapter] Handler error:",
          error
        );
        return new Response(
          JSON.stringify({
            error: error instanceof Error ? error.message : "Internal error"
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }
    };
  }
});
var CreateNextjsFileServingHandler = class {
  constructor(config) {
    this.config = config;
  }
  config;
  async serveFile(ref) {
    const config = this.config;
    const isString = typeof config === "string";
    const rootDir = isString ? config : config.rootDir;
    const database = isString ? void 0 : config.database;
    const cacheMaxAge = isString ? "1d" : config.cacheMaxAge || "1d";
    const handler = new FileServingHandler(
      rootDir,
      database,
      cacheMaxAge
    );
    const bridge = new NextjsNormalizedResponse();
    await handler.serveFile(
      ref,
      bridge
    );
    return bridge.raw;
  }
};

// src/hooks/examples.ts
function createRedisCacheHooks(redis) {
  return {
    beforeGetFileById: async (id, ctx) => {
      try {
        const cached = await redis.get(`file:${id}`);
        if (cached) return JSON.parse(cached);
      } catch (error) {
        console.error("[CacheHook] Failed to get from cache:", error);
      }
      return null;
    },
    afterGetFileById: async (file, ctx) => {
      if (!file) return null;
      try {
        await redis.set(`file:${file.id}`, JSON.stringify(file), "EX", 300);
      } catch (error) {
        console.error("[CacheHook] Failed to set cache:", error);
      }
      return file;
    },
    beforeGetFileBySessionId: async (sessionId, ctx) => {
      try {
        const cached = await redis.get(`session:${sessionId}`);
        if (cached) return JSON.parse(cached);
      } catch {
      }
      return null;
    },
    afterGetFileBySessionId: async (file, ctx) => {
      if (!file) return null;
      try {
        await redis.set(`session:${file.sessionId}`, JSON.stringify(file), "EX", 300);
      } catch {
      }
      return file;
    },
    beforeFindFiles: async (query, ctx) => {
      try {
        const key = `files:${JSON.stringify(query)}`;
        const cached = await redis.get(key);
        if (cached) return JSON.parse(cached);
      } catch {
      }
      return null;
    },
    afterFindFiles: async (results, ctx) => {
      try {
        const key = `files:${JSON.stringify(ctx.originalQuery)}`;
        await redis.set(key, JSON.stringify(results), "EX", 600);
      } catch {
      }
      return results;
    },
    afterDeleteFiles: async (count, ctx) => {
      try {
        await redis.del(...await redis.keys("file:*"));
        await redis.del(...await redis.keys("session:*"));
        await redis.del(...await redis.keys("files:*"));
      } catch {
      }
      return count;
    }
  };
}
function createLoggingHooks(logger = console) {
  return {
    afterCreateFile: async (file, ctx) => {
      logger.info(`[FileCreated] ${file.id} (${file.originalName}, ${file.size} bytes)`);
      return file;
    },
    afterGetFileById: async (file, ctx) => {
      if (file) {
        logger.debug(`[FileQueried] ${file.id}`);
      }
      return file;
    },
    afterFindFiles: async (results, ctx) => {
      logger.debug(`[FilesQueried] Found ${results.length} files`);
      return results;
    },
    afterUpdateFile: async (file, ctx) => {
      if (file) {
        logger.info(`[FileUpdated] ${file.id}`);
      }
      return file;
    },
    afterDeleteFiles: async (count, ctx) => {
      logger.info(`[FilesDeleted] ${count} files removed`);
      return count;
    }
  };
}
function createStorageLoggingHooks(logger = console) {
  return {
    afterWriteChunk: async (fileId, chunkNumber, ctx) => {
      logger.debug(`[ChunkWritten] ${fileId} chunk ${chunkNumber}`);
    },
    afterFinalize: async (result, ctx) => {
      logger.info(`[FileFinalized] \u2192 ${result.storageRef}`);
      return result;
    },
    afterDelete: async (ctx) => {
      logger.debug(`[FileDeleted]`);
    }
  };
}
function createValidationHooks() {
  return {
    beforeCreateFile: async (file, ctx) => {
      if (file.size < 0) {
        throw new Error("File size cannot be negative");
      }
      if (file.chunkCount < 1) {
        throw new Error("File must have at least 1 chunk");
      }
      if (file.originalName.length > 255) {
        throw new Error("Filename too long (max 255 characters)");
      }
      return null;
    },
    beforeUpdateFile: async (id, patch, ctx) => {
      if (patch.size && patch.size < 0) {
        throw new Error("Size cannot be negative");
      }
      return null;
    }
  };
}
function createAutoCleanupHooks(maxAgeMs = 7 * 24 * 60 * 60 * 1e3) {
  return {
    afterFindFiles: async (results, ctx) => {
      const now = Date.now();
      const toDelete = results.filter((f) => {
        const age = now - f.createdAt;
        return !f.isComplete && age > maxAgeMs;
      });
      if (toDelete.length > 0) {
        console.info(`[AutoCleanup] Removing ${toDelete.length} stale uploads`);
      }
      return results;
    }
  };
}
function createMetricsHooks(metrics) {
  return {
    afterCreateFile: async (file, ctx) => {
      metrics.increment("files.created");
      metrics.histogram("file.size.bytes", file.size);
      return file;
    },
    afterFindFiles: async (results, ctx) => {
      metrics.increment("files.queried");
      metrics.histogram("files.query.count", results.length);
      return results;
    },
    afterDeleteFiles: async (count, ctx) => {
      metrics.increment("files.deleted", count);
      return count;
    }
  };
}
function createTransformationHooks() {
  return {
    afterGetFileById: async (file, ctx) => {
      if (!file) return null;
      return {
        ...file,
        // Add computed fields
        ageSeconds: Math.floor((Date.now() - file.createdAt) / 1e3),
        isExpired: Date.now() - file.createdAt > 30 * 24 * 60 * 60 * 1e3,
        // 30 days
        progress: file.isComplete ? 100 : file.chunkCount > 0 ? 0 : 0
        // Placeholder
      };
    }
  };
}
function chainHooks(...hooks) {
  const filteredHooks = hooks.filter((h) => h !== void 0);
  return {
    beforeCreateFile: async (file, ctx) => {
      for (const hook of filteredHooks) {
        if (hook.beforeCreateFile) {
          const result = await hook.beforeCreateFile(file, ctx);
          if (result) return result;
        }
      }
      return null;
    },
    afterCreateFile: async (file, ctx) => {
      let current = file;
      for (const hook of filteredHooks) {
        if (hook.afterCreateFile) {
          current = await hook.afterCreateFile(current, ctx);
        }
      }
      return current;
    },
    beforeGetFileById: async (id, ctx) => {
      for (const hook of filteredHooks) {
        if (hook.beforeGetFileById) {
          const result = await hook.beforeGetFileById(id, ctx);
          if (result) return result;
        }
      }
      return null;
    },
    afterGetFileById: async (file, ctx) => {
      let current = file;
      for (const hook of filteredHooks) {
        if (hook.afterGetFileById) {
          current = await hook.afterGetFileById(current, ctx);
        }
      }
      return current;
    },
    beforeGetFileBySessionId: async (sessionId, ctx) => {
      for (const hook of filteredHooks) {
        if (hook.beforeGetFileBySessionId) {
          const result = await hook.beforeGetFileBySessionId(sessionId, ctx);
          if (result) return result;
        }
      }
      return null;
    },
    afterGetFileBySessionId: async (file, ctx) => {
      let current = file;
      for (const hook of filteredHooks) {
        if (hook.afterGetFileBySessionId) {
          current = await hook.afterGetFileBySessionId(current, ctx);
        }
      }
      return current;
    },
    beforeUpdateFile: async (id, patch, ctx) => {
      for (const hook of filteredHooks) {
        if (hook.beforeUpdateFile) {
          const result = await hook.beforeUpdateFile(id, patch, ctx);
          if (result) return result;
        }
      }
      return null;
    },
    afterUpdateFile: async (file, ctx) => {
      let current = file;
      for (const hook of filteredHooks) {
        if (hook.afterUpdateFile) {
          current = await hook.afterUpdateFile(current, ctx);
        }
      }
      return current;
    },
    beforeFindFiles: async (query, ctx) => {
      for (const hook of filteredHooks) {
        if (hook.beforeFindFiles) {
          const result = await hook.beforeFindFiles(query, ctx);
          if (result) return result;
        }
      }
      return null;
    },
    afterFindFiles: async (results, ctx) => {
      let current = results;
      for (const hook of filteredHooks) {
        if (hook.afterFindFiles) {
          current = await hook.afterFindFiles(current, ctx);
        }
      }
      return current;
    },
    beforeDeleteFiles: async (ids, ctx) => {
      for (const hook of filteredHooks) {
        if (hook.beforeDeleteFiles) {
          const result = await hook.beforeDeleteFiles(ids, ctx);
          if (result !== null && result !== void 0) return result;
        }
      }
      return null;
    },
    afterDeleteFiles: async (count, ctx) => {
      let current = count;
      for (const hook of filteredHooks) {
        if (hook.afterDeleteFiles) {
          current = await hook.afterDeleteFiles(current, ctx);
        }
      }
      return current;
    }
  };
}

// src/utils/encryption.ts
function fromBase64Url(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  str += "=".repeat((4 - str.length % 4) % 4);
  return Buffer.from(str, "base64");
}
function isNodeJs() {
  return typeof global !== "undefined" && !globalThis.Bun;
}
function isBun() {
  return !!globalThis.Bun;
}
function decryptQueryString(token) {
  const key = deriveKey();
  const raw = fromBase64Url(token);
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  if (isNodeJs()) {
    return decryptNodeJs(encrypted, tag, iv, key);
  } else if (isBun()) {
    return decryptBun(encrypted, tag, iv, key);
  } else {
    throw new Error("[decrypt] Unable to determine runtime (Node.js or Bun)");
  }
}
function deriveKey() {
  const keyString = (process.env.VITE_QUERY_STRING_KEY || "").padEnd(32, "0").slice(0, 32);
  if (isNodeJs()) {
    const crypto = __require("crypto");
    return crypto.createHash("sha256").update(keyString).digest();
  } else if (isBun()) {
    const crypto = __require("crypto");
    const hash = crypto.createHash("sha256");
    hash.update(keyString);
    return hash.digest();
  }
  throw new Error("[deriveKey] Unable to determine runtime");
}
function decryptNodeJs(encrypted, tag, iv, key) {
  const crypto = __require("crypto");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}
function decryptBun(encrypted, tag, iv, key) {
  try {
    const crypto = __require("crypto");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    throw new Error("[decryptBun] crypto.createDecipheriv not available in this Bun version");
  }
}
function hashString(input) {
  if (isNodeJs()) {
    const crypto = __require("crypto");
    return crypto.createHash("sha256").update(input).digest("hex");
  } else if (isBun()) {
    const crypto = __require("crypto");
    const hash = crypto.createHash("sha256");
    hash.update(input);
    return hash.digest("hex");
  }
  throw new Error("[hashString] Unable to determine runtime");
}
function generateRandomString(byteLength = 32) {
  if (isNodeJs()) {
    const crypto = __require("crypto");
    return crypto.randomBytes(byteLength).toString("hex");
  } else if (isBun()) {
    const crypto = __require("crypto");
    return crypto.randomBytes(byteLength).toString("hex");
  }
  throw new Error("[generateRandomString] Unable to determine runtime");
}
function signData(data, secret) {
  if (isNodeJs()) {
    const crypto = __require("crypto");
    return crypto.createHmac("sha256", secret).update(data).digest("hex");
  } else if (isBun()) {
    const crypto = __require("crypto");
    return crypto.createHmac("sha256", secret).update(data).digest("hex");
  }
  throw new Error("[signData] Unable to determine runtime");
}
function verifySignature(data, secret, signature) {
  const expected = signData(data, secret);
  return expected === signature;
}
export {
  AUTH_CACHE_TTL_SECONDS,
  CACHE_PREFIXES,
  CloudinaryStorageAdapter,
  ConfigValidationError,
  CreateH3FileServingHandler,
  CreateNextjsFileServingHandler,
  DEFAULT_CACHE_TTL_SECONDS,
  DEFAULT_CHUNK_SIZES,
  DEFAULT_CLEANUP_BATCH_SIZE,
  DEFAULT_CLEANUP_INTERVAL_MS,
  DEFAULT_QUALITY,
  DEFAULT_SIZE_LIMITS,
  DEFAULT_STALE_UPLOAD_RETENTION_MS,
  DatabaseStorageAdapter,
  InMemoryRepository,
  LocalDiskStorageAdapter,
  MongooseRepository,
  MultipartParser,
  QUALITY_MAPPINGS,
  S3StorageAdapter,
  SQLRepository,
  SUPPORTED_MIME_TYPES,
  THUMBNAIL_CHUNK_SIZE,
  THUMBNAIL_DIMENSIONS,
  THUMBNAIL_SIZE_LIMIT,
  UploadEngine,
  ValidationError,
  assertKindAllowed,
  assertRequiredFields,
  assertWithinLimit,
  chainHooks,
  createAutoCleanupHooks,
  createElysiaAdapter,
  createElysiaFileServingHandler,
  createExpressAdapter,
  createExpressFileServingMiddleware,
  createFastifyAdapter,
  createFastifyFileServingPlugin,
  createH3Adapter,
  createHonoAdapter,
  createHonoFileServingMiddleware,
  createKoaAdapter,
  createKoaFileServingMiddleware,
  createLoggingHooks,
  createMetricsHooks,
  createNextjsAdapter,
  createRedisCacheHooks,
  createStorageLoggingHooks,
  createTransformationHooks,
  createValidationHooks,
  decryptQueryString,
  detectKind,
  generateRandomString,
  getMimeKind,
  hashString,
  parseBooleanFlag,
  parseIntSafe,
  parseJsonSafe,
  resolveChunkLimit,
  resolveSizeLimit,
  resolveStorageKey,
  resolveUploadConfig,
  signData,
  verifySignature
};
