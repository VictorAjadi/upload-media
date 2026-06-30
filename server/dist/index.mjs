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

// src/core/UploadEngine.ts
import * as fs2 from "fs";
import * as path2 from "path";

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
          const safeChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          chunks.push(safeChunk);
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
            const fileRule = options.fileValidation?.[fieldname];
            const wildcardRule = options.fileValidation?.[".*"];
            if (fileRule?.detectMagicBytes || wildcardRule?.detectMagicBytes) {
              fileInfo.detectedMimetype = this.detectMimeType(buffer);
            }
            if (fileRule) {
              this.validateFile(fieldname, fileInfo, buffer, fileRule);
            } else if (wildcardRule) {
              this.validateFile(fieldname, fileInfo, buffer, wildcardRule);
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
    const detectedIsUnknown = !info.detectedMimetype || info.detectedMimetype === "application/octet-stream";
    const mimeToCheck = detectedIsUnknown ? info.mimetype : info.detectedMimetype;
    if (rule.allowedMimeTypes && rule.allowedMimeTypes.length > 0) {
      const detectedMatch = info.detectedMimetype && rule.allowedMimeTypes.includes(info.detectedMimetype);
      const originalMatch = rule.allowedMimeTypes.includes(info.mimetype);
      if (!detectedMatch && !originalMatch) {
        throw new Error(
          `File "${fieldname}" has unsupported type "${mimeToCheck}". Allowed: ${rule.allowedMimeTypes.join(", ")}`
        );
      }
    }
    if (rule.allowedMimePatterns && rule.allowedMimePatterns.length > 0) {
      const patterns = rule.allowedMimePatterns;
      const detectedMatch = info.detectedMimetype && !detectedIsUnknown && this.matchesMimePattern(info.detectedMimetype, patterns);
      const originalMatch = this.matchesMimePattern(info.mimetype, patterns);
      if (!detectedMatch && !originalMatch) {
        throw new Error(
          `File "${fieldname}" type "${mimeToCheck}" does not match allowed patterns: ${patterns.join(", ")}`
        );
      }
    }
    if (rule.filename?.maxLength && info.filename.length > rule.filename.maxLength) {
      throw new Error(`Filename is too long (max ${rule.filename.maxLength} characters)`);
    }
  }
  /**
   * Helper method to check if a MIME type matches any of the given patterns
   */
  static matchesMimePattern(mimeType, patterns) {
    return patterns.some((pattern) => {
      const subPatterns = pattern.split("|");
      return subPatterns.some((singlePattern) => {
        const regexPattern = singlePattern.trim().replace(/\*/g, ".*").replace(/\?/g, ".");
        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(mimeType);
      });
    });
  }
  /**
   * Detect MIME type from magic bytes.
   * Returns detected MIME type or 'application/octet-stream' if unknown.
   * 
   * This method now handles both Buffer and Uint8Array inputs safely.
   */
  static detectMimeType(buffer) {
    const safeBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (safeBuffer.length < 4) return "application/octet-stream";
    for (const [_, { signature, mimeType }] of Object.entries(MAGIC_BYTES)) {
      if (safeBuffer.length >= signature.length) {
        const prefix = safeBuffer.subarray(0, signature.length);
        if (prefix.equals(signature)) {
          return mimeType;
        }
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

// src/core/Mediaprocessor.ts
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
function ensureBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return Buffer.from(input);
}
function normaliseFormat(format) {
  return format.replace(/^(video|audio|image)\//, "");
}
function loadSharp() {
  try {
    return __require("sharp");
  } catch {
    return null;
  }
}
function loadFluentFfmpeg() {
  try {
    return __require("fluent-ffmpeg");
  } catch {
    return null;
  }
}
function resolveFfmpegPath(customPath) {
  if (customPath) return customPath;
  try {
    const p = __require("@ffmpeg-installer/ffmpeg").path;
    if (p) return p;
  } catch {
  }
  try {
    const p = __require("ffmpeg-static");
    if (p) return p;
  } catch {
  }
  try {
    const cmd = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    __require("child_process").execSync(`"${cmd}" -version`, { stdio: "ignore" });
    return cmd;
  } catch {
  }
  console.warn("[MediaProcessor] FFmpeg not found \u2014 video/audio processing disabled.");
  return null;
}
function resolveFfprobePath(customPath, ffmpegPath) {
  if (customPath) return customPath;
  try {
    const p = __require("@ffprobe-installer/ffprobe").path;
    if (p) return p;
  } catch {
  }
  if (ffmpegPath) {
    const probe = path.join(
      path.dirname(ffmpegPath),
      process.platform === "win32" ? "ffprobe.exe" : "ffprobe"
    );
    try {
      __require("child_process").execSync(`"${probe}" -version`, { stdio: "ignore" });
      return probe;
    } catch {
    }
  }
  return process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
}
var RESOLUTION_MAP = {
  "2160p": { width: 3840, height: 2160 },
  "4k": { width: 3840, height: 2160 },
  "1440p": { width: 2560, height: 1440 },
  "2k": { width: 2560, height: 1440 },
  "1080p": { width: 1920, height: 1080 },
  "720p": { width: 1280, height: 720 },
  "540p": { width: 960, height: 540 },
  "480p": { width: 854, height: 480 },
  "360p": { width: 640, height: 360 },
  "240p": { width: 426, height: 240 },
  "144p": { width: 256, height: 144 }
};
function parseResolution(res) {
  if (!res) return void 0;
  return RESOLUTION_MAP[res.toLowerCase()];
}
var RESOLUTION_ENCODING_LADDER = {
  "2160p": { crf: 17, videoBitrate: "14000k", maxBitrate: "21000k", bufsize: "28000k", audioBitrate: "192k", preset: "slow" },
  "4k": { crf: 17, videoBitrate: "14000k", maxBitrate: "21000k", bufsize: "28000k", audioBitrate: "192k", preset: "slow" },
  "1440p": { crf: 19, videoBitrate: "7500k", maxBitrate: "11250k", bufsize: "15000k", audioBitrate: "192k", preset: "medium" },
  "2k": { crf: 19, videoBitrate: "7500k", maxBitrate: "11250k", bufsize: "15000k", audioBitrate: "192k", preset: "medium" },
  "1080p": { crf: 20, videoBitrate: "4000k", maxBitrate: "6000k", bufsize: "8000k", audioBitrate: "160k", preset: "medium" },
  "720p": { crf: 21, videoBitrate: "2200k", maxBitrate: "3300k", bufsize: "4400k", audioBitrate: "128k", preset: "fast" },
  "540p": { crf: 23, videoBitrate: "1300k", maxBitrate: "1950k", bufsize: "2600k", audioBitrate: "128k", preset: "fast" },
  "480p": { crf: 24, videoBitrate: "900k", maxBitrate: "1350k", bufsize: "1800k", audioBitrate: "96k", preset: "faster" },
  "360p": { crf: 26, videoBitrate: "650k", maxBitrate: "975k", bufsize: "1300k", audioBitrate: "96k", preset: "faster" },
  "240p": { crf: 28, videoBitrate: "400k", maxBitrate: "600k", bufsize: "800k", audioBitrate: "64k", preset: "veryfast" },
  "144p": { crf: 30, videoBitrate: "200k", maxBitrate: "300k", bufsize: "400k", audioBitrate: "64k", preset: "veryfast" }
};
var X264_PRESET_ORDER = [
  "veryslow",
  "slower",
  "slow",
  "medium",
  "fast",
  "faster",
  "veryfast",
  "superfast",
  "ultrafast"
];
function resolveRuntimePreset(basePreset, cpuCount, concurrentVariants, speedProfile) {
  const baseIndex = X264_PRESET_ORDER.indexOf(basePreset);
  const safeBaseIndex = baseIndex === -1 ? X264_PRESET_ORDER.indexOf("medium") : baseIndex;
  const threadsPerProcess = Math.max(1, Math.floor(cpuCount / Math.max(1, concurrentVariants)));
  let step = 0;
  if (threadsPerProcess <= 1) step += 1;
  if (speedProfile === "speed") step += 2;
  else if (speedProfile === "quality") step -= 1;
  const targetIndex = Math.min(
    X264_PRESET_ORDER.length - 1,
    Math.max(0, safeBaseIndex + step)
  );
  return X264_PRESET_ORDER[targetIndex];
}
function getLadderTier(resolution) {
  if (!resolution) return null;
  return RESOLUTION_ENCODING_LADDER[resolution.toLowerCase()] ?? null;
}
function resolveVideoQuality(cfg, quality) {
  if (cfg) {
    const dims = parseResolution(cfg.resolution);
    const ladder = getLadderTier(cfg.resolution);
    return {
      width: cfg.width ?? dims?.width,
      height: cfg.height ?? dims?.height,
      videoBitrate: cfg.videoBitrate ?? ladder?.videoBitrate ?? resolveNamedVideoBitrate(quality),
      audioBitrate: cfg.audioBitrate ?? ladder?.audioBitrate ?? resolveNamedAudioBitrate(quality),
      crf: cfg.crf ?? ladder?.crf ?? resolveCrf(quality),
      preset: cfg.preset ?? ladder?.preset ?? resolveNamedPreset(quality)
    };
  }
  return {
    videoBitrate: resolveNamedVideoBitrate(quality),
    audioBitrate: resolveNamedAudioBitrate(quality),
    crf: resolveCrf(quality),
    preset: resolveNamedPreset(quality)
  };
}
function resolveNamedVideoBitrate(quality) {
  if (typeof quality === "number") return `${quality}k`;
  switch (quality) {
    case "high":
      return "4500k";
    case "low":
      return "800k";
    default:
      return "2500k";
  }
}
function resolveNamedAudioBitrate(quality) {
  switch (quality) {
    case "high":
      return "192k";
    case "low":
      return "96k";
    default:
      return "128k";
  }
}
function resolveNamedPreset(quality) {
  switch (quality) {
    case "high":
      return "medium";
    case "low":
      return "veryfast";
    default:
      return "faster";
  }
}
function resolveCrf(quality) {
  if (typeof quality === "number") {
    return Math.round(51 - Math.min(100, Math.max(0, quality)) / 100 * 51);
  }
  switch (quality) {
    case "high":
      return 18;
    case "low":
      return 28;
    default:
      return 23;
  }
}
var TIER_SOURCE_BITRATE_FACTOR = {
  "2160p": 0.85,
  "4k": 0.85,
  "1440p": 0.75,
  "2k": 0.75,
  "1080p": 0.65,
  "720p": 0.55,
  "540p": 0.5,
  "480p": 0.45,
  "360p": 0.4,
  "240p": 0.35,
  "144p": 0.3
};
var DEFAULT_TIER_SOURCE_FACTOR = 0.55;
var MIN_VIDEO_BITRATE_KBPS = 80;
function kbpsToString(kbps) {
  return `${Math.max(MIN_VIDEO_BITRATE_KBPS, Math.round(kbps))}k`;
}
function parseKbps(bitrateStr) {
  if (!bitrateStr) return null;
  const n = parseInt(bitrateStr, 10);
  return isNaN(n) ? null : n;
}
function clampTierToSourceBitrate(resolution, ladderVideoBitrateKbps, sourceBitrateKbps) {
  if (!sourceBitrateKbps || sourceBitrateKbps <= 0) return null;
  const factor = (resolution && TIER_SOURCE_BITRATE_FACTOR[resolution.toLowerCase()]) ?? DEFAULT_TIER_SOURCE_FACTOR;
  const sourceDerivedTarget = sourceBitrateKbps * (factor === "" ? 0 : factor);
  if (sourceDerivedTarget >= ladderVideoBitrateKbps) return null;
  const videoBitrateKbps = Math.max(MIN_VIDEO_BITRATE_KBPS, sourceDerivedTarget);
  const maxBitrateKbps = videoBitrateKbps * 1.5;
  const bufsizeKbps = videoBitrateKbps * 2;
  return {
    videoBitrate: kbpsToString(videoBitrateKbps),
    maxBitrate: kbpsToString(maxBitrateKbps),
    bufsize: kbpsToString(bufsizeKbps)
  };
}
function resolveMaxBitrate(cfg, avgBitrate) {
  if (cfg?.resolution) {
    const tier = getLadderTier(cfg.resolution);
    if (tier) return tier.maxBitrate;
  }
  const n = parseInt(avgBitrate, 10);
  return isNaN(n) ? avgBitrate : `${Math.round(n * 1.5)}k`;
}
function resolveBufsize(cfg, avgBitrate) {
  if (cfg?.resolution) {
    const tier = getLadderTier(cfg.resolution);
    if (tier) return tier.bufsize;
  }
  const n = parseInt(avgBitrate, 10);
  return isNaN(n) ? avgBitrate : `${n * 2}k`;
}
function resolveImageQuality(cfg, quality) {
  if (cfg?.quality !== void 0) return resolveImageQualityValue(cfg.quality);
  return resolveImageQualityValue(quality);
}
function resolveImageQualityValue(quality) {
  if (typeof quality === "number") return Math.max(1, Math.min(100, quality));
  switch (quality) {
    case "high":
      return 90;
    case "low":
      return 60;
    default:
      return 80;
  }
}
function resolveImageDimensions(cfg, quality) {
  if (cfg) {
    if (cfg.width || cfg.height) return { width: cfg.width, height: cfg.height };
    if (cfg.maxDimension) return { width: cfg.maxDimension, height: cfg.maxDimension };
    if (cfg.resolution) {
      const dims = parseResolution(cfg.resolution);
      if (dims) return { width: dims.width, height: dims.height };
    }
  }
  switch (quality) {
    case "high":
      return { width: 1920, height: 1080 };
    case "low":
      return { width: 800, height: 600 };
    default:
      return { width: 1280, height: 720 };
  }
}
function resolveAudioBitrate(cfg, quality) {
  if (cfg?.audioBitrate) return cfg.audioBitrate;
  if (typeof quality === "number") return `${Math.max(64, Math.min(320, quality * 3))}k`;
  switch (quality) {
    case "high":
      return "320k";
    case "low":
      return "96k";
    default:
      return "192k";
  }
}
var Semaphore = class {
  queue = [];
  count;
  constructor(max) {
    this.count = max;
  }
  acquire() {
    if (this.count > 0) {
      this.count--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    if (this.queue.length > 0) this.queue.shift()();
    else this.count++;
  }
};
var TempFileManager = class {
  files = /* @__PURE__ */ new Set();
  dir;
  sessionId;
  constructor(dir) {
    this.dir = dir;
    this.sessionId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    fs.mkdirSync(dir, { recursive: true });
  }
  /**
   * Create a temp path for a given logical variant id (e.g. "480p", "720p",
   * "thumb", "1080p_thumb"). Calling this twice with the same id returns the
   * SAME path (idempotent) rather than minting a new random name — that's
   * what allows a variant's encode output and its thumbnail to be named
   * predictably and reused instead of regenerated.
   */
  create(ext, variantId = "tmp") {
    const safeId = variantId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const name = `upload_proc_${this.sessionId}_${safeId}${ext}`;
    const fullPath = path.join(this.dir, name);
    this.files.add(fullPath);
    return fullPath;
  }
  register(filePath) {
    this.files.add(filePath);
  }
  async cleanup(retries = 3, delayMs = 500) {
    await new Promise((r) => setTimeout(r, delayMs));
    const remaining = /* @__PURE__ */ new Set();
    for (const f of this.files) {
      let deleted = false;
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          if (fs.existsSync(f)) await fs.promises.unlink(f);
          deleted = true;
          break;
        } catch {
          if (attempt < retries - 1)
            await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
        }
      }
      if (!deleted) remaining.add(f);
    }
    this.files.clear();
    if (remaining.size > 0)
      console.warn("[MediaProcessor] Failed to clean up temp files:", [...remaining]);
  }
};
async function assembleChunksToDisk(chunks, outputPath) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outputPath);
    ws.on("error", reject);
    ws.on("finish", resolve);
    let i = 0;
    function writeNext() {
      if (i >= chunks.length) {
        ws.end();
        return;
      }
      const chunk = chunks[i++];
      const ok = ws.write(chunk);
      if (ok) writeNext();
      else ws.once("drain", writeNext);
    }
    writeNext();
  });
}
function buildScaleFilter(width, height) {
  if (!width && !height) return null;
  if (width && height) {
    return [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=fast_bilinear`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      `scale=trunc(iw/2)*2:trunc(ih/2)*2`
    ].join(",");
  }
  if (width) return `scale=${width}:-2:flags=fast_bilinear`;
  if (height) return `scale=-2:${height}:flags=fast_bilinear`;
  return null;
}
var HW_ENCODERS_PRIORITY = ["h264_nvenc", "h264_qsv", "h264_amf"];
var _hwProbeCache = null;
var _hwProbeInflight = null;
function extraArgsFor(enc) {
  if (enc === "h264_nvenc") {
    return ["-rc:v vbr", "-cq 23", "-b_ref_mode middle"];
  }
  if (enc === "h264_qsv") {
    return ["-global_quality 23", "-look_ahead 1"];
  }
  return ["-rc cqp", "-qp_i 23", "-qp_p 25"];
}
function extraArgsForAbr(enc) {
  if (enc === "h264_nvenc") {
    return ["-rc:v cbr"];
  }
  if (enc === "h264_qsv") {
    return ["-look_ahead 0"];
  }
  return ["-rc cbr"];
}
function canActuallyEncode(ffmpegBin, encoder, extraArgs) {
  try {
    const { execSync } = __require("child_process");
    const argsStr = extraArgs.join(" ");
    execSync(
      `"${ffmpegBin}" -hide_banner -loglevel error -f lavfi -i color=c=black:s=64x64:d=0.1 -frames:v 1 -c:v ${encoder} ${argsStr} -f null -`,
      { stdio: "ignore", timeout: 5e3 }
    );
    return true;
  } catch {
    return false;
  }
}
async function probeHardwareEncoder(ffmpegBin, _ffmpegModule) {
  if (_hwProbeCache) return _hwProbeCache;
  if (_hwProbeInflight) return _hwProbeInflight;
  _hwProbeInflight = (async () => {
    try {
      const { execSync } = __require("child_process");
      const out = execSync(`"${ffmpegBin}" -encoders -v quiet`, {
        encoding: "utf8",
        timeout: 1e4
      });
      for (const enc of HW_ENCODERS_PRIORITY) {
        if (!out.includes(enc)) continue;
        const extraArgs = extraArgsFor(enc);
        const works = canActuallyEncode(ffmpegBin, enc, extraArgs);
        if (!works) {
          console.log(`[MediaProcessor] ${enc} is compiled in but not functional on this machine (driver/GPU unavailable) \u2014 skipping.`);
          continue;
        }
        console.log(`[MediaProcessor] Hardware encoder detected and verified working: ${enc}`);
        _hwProbeCache = { encoder: enc, extraArgs };
        return _hwProbeCache;
      }
    } catch (e) {
      console.warn("[MediaProcessor] HW encoder probe failed, using libx264:", e.message);
    }
    console.log("[MediaProcessor] No working hardware encoder found \u2014 using libx264.");
    _hwProbeCache = { encoder: null, extraArgs: [] };
    return _hwProbeCache;
  })();
  const result = await _hwProbeInflight;
  _hwProbeInflight = null;
  return result;
}
function buildAudioFilterChain(bitrateStr) {
  const k = parseInt(bitrateStr, 10);
  const fcut = k <= 64 ? 14e3 : k <= 128 ? 17e3 : 2e4;
  return [
    "aresample=48000",
    "highpass=f=80:poles=2",
    `lowpass=f=${fcut}:poles=2`
  ].join(",");
}
function resolveVbrQuality(bitrateStr) {
  const k = parseInt(bitrateStr, 10);
  if (k >= 320) return 0;
  if (k >= 256) return 1;
  if (k >= 192) return 2;
  if (k >= 160) return 3;
  if (k >= 128) return 4;
  if (k >= 96) return 5;
  if (k >= 64) return 7;
  return 9;
}
var MediaProcessor = class {
  tempDir;
  ffmpegPath;
  ffprobePath;
  semaphore;
  timeoutMs;
  speedProfile;
  hwProbePromise = null;
  _sharp = void 0;
  _sharpLoaded = false;
  _ffmpeg = void 0;
  _ffmpegLoaded = false;
  constructor(options = {}) {
    this.tempDir = options.tempDir ?? path.join(os.tmpdir(), "upload-media-proc");
    const cpus2 = os.cpus().length;
    const maxConcurrency = options.maxConcurrency ?? Math.min(4, Math.max(1, cpus2));
    this.ffmpegPath = resolveFfmpegPath(options.ffmpegPath);
    this.ffprobePath = resolveFfprobePath(options.ffprobePath, this.ffmpegPath);
    this.semaphore = new Semaphore(maxConcurrency);
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1e3;
    this.speedProfile = options.speedProfile ?? "balanced";
    fs.mkdirSync(this.tempDir, { recursive: true });
    if (this.ffmpegPath) {
      this.hwProbePromise = probeHardwareEncoder(this.ffmpegPath, null);
    }
  }
  get sharp() {
    if (!this._sharpLoaded) {
      this._sharp = loadSharp();
      this._sharpLoaded = true;
    }
    return this._sharp;
  }
  get ffmpeg() {
    if (!this._ffmpegLoaded) {
      this._ffmpeg = loadFluentFfmpeg();
      this._ffmpegLoaded = true;
      if (this._ffmpeg && this.ffmpegPath) this._ffmpeg.setFfmpegPath(this.ffmpegPath);
      if (this._ffmpeg && this.ffprobePath) this._ffmpeg.setFfprobePath(this.ffprobePath);
    }
    return this._ffmpeg;
  }
  get canProcessImages() {
    return this.sharp !== null;
  }
  get canProcessMedia() {
    return this.ffmpeg !== null && this.ffmpegPath !== null;
  }
  // ── Image processing ──────────────────────────────────────────────────────
  async processImage(inputBuffer, originalMimeType, config) {
    const safeBuffer = ensureBuffer(inputBuffer);
    if (!this.canProcessImages) {
      console.warn("[MediaProcessor] Sharp not installed \u2014 returning original image.");
      return { buffer: safeBuffer, mimeType: originalMimeType, extension: inferImageFormat(originalMimeType) };
    }
    const qualityConfigs = config.qualityConfigs;
    if (qualityConfigs && qualityConfigs.length > 1) {
      const results = await Promise.all(
        qualityConfigs.map(async (qc) => ({
          id: qc.id,
          buffer: await this.processImageSingle(this.sharp, safeBuffer, originalMimeType, {
            ...config,
            qualityConfig: qc,
            quality: qc.quality ?? config.quality,
            format: qc.format ?? config.format
          })
        }))
      );
      const variants = {};
      for (const r of results) variants[r.id] = r.buffer;
      const firstId = qualityConfigs[0].id;
      return {
        variants,
        buffer: variants[firstId],
        mimeType: resolveImageOutputMime(config.format ?? qualityConfigs[0].format, originalMimeType),
        extension: resolveImageOutputExt(config.format ?? qualityConfigs[0].format, originalMimeType)
      };
    }
    const buffer = await this.processImageSingle(this.sharp, safeBuffer, originalMimeType, config);
    return {
      buffer,
      mimeType: resolveImageOutputMime(config.format, originalMimeType),
      extension: resolveImageOutputExt(config.format, originalMimeType)
    };
  }
  async processImageSingle(sharp, inputBuffer, originalMimeType, config) {
    if (originalMimeType === "image/gif") return inputBuffer;
    const dims = resolveImageDimensions(config.qualityConfig, config.quality);
    const quality = resolveImageQuality(config.qualityConfig, config.quality);
    const outputFormat = config.qualityConfig?.format ?? config.format ?? inferImageFormat(originalMimeType);
    let pipeline = sharp(inputBuffer);
    if (dims.width || dims.height) {
      pipeline = pipeline.resize(dims.width ?? null, dims.height ?? null, { fit: "inside", withoutEnlargement: true });
    }
    switch (outputFormat) {
      case "jpeg":
      case "jpg":
        pipeline = pipeline.jpeg({ quality, progressive: true, mozjpeg: true });
        break;
      case "webp":
        pipeline = pipeline.webp({ quality, effort: 4 });
        break;
      case "png":
        pipeline = pipeline.png({ compressionLevel: Math.round((100 - quality) / 10) });
        break;
      case "avif":
        pipeline = pipeline.avif({ quality, effort: 4 });
        break;
      default:
        pipeline = pipeline.jpeg({ quality, progressive: true });
        break;
    }
    return await pipeline.toBuffer();
  }
  // ── Video processing ──────────────────────────────────────────────────────
  async processVideo(inputBuffer, originalMimeType, originalFilename, config) {
    const safeBuffer = ensureBuffer(inputBuffer);
    if (!this.canProcessMedia) {
      console.warn("[MediaProcessor] FFmpeg not available \u2014 returning original video.");
      return { buffer: safeBuffer, mimeType: originalMimeType, extension: path.extname(originalFilename).slice(1) || "mp4" };
    }
    await this.semaphore.acquire();
    const tmp = new TempFileManager(this.tempDir);
    try {
      const inputExt = path.extname(originalFilename) || inferVideoExt(originalMimeType);
      const inputPath = tmp.create(inputExt, "source");
      await fs.promises.writeFile(inputPath, safeBuffer);
      return await this._encodeVideoFromPath(inputPath, originalMimeType, originalFilename, config, tmp);
    } finally {
      await tmp.cleanup();
      this.semaphore.release();
    }
  }
  async processVideoFromPath(inputPath, originalMimeType, originalFilename, config) {
    if (!this.canProcessMedia) {
      console.warn("[MediaProcessor] FFmpeg not available \u2014 returning passthrough.");
      return {
        outputPath: inputPath,
        mimeType: originalMimeType,
        extension: path.extname(originalFilename).slice(1) || "mp4",
        cleanupFn: async () => {
        }
      };
    }
    await this.semaphore.acquire();
    const tmp = new TempFileManager(this.tempDir);
    let acquired = true;
    try {
      const result = await this._encodeVideoFromPath(
        inputPath,
        originalMimeType,
        originalFilename,
        config,
        tmp
      );
      const releaseOnce = () => {
        if (acquired) {
          acquired = false;
          this.semaphore.release();
        }
      };
      return {
        ...result,
        cleanupFn: async () => {
          try {
            await tmp.cleanup();
          } finally {
            releaseOnce();
          }
        }
      };
    } catch (err) {
      acquired = false;
      this.semaphore.release();
      await tmp.cleanup().catch(() => {
      });
      throw err;
    }
  }
  /**
   * Probe the source file's own bitrate via ffprobe. Used to clamp ladder
   * targets down when the source is already lean (see clampTierToSourceBitrate).
   * Returns null (and we just fall back to ladder defaults) if probing fails
   * for any reason — this is a best-effort optimization, not load-bearing.
   */
  async probeSourceBitrateKbps(inputPath) {
    if (!this.ffmpeg) return null;
    try {
      const metadata = await new Promise((resolve, reject) => {
        this.ffmpeg.ffprobe(inputPath, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });
      const videoStream = metadata?.streams?.find((s) => s.codec_type === "video");
      const raw = videoStream?.bit_rate ?? metadata?.format?.bit_rate;
      const bps = raw != null ? parseInt(raw, 10) : NaN;
      if (isNaN(bps) || bps <= 0) return null;
      return bps / 1e3;
    } catch {
      return null;
    }
  }
  async _encodeVideoFromPath(inputPath, originalMimeType, originalFilename, config, tmp) {
    const outputFormat = normaliseFormat(config.format ?? "mp4");
    const outputMime = `video/${outputFormat}`;
    const sourceBitrateKbps = await this.probeSourceBitrateKbps(inputPath);
    if (sourceBitrateKbps != null) {
      console.log(`[MediaProcessor] Source bitrate: ${Math.round(sourceBitrateKbps)} kbps`);
    }
    if (config.qualityConfigs && config.qualityConfigs.length > 1) {
      const variantSpecs = config.qualityConfigs.map((qc) => ({
        qc,
        outputPath: tmp.create(`.${outputFormat}`, qc.id)
      }));
      const cpuCount = os.cpus().length || 2;
      const threadsPerProcess = Math.max(1, Math.floor(cpuCount / variantSpecs.length));
      for (const { qc, outputPath: outputPath2 } of variantSpecs) {
        const q = resolveVideoQuality(qc, config.quality);
        console.log(
          `[MediaProcessor] Queuing variant ${qc.id} (res: ${qc.resolution ?? "inherit"}, crf: ${q.crf}, b:v: ${q.videoBitrate}, preset: ${q.preset}, threads: ${threadsPerProcess})...`
        );
      }
      const thumbnailPromise2 = config.generateThumbnail !== false ? this.generateVideoThumbnailBuffer(inputPath, config.thumbnailTimeSeconds, tmp, "thumb") : Promise.resolve(void 0);
      await Promise.all(
        variantSpecs.map(
          ({ qc, outputPath: outputPath2 }) => this.runFFmpegVideo(
            inputPath,
            outputPath2,
            outputFormat,
            config,
            qc,
            threadsPerProcess,
            variantSpecs.length,
            sourceBitrateKbps
          ).then(() => {
            const sizeKB = (fs.statSync(outputPath2).size / 1024).toFixed(0);
            console.log(`[MediaProcessor] Variant ${qc.id} done \u2014 ${sizeKB} KB`);
          })
        )
      );
      const thumbnail2 = await thumbnailPromise2;
      const variantPaths = {};
      for (const { qc, outputPath: outputPath2 } of variantSpecs) {
        variantPaths[qc.id] = outputPath2;
      }
      const firstId = config.qualityConfigs[0].id;
      return {
        variants: {},
        variantPaths,
        buffer: void 0,
        outputPath: variantPaths[firstId],
        thumbnail: thumbnail2,
        mimeType: outputMime,
        extension: outputFormat
      };
    }
    const outputPath = tmp.create(`.${outputFormat}`, "single");
    const thumbnailPromise = config.generateThumbnail !== false ? this.generateVideoThumbnailBuffer(inputPath, config.thumbnailTimeSeconds, tmp, "thumb") : Promise.resolve(void 0);
    await this.runFFmpegVideo(inputPath, outputPath, outputFormat, config, void 0, void 0, 1, sourceBitrateKbps);
    const buffer = await fs.promises.readFile(outputPath);
    const thumbnail = await thumbnailPromise;
    return { buffer, outputPath, thumbnail, mimeType: outputMime, extension: outputFormat };
  }
  async runFFmpegVideo(inputPath, outputPath, format, config, qc, threadsPerProcess, concurrentVariants = 1, sourceBitrateKbps = null) {
    let hwProbe = { encoder: null, extraArgs: [] };
    if (this.hwProbePromise) {
      try {
        hwProbe = await this.hwProbePromise;
      } catch {
      }
    }
    const requestedCodec = qc?.codec ?? config.codec ?? "libx264";
    if (hwProbe.encoder && requestedCodec === "libx264") {
      try {
        await this._executeFfmpegVideoCommand(
          inputPath,
          outputPath,
          format,
          config,
          qc,
          hwProbe.encoder,
          void 0,
          threadsPerProcess,
          concurrentVariants,
          sourceBitrateKbps
        );
        return;
      } catch (err) {
        console.warn(`[MediaProcessor] Hardware encoding (${hwProbe.encoder}) failed. Retrying with libx264... Error: ${err.message}`);
        await fs.promises.unlink(outputPath).catch(() => {
        });
      }
    }
    await this._executeFfmpegVideoCommand(
      inputPath,
      outputPath,
      format,
      config,
      qc,
      requestedCodec,
      [],
      threadsPerProcess,
      concurrentVariants,
      sourceBitrateKbps
    );
  }
  async _executeFfmpegVideoCommand(inputPath, outputPath, format, config, qc, actualCodec, extraCodecArgsInput, threadsPerProcess, concurrentVariants = 1, sourceBitrateKbps = null) {
    return new Promise((resolve, reject) => {
      if (!this.ffmpeg) return reject(new Error("[MediaProcessor] fluent-ffmpeg is not installed."));
      const q = resolveVideoQuality(qc, config.quality);
      const outputFormat = normaliseFormat(format);
      const isSoftwareX264 = actualCodec === "libx264";
      const explicitPreset = qc?.preset;
      const preset = explicitPreset ?? resolveRuntimePreset(
        q.preset ?? "medium",
        os.cpus().length || 2,
        concurrentVariants,
        this.speedProfile
      );
      let videoBitrate = q.videoBitrate;
      let maxBitrate = resolveMaxBitrate(qc, q.videoBitrate);
      let bufsize = resolveBufsize(qc, q.videoBitrate);
      let clampApplied = false;
      const ladderKbps = parseKbps(q.videoBitrate);
      if (ladderKbps != null) {
        const clamped = clampTierToSourceBitrate(qc?.resolution, ladderKbps, sourceBitrateKbps);
        if (clamped) {
          videoBitrate = clamped.videoBitrate;
          maxBitrate = clamped.maxBitrate;
          bufsize = clamped.bufsize;
          clampApplied = true;
          console.log(
            `[MediaProcessor] ${qc?.id ?? "single"}: source-bitrate-aware clamp ${q.videoBitrate} -> ${videoBitrate} (source ~${Math.round(sourceBitrateKbps)}k) \u2014 switching to ABR mode for a real size ceiling`
          );
        }
      }
      let cmd = this.ffmpeg(inputPath).addInputOptions(`-fflags +genpts`).addInputOptions(`-analyzeduration 20M`).addInputOptions(`-probesize 20M`);
      if (config.startTime != null && config.startTime > 0)
        cmd = cmd.inputOptions(`-ss ${config.startTime}`);
      if (config.endTime != null) {
        const dur = config.endTime - (config.startTime ?? 0);
        if (dur > 0) cmd = cmd.inputOptions(`-t ${dur}`);
      }
      cmd = cmd.videoCodec(actualCodec);
      if ((isSoftwareX264 || actualCodec === "libx265") && !clampApplied) {
        cmd = cmd.addOutputOptions(`-crf ${q.crf}`);
      }
      if (isSoftwareX264 || actualCodec === "libx265") {
        cmd = cmd.addOutputOptions(`-preset ${preset}`);
      }
      const isHwEncoder = extraCodecArgsInput === void 0;
      const extraCodecArgs = isHwEncoder ? clampApplied ? extraArgsForAbr(actualCodec) : extraArgsFor(actualCodec) : extraCodecArgsInput;
      if (extraCodecArgs.length > 0) {
        for (const arg of extraCodecArgs) {
          cmd = cmd.addOutputOptions(arg);
        }
      }
      cmd = cmd.addOutputOptions(`-b:v ${videoBitrate}`).addOutputOptions(`-maxrate ${maxBitrate}`).addOutputOptions(`-bufsize ${bufsize}`).addOutputOptions(`-g 48`).addOutputOptions(`-keyint_min 48`).addOutputOptions(`-sc_threshold 0`).addOutputOptions(`-movflags +faststart`);
      if (isSoftwareX264 && threadsPerProcess && threadsPerProcess > 0) {
        cmd = cmd.addOutputOptions(`-threads ${threadsPerProcess}`);
      }
      if (isSoftwareX264) {
        if (this.speedProfile === "speed") {
          cmd = cmd.addOutputOptions(`-x264-params bframes=0:rc-lookahead=10`);
        } else if (this.speedProfile === "balanced") {
          cmd = cmd.addOutputOptions(`-x264-params rc-lookahead=20`);
        }
      }
      const scaleFilter = buildScaleFilter(q.width, q.height);
      const hwPixFmtFilter = !isSoftwareX264 ? "format=nv12" : null;
      if (config.mute) {
        cmd = cmd.noAudio();
        const vf = [scaleFilter, hwPixFmtFilter].filter(Boolean).join(",");
        if (vf) cmd = cmd.addOutputOptions(`-vf ${vf}`);
      } else {
        const audioBitrate = q.audioBitrate ?? "128k";
        const audioFilter = buildAudioFilterChain(audioBitrate);
        if (scaleFilter || hwPixFmtFilter) {
          const videoChain = [scaleFilter, hwPixFmtFilter].filter(Boolean).join(",");
          cmd = cmd.complexFilter(
            `[0:v]${videoChain}[v];[0:a]${audioFilter}[a]`,
            ["v", "a"]
          );
        } else {
          cmd = cmd.addOutputOptions(`-af ${audioFilter}`).addOutputOptions(`-vf copy`);
        }
        cmd = cmd.audioCodec("aac").audioBitrate(audioBitrate).addOutputOptions(`-ar 48000`).addOutputOptions(`-ac 2`).addOutputOptions(`-profile:a aac_low`);
      }
      cmd = cmd.format(outputFormat).output(outputPath);
      const timer = setTimeout(() => {
        try {
          cmd.kill("SIGKILL");
        } catch {
        }
        reject(new Error(
          `[MediaProcessor] FFmpeg timed out after ${this.timeoutMs / 1e3}s encoding variant (crf=${q.crf}, preset=${preset}, res=${q.width ?? "?"}x${q.height ?? "?"}).`
        ));
      }, this.timeoutMs);
      cmd.on("end", () => {
        clearTimeout(timer);
        resolve();
      }).on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      }).run();
    });
  }
  // ── Audio processing ──────────────────────────────────────────────────────
  async processAudio(inputBuffer, originalMimeType, originalFilename, config) {
    const safeBuffer = ensureBuffer(inputBuffer);
    if (!this.canProcessMedia) {
      console.warn("[MediaProcessor] FFmpeg not available \u2014 returning original audio.");
      return { buffer: safeBuffer, mimeType: originalMimeType, extension: path.extname(originalFilename).slice(1) || "mp3" };
    }
    await this.semaphore.acquire();
    const tmp = new TempFileManager(this.tempDir);
    try {
      const inputExt = path.extname(originalFilename) || inferAudioExt(originalMimeType);
      const inputPath = tmp.create(inputExt, "source");
      await fs.promises.writeFile(inputPath, safeBuffer);
      return await this._encodeAudioFromPath(inputPath, originalMimeType, config, tmp);
    } finally {
      await tmp.cleanup();
      this.semaphore.release();
    }
  }
  async processAudioFromPath(inputPath, originalMimeType, originalFilename, config) {
    if (!this.canProcessMedia) {
      console.warn("[MediaProcessor] FFmpeg not available \u2014 returning passthrough.");
      return {
        outputPath: inputPath,
        mimeType: originalMimeType,
        extension: path.extname(originalFilename).slice(1) || "mp3",
        cleanupFn: async () => {
        }
      };
    }
    await this.semaphore.acquire();
    const tmp = new TempFileManager(this.tempDir);
    let acquired = true;
    try {
      const result = await this._encodeAudioFromPath(inputPath, originalMimeType, config, tmp);
      const releaseOnce = () => {
        if (acquired) {
          acquired = false;
          this.semaphore.release();
        }
      };
      return {
        ...result,
        cleanupFn: async () => {
          try {
            await tmp.cleanup();
          } finally {
            releaseOnce();
          }
        }
      };
    } catch (err) {
      acquired = false;
      this.semaphore.release();
      await tmp.cleanup().catch(() => {
      });
      throw err;
    }
  }
  async _encodeAudioFromPath(inputPath, originalMimeType, config, tmp) {
    const outputFormat = normaliseFormat(config.format ?? "mp3");
    const outputMime = inferAudioMime(outputFormat);
    if (config.qualityConfigs && config.qualityConfigs.length > 1) {
      const variantSpecs = config.qualityConfigs.map((qc) => ({
        qc,
        outputPath: tmp.create(`.${outputFormat}`, qc.id)
      }));
      await Promise.all(
        variantSpecs.map(
          ({ qc, outputPath: outputPath2 }) => this.runFFmpegAudio(inputPath, outputPath2, outputFormat, {
            ...config,
            qualityConfig: qc,
            quality: qc.quality ?? config.quality,
            audioBitrate: qc.audioBitrate ?? config.audioBitrate
          })
        )
      );
      const variantPaths = {};
      for (const { qc, outputPath: outputPath2 } of variantSpecs) {
        variantPaths[qc.id] = outputPath2;
      }
      const firstId = config.qualityConfigs[0].id;
      return {
        variants: {},
        variantPaths,
        buffer: void 0,
        outputPath: variantPaths[firstId],
        mimeType: outputMime,
        extension: outputFormat
      };
    }
    const outputPath = tmp.create(`.${outputFormat}`, "single");
    await this.runFFmpegAudio(inputPath, outputPath, outputFormat, config);
    const buffer = await fs.promises.readFile(outputPath);
    return { buffer, outputPath, mimeType: outputMime, extension: outputFormat };
  }
  runFFmpegAudio(inputPath, outputPath, format, config) {
    return new Promise((resolve, reject) => {
      if (!this.ffmpeg) return reject(new Error("[MediaProcessor] fluent-ffmpeg is not installed."));
      const bitrate = resolveAudioBitrate(config.qualityConfig, config.quality);
      const outputFormat = normaliseFormat(format);
      const audioFilter = buildAudioFilterChain(bitrate);
      const codecMap = {
        mp3: "libmp3lame",
        aac: "aac",
        ogg: "libvorbis",
        m4a: "aac",
        wav: "pcm_s16le",
        flac: "flac"
      };
      let cmd = this.ffmpeg(inputPath).addInputOptions(`-analyzeduration 10M`).addInputOptions(`-probesize 10M`);
      if (config.startTime != null && config.startTime > 0)
        cmd = cmd.inputOptions(`-ss ${config.startTime}`);
      if (config.endTime != null) {
        const dur = config.endTime - (config.startTime ?? 0);
        if (dur > 0) cmd = cmd.inputOptions(`-t ${dur}`);
      }
      const audioCodec = codecMap[outputFormat] ?? "libmp3lame";
      cmd = cmd.noVideo().audioCodec(audioCodec).addOutputOptions(`-af ${audioFilter}`).addOutputOptions(`-ar 48000`).addOutputOptions(`-ac 2`);
      if (audioCodec === "libmp3lame") {
        const vbrQ = resolveVbrQuality(bitrate);
        cmd = cmd.addOutputOptions(`-q:a ${vbrQ}`);
      } else if (audioCodec === "libvorbis") {
        const vbrQ = Math.max(0, Math.min(10, Math.round(parseInt(bitrate, 10) / 32)));
        cmd = cmd.addOutputOptions(`-q:a ${vbrQ}`);
      } else {
        cmd = cmd.audioBitrate(bitrate);
      }
      cmd = cmd.format(outputFormat).output(outputPath);
      const timer = setTimeout(() => {
        try {
          cmd.kill("SIGKILL");
        } catch {
        }
        reject(new Error(`[MediaProcessor] FFmpeg audio timed out after ${this.timeoutMs / 1e3}s`));
      }, this.timeoutMs);
      cmd.on("end", () => {
        clearTimeout(timer);
        resolve();
      }).on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      }).run();
    });
  }
  // ── Thumbnail generation ──────────────────────────────────────────────────
  async generateVideoThumbnail(inputBuffer, originalFilename, timeSeconds) {
    const safeBuffer = ensureBuffer(inputBuffer);
    if (!this.canProcessMedia) throw new Error("[MediaProcessor] FFmpeg not available for thumbnail generation");
    await this.semaphore.acquire();
    const tmp = new TempFileManager(this.tempDir);
    try {
      const inputPath = tmp.create(path.extname(originalFilename) || ".mp4", "source");
      await fs.promises.writeFile(inputPath, safeBuffer);
      return await this.generateVideoThumbnailBuffer(inputPath, timeSeconds, tmp, "thumb");
    } finally {
      await tmp.cleanup();
      this.semaphore.release();
    }
  }
  async generateVideoThumbnailFromPath(inputPath, timeSeconds) {
    if (!this.canProcessMedia) throw new Error("[MediaProcessor] FFmpeg not available for thumbnail generation");
    const tmp = new TempFileManager(this.tempDir);
    try {
      return await this.generateVideoThumbnailBuffer(inputPath, timeSeconds, tmp, "thumb");
    } finally {
      await tmp.cleanup();
    }
  }
  /**
   * [FIX 1] Now takes a variantId so its temp output is named predictably
   * (e.g. "<session>_thumb.jpg" or "<session>_480p_thumb.jpg") instead of
   * a fresh random suffix on every call — reusing the create() idempotency
   * from TempFileManager when the same id is requested twice.
   */
  generateVideoThumbnailBuffer(inputPath, timeSeconds, tmp, variantId = "thumb") {
    return new Promise(async (resolve, reject) => {
      if (!this.ffmpeg) return reject(new Error("[MediaProcessor] fluent-ffmpeg is not installed."));
      let seekTime;
      if (timeSeconds != null && timeSeconds > 0) {
        seekTime = timeSeconds;
      } else {
        seekTime = 5;
        try {
          const duration = await this.getVideoDuration(inputPath, this.ffmpeg);
          if (duration > 0) seekTime = Math.max(0.1, duration * 0.1);
        } catch {
        }
      }
      const outputPath = tmp.create(".jpg", variantId);
      const timer = setTimeout(
        () => reject(new Error("[MediaProcessor] Thumbnail timed out after 30s")),
        3e4
      );
      this.ffmpeg(inputPath).seekInput(seekTime).frames(1).videoFilters("scale=320:180:flags=fast_bilinear:force_original_aspect_ratio=decrease").outputOptions([
        "-q:v 4",
        "-update 1"
      ]).output(outputPath).on("end", async () => {
        clearTimeout(timer);
        try {
          const raw = await fs.promises.readFile(outputPath);
          resolve(this.sharp ? await this.sharp(raw).jpeg({ quality: 80, mozjpeg: true }).toBuffer() : raw);
        } catch (err) {
          reject(err);
        }
      }).on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      }).run();
    });
  }
  getVideoDuration(inputPath, ffmpeg) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) return reject(err);
        resolve(metadata?.format?.duration ?? 0);
      });
    });
  }
  // ── Public helpers (used by UploadEngine) ─────────────────────────────────
  async assembleChunksToDisk(chunks, ext) {
    const outputPath = path.join(
      this.tempDir,
      `upload_assembled_${Date.now()}_${Math.random().toString(36).substring(2, 9)}${ext}`
    );
    await assembleChunksToDisk(chunks, outputPath);
    return outputPath;
  }
  async writeTempFile(buffer, ext) {
    const safeBuffer = ensureBuffer(buffer);
    const name = `upload_tmp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}${ext}`;
    const fullPath = path.join(this.tempDir, name);
    await fs.promises.writeFile(fullPath, safeBuffer);
    return fullPath;
  }
  async deleteTempFile(filePath) {
    try {
      if (fs.existsSync(filePath)) await fs.promises.unlink(filePath);
    } catch {
    }
  }
};
function resolveImageOutputMime(format, original) {
  const f = format ?? inferImageFormat(original);
  const map = {
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    avif: "image/avif",
    gif: "image/gif"
  };
  return map[f] ?? original;
}
function resolveImageOutputExt(format, original) {
  const f = format ?? inferImageFormat(original);
  return f === "jpeg" ? "jpg" : f;
}
function inferImageFormat(mimeType) {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("avif")) return "avif";
  if (mimeType.includes("gif")) return "gif";
  return "jpeg";
}
function inferVideoExt(mimeType) {
  if (mimeType.includes("webm")) return ".webm";
  if (mimeType.includes("quicktime")) return ".mov";
  if (mimeType.includes("x-msvideo")) return ".avi";
  if (mimeType.includes("x-matroska")) return ".mkv";
  return ".mp4";
}
function inferAudioExt(mimeType) {
  if (mimeType.includes("wav")) return ".wav";
  if (mimeType.includes("ogg")) return ".ogg";
  if (mimeType.includes("aac")) return ".aac";
  if (mimeType.includes("flac")) return ".flac";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return ".m4a";
  return ".mp3";
}
function inferAudioMime(format) {
  const map = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    aac: "audio/aac",
    flac: "audio/flac",
    m4a: "audio/mp4"
  };
  return map[format] ?? "audio/mpeg";
}

// src/core/UploadEngine.ts
function ensureBuffer2(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return Buffer.from(input);
}
async function streamFileToStorage(storage, fileId, filePath, ctx) {
  const stat = await fs2.promises.stat(filePath);
  if (storage.putStream) {
    const stream = fs2.createReadStream(filePath);
    const result2 = await storage.putStream(fileId, stream, ctx);
    return {
      url: result2.url,
      storageRef: result2.storageRef,
      chunkCount: typeof result2.chunkCount === "number" ? result2.chunkCount : 1,
      chunkSize: typeof result2.chunkSize === "number" ? result2.chunkSize : stat.size,
      totalSize: typeof result2.totalSize === "number" ? result2.totalSize : stat.size
    };
  }
  const buffer = await fs2.promises.readFile(filePath);
  const result = await storage.putObject(fileId, buffer, ctx);
  return {
    url: result.url,
    storageRef: result.storageRef,
    chunkCount: typeof result.chunkCount === "number" ? result.chunkCount : 1,
    chunkSize: typeof result.chunkSize === "number" ? result.chunkSize : buffer.length,
    totalSize: typeof result.totalSize === "number" ? result.totalSize : buffer.length
  };
}
function buildVariantFileId(primaryFileId, qualityId) {
  return `${primaryFileId}_${qualityId}`;
}
var UploadEngine = class {
  config;
  mediaProcessor;
  constructor(config) {
    this.config = resolveUploadConfig(config);
    this.mediaProcessor = new MediaProcessor(config.mediaProcessor ?? {});
  }
  handle = async (req, res) => {
    try {
      const contentType = this.getContentType(req);
      if (!contentType.includes("multipart/form-data"))
        throw new ValidationError("Content-Type must be multipart/form-data", 400);
      let uploadType = this.getUploadType(req);
      if (!uploadType && this.config.defaultUploadType) uploadType = this.config.defaultUploadType;
      if (!uploadType || !this.config.uploadTypes[uploadType])
        throw new ValidationError(
          `Invalid or missing uploadType. Available: ${Object.keys(this.config.uploadTypes).join(", ")}`,
          400
        );
      const typeConfig = this.config.uploadTypes[uploadType];
      const storageKey = resolveStorageKey(this.config, typeConfig);
      const storage = this.config.storages[storageKey];
      if (!storage) throw new ValidationError(`Storage '${storageKey}' not configured`, 500);
      const parsed = await MultipartParser.parseBuffered(req, {
        maxFieldSize: this.config.maxFieldSize || 1 * 1024 * 1024,
        maxFileSize: resolveSizeLimit(this.config, typeConfig, "unknown"),
        maxFiles: this.config.maxFiles || 10,
        maxTotalSize: this.config.maxTotalSize || 500 * 1024 * 1024,
        fieldValidation: this.buildFieldValidation(typeConfig),
        fileValidation: this.buildFileValidation(typeConfig),
        onProgress: this.config.onProgress
      });
      req.fields = parsed.fields || {};
      req.files = parsed.files || [];
      let transformer;
      if (parsed.fields.transformer) {
        try {
          transformer = typeof parsed.fields.transformer === "string" ? JSON.parse(parsed.fields.transformer) : parsed.fields.transformer;
        } catch {
          transformer = void 0;
        }
      }
      req.transformer = transformer;
      if (this.isChunkedUpload(parsed.fields)) {
        return await this.handleChunkedUpload(req, res, parsed, uploadType, storage, typeConfig, transformer);
      } else {
        return await this.handleNonChunkedUpload(req, res, parsed, uploadType, storage, typeConfig, transformer);
      }
    } catch (error) {
      return await this.handleError(error, this.getUploadType(req), res);
    }
  };
  // ── Chunked upload ────────────────────────────────────────────────────────
  async handleChunkedUpload(req, res, parsed, uploadType, storage, typeConfig, transformer) {
    const sessionId = String(parsed.fields.sessionId);
    const chunkIndex = parseInt(String(parsed.fields.chunkIndex), 10);
    const totalChunks = parseInt(String(parsed.fields.totalChunks), 10);
    const filename = String(parsed.fields.filename);
    const mimetype = String(parsed.fields.mimetype);
    const totalSize = parseInt(String(parsed.fields.totalSize || 0), 10);
    const chunksize = parseInt(String(parsed.fields.chunksize || 0), 10);
    if (!sessionId || isNaN(chunkIndex) || isNaN(totalChunks))
      throw new ValidationError("Missing or invalid chunked upload fields", 400);
    if (!parsed.files || parsed.files.length === 0)
      throw new ValidationError("No chunk data received", 400);
    const chunkFile = parsed.files[0];
    const chunkBuffer = ensureBuffer2(chunkFile.buffer);
    const kind = detectKind(mimetype);
    assertKindAllowed(kind, typeConfig);
    assertWithinLimit(chunkBuffer.length, resolveSizeLimit(this.config, typeConfig, kind), "File size");
    const actualTotalSize = totalSize > 0 ? totalSize : chunkBuffer.length * totalChunks;
    const actualChunkSize = chunkBuffer.length;
    let existingFile = null;
    if (this.config.database) existingFile = await this.config.database.getFileBySessionId(sessionId);
    const fileId = existingFile?.id ?? this.generateFileId();
    const isLastChunk = chunkIndex === totalChunks - 1;
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
    await storage.writeChunk(fileId, chunkIndex, chunkBuffer, storageCtx);
    if (chunkIndex === 0 && this.config.database && !existingFile) {
      const metadata = this.extractCustomFields(parsed.fields, [
        "sessionId",
        "chunkIndex",
        "totalChunks",
        "filename",
        "mimetype",
        "uploadType",
        "totalSize",
        "chunksize",
        "transformer"
      ]);
      if (transformer) metadata._transformer = transformer;
      await this.config.database.createFile({
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
    }
    if (!isLastChunk) {
      const result = {
        status: "chunk_received",
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
    const inputExt = path2.extname(filename) || inferExtFromMime(mimetype);
    let assembledPath = null;
    let processedResult = null;
    try {
      assembledPath = await this.assembleChunksToDisk(
        storage,
        fileId,
        totalChunks,
        inputExt,
        storageCtx
      );
      let finalMimeType = mimetype;
      let finalFilename = filename;
      if (transformer && this.shouldProcessMedia(mimetype, transformer, storage)) {
        try {
          processedResult = await this.processMediaFromPath(
            assembledPath,
            mimetype,
            filename,
            transformer
          );
          if (processedResult) {
            finalMimeType = processedResult.mimeType;
            finalFilename = replaceExtension(filename, `.${processedResult.extension}`);
          }
        } catch (processingError) {
          console.error("[UploadEngine] Media processing failed, storing raw:", processingError);
          processedResult = null;
        }
      }
      const variantResults = {};
      const variantFileIds = {};
      let finalUrl;
      let finalStorageRef;
      let primaryEncodedSize = actualTotalSize;
      let primaryChunkCount = 1;
      let primaryChunkSize = actualChunkSize;
      if (processedResult?.variantPaths && Object.keys(processedResult.variantPaths).length > 0) {
        const entries = Object.entries(processedResult.variantPaths);
        await Promise.all(entries.map(async ([qualityId, variantPath], i) => {
          const isPrimary = i === 0;
          const variantFileId = isPrimary ? fileId : buildVariantFileId(fileId, qualityId);
          const variantFilename = buildVariantFilename(filename, qualityId, processedResult.extension);
          const variantCtx = {
            ...storageCtx,
            originalName: variantFilename,
            contentType: processedResult.mimeType
            // totalChunks/chunkIndex below describe the ORIGINAL upload context,
            // not the variant's own chunking — the adapter computes the variant's
            // real chunkCount/chunkSize itself and returns it from putStream().
          };
          const vr = await streamFileToStorage(storage, variantFileId, variantPath, variantCtx);
          if (isPrimary) {
            finalUrl = vr.url;
            finalStorageRef = vr.storageRef;
            primaryEncodedSize = vr.totalSize;
            primaryChunkCount = vr.chunkCount;
            primaryChunkSize = vr.chunkSize;
          }
          variantResults[qualityId] = { url: vr.url, storageRef: vr.storageRef, fileId: variantFileId };
          if (!isPrimary) {
            variantFileIds[qualityId] = variantFileId;
            if (this.config.database) {
              const vRecord = await this.config.database.createFile({
                id: variantFileId,
                sessionId: `${sessionId}_${qualityId}`,
                originalName: variantFilename,
                storedName: this.sanitizeFilename(variantFilename),
                fieldname: parsed.fields.fieldname || "file",
                contentType: processedResult.mimeType,
                kind,
                size: vr.totalSize,
                // FIX: real chunk geometry from the adapter, not a hardcoded 1.
                // For a large variant written via DatabaseStorageAdapter.putStream,
                // chunkCount will be >1 and chunkSize matches what was actually
                // written, so FileServingHandler's ChunkReadStream can correctly
                // address every chunk (chunkNumber * chunkSize = exact byte offset,
                // with the final chunk sized to the true remainder).
                chunkSize: vr.chunkSize,
                chunkCount: vr.chunkCount,
                uploadType,
                bucket: typeConfig.bucket || uploadType,
                storageProvider: resolveStorageKey(this.config, typeConfig),
                storageRef: vr.storageRef,
                url: vr.url,
                isComplete: true,
                metadata: { parentFileId: fileId, quality: qualityId, isVariant: true }
              });
              this.config.onUploadComplete?.(vRecord);
            }
          }
        }));
      } else {
        const sourcePath = processedResult?.outputPath ?? assembledPath;
        const singleCtx = {
          ...storageCtx,
          originalName: finalFilename,
          contentType: finalMimeType
        };
        const sr = await streamFileToStorage(storage, fileId, sourcePath, singleCtx);
        finalUrl = sr.url;
        finalStorageRef = sr.storageRef;
        primaryEncodedSize = sr.totalSize;
        primaryChunkCount = sr.chunkCount;
        primaryChunkSize = sr.chunkSize;
      }
      let thumbnailUrl;
      let thumbnailStorageRef;
      if (processedResult?.thumbnail && storage.putObject) {
        try {
          const thumbId = `thumb_${fileId}`;
          const thumbCtx = {
            ...storageCtx,
            originalName: `${path2.basename(filename, path2.extname(filename))}_thumb.jpg`,
            contentType: "image/jpeg"
          };
          const tr = await storage.putObject(thumbId, processedResult.thumbnail, thumbCtx);
          thumbnailUrl = tr.url;
          thumbnailStorageRef = tr.storageRef;
        } catch (e) {
          console.warn("[UploadEngine] Thumbnail upload failed:", e);
        }
      }
      let finalFileRecord = null;
      if (this.config.database) {
        finalFileRecord = await this.config.database.updateFile(fileId, {
          isComplete: true,
          storageRef: finalStorageRef,
          url: finalUrl,
          contentType: finalMimeType,
          originalName: finalFilename,
          storedName: this.sanitizeFilename(finalFilename),
          size: primaryEncodedSize,
          chunkCount: primaryChunkCount,
          chunkSize: primaryChunkSize,
          thumbnailUrl,
          thumbnailRef: thumbnailStorageRef,
          ...Object.keys(variantFileIds).length > 0 ? { variantFileIds } : {},
          updatedAt: Date.now()
        });
      } else {
        finalFileRecord = {
          id: fileId,
          sessionId,
          originalName: finalFilename,
          storedName: this.sanitizeFilename(finalFilename),
          fieldname: parsed.fields.fieldname || "file",
          contentType: finalMimeType,
          kind,
          size: primaryEncodedSize,
          chunkSize: primaryChunkSize,
          chunkCount: primaryChunkCount,
          uploadType,
          bucket: typeConfig.bucket || uploadType,
          storageProvider: resolveStorageKey(this.config, typeConfig),
          storageRef: finalStorageRef,
          url: finalUrl,
          thumbnailUrl,
          isComplete: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ...Object.keys(variantFileIds).length > 0 ? { variantFileIds } : {}
        };
      }
      if (finalFileRecord) this.config.onUploadComplete?.(finalFileRecord);
      const result = {
        status: "success",
        message: "File uploaded successfully",
        fileId,
        url: finalUrl,
        storageRef: finalStorageRef,
        progress: 100,
        metadata: this.extractCustomFields(parsed.fields),
        fields: this.extractCustomFields(parsed.fields),
        file: finalFileRecord ?? void 0,
        fileFields: finalFileRecord ? { [finalFileRecord.fieldname || "file"]: finalFileRecord } : void 0,
        thumbnailUrl,
        ...Object.keys(variantResults).length > 0 ? { variants: variantResults } : {}
      };
      if (finalFileRecord) req.fileFields = { [finalFileRecord.fieldname || "file"]: finalFileRecord };
      const autoRespond = typeConfig.autoRespond ?? this.config.autoRespond;
      if (autoRespond) {
        res.status(200);
        res.json(result);
      }
      return result;
    } finally {
      if (processedResult?.cleanupFn) {
        await processedResult.cleanupFn().catch(
          (e) => console.warn("[UploadEngine] Processed temp cleanup failed:", e)
        );
      }
      if (assembledPath) {
        await this.mediaProcessor.deleteTempFile(assembledPath).catch(() => {
        });
      }
    }
  }
  // ── Non-chunked upload ────────────────────────────────────────────────────
  async handleNonChunkedUpload(req, res, parsed, uploadType, storage, typeConfig, transformer) {
    if (!parsed.files || parsed.files.length === 0)
      throw new ValidationError("No files provided", 400);
    const uploadResults = [];
    for (const file of parsed.files) {
      const kind = detectKind(file.mimetype);
      assertKindAllowed(kind, typeConfig);
      const originalBuffer = ensureBuffer2(file.buffer);
      assertWithinLimit(originalBuffer.length, resolveSizeLimit(this.config, typeConfig, kind), "File size");
      const fileId = this.generateFileId();
      const sessionId = this.generateSessionId();
      let processedBuffer = originalBuffer;
      let processedMimeType = file.mimetype;
      let processedFilename = file.filename;
      let processedResult = null;
      let thumbnailUrl;
      if (transformer && this.shouldProcessMedia(file.mimetype, transformer, storage)) {
        try {
          const inputExt = path2.extname(file.filename) || inferExtFromMime(file.mimetype);
          const inputPath = await this.mediaProcessor.writeTempFile(originalBuffer, inputExt);
          try {
            processedResult = await this.processMediaFromPath(inputPath, file.mimetype, file.filename, transformer);
            if (processedResult?.buffer) {
              processedBuffer = processedResult.buffer;
              processedMimeType = processedResult.mimeType;
              processedFilename = replaceExtension(file.filename, `.${processedResult.extension}`);
            }
          } finally {
            await this.mediaProcessor.deleteTempFile(inputPath).catch(() => {
            });
          }
        } catch (processingError) {
          console.error("[UploadEngine] Media processing failed, using raw file:", processingError);
        }
      }
      const primaryTempPath = await this.mediaProcessor.writeTempFile(processedBuffer, path2.extname(processedFilename) || ".bin");
      let storageResult;
      try {
        storageResult = await streamFileToStorage(storage, fileId, primaryTempPath, {
          originalName: processedFilename,
          contentType: processedMimeType,
          bucket: typeConfig.bucket || uploadType,
          uploadType
        });
      } finally {
        await this.mediaProcessor.deleteTempFile(primaryTempPath).catch(() => {
        });
      }
      if (processedResult?.thumbnail && storage.putObject) {
        try {
          const tr = await storage.putObject(`thumb_${fileId}`, processedResult.thumbnail, {
            originalName: `${path2.basename(file.filename, path2.extname(file.filename))}_thumb.jpg`,
            contentType: "image/jpeg",
            bucket: typeConfig.bucket || uploadType,
            totalSize: processedResult.thumbnail.length,
            chunkSize: processedResult.thumbnail.length,
            chunkCount: 1,
            uploadType
          });
          thumbnailUrl = tr.url;
        } catch (e) {
          console.warn("[UploadEngine] Thumbnail upload failed:", e);
        }
      }
      const variantResults = {};
      const variantFileIds = {};
      if (processedResult?.variants && Object.keys(processedResult.variants).length > 1) {
        const entries = Object.entries(processedResult.variants);
        await Promise.all(entries.map(async ([qualityId, variantBuffer], i) => {
          const isPrimary = i === 0;
          const variantFileId = isPrimary ? fileId : buildVariantFileId(fileId, qualityId);
          const variantName = buildVariantFilename(file.filename, qualityId, processedResult.extension);
          if (isPrimary) {
            variantResults[qualityId] = { url: storageResult.url, storageRef: storageResult.storageRef, fileId };
          } else {
            const variantTempPath = await this.mediaProcessor.writeTempFile(
              variantBuffer,
              `.${processedResult.extension}`
            );
            let vr;
            try {
              vr = await streamFileToStorage(storage, variantFileId, variantTempPath, {
                originalName: variantName,
                contentType: processedResult.mimeType,
                bucket: typeConfig.bucket || uploadType,
                uploadType
              });
            } finally {
              await this.mediaProcessor.deleteTempFile(variantTempPath).catch(() => {
              });
            }
            variantResults[qualityId] = { url: vr.url, storageRef: vr.storageRef, fileId: variantFileId };
            variantFileIds[qualityId] = variantFileId;
            if (this.config.database) {
              const vRecord = await this.config.database.createFile({
                id: variantFileId,
                sessionId: `${sessionId}_${qualityId}`,
                originalName: variantName,
                storedName: this.sanitizeFilename(variantName),
                fieldname: file.fieldname || "file",
                contentType: processedResult.mimeType,
                kind,
                size: vr.totalSize,
                chunkSize: vr.chunkSize,
                chunkCount: vr.chunkCount,
                uploadType,
                bucket: typeConfig.bucket || uploadType,
                storageProvider: resolveStorageKey(this.config, typeConfig),
                storageRef: vr.storageRef,
                url: vr.url,
                isComplete: true,
                metadata: { parentFileId: fileId, quality: qualityId, isVariant: true }
              });
              this.config.onUploadComplete?.(vRecord);
            }
          }
        }));
      }
      if (processedResult?.cleanupFn) {
        await processedResult.cleanupFn().catch(
          (e) => console.warn("[UploadEngine] Processed temp cleanup failed:", e)
        );
      }
      let finalFileRecord = null;
      const meta = {
        ...this.extractCustomFields(parsed.fields),
        ...transformer ? { _transformer: transformer } : {},
        ...Object.keys(variantFileIds).length > 0 ? { variantFileIds } : {}
      };
      if (this.config.database) {
        finalFileRecord = await this.config.database.createFile({
          id: fileId,
          sessionId,
          originalName: processedFilename,
          storedName: this.sanitizeFilename(processedFilename),
          fieldname: file.fieldname || "file",
          contentType: processedMimeType,
          kind,
          size: storageResult.totalSize,
          chunkSize: storageResult.chunkSize,
          chunkCount: storageResult.chunkCount,
          uploadType,
          bucket: typeConfig.bucket || uploadType,
          storageProvider: resolveStorageKey(this.config, typeConfig),
          storageRef: storageResult.storageRef,
          url: storageResult.url,
          thumbnailUrl,
          isComplete: true,
          metadata: meta
        });
        this.config.onUploadComplete?.(finalFileRecord);
      } else {
        finalFileRecord = {
          id: fileId,
          sessionId,
          originalName: processedFilename,
          storedName: this.sanitizeFilename(processedFilename),
          fieldname: file.fieldname || "file",
          contentType: processedMimeType,
          kind,
          size: storageResult.totalSize,
          chunkSize: storageResult.chunkSize,
          chunkCount: storageResult.chunkCount,
          uploadType,
          bucket: typeConfig.bucket || uploadType,
          storageProvider: resolveStorageKey(this.config, typeConfig),
          storageRef: storageResult.storageRef,
          url: storageResult.url,
          thumbnailUrl,
          isComplete: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ...Object.keys(variantFileIds).length > 0 ? { variantFileIds } : {}
        };
        this.config.onUploadComplete?.(finalFileRecord);
      }
      uploadResults.push({
        status: "success",
        message: "File uploaded successfully",
        fileId,
        url: storageResult.url,
        storageRef: storageResult.storageRef,
        progress: 100,
        metadata: this.extractCustomFields(parsed.fields),
        file: finalFileRecord ?? void 0,
        thumbnailUrl,
        ...Object.keys(variantResults).length > 0 ? { variants: variantResults } : {}
      });
    }
    const fileFields = {};
    for (const r of uploadResults) {
      if (r.file) {
        const fn = r.file.fieldname;
        if (!fileFields[fn]) fileFields[fn] = [];
        fileFields[fn].push(r.file);
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
  // ── Chunk-to-disk assembly ────────────────────────────────────────────────
  async assembleChunksToDisk(storage, fileId, totalChunks, ext, ctx) {
    if (typeof storage.assembleChunksToPath === "function") {
      return await storage.assembleChunksToPath(fileId, totalChunks, ext, ctx);
    }
    const chunks = [];
    for (let i = 0; i < totalChunks; i++) {
      const buf = await storage.readChunk(fileId, i, ctx);
      chunks.push(ensureBuffer2(buf));
    }
    return await this.mediaProcessor.assembleChunksToDisk(chunks, ext);
  }
  // ── Media processing dispatch (path-based) ────────────────────────────────
  shouldProcessMedia(mimetype, transformer, storage) {
    if (storage?.hasNativeVariantSupport) {
      console.log(`[UploadEngine] Skipping local media processing; natively supported by storage adapter '${storage.name}'`);
      return false;
    }
    return !!(transformer && (mimetype.startsWith("image/") || mimetype.startsWith("video/") || mimetype.startsWith("audio/")));
  }
  async processMediaFromPath(inputPath, mimetype, filename, transformer) {
    const mediaType = transformer.type ?? (mimetype.startsWith("video/") ? "video" : mimetype.startsWith("audio/") ? "audio" : mimetype.startsWith("image/") ? "image" : null);
    if (!mediaType) return null;
    const qualityConfigs = normaliseQualityConfigs(transformer);
    if (mediaType === "video") {
      const cfg = {
        quality: normaliseQuality(transformer.quality),
        qualityConfigs: qualityConfigs.length > 0 ? qualityConfigs : void 0,
        format: normaliseFormat2(transformer.format) ?? "mp4",
        startTime: transformer.startTime,
        endTime: transformer.endTime,
        mute: transformer.mute,
        videoBitrate: transformer.videoBitrate,
        audioBitrate: transformer.audioBitrate,
        resolution: transformer.resolution,
        codec: transformer.codec,
        generateThumbnail: transformer.generateThumbnail !== false,
        thumbnailTimeSeconds: transformer.thumbnailTimeSeconds
      };
      return await this.mediaProcessor.processVideoFromPath(inputPath, mimetype, filename, cfg);
    }
    if (mediaType === "audio") {
      const cfg = {
        quality: normaliseQuality(transformer.quality),
        qualityConfigs: qualityConfigs.length > 0 ? qualityConfigs : void 0,
        format: normaliseFormat2(transformer.format) ?? "mp3",
        startTime: transformer.startTime,
        endTime: transformer.endTime,
        audioBitrate: transformer.audioBitrate
      };
      return await this.mediaProcessor.processAudioFromPath(inputPath, mimetype, filename, cfg);
    }
    if (mediaType === "image") {
      const buffer = await fs2.promises.readFile(inputPath);
      const cfg = {
        quality: normaliseQuality(transformer.quality),
        qualityConfigs: qualityConfigs.length > 0 ? qualityConfigs : void 0,
        format: normaliseFormat2(transformer.format),
        width: transformer.width,
        height: transformer.height
      };
      const result = await this.mediaProcessor.processImage(buffer, mimetype, cfg);
      return { ...result, cleanupFn: async () => {
      } };
    }
    return null;
  }
  // ── Cleanup ───────────────────────────────────────────────────────────────
  async cleanup(files) {
    const fileArray = Array.isArray(files) ? files : [files];
    for (const file of fileArray) {
      try {
        const storage = this.config.storages[file.storageProvider || this.config.defaultStorage];
        if (storage) await storage.delete(file.storageRef);
        if (this.config.database) await this.config.database.deleteFiles([file.id]);
      } catch (error) {
        console.error(`[UploadEngine] Cleanup failed for file ${file.id}:`, error);
      }
    }
  }
  // ── Private helpers ───────────────────────────────────────────────────────
  isChunkedUpload(fields) {
    return !!(fields.sessionId && typeof fields.sessionId === "string" && fields.chunkIndex !== void 0 && !isNaN(parseInt(String(fields.chunkIndex))) && fields.totalChunks !== void 0 && !isNaN(parseInt(String(fields.totalChunks))));
  }
  buildFieldValidation(typeConfig) {
    const v = {
      sessionId: { minLength: 5 },
      chunkIndex: {},
      totalChunks: {},
      filename: { required: true, maxLength: 255 },
      mimetype: { required: true },
      uploadType: { required: true }
    };
    if (typeConfig.customFields) {
      for (const [name, rule] of Object.entries(typeConfig.customFields)) v[name] = rule;
    }
    return v;
  }
  buildFileValidation(typeConfig) {
    return {
      ".*": {
        allowedMimePatterns: typeConfig.allowedKinds.map((kind) => {
          if (kind === "image") return "image/*";
          if (kind === "video") return "video/*";
          if (kind === "audio") return "audio/*";
          if (kind === "document") return "application/*|text/*";
          return "*/*";
        }),
        maxSize: resolveSizeLimit(this.config, typeConfig, "unknown"),
        detectMagicBytes: true
      }
    };
  }
  extractCustomFields(fields, exclude = []) {
    const std = ["sessionId", "chunkIndex", "totalChunks", "filename", "mimetype", "uploadType", "fieldname", "transformer", ...exclude];
    const out = {};
    for (const [k, v] of Object.entries(fields)) if (!std.includes(k)) out[k] = v;
    return out;
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
    return typeof ct === "string" ? ct : Array.isArray(ct) ? ct[0] || "" : "";
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
function normaliseQuality(q) {
  if (q === void 0) return void 0;
  if (typeof q === "number") return q;
  if (q === "high" || q === "medium" || q === "low") return q;
  if (/^\d+p$/i.test(String(q))) return void 0;
  const n = parseFloat(q);
  return isNaN(n) ? "medium" : n;
}
var RESOLUTION_PATTERN = /^\d{3,4}p$/i;
function normaliseQualityConfigs(transformer) {
  const qc = transformer.qualityConfigs;
  if (qc) {
    let arr;
    if (Array.isArray(qc) && qc.length > 0) {
      arr = qc;
    } else if (typeof qc === "object" && !Array.isArray(qc)) {
      arr = Object.values(qc);
    } else {
      arr = [];
    }
    if (arr.length > 0) {
      const seen = /* @__PURE__ */ new Set();
      const deduped = arr.filter((cfg) => {
        if (seen.has(cfg.id)) {
          console.warn(`[UploadEngine] Duplicate quality config id "${cfg.id}" removed.`);
          return false;
        }
        seen.add(cfg.id);
        return true;
      });
      return deduped.map((cfg) => {
        if (!cfg.resolution && RESOLUTION_PATTERN.test(cfg.id)) {
          return { ...cfg, resolution: cfg.id.toLowerCase() };
        }
        return cfg;
      });
    }
  }
  if (Array.isArray(transformer.qualities) && transformer.qualities.length > 0) {
    const seen = /* @__PURE__ */ new Set();
    return transformer.qualities.map((q) => {
      const raw = String(q).trim();
      return {
        id: raw,
        label: raw,
        ...RESOLUTION_PATTERN.test(raw) ? { resolution: raw.toLowerCase() } : { quality: raw }
      };
    }).filter((cfg) => {
      if (seen.has(cfg.id)) {
        console.warn(`[UploadEngine] Duplicate quality "${cfg.id}" in qualities[] removed.`);
        return false;
      }
      seen.add(cfg.id);
      return true;
    });
  }
  return [];
}
function normaliseFormat2(fmt) {
  if (!fmt) return void 0;
  return fmt.replace(/^(video|audio|image)\//, "");
}
function buildVariantFilename(original, qualityId, extension) {
  const dir = path2.dirname(original);
  const base = path2.basename(original, path2.extname(original));
  const name = `${base}_${qualityId}.${extension}`;
  return dir === "." ? name : `${dir}/${name}`;
}
function replaceExtension(filename, newExt) {
  const base = path2.basename(filename, path2.extname(filename));
  const dir = path2.dirname(filename);
  return dir === "." ? `${base}${newExt}` : `${dir}/${base}${newExt}`;
}
function inferExtFromMime(mime) {
  if (mime.startsWith("video/")) {
    if (mime.includes("webm")) return ".webm";
    if (mime.includes("quicktime")) return ".mov";
    return ".mp4";
  }
  if (mime.startsWith("audio/")) {
    if (mime.includes("wav")) return ".wav";
    if (mime.includes("ogg")) return ".ogg";
    return ".mp3";
  }
  if (mime.includes("png")) return ".png";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("gif")) return ".gif";
  return ".jpg";
}

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
    await this.chunkModel.findOneAndUpdate(
      {
        fileId: chunkToStore.fileId,
        chunkNumber: chunkToStore.chunkNumber
      },
      {
        $set: chunkToStore,
        $setOnInsert: { createdAt: /* @__PURE__ */ new Date() }
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      }
    );
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
import { createReadStream as createReadStream2, promises as fs3 } from "fs";
import * as fsCb from "fs";
import * as path3 from "path";
var LocalDiskStorageAdapter = class {
  name = "local-disk";
  rootDir;
  publicBaseUrl;
  /** Remembers the StorageContext for each in-progress upload. */
  fileCtx = /* @__PURE__ */ new Map();
  constructor(options) {
    this.rootDir = options.rootDir;
    this.publicBaseUrl = options.publicBaseUrl;
  }
  // ── Path helpers ────────────────────────────────────────────────────────
  async ensureDir(dir) {
    await fs3.mkdir(dir, { recursive: true });
  }
  /**
   * Path for an individual chunk file.
   * Zero-padded index keeps OS directory listings in order.
   */
  chunkPath(fileId, chunkNumber, ctx) {
    const idx = String(chunkNumber).padStart(6, "0");
    return path3.join(
      this.rootDir,
      ctx.bucket || "default",
      `${fileId}.chunk-${idx}`
    );
  }
  /** Path for the final assembled file. */
  finalPath(fileId, ctx) {
    const ext = ctx.originalName ? path3.extname(ctx.originalName) : "";
    return path3.join(this.rootDir, ctx.bucket || "default", `${fileId}${ext}`);
  }
  /** Temporary assembled path used during media processing. */
  assembledPath(fileId, ext, ctx) {
    return path3.join(this.rootDir, ctx.bucket || "default", `${fileId}_assembled${ext}`);
  }
  // ── StorageAdapter implementation ───────────────────────────────────────
  /**
   * Write one chunk to its own file (FIX [1] + [2]).
   * Writing is idempotent: retrying chunk N just overwrites the same file.
   */
  async writeChunk(fileId, chunkNumber, data, ctx) {
    const dest = this.chunkPath(fileId, chunkNumber, ctx);
    await this.ensureDir(path3.dirname(dest));
    await fs3.writeFile(dest, data);
    this.fileCtx.set(fileId, ctx);
  }
  /**
   * Stream all chunk files to a single assembled file on disk (FIX [3]).
   *
   * UploadEngine.assembleChunksToDisk() calls this first. Because it
   * exists on this adapter, the engine never falls through to the
   * missing readChunk() fallback.
   *
   * Returns the path of the assembled file so FFmpeg (or the engine's
   * single-quality path) can read directly from disk.
   */
  async assembleChunksToPath(fileId, totalChunks, ext, ctx) {
    const resolvedCtx = ctx ?? this.fileCtx.get(fileId);
    if (!resolvedCtx) {
      throw new Error(`[LocalDisk] No StorageContext for fileId "${fileId}"`);
    }
    const dest = this.assembledPath(fileId, ext, resolvedCtx);
    await this.ensureDir(path3.dirname(dest));
    const writeStream = fsCb.createWriteStream(dest);
    await new Promise((resolve, reject) => {
      writeStream.on("error", reject);
      writeStream.on("finish", resolve);
      (async () => {
        try {
          for (let i = 0; i < totalChunks; i++) {
            const chunkFile = this.chunkPath(fileId, i, resolvedCtx);
            const buf = await fs3.readFile(chunkFile);
            const ok = writeStream.write(buf);
            if (!ok) await new Promise((r) => writeStream.once("drain", r));
          }
          writeStream.end();
        } catch (err) {
          writeStream.destroy(err);
          reject(err);
        }
      })();
    });
    return dest;
  }
  /**
   * Concatenate chunk files into the final stored file, then remove the
   * chunk files (FIX [4]). Called by UploadEngine when no media
   * processing transformer is provided.
   */
  async finalize(fileId, ctx) {
    const resolvedCtx = ctx ?? this.fileCtx.get(fileId);
    if (!resolvedCtx) {
      throw new Error(`[LocalDisk] No StorageContext for fileId "${fileId}"`);
    }
    const totalChunks = resolvedCtx.chunkCount;
    const dest = this.finalPath(fileId, resolvedCtx);
    await this.ensureDir(path3.dirname(dest));
    const writeStream = fsCb.createWriteStream(dest);
    await new Promise((resolve, reject) => {
      writeStream.on("error", reject);
      writeStream.on("finish", resolve);
      (async () => {
        try {
          for (let i = 0; i < totalChunks; i++) {
            const chunkFile = this.chunkPath(fileId, i, resolvedCtx);
            const buf = await fs3.readFile(chunkFile);
            const ok = writeStream.write(buf);
            if (!ok) await new Promise((r) => writeStream.once("drain", r));
            await fs3.unlink(chunkFile).catch(() => {
            });
          }
          writeStream.end();
        } catch (err) {
          writeStream.destroy(err);
          reject(err);
        }
      })();
    });
    this.fileCtx.delete(fileId);
    const ref = path3.relative(this.rootDir, dest);
    return {
      storageRef: ref,
      url: this.publicBaseUrl ? `${this.publicBaseUrl.replace(/\/$/, "")}/${ref}` : void 0
    };
  }
  // ── putStream ────────────────────────────────────────────────────────────
  async putStream(fileId, stream, ctx) {
    const dest = this.finalPath(fileId, ctx);
    await this.ensureDir(path3.dirname(dest));
    const writeStream = fsCb.createWriteStream(dest);
    await new Promise((resolve, reject) => {
      writeStream.on("error", reject);
      writeStream.on("finish", resolve);
      stream.pipe(writeStream);
      stream.on("error", reject);
    });
    const ref = path3.relative(this.rootDir, dest);
    return {
      storageRef: ref,
      url: this.publicBaseUrl ? `${this.publicBaseUrl.replace(/\/$/, "")}/${ref}` : void 0
    };
  }
  /** Single-shot write for non-chunked uploads. */
  async putObject(fileId, data, ctx) {
    const dest = this.finalPath(fileId, ctx);
    await this.ensureDir(path3.dirname(dest));
    await fs3.writeFile(dest, data);
    const ref = path3.relative(this.rootDir, dest);
    return {
      storageRef: ref,
      url: this.publicBaseUrl ? `${this.publicBaseUrl.replace(/\/$/, "")}/${ref}` : void 0
    };
  }
  async readStream(ref, options) {
    return createReadStream2(path3.join(this.rootDir, ref), {
      start: options?.start,
      end: options?.end
    });
  }
  async delete(ref) {
    await fs3.unlink(path3.join(this.rootDir, ref)).catch(() => {
    });
  }
};

// src/adapters/storage/DatabaseStorageAdapter.ts
import { Readable } from "stream";
import * as os2 from "os";
import * as path4 from "path";
import * as fsCb2 from "fs";
var DEFAULT_STREAM_CHUNK_SIZE = 4 * 1024 * 1024;
function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input && typeof input === "object") {
    if (input.buffer && typeof input.buffer === "object") return Buffer.from(input.buffer);
    if (input.data) return Buffer.from(input.data);
    if (input.type === "Buffer" && Array.isArray(input.data)) return Buffer.from(input.data);
  }
  return Buffer.from(input);
}
var DatabaseStorageAdapter = class {
  name = "database";
  database;
  prefetchCount;
  tempDir;
  defaultStreamChunkSize;
  constructor(options) {
    if (!options.database.createChunk || !options.database.getChunk) {
      throw new Error(
        "[DatabaseStorageAdapter] The provided MetadataRepository does not implement createChunk / getChunk \u2014 DatabaseStorageAdapter cannot be used with it."
      );
    }
    this.database = options.database;
    this.prefetchCount = options.prefetchCount ?? 2;
    this.tempDir = options.tempDir ?? os2.tmpdir();
    this.defaultStreamChunkSize = options.defaultStreamChunkSize ?? DEFAULT_STREAM_CHUNK_SIZE;
  }
  // ── Core chunk write (original upload path — unchanged) ─────────────────
  async writeChunk(fileId, chunkNumber, data, ctx) {
    const safe = toBuffer(data);
    await this.database.createChunk({ fileId, chunkNumber, data: safe });
  }
  // ── assembleChunksToPath — streams chunk rows to a temp file on disk ────
  async assembleChunksToPath(fileId, totalChunks, ext, ctx) {
    const dest = path4.join(this.tempDir, `${fileId}_assembled${ext}`);
    const writeStream = fsCb2.createWriteStream(dest);
    await new Promise((resolve, reject) => {
      writeStream.on("error", reject);
      writeStream.on("finish", resolve);
      (async () => {
        try {
          for (let i = 0; i < totalChunks; i++) {
            const raw = await this.database.getChunk(fileId, i);
            if (!raw) {
              throw new Error(
                `[DatabaseStorageAdapter] Missing chunk ${i} for file "${fileId}"`
              );
            }
            const buf = toBuffer(raw);
            const ok = writeStream.write(buf);
            if (!ok) await new Promise((r) => writeStream.once("drain", r));
          }
          writeStream.end();
        } catch (err) {
          writeStream.destroy(err);
          reject(err);
        }
      })();
    });
    return dest;
  }
  // ── finalize ──────────────────────────────────────────────────────────
  async finalize(fileId, ctx) {
    return { storageRef: fileId };
  }
  // ── Single-shot write (small files / fallback) ───────────────────────────
  //
  // Still used directly for things like thumbnails, which are always small
  // (a few hundred KB JPEGs) and safely fit in one chunk document.
  async putObject(fileId, data, ctx) {
    const safe = toBuffer(data);
    if (safe.length > this.defaultStreamChunkSize) {
      console.warn(
        `[DatabaseStorageAdapter] putObject received ${safe.length} bytes for "${fileId}", exceeding the ${this.defaultStreamChunkSize} byte single-chunk safety threshold. Re-chunking in memory \u2014 prefer putStream() for large files.`
      );
      return this.writeBufferAsChunks(fileId, safe, this.resolveChunkSize(ctx));
    }
    await this.database.createChunk({ fileId, chunkNumber: 0, data: safe });
    return { storageRef: fileId };
  }
  /** Shared chunking logic for the in-memory guard-rail path in putObject(). */
  async writeBufferAsChunks(fileId, buffer, chunkSize) {
    const chunkCount = Math.max(1, Math.ceil(buffer.length / chunkSize));
    for (let i = 0; i < chunkCount; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, buffer.length);
      await this.database.createChunk({ fileId, chunkNumber: i, data: buffer.subarray(start, end) });
    }
    return { storageRef: fileId, chunkCount, chunkSize, totalSize: buffer.length };
  }
  // ── putStream — THE FIX ───────────────────────────────────────────────
  //
  // Reads `source` (e.g. fs.createReadStream(variantPath)) and writes it to
  // the database as a sequence of fixed-size chunk documents, never holding
  // more than ~chunkSize bytes in memory at once. This is what UploadEngine
  // calls for every encoded variant (and the primary/raw file) regardless
  // of size, so a 1.5GB 1080p variant is written the same way a 1.5GB
  // original upload was received: in pieces.
  //
  // Chunk-size selection — per explicit requirement, this REUSES the
  // ORIGINAL upload's chunkSize so the variant's chunk geometry matches the
  // source file's, with the correct "last chunk is a remainder, not padded"
  // behavior:
  //   e.g. a 5MB file uploaded in 2MB pieces is [2MB, 2MB, 1MB] — three
  //   chunks. If the encoded variant comes out to, say, 4.3MB, written with
  //   the SAME 2MB chunkSize it becomes [2MB, 2MB, 0.3MB] — still three
  //   chunks, last one sized to whatever is actually left. We do not pad,
  //   and we do not assume the variant's total size lines up evenly with
  //   chunkSize.
  //
  // ctx.chunkSize is expected to carry the original upload's chunk size
  // (UploadEngine sets this on storageCtx from the chunked-upload fields).
  // If absent (e.g. non-chunked single-shot upload), defaultStreamChunkSize
  // is used instead.
  async putStream(fileId, source, ctx) {
    const chunkSize = this.resolveChunkSize(ctx);
    let chunkNumber = 0;
    let totalBytes = 0;
    let pending = [];
    let pendingLength = 0;
    for await (const chunk of source) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      pending.push(buf);
      pendingLength += buf.length;
      while (pendingLength >= chunkSize) {
        let collected = 0;
        const pieces = [];
        while (collected < chunkSize && pending.length > 0) {
          const first = pending[0];
          const needed = chunkSize - collected;
          if (first.length <= needed) {
            pieces.push(first);
            collected += first.length;
            pending.shift();
            pendingLength -= first.length;
          } else {
            pieces.push(first.subarray(0, needed));
            collected += needed;
            pending[0] = first.subarray(needed);
            pendingLength -= needed;
          }
        }
        const piece = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, chunkSize);
        await this.database.createChunk({ fileId, chunkNumber, data: Buffer.from(piece) });
        chunkNumber += 1;
        totalBytes += piece.length;
      }
    }
    if (pendingLength > 0) {
      const piece = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLength);
      await this.database.createChunk({ fileId, chunkNumber, data: Buffer.from(piece) });
      chunkNumber += 1;
      totalBytes += piece.length;
    }
    if (chunkNumber === 0) {
      await this.database.createChunk({ fileId, chunkNumber: 0, data: Buffer.alloc(0) });
      chunkNumber = 1;
    }
    return {
      storageRef: fileId,
      chunkCount: chunkNumber,
      chunkSize,
      totalSize: totalBytes
    };
  }
  /**
   * Resolve the chunk size to use for re-chunking an outgoing stream.
   * Prefers the ORIGINAL upload's chunkSize (carried on StorageContext by
   * UploadEngine) so a variant's on-disk chunk geometry matches the source
   * file's. Falls back to defaultStreamChunkSize for non-chunked uploads.
   */
  resolveChunkSize(ctx) {
    const inherited = ctx?.chunkSize;
    if (typeof inherited === "number" && inherited > 0) return inherited;
    return this.defaultStreamChunkSize;
  }
  // ── Streaming read (unchanged) ───────────────────────────────────────────
  async readStream(ref, options) {
    const file = await this.database.getFileById(ref);
    if (!file) {
      throw new Error(`[DatabaseStorageAdapter] No file record found for ref "${ref}"`);
    }
    const startByte = options?.start ?? 0;
    const endByte = options?.end ?? file.size - 1;
    const chunkSize = file.chunkSize || file.size;
    const startChunk = chunkSize > 0 ? Math.floor(startByte / chunkSize) : 0;
    const endChunk = chunkSize > 0 ? Math.floor(endByte / chunkSize) : 0;
    return new ChunkReadStream({
      database: this.database,
      fileId: ref,
      chunkSize,
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
  async fetchChunk(chunkNumber) {
    const chunk = await this.opts.database.getChunk(this.opts.fileId, chunkNumber);
    if (!chunk) return null;
    return toBuffer(chunk);
  }
  prefetchAhead() {
    for (let i = 1; i <= this.opts.prefetchCount; i++) {
      const num = this.current + i;
      if (num > this.opts.endChunk || this.prefetch.has(num)) continue;
      this.prefetch.set(num, this.fetchChunk(num));
    }
  }
  chunkActualSize(chunkNumber) {
    const totalChunks = Math.ceil(this.opts.fileSize / this.opts.chunkSize);
    const isLast = chunkNumber === totalChunks - 1;
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
      const buffer = this.prefetch.has(this.current) ? await this.prefetch.get(this.current) : await this.fetchChunk(this.current);
      this.prefetch.delete(this.current);
      if (!buffer) {
        this.destroy(
          new Error(`Missing chunk ${this.current} for file ${this.opts.fileId}`)
        );
        return;
      }
      const isFirst = this.current === Math.floor(this.opts.startByte / this.opts.chunkSize);
      const isLast = this.current === Math.floor(this.opts.endByte / this.opts.chunkSize);
      const actualSize = this.chunkActualSize(this.current);
      let sliceStart = 0;
      let sliceEnd = Math.min(actualSize, buffer.length);
      if (isFirst) sliceStart = this.opts.startByte % this.opts.chunkSize;
      if (isLast)
        sliceEnd = Math.min(sliceEnd, this.opts.endByte % this.opts.chunkSize + 1);
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
import * as os3 from "os";
import * as path5 from "path";
import * as fsCb3 from "fs";
var MIN_S3_PART_SIZE = 5 * 1024 * 1024;
var S3StorageAdapter = class {
  name = "s3";
  options;
  _client;
  minPartSize;
  tempDir;
  /** Active multipart uploads keyed by fileId. */
  uploads = /* @__PURE__ */ new Map();
  /**
   * FIX [1]: Parallel cache of the raw engine-chunks (before S3-part
   * buffering) so assembleChunksToPath() can reconstruct the file
   * without downloading from S3.
   */
  partCache = /* @__PURE__ */ new Map();
  constructor(options) {
    this.options = options;
    this.minPartSize = options.minPartSize ?? MIN_S3_PART_SIZE;
    this.tempDir = options.tempDir ?? os3.tmpdir();
  }
  // ── SDK lazy-loader ──────────────────────────────────────────────────────
  async getClient() {
    if (this.options.client) return this.options.client;
    if (this._client) return this._client;
    let S3Client;
    try {
      ({ S3Client } = __require("@aws-sdk/client-s3"));
    } catch {
      throw new Error(
        '[upload-media/server] S3StorageAdapter requires "@aws-sdk/client-s3". Install it with: npm install @aws-sdk/client-s3'
      );
    }
    this._client = new S3Client({
      region: this.options.region,
      credentials: this.options.credentials,
      endpoint: this.options.endpoint,
      forcePathStyle: this.options.forcePathStyle
    });
    return this._client;
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
  // ── Key / URL builders ───────────────────────────────────────────────────
  buildKey(fileId, ctx) {
    if (this.options.buildKey) return this.options.buildKey(fileId, ctx);
    return `${ctx.bucket}/${fileId}`;
  }
  buildPublicUrl(key) {
    if (this.options.buildPublicUrl) {
      return this.options.buildPublicUrl(this.options.bucket, key);
    }
    if (this.options.endpoint) {
      return `${this.options.endpoint.replace(/\/$/, "")}/${this.options.bucket}/${key}`;
    }
    return `https://${this.options.bucket}.s3.${this.options.region}.amazonaws.com/${key}`;
  }
  // ── Part flusher ─────────────────────────────────────────────────────────
  async flushPart(state, sdk, client, isFinal) {
    if (state.bufferedBytes === 0) return;
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
  // ── writeChunk ───────────────────────────────────────────────────────────
  async writeChunk(fileId, chunkNumber, data, ctx) {
    const sdk = await this.loadCommands();
    const client = await this.getClient();
    if (!this.partCache.has(fileId)) this.partCache.set(fileId, []);
    this.partCache.get(fileId)[chunkNumber] = data;
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
  // ── assembleChunksToPath (FIX [1]) ───────────────────────────────────────
  //
  // Reads cached engine-chunks in order and writes them to a temp file.
  // The multipart upload on S3 is left open; finalize() completes it.
  async assembleChunksToPath(fileId, totalChunks, ext, ctx) {
    const cache = this.partCache.get(fileId);
    if (!cache || cache.length < totalChunks) {
      throw new Error(
        `[S3StorageAdapter] Part cache incomplete for fileId "${fileId}" (have ${cache?.length ?? 0}, need ${totalChunks})`
      );
    }
    const dest = path5.join(this.tempDir, `${fileId}_assembled${ext}`);
    const writeStream = fsCb3.createWriteStream(dest);
    await new Promise((resolve, reject) => {
      writeStream.on("error", reject);
      writeStream.on("finish", resolve);
      (async () => {
        try {
          for (let i = 0; i < totalChunks; i++) {
            const buf = cache[i];
            if (!buf) {
              throw new Error(
                `[S3StorageAdapter] Missing cached chunk ${i} for file "${fileId}"`
              );
            }
            const ok = writeStream.write(buf);
            if (!ok) await new Promise((r) => writeStream.once("drain", r));
          }
          writeStream.end();
        } catch (err) {
          writeStream.destroy(err);
          reject(err);
        }
      })();
    });
    return dest;
  }
  // ── finalize (FIX [2]) ───────────────────────────────────────────────────
  async finalize(fileId, ctx) {
    const sdk = await this.loadCommands();
    const client = await this.getClient();
    const state = this.uploads.get(fileId);
    if (!state) {
      throw new Error(
        `[S3StorageAdapter] No active multipart upload found for fileId "${fileId}"`
      );
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
    this.partCache.delete(fileId);
    return {
      storageRef: state.key,
      url: this.buildPublicUrl(state.key)
    };
  }
  // ── putStream ────────────────────────────────────────────────────────────
  async putStream(fileId, stream, ctx) {
    const sdk = await this.loadCommands();
    const client = await this.getClient();
    const key = this.buildKey(fileId, ctx);
    await client.send(
      new sdk.PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: stream,
        ContentType: ctx.contentType
      })
    );
    return { storageRef: key, url: this.buildPublicUrl(key) };
  }
  // ── putObject ────────────────────────────────────────────────────────────
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
  // ── readStream ───────────────────────────────────────────────────────────
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
  // ── delete ───────────────────────────────────────────────────────────────
  async delete(ref) {
    const sdk = await this.loadCommands();
    const client = await this.getClient();
    await client.send(
      new sdk.DeleteObjectCommand({ Bucket: this.options.bucket, Key: ref })
    );
  }
};

// src/adapters/storage/CloudinaryStorageAdapter.ts
import * as os4 from "os";
import * as path6 from "path";
import * as fsCb4 from "fs";
var CloudinaryStorageAdapter = class {
  name = "cloudinary";
  hasNativeVariantSupport = true;
  options;
  _cloudinary;
  tempDir;
  /** Active upload_large_stream sessions keyed by fileId. */
  pending = /* @__PURE__ */ new Map();
  /**
   * FIX [1]: Raw engine-chunks cached so assembleChunksToPath() can
   * reconstruct the file without re-downloading from Cloudinary.
   */
  chunkCache = /* @__PURE__ */ new Map();
  constructor(options) {
    this.options = options;
    this.tempDir = options.tempDir ?? os4.tmpdir();
  }
  // ── SDK lazy-loader ──────────────────────────────────────────────────────
  getSdk() {
    if (this._cloudinary) return this._cloudinary;
    if (this.options.cloudinary) {
      this._cloudinary = this.options.cloudinary;
      return this._cloudinary;
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
    this._cloudinary = cloudinary;
    return cloudinary;
  }
  // ── Helpers ──────────────────────────────────────────────────────────────
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
    const existing = this.pending.get(fileId);
    if (existing) return existing;
    const cloudinary = this.getSdk();
    const publicId = this.buildPublicId(fileId, ctx);
    let resolveDone;
    let rejectDone;
    const done = new Promise((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });
    const stream = cloudinary.uploader.upload_large_stream(
      {
        public_id: publicId,
        resource_type: this.resourceTypeFor(ctx.contentType),
        use_filename: true,
        unique_filename: false,
        chunk_size: 6 * 1024 * 1024
      },
      (error, result) => {
        if (error) rejectDone(error);
        else resolveDone(result);
      }
    );
    const entry = { stream, done };
    this.pending.set(fileId, entry);
    return entry;
  }
  // ── writeChunk ───────────────────────────────────────────────────────────
  async writeChunk(fileId, chunkNumber, data, ctx) {
    if (!this.chunkCache.has(fileId)) this.chunkCache.set(fileId, []);
    this.chunkCache.get(fileId)[chunkNumber] = data;
    const { stream } = this.getOrCreateUpload(fileId, ctx);
    const ok = stream.write(data);
    if (!ok) await new Promise((r) => stream.once("drain", r));
  }
  // ── assembleChunksToPath (FIX [1]) ───────────────────────────────────────
  //
  // Drains the chunkCache to a temp file in order. The in-progress
  // upload_large_stream is aborted here because the engine will
  // re-upload the processed file via putObject/putStream.
  async assembleChunksToPath(fileId, totalChunks, ext, ctx) {
    const cache = this.chunkCache.get(fileId);
    if (!cache || cache.length < totalChunks) {
      throw new Error(
        `[CloudinaryStorageAdapter] Chunk cache incomplete for fileId "${fileId}" (have ${cache?.length ?? 0}, need ${totalChunks})`
      );
    }
    const dest = path6.join(this.tempDir, `${fileId}_assembled${ext}`);
    const writeStream = fsCb4.createWriteStream(dest);
    await new Promise((resolve, reject) => {
      writeStream.on("error", reject);
      writeStream.on("finish", resolve);
      (async () => {
        try {
          for (let i = 0; i < totalChunks; i++) {
            const buf = cache[i];
            if (!buf) {
              throw new Error(
                `[CloudinaryStorageAdapter] Missing cached chunk ${i} for file "${fileId}"`
              );
            }
            const ok = writeStream.write(buf);
            if (!ok) await new Promise((r) => writeStream.once("drain", r));
          }
          writeStream.end();
        } catch (err) {
          writeStream.destroy(err);
          reject(err);
        }
      })();
    });
    this._abortPending(fileId);
    return dest;
  }
  /** Destroy the pending upload_large_stream without completing it. */
  _abortPending(fileId) {
    const entry = this.pending.get(fileId);
    if (entry) {
      try {
        entry.stream.destroy();
      } catch {
      }
      this.pending.delete(fileId);
    }
    this.chunkCache.delete(fileId);
  }
  // ── finalize (FIX [2]) ───────────────────────────────────────────────────
  //
  // Called by UploadEngine when NO media processing is configured.
  // Ends the upload_large_stream and waits for Cloudinary's confirmation.
  async finalize(fileId, ctx) {
    const entry = this.pending.get(fileId);
    if (!entry) {
      throw new Error(
        `[CloudinaryStorageAdapter] No active upload stream for fileId "${fileId}". If media processing is enabled, the engine re-uploads via putObject \u2014 do not call finalize() manually in that case.`
      );
    }
    entry.stream.end();
    const result = await entry.done;
    this.pending.delete(fileId);
    this.chunkCache.delete(fileId);
    return {
      storageRef: result.public_id,
      url: result.secure_url
    };
  }
  // ── putStream (FIX [4]) ──────────────────────────────────────────────────
  //
  // Called by UploadEngine.streamFileToStorage() for large processed files.
  // Pipes a readable stream directly into Cloudinary's upload_stream.
  async putStream(fileId, stream, ctx) {
    const cloudinary = this.getSdk();
    const publicId = this.buildPublicId(fileId, ctx);
    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id: publicId,
          resource_type: this.resourceTypeFor(ctx.contentType),
          use_filename: true,
          unique_filename: false
        },
        (error, res) => error ? reject(error) : resolve(res)
      );
      stream.pipe(uploadStream);
      stream.on("error", reject);
    });
    return { storageRef: result.public_id, url: result.secure_url };
  }
  // ── putObject ────────────────────────────────────────────────────────────
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
  // ── readStream ───────────────────────────────────────────────────────────
  async readStream(ref, _options) {
    const cloudinary = this.getSdk();
    const https = __require("https");
    const signedUrl = cloudinary.url(ref, { secure: true, resource_type: "auto" });
    return new Promise((resolve, reject) => {
      https.get(signedUrl, (response) => resolve(response)).on("error", reject);
    });
  }
  // ── delete ───────────────────────────────────────────────────────────────
  async delete(ref) {
    const cloudinary = this.getSdk();
    await cloudinary.uploader.destroy(ref, { resource_type: "auto" });
  }
};

// src/core/FileServingHandler.ts
import { createReadStream as createReadStream3 } from "fs";
import { promises as fs4 } from "fs";
import * as path7 from "path";
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
      fullPath = path7.join(this.rootDir, ref);
    } else {
      const uploadType = file?.uploadType || "avatar";
      fullPath = path7.join(this.rootDir, uploadType, ref);
      if (!await this.fileExists(fullPath)) {
        fullPath = path7.join(this.rootDir, ref);
      }
    }
    if (!fullPath.startsWith(this.rootDir)) {
      res.status(403);
      res.json({ error: "Forbidden - Path traversal detected" });
      return;
    }
    try {
      const stat = await fs4.stat(fullPath);
      const mimeType = file?.contentType || this.getMimeTypeFromExtension(fullPath);
      this.setHeaders(res, mimeType, stat.size, stat.ino, stat.mtime);
      if (start !== void 0 && end !== void 0) {
        res.status(206);
        res.header("Content-Range", `bytes ${start}-${end}/${stat.size}`);
        res.header("Content-Length", String(end - start + 1));
        const stream = createReadStream3(fullPath, { start, end });
        await res.pipeFrom(stream);
      } else {
        res.status(200);
        res.header("Content-Length", String(stat.size));
        const stream = createReadStream3(fullPath);
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
      await fs4.access(filePath);
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
    const ext = path7.extname(fullPath).toLowerCase();
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
    super({ highWaterMark: 1024 * 1024, objectMode: false, autoDestroy: true });
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
  /** Starting byte of a given chunk in the logical file */
  getChunkStartByte(chunkNumber) {
    return chunkNumber * this.fileChunkSize;
  }
  async fetchChunk(chunkNumber) {
    try {
      const raw = await this.database.getChunk(this.fileId, chunkNumber);
      if (!raw) {
        console.warn(`\u26A0\uFE0F Missing chunk ${chunkNumber} for file ${this.fileId}`);
        return null;
      }
      const buffer = this.normalizeBuffer(raw);
      if (!buffer || buffer.length === 0) {
        console.warn(`\u26A0\uFE0F Chunk ${chunkNumber} is empty or unreadable`);
        return null;
      }
      return { buffer, chunkNumber };
    } catch (err) {
      console.error(`Error fetching chunk ${chunkNumber}:`, err);
      return null;
    }
  }
  normalizeBuffer(input) {
    if (!input) return null;
    if (Buffer.isBuffer(input)) return input;
    if (input && typeof input === "object" && input._bsontype === "Binary") {
      if (input.buffer) return Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer);
      try {
        return Buffer.from(input);
      } catch {
        return null;
      }
    }
    if (input && typeof input === "object" && input.buffer) {
      if (Buffer.isBuffer(input.buffer)) return input.buffer;
      if (ArrayBuffer.isView(input.buffer)) return Buffer.from(input.buffer.buffer, input.buffer.byteOffset, input.buffer.byteLength);
      if (input.buffer instanceof ArrayBuffer) return Buffer.from(input.buffer);
      try {
        return Buffer.from(input.buffer);
      } catch {
      }
    }
    if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (typeof input === "string") return Buffer.from(input, "utf-8");
    try {
      const c = Buffer.from(input);
      return c.length > 0 ? c : null;
    } catch {
      return null;
    }
  }
  prefetchChunks() {
    if (this.prefetchInProgress || this.destroyed) return;
    this.prefetchInProgress = true;
    for (let i = 1; i <= PREFETCH_COUNT; i++) {
      const n = this.currentChunk + i;
      if (n > this.endChunk || this.prefetchQueue.has(n)) continue;
      const p = this.fetchChunk(n);
      this.prefetchQueue.set(n, p);
      p.finally(() => {
        setTimeout(() => this.prefetchQueue.delete(n), 2e3);
      });
    }
    this.prefetchInProgress = false;
  }
  async _read() {
    if (this.destroyed || this.isReading) return;
    if (this.currentChunk > this.endChunk) {
      this.push(null);
      this.cleanup();
      return;
    }
    this.isReading = true;
    try {
      let chunkData;
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
        this.isReading = false;
        return;
      }
      const bufLen = chunkData.buffer.length;
      const chunkStartByte = this.getChunkStartByte(this.currentChunk);
      let sliceStart = 0;
      let sliceEnd = bufLen;
      const rangeStartChunk = Math.floor(this.startOffset / this.fileChunkSize);
      if (this.currentChunk === rangeStartChunk) {
        sliceStart = this.startOffset - chunkStartByte;
      }
      const rangeEndChunk = Math.floor(this.endOffset / this.fileChunkSize);
      if (this.currentChunk === rangeEndChunk) {
        sliceEnd = Math.min(bufLen, this.endOffset - chunkStartByte + 1);
      }
      sliceStart = Math.max(0, Math.min(sliceStart, bufLen));
      sliceEnd = Math.max(0, Math.min(sliceEnd, bufLen));
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
      if (!this.destroyed && this.currentChunk <= this.endChunk) this.prefetchChunks();
      if (canPush && this.currentChunk <= this.endChunk && !this.destroyed) setImmediate(() => this._read());
    } catch (err) {
      this.isReading = false;
      if (!this.destroyed) this.destroy(err);
    }
  }
  cleanup() {
    this.prefetchQueue.clear();
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
import path8 from "path";
import fs5 from "fs/promises";
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
    const fullPath = path8.resolve(
      this.rootDir,
      ref
    );
    if (!fullPath.startsWith(
      path8.resolve(
        this.rootDir
      )
    )) {
      throw createError({
        statusCode: 403,
        statusMessage: "Forbidden"
      });
    }
    try {
      const stat = await fs5.stat(
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
      const fileBuffer = await fs5.readFile(
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
    return path8.basename(ref).replace(
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
  toBuffer,
  verifySignature
};
