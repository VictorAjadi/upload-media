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

// src/hooks/useVideoTrimmer.ts
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

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
    high: {
      maxWidth: 1920,
      maxHeight: 1080,
      bitrate: "4M",
      crf: 21,
      preset: "fast"
    },
    medium: {
      maxWidth: 1280,
      maxHeight: 720,
      bitrate: "2.5M",
      crf: 23,
      preset: "fast"
    },
    low: {
      maxWidth: 800,
      maxHeight: 480,
      bitrate: "1M",
      crf: 28,
      preset: "ultrafast"
    }
  },
  image: {
    high: {
      maxWidth: 1920,
      maxHeight: 1080,
      quality: 0.9
    },
    medium: {
      maxWidth: 1280,
      maxHeight: 720,
      quality: 0.7
    },
    low: {
      maxWidth: 800,
      maxHeight: 600,
      quality: 0.5
    }
  },
  audio: {
    high: { bitrate: "320k" },
    medium: { bitrate: "128k" },
    low: { bitrate: "64k" }
  }
};
var DEFAULT_MAX_RETRIES = 3;
var CHUNK_SIZES = DEFAULT_CHUNK_SIZES;
var MAX_RETRIES = DEFAULT_MAX_RETRIES;

// src/hooks/useVideoTrimmer.ts
var ResourceManager = class {
  resources = /* @__PURE__ */ new Set();
  ffmpegInstance = null;
  encoders = /* @__PURE__ */ new Set();
  decoders = /* @__PURE__ */ new Set();
  videoFrames = /* @__PURE__ */ new Set();
  register(cleanup) {
    this.resources.add(cleanup);
  }
  registerEncoder(encoder) {
    this.encoders.add(encoder);
  }
  registerDecoder(decoder) {
    this.decoders.add(decoder);
  }
  registerVideoFrame(frame) {
    this.videoFrames.add(frame);
  }
  removeVideoFrame(frame) {
    this.videoFrames.delete(frame);
  }
  setFFmpeg(instance) {
    this.ffmpegInstance = instance;
  }
  cleanup() {
    this.videoFrames.forEach((frame) => {
      try {
        if (frame && typeof frame.close === "function") {
          frame.close();
        }
      } catch (error) {
        console.warn("VideoFrame cleanup error:", error);
      }
    });
    this.videoFrames.clear();
    this.encoders.forEach((encoder) => {
      try {
        if (encoder && encoder.state !== "closed") {
          encoder.close();
        }
      } catch (error) {
        console.warn("Encoder cleanup error:", error);
      }
    });
    this.encoders.clear();
    this.decoders.forEach((decoder) => {
      try {
        if (decoder && decoder.state !== "closed") {
          decoder.close();
        }
      } catch (error) {
        console.warn("Decoder cleanup error:", error);
      }
    });
    this.decoders.clear();
    this.resources.forEach((cleanup) => {
      try {
        cleanup();
      } catch (error) {
        console.warn("Cleanup error:", error);
      }
    });
    this.resources.clear();
    if (this.ffmpegInstance) {
      this.ffmpegInstance = null;
    }
  }
};
var VideoTrimmer = class _VideoTrimmer {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
  }
  callbacks;
  abortController = null;
  isProcessing = false;
  resources = new ResourceManager();
  ffmpeg = null;
  ffmpegLoaded = false;
  async trimVideo(file, options) {
    if (this.isProcessing) {
      throw new Error("Another trimming operation is already in progress");
    }
    this.validateInputs(file, options);
    this.isProcessing = true;
    this.abortController = new AbortController();
    try {
      return await this.performTrimming(file, options);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      this.callbacks.onError?.(errorMessage);
      throw new Error(errorMessage);
    } finally {
      this.cleanup();
    }
  }
  validateInputs(file, options) {
    if (!file || file.size === 0) {
      throw new Error("Invalid or empty file provided");
    }
    if (!file.type.startsWith("video/")) {
      throw new Error("File must be a video");
    }
    if (options.startTime != null && (!isFinite(options.startTime) || options.startTime < 0)) {
      throw new Error("Invalid start time specified");
    }
    if (options.endTime != null && (!isFinite(options.endTime) || options.endTime < 0)) {
      throw new Error("Invalid end time specified");
    }
  }
  async performTrimming(file, options) {
    const metadata = await this.getEnhancedVideoMetadata(file);
    this.emitProgress(10);
    const { startTime, endTime } = this.validateTimeBounds(options, metadata.duration);
    this.emitProgress(15);
    const method = this.selectOptimalMethod(file, options, metadata, endTime - startTime);
    this.emitProgress(20);
    switch (method) {
      case "webcodecs":
        return await this.trimWithWebCodecs(file, startTime, endTime, options, metadata);
      case "optimized-recording":
        return await this.trimWithOptimizedRecording(file, startTime, endTime, options, metadata);
      case "ffmpeg":
        try {
          return await this.trimWithOptimizedFFmpeg(file, startTime, endTime, options, metadata);
        } catch (error) {
          if (this.supportsWebCodecs()) {
            return await this.trimWithWebCodecs(file, startTime, endTime, options, metadata);
          } else {
            return await this.trimWithOptimizedRecording(file, startTime, endTime, options, metadata);
          }
        }
      default:
        return await this.trimWithOptimizedRecording(file, startTime, endTime, options, metadata);
    }
  }
  selectOptimalMethod(file, options, _metadata, trimDuration) {
    if (options.useFFmpeg) {
      return "ffmpeg";
    }
    const fileSizeMB = file.size / (1024 * 1024);
    const isLargeFile = fileSizeMB > 50;
    const isLongTrim = trimDuration > 60;
    if (this.supportsWebCodecs() && (file.type.includes("mp4") || file.type.includes("webm")) && !isLargeFile && !isLongTrim) {
      return "webcodecs";
    }
    return "optimized-recording";
  }
  async trimWithOptimizedFFmpeg(file, startTime, endTime, options, metadata) {
    try {
      const ffmpeg = await this.loadFFmpeg();
      this.emitProgress(25);
      const inputFileName = `input.${this.getFileExtension(file.type)}`;
      const outputFormat = options.outputFormat || "mp4";
      const outputFileName = `output.${outputFormat}`;
      await ffmpeg.writeFile(inputFileName, await fetchFile(file));
      this.emitProgress(35);
      const duration = endTime - startTime;
      const args = [
        "-i",
        inputFileName,
        "-ss",
        startTime.toFixed(3),
        "-t",
        duration.toFixed(3),
        "-avoid_negative_ts",
        "make_zero"
      ];
      if (options.fastMode !== false) {
        args.push(
          "-c",
          "copy",
          "-avoid_negative_ts",
          "make_zero"
        );
      } else {
        const quality = options.quality || "medium";
        const qConfig = QUALITY_MAPPINGS.video[quality];
        args.push("-crf", qConfig.crf.toString(), "-preset", qConfig.preset, "-maxrate", qConfig.bitrate, "-bufsize", (parseInt(qConfig.bitrate) * 2).toString() + "M");
        if (options.mute || !metadata.hasAudio) {
          args.push("-an");
        } else {
          args.push("-c:a", "aac", "-b:a", "128k");
        }
        if (outputFormat === "mp4") {
          args.push(
            "-c:v",
            "libx264",
            "-movflags",
            "+faststart",
            "-profile:v",
            "baseline",
            "-level",
            "3.1"
          );
          if (metadata.width > 1920 || metadata.height > 1080) {
            args.push("-vf", "scale=1920:1080:force_original_aspect_ratio=decrease");
          }
        }
      }
      args.push(outputFileName);
      await ffmpeg.exec(args);
      this.emitProgress(90);
      const data = await ffmpeg.readFile(outputFileName);
      try {
        await ffmpeg.deleteFile(inputFileName);
        await ffmpeg.deleteFile(outputFileName);
      } catch (e) {
      }
      this.emitProgress(100);
      const mimeType = this.getMimeTypeFromFormat(outputFormat);
      return new Blob([data], { type: mimeType });
    } catch (error) {
      throw error;
    }
  }
  async loadFFmpeg() {
    if (this.ffmpeg && this.ffmpegLoaded) {
      return this.ffmpeg;
    }
    try {
      this.ffmpeg = new FFmpeg();
      this.ffmpeg.on("progress", ({ progress }) => {
        const adjustedProgress = 25 + progress * 65;
        this.emitProgress(adjustedProgress);
      });
      const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
      await this.ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm")
      });
      this.ffmpegLoaded = true;
      this.resources.setFFmpeg(this.ffmpeg);
      return this.ffmpeg;
    } catch (error) {
      throw new Error("FFmpeg not available");
    }
  }
  // Enhanced WebCodecs implementation
  async trimWithWebCodecs(file, startTime, endTime, options, metadata) {
    this.emitProgress(30);
    try {
      const { VideoDecoder, VideoEncoder, VideoFrame } = window;
      if (!VideoDecoder || !VideoEncoder || !VideoFrame) {
        throw new Error("WebCodecs not supported");
      }
      const chunks = [];
      let frameCount = 0;
      const targetFrameRate = options.fastMode ? 24 : Math.min(metadata.frameRate, 30);
      const frameDuration = 1 / targetFrameRate;
      const { width, height } = this.getSafeEncoderDimensions(metadata.width, metadata.height);
      const encoderConfig = {
        codec: "avc1.42001f",
        // H.264 baseline profile - most compatible
        width,
        height,
        bitrate: this.calculateWebCodecsBitrate(options, width, height, targetFrameRate),
        framerate: targetFrameRate,
        keyInterval: Math.floor(targetFrameRate * 2),
        latencyMode: "realtime",
        bitrateMode: "constant"
      };
      const encoder = new VideoEncoder({
        output: (chunk) => {
          try {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            chunks.push(data);
          } catch (error) {
            console.warn("Chunk processing error:", error);
          }
        },
        error: (error) => {
          throw new Error(`WebCodecs encoding error: ${error.message}`);
        }
      });
      encoder.configure(encoderConfig);
      this.resources.registerEncoder(encoder);
      this.emitProgress(40);
      const video = await this.createOptimizedVideo(file);
      await this.seekToTime(video, startTime);
      this.emitProgress(50);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", {
        alpha: false,
        desynchronized: true,
        powerPreference: "high-performance"
      });
      this.resources.register(() => canvas.remove());
      return new Promise(async (resolve, reject) => {
        let currentTime = startTime;
        let encodedFrames = 0;
        const totalFrames = Math.ceil((endTime - startTime) * targetFrameRate);
        const batchSize = options.fastMode ? 5 : 3;
        const processBatch = async () => {
          try {
            for (let i = 0; i < batchSize && currentTime < endTime; i++) {
              if (this.abortController?.signal.aborted) {
                reject(new Error("Operation cancelled"));
                return;
              }
              video.currentTime = currentTime;
              await new Promise((resolveSeek) => setTimeout(resolveSeek, 16));
              ctx.drawImage(video, 0, 0, metadata.width, metadata.height, 0, 0, width, height);
              const videoFrame = new VideoFrame(canvas, {
                timestamp: frameCount * frameDuration * 1e6,
                duration: frameDuration * 1e6
              });
              this.resources.registerVideoFrame(videoFrame);
              try {
                if (encoder.state === "configured") {
                  encoder.encode(videoFrame, { keyFrame: frameCount % (targetFrameRate * 2) === 0 });
                }
              } finally {
                videoFrame.close();
                this.resources.removeVideoFrame(videoFrame);
              }
              frameCount++;
              encodedFrames++;
              currentTime += frameDuration;
            }
            const progress = 50 + encodedFrames / totalFrames * 45;
            this.emitProgress(Math.min(95, progress));
            if (currentTime >= endTime) {
              await encoder.flush();
              if (chunks.length === 0) {
                reject(new Error("No frames were encoded"));
                return;
              }
              const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
              const combined = new Uint8Array(totalLength);
              let offset = 0;
              for (const chunk of chunks) {
                combined.set(chunk, offset);
                offset += chunk.length;
              }
              this.emitProgress(100);
              resolve(new Blob([combined], { type: "video/mp4" }));
            } else {
              setTimeout(processBatch, 8);
            }
          } catch (error) {
            reject(error);
          }
        };
        processBatch();
      });
    } catch (error) {
      console.warn("WebCodecs trimming failed:", error);
      return await this.trimWithOptimizedRecording(file, startTime, endTime, options, metadata);
    }
  }
  calculateWebCodecsBitrate(options, width, height, frameRate) {
    const pixels = width * height;
    const quality = options.quality || "medium";
    const bppRates = {
      low: 0.05,
      // bits per pixel per frame
      medium: 0.1,
      // reduced from 0.15
      high: 0.15
      // reduced from 0.25
    };
    let bitrate = pixels * frameRate * bppRates[quality];
    bitrate = Math.max(5e5, Math.min(8e6, bitrate));
    return Math.floor(bitrate);
  }
  // Enhanced recording method with better performance
  async trimWithOptimizedRecording(file, startTime, endTime, options, metadata) {
    this.emitProgress(30);
    const video = await this.createOptimizedVideo(file);
    const duration = endTime - startTime;
    const { width, height } = this.getOptimalDimensions(
      metadata.width,
      metadata.height,
      options.fastMode
    );
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.style.display = "none";
    const ctx = canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
      willReadFrequently: false
    });
    document.body.appendChild(canvas);
    this.resources.register(() => canvas.remove());
    this.emitProgress(40);
    const frameRate = options.fastMode ? 24 : Math.min(30, Math.max(20, metadata.frameRate));
    const stream = canvas.captureStream(frameRate);
    if (!options.mute && metadata.hasAudio) {
      await this.addOptimizedAudio(stream, video);
    }
    this.emitProgress(50);
    const mimeType = this.getBestRecordingMimeType();
    const bitrate = this.calculateOptimalBitrate(options.quality || "medium", duration, metadata);
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: bitrate,
      audioBitsPerSecond: options.mute ? void 0 : 128e3
    });
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data?.size > 0) {
        chunks.push(event.data);
      }
    };
    return new Promise(async (resolve, reject) => {
      let isCompleted = false;
      const complete = () => {
        if (isCompleted) return;
        isCompleted = true;
        if (chunks.length === 0) {
          reject(new Error("No video data recorded"));
          return;
        }
        const blob = new Blob(chunks, { type: recorder.mimeType });
        this.emitProgress(100);
        this.callbacks.onComplete?.(blob);
        resolve(blob);
      };
      recorder.onstop = complete;
      recorder.onerror = (event) => {
        if (!isCompleted) {
          reject(new Error(`Recording failed: ${event}`));
        }
      };
      try {
        await this.seekToTime(video, startTime);
        this.emitProgress(60);
        recorder.start(100);
        video.playbackRate = 1;
        await video.play();
        let startTimestamp = performance.now();
        let lastProgressUpdate = 0;
        const frameInterval = 1e3 / frameRate;
        const renderFrame = () => {
          if (isCompleted || this.abortController?.signal.aborted) {
            return;
          }
          const elapsed = (performance.now() - startTimestamp) / 1e3;
          if (elapsed >= duration || video.currentTime >= endTime) {
            video.pause();
            if (recorder.state === "recording") {
              recorder.stop();
            }
            return;
          }
          try {
            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(video, 0, 0, width, height);
            const now = performance.now();
            if (now - lastProgressUpdate > 300) {
              const progress = 60 + elapsed / duration * 35;
              this.emitProgress(Math.min(95, progress));
              lastProgressUpdate = now;
            }
            requestAnimationFrame(renderFrame);
          } catch (error) {
            console.warn("Frame rendering error:", error);
            setTimeout(renderFrame, frameInterval);
          }
        };
        renderFrame();
        const safetyTimeout = setTimeout(() => {
          if (!isCompleted) {
            video.pause();
            if (recorder.state === "recording") {
              recorder.stop();
            }
          }
        }, duration * 1e3 + 5e3);
        this.resources.register(() => clearTimeout(safetyTimeout));
      } catch (error) {
        if (!isCompleted) {
          reject(error);
        }
      }
    });
  }
  // Rest of the methods with minor optimizations
  async getEnhancedVideoMetadata(file) {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      const url = URL.createObjectURL(file);
      this.resources.register(() => {
        URL.revokeObjectURL(url);
        video.src = "";
        video.remove();
      });
      const timeout = setTimeout(() => reject(new Error("Metadata timeout")), 8e3);
      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener("loadedmetadata", onLoad);
        video.removeEventListener("error", onError);
      };
      const onLoad = async () => {
        cleanup();
        if (!isFinite(video.duration) || video.duration <= 0) {
          reject(new Error("Invalid video duration"));
          return;
        }
        let frameRate = 30;
        let hasAudio = true;
        resolve({
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
          hasAudio,
          frameRate,
          bitrate: Math.round(file.size * 8 / video.duration),
          codec: file.type.includes("mp4") ? "h264" : "vp8",
          audioCodec: file.type.includes("mp4") ? "aac" : "opus"
        });
      };
      const onError = (e) => {
        cleanup();
        reject(new Error(`Failed to load video metadata: ${e.message || "Unknown error"}`));
      };
      video.addEventListener("loadedmetadata", onLoad);
      video.addEventListener("error", onError);
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.src = url;
    });
  }
  validateTimeBounds(options, duration) {
    const startTime = Math.max(0, Math.min(options.startTime ?? 0, duration - 0.033));
    const endTime = Math.min(duration, Math.max(options.endTime ?? duration, startTime + 0.033));
    if (endTime < startTime) {
      throw new Error(`Invalid time range: ${startTime}s - ${endTime}s (duration: ${duration}s)`);
    }
    return { startTime, endTime };
  }
  supportsWebCodecs() {
    return typeof window !== "undefined" && "VideoDecoder" in window && "VideoEncoder" in window && "VideoFrame" in window;
  }
  getSafeEncoderDimensions(width, height) {
    let w = Math.max(16, Math.floor(width / 16) * 16);
    let h = Math.max(16, Math.floor(height / 16) * 16);
    const maxWidth = 1280;
    const maxHeight = 720;
    if (w > maxWidth || h > maxHeight) {
      const aspectRatio = w / h;
      if (aspectRatio > 1) {
        w = maxWidth;
        h = Math.floor(maxWidth / aspectRatio / 16) * 16;
      } else {
        h = maxHeight;
        w = Math.floor(maxHeight * aspectRatio / 16) * 16;
      }
    }
    return { width: Math.max(16, w), height: Math.max(16, h) };
  }
  async createOptimizedVideo(file) {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      const url = URL.createObjectURL(file);
      this.resources.register(() => {
        URL.revokeObjectURL(url);
        video.src = "";
        video.remove();
      });
      const timeout = setTimeout(() => {
        reject(new Error("Video loading timeout"));
      }, 15e3);
      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener("canplaythrough", onReady);
        video.removeEventListener("error", onError);
      };
      const onReady = () => {
        cleanup();
        resolve(video);
      };
      const onError = (e) => {
        cleanup();
        reject(new Error(`Video load failed: ${e.message || "Unknown error"}`));
      };
      video.addEventListener("canplaythrough", onReady, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;
      video.disablePictureInPicture = true;
      video.disableRemotePlaybook = true;
      video.controls = false;
      video.style.display = "none";
      document.body.appendChild(video);
      video.src = url;
    });
  }
  async seekToTime(video, time) {
    return new Promise((resolve, reject) => {
      if (Math.abs(video.currentTime - time) < 0.1) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        video.removeEventListener("seeked", onSeeked);
        reject(new Error("Seek timeout"));
      }, 2e3);
      const onSeeked = () => {
        clearTimeout(timeout);
        video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      video.addEventListener("seeked", onSeeked, { once: true });
      video.currentTime = Math.max(0, Math.min(time, video.duration - 1e-3));
    });
  }
  async addOptimizedAudio(stream, video) {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: "playback",
        sampleRate: 44100
        // Reduced sample rate for performance
      });
      const source = audioContext.createMediaElementSource(video);
      const destination = audioContext.createMediaStreamDestination();
      source.connect(destination);
      source.connect(audioContext.destination);
      destination.stream.getAudioTracks().forEach((track) => {
        stream.addTrack(track);
      });
      this.resources.register(() => {
        audioContext.close().catch(() => {
        });
      });
    } catch (error) {
      console.warn("Audio processing failed:", error);
    }
  }
  getOptimalDimensions(width, height, fastMode) {
    let w = Math.max(2, Math.floor(width / 2) * 2);
    let h = Math.max(2, Math.floor(height / 2) * 2);
    const aspectRatio = w / h;
    const maxDimension = fastMode ? 1280 : 1920;
    const minDimension = 320;
    if (w > maxDimension || h > maxDimension) {
      if (w > h) {
        w = maxDimension;
        h = Math.floor(maxDimension / aspectRatio / 2) * 2;
      } else {
        h = maxDimension;
        w = Math.floor(maxDimension * aspectRatio / 2) * 2;
      }
    }
    if (w < minDimension && h < minDimension) {
      if (w > h) {
        w = minDimension;
        h = Math.floor(minDimension / aspectRatio / 2) * 2;
      } else {
        h = minDimension;
        w = Math.floor(minDimension * aspectRatio / 2) * 2;
      }
    }
    return {
      width: Math.max(2, w),
      height: Math.max(2, h)
    };
  }
  getBestRecordingMimeType() {
    const preferredTypes = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=h264,opus",
      "video/mp4;codecs=h264,aac",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
      "video/mp4"
    ];
    for (const type of preferredTypes) {
      try {
        if (MediaRecorder.isTypeSupported(type)) {
          return type;
        }
      } catch (e) {
        continue;
      }
    }
    return "video/webm";
  }
  getFileExtension(mimeType) {
    const extensions = {
      "video/mp4": "mp4",
      "video/webm": "webm",
      "video/quicktime": "mov",
      "video/x-msvideo": "avi",
      "video/x-matroska": "mkv"
    };
    return extensions[mimeType] || "mp4";
  }
  getMimeTypeFromFormat(format) {
    const mimeTypes = {
      "mp4": "video/mp4",
      "webm": "video/webm",
      "mkv": "video/x-matroska",
      "mov": "video/quicktime",
      "avi": "video/x-msvideo",
      "flv": "video/x-flv"
    };
    return mimeTypes[format] || "video/mp4";
  }
  calculateOptimalBitrate(quality = "medium", duration, metadata) {
    const baseRates = {
      low: 8e5,
      // 0.8 Mbps
      medium: 2e6,
      // 2 Mbps  
      high: 4e6
      // 4 Mbps
    };
    let bitrate = baseRates[quality] || baseRates.medium;
    const pixels = metadata.width * metadata.height;
    if (pixels > 2073600) {
      bitrate *= 1.3;
    } else if (pixels > 921600) {
      bitrate *= 1;
    } else if (pixels < 307200) {
      bitrate *= 0.6;
    }
    if (metadata.frameRate > 30) {
      bitrate *= Math.min(1.5, metadata.frameRate / 30);
    }
    if (duration > 60) bitrate *= 0.9;
    if (duration > 300) bitrate *= 0.8;
    return Math.max(5e5, Math.floor(bitrate));
  }
  emitProgress(progress) {
    const clampedProgress = Math.max(0, Math.min(100, Math.round(progress)));
    this.callbacks.onProgress?.(clampedProgress);
  }
  cleanup() {
    this.resources.cleanup();
    this.isProcessing = false;
    this.abortController = null;
  }
  cancel() {
    if (this.abortController) {
      this.abortController.abort();
      this.callbacks.onCancel?.();
    }
    this.cleanup();
  }
  isProcessingVideo() {
    return this.isProcessing;
  }
  // Enhanced static method with better defaults
  static async trim(file, options) {
    const callbacks = {
      onProgress: options.onProgress,
      onError: (error) => console.error("VideoTrimmer error:", error),
      onComplete: (blob) => console.log("VideoTrimmer completed:", blob.size, "bytes")
    };
    const trimmer = new _VideoTrimmer(callbacks);
    const enhancedOptions = {
      ...options,
      fastMode: options.fastMode !== false,
      // Default to true
      quality: options.quality || "medium"
    };
    if (options.preferredMethod && options.preferredMethod !== "auto") {
      if (options.preferredMethod === "ffmpeg") {
        enhancedOptions.useFFmpeg = true;
      }
    }
    return trimmer.trimVideo(file, enhancedOptions);
  }
  // Utility method to get video info without trimming
  static async getVideoInfo(file) {
    const trimmer = new _VideoTrimmer();
    try {
      return await trimmer.getEnhancedVideoMetadata(file);
    } finally {
      trimmer.cleanup();
    }
  }
  // Enhanced capabilities check
  static getCapabilities() {
    const supportedInputs = [
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "video/x-msvideo",
      "video/x-matroska"
    ];
    const supportedOutputs = ["mp4", "webm"];
    let recommendedMethod = "optimized-recording";
    if (typeof window !== "undefined" && "VideoDecoder" in window && "VideoEncoder" in window) {
      recommendedMethod = "webcodecs";
    }
    return {
      ffmpegSupported: typeof window !== "undefined",
      webCodecsSupported: typeof window !== "undefined" && "VideoDecoder" in window && "VideoEncoder" in window,
      supportedInputFormats: supportedInputs,
      supportedOutputFormats: supportedOutputs,
      recommendedMethod
    };
  }
  // Method to estimate processing time with better accuracy
  static estimateProcessingTime(file, trimDuration, method = "auto", fastMode = true) {
    const fileSizeMB = file.size / (1024 * 1024);
    const speedMultiplier = fastMode ? 0.6 : 1;
    const baseEstimates = {
      ffmpeg: Math.max(3, (trimDuration * 0.2 + fileSizeMB * 0.08) * speedMultiplier),
      webcodecs: Math.max(2, (trimDuration * 0.6 + fileSizeMB * 0.03) * speedMultiplier),
      recording: Math.max(trimDuration * 1.05, (trimDuration * 1.1 + fileSizeMB * 0.01) * speedMultiplier)
    };
    if (method === "auto") {
      return baseEstimates.recording;
    }
    return baseEstimates[method] || baseEstimates.recording;
  }
  // New method to suggest optimal settings
  static suggestOptimalSettings(file, trimDuration) {
    const fileSizeMB = file.size / (1024 * 1024);
    const isLargeFile = fileSizeMB > 100;
    const isLongTrim = trimDuration > 120;
    let quality = "medium";
    if (fileSizeMB < 10 && trimDuration < 30) {
      quality = "high";
    } else if (isLargeFile || isLongTrim) {
      quality = "low";
    }
    const fastMode = isLargeFile || isLongTrim || fileSizeMB > 50;
    let preferredMethod = "recording";
    if (this.getCapabilities().webCodecsSupported && !isLargeFile && file.type.includes("mp4")) {
      preferredMethod = "webcodecs";
    }
    const outputFormat = file.type.includes("webm") ? "webm" : "mp4";
    return {
      quality,
      fastMode,
      preferredMethod,
      outputFormat
    };
  }
};
var useVideoTrimmer = (callbacks = {}) => {
  const trimmer = new VideoTrimmer(callbacks);
  return {
    trimVideo: (file, options) => trimmer.trimVideo(file, options),
    getCapabilities: () => VideoTrimmer.getCapabilities(),
    suggestSettings: (file, trimDuration) => VideoTrimmer.suggestOptimalSettings(file, trimDuration)
  };
};

// src/store/useUploadProgress.ts
import { createStore } from "zustand/vanilla";
import { persist, createJSONStorage } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { enableMapSet } from "immer";

// src/hooks/useAudioTrimmer.ts
import { FFmpeg as FFmpeg2 } from "@ffmpeg/ffmpeg";
import { fetchFile as fetchFile2, toBlobURL as toBlobURL2 } from "@ffmpeg/util";
var AudioResourceManager = class {
  resources = /* @__PURE__ */ new Set();
  ffmpegInstance = null;
  register(cleanup) {
    if (typeof cleanup === "function") {
      this.resources.add(cleanup);
    }
  }
  setFFmpeg(instance) {
    if (this.ffmpegInstance && this.ffmpegInstance !== instance) {
      try {
        this.ffmpegInstance.terminate?.();
      } catch (error) {
        console.warn("Audio cleanup error:", error);
      }
    }
    this.ffmpegInstance = instance;
  }
  cleanup() {
    this.resources.forEach((cleanup) => {
      try {
        cleanup();
      } catch (error) {
        console.warn("Audio cleanup error:", error);
      }
    });
    this.resources.clear();
    if (this.ffmpegInstance) {
      try {
        this.ffmpegInstance.terminate?.();
      } catch (error) {
        console.warn("Audio cleanup error:", error);
      }
      this.ffmpegInstance = null;
    }
  }
};
var AudioTrimmer = class {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
  }
  callbacks;
  isProcessing = false;
  resources = new AudioResourceManager();
  ffmpeg = null;
  ffmpegLoaded = false;
  async trimAudio(file, options) {
    if (this.isProcessing) {
      throw new Error("Another audio processing operation is already in progress");
    }
    if (!file || !(file instanceof Blob)) {
      throw new Error("Invalid file provided");
    }
    this.isProcessing = true;
    try {
      return await this.performAudioTrimming(file, options);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      console.error("[AudioTrimmer] Error:", errorMessage);
      this.callbacks.onError?.(errorMessage);
      throw error;
    } finally {
      this.resources.cleanup();
      this.isProcessing = false;
    }
  }
  async performAudioTrimming(file, options) {
    const metadata = await this.getAudioMetadata(file);
    const ffmpeg = await this.loadFFmpeg();
    this.emitProgress(15);
    const startTime = options.startTime ?? 0;
    const endTime = options.endTime ?? metadata.duration;
    const duration = endTime - startTime;
    if (duration <= 0) {
      throw new Error("Invalid trim duration");
    }
    const inputExt = this.getFileExtension(file.type) || "mp3";
    const inputFileName = `input.${inputExt}`;
    const outputFormat = options.outputFormat || "mp3";
    const outputFileName = `output.${outputFormat}`;
    await ffmpeg.writeFile(inputFileName, await fetchFile2(file));
    this.emitProgress(30);
    const quality = options.quality || "medium";
    const qConfig = QUALITY_MAPPINGS.audio[quality];
    const args = [
      "-i",
      inputFileName,
      "-ss",
      startTime.toFixed(3),
      "-t",
      duration.toFixed(3),
      "-b:a",
      qConfig.bitrate,
      outputFileName
    ];
    await ffmpeg.exec(args);
    this.emitProgress(90);
    const data = await ffmpeg.readFile(outputFileName);
    try {
      await ffmpeg.deleteFile(inputFileName);
      await ffmpeg.deleteFile(outputFileName);
    } catch (e) {
      console.warn("[AudioTrimmer] Failed to cleanup FFmpeg files:", e);
    }
    this.emitProgress(100);
    const mimeType = this.getMimeTypeFromFormat(outputFormat);
    return new Blob([data], { type: mimeType });
  }
  async getAudioMetadata(file) {
    return new Promise((resolve, reject) => {
      const audio = new Audio();
      const url = URL.createObjectURL(file);
      const cleanup = () => {
        URL.revokeObjectURL(url);
        audio.remove();
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Audio metadata timeout"));
      }, 5e3);
      const handleMetadata = () => {
        clearTimeout(timeout);
        const duration = audio.duration;
        if (!isFinite(duration) || isNaN(duration)) {
          cleanup();
          reject(new Error("Invalid audio duration"));
          return;
        }
        cleanup();
        resolve({ duration });
      };
      const handleError = () => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error("Failed to load audio metadata"));
      };
      audio.addEventListener("loadedmetadata", handleMetadata, { once: true });
      audio.addEventListener("error", handleError, { once: true });
      audio.preload = "metadata";
      audio.src = url;
    });
  }
  async loadFFmpeg() {
    if (this.ffmpeg && this.ffmpegLoaded) {
      return this.ffmpeg;
    }
    try {
      this.ffmpeg = new FFmpeg2();
      this.ffmpeg.on("progress", ({ progress }) => {
        const adjustedProgress = 20 + progress * 70;
        this.emitProgress(Math.min(100, Math.max(0, adjustedProgress)));
      });
      const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
      await this.ffmpeg.load({
        coreURL: await toBlobURL2(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL2(`${baseURL}/ffmpeg-core.wasm`, "application/wasm")
      });
      this.ffmpegLoaded = true;
      this.resources.setFFmpeg(this.ffmpeg);
      return this.ffmpeg;
    } catch (error) {
      console.error("[AudioTrimmer] FFmpeg load failed:", error);
      throw new Error("FFmpeg not available for audio processing");
    }
  }
  emitProgress(progress) {
    const clampedProgress = Math.min(100, Math.max(0, Math.round(progress)));
    this.callbacks.onProgress?.(clampedProgress);
  }
  getFileExtension(mimeType) {
    const map = {
      "audio/mpeg": "mp3",
      "audio/mp3": "mp3",
      "audio/wav": "wav",
      "audio/x-wav": "wav",
      "audio/aac": "aac",
      "audio/ogg": "ogg",
      "audio/mp4": "m4a",
      "audio/x-m4a": "m4a"
    };
    return map[mimeType] || "mp3";
  }
  getMimeTypeFromFormat(format) {
    const map = {
      "mp3": "audio/mpeg",
      "wav": "audio/wav",
      "aac": "audio/aac",
      "ogg": "audio/ogg",
      "m4a": "audio/mp4"
    };
    return map[format] || "audio/mpeg";
  }
};

// src/store/useUploadProgress.ts
enableMapSet();
var CHUNK_SIZES2 = {
  video: 2 * 1024 * 1024,
  audio: 2 * 1024 * 1024,
  image: 1 * 1024 * 1024,
  document: 5 * 1024 * 1024
};
var MAX_CONCURRENT_UPLOADS = 5;
var MAX_RETRIES2 = 3;
function getChunkSizeForFileType(fileType) {
  if (fileType.startsWith("video/")) return CHUNK_SIZES2.video;
  if (fileType.startsWith("audio/")) return CHUNK_SIZES2.audio;
  if (fileType.startsWith("image/")) return CHUNK_SIZES2.image;
  return CHUNK_SIZES2.document;
}
var speedCalculators = /* @__PURE__ */ new Map();
var useUploadProgress = createStore()(
  persist(
    immer((set, get) => ({
      uploads: [],
      activeWorkers: /* @__PURE__ */ new Map(),
      uploadQueue: /* @__PURE__ */ new Map(),
      concurrentUploads: 0,
      addUpload: (params) => {
        set((state) => {
          const newUpload = {
            uploadId: params.uploadId,
            files: [{
              fileIndex: 0,
              fileName: params.fileName,
              fileSize: params.fileSize,
              fileType: params.fileType,
              progress: 0,
              chunkIndex: 0,
              totalChunks: 0,
              status: "pending",
              needsModification: false,
              isModified: false
            }],
            overallProgress: 0,
            status: "initializing",
            startTime: Date.now(),
            canResume: false,
            allFilesSessionId: [],
            retryCount: 0,
            maxRetries: MAX_RETRIES2,
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
            duration: params.duration
          };
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
        const { uploadId, blobs, endpoint, method, postData, metadata, videoStartTime, videoEndTime, duration, filenameArray, modificationConfigs, uploadType, transformer } = params;
        const transformerConfigs = blobs.map((_, index) => ({
          needsTransformation: transformer ? true : false,
          isTransformed: false,
          config: transformer
        }));
        set((state) => {
          state.uploads = state.uploads.filter((u) => u.uploadId !== uploadId);
          const { videoState } = getUploadMediaConfig();
          const { videos } = videoState.getState();
          const fileItems = blobs.map((file, index) => ({
            fileIndex: index,
            fileName: filenameArray?.[index] ?? "",
            fileSize: file.size,
            fileType: file.type,
            progress: 0,
            chunkIndex: 0,
            totalChunks: Math.ceil(file.size / getChunkSizeForFileType(file.type)),
            status: "pending",
            needsModification: modificationConfigs?.[index]?.needsModification || false,
            isModified: false,
            modificationProgress: 0,
            ...videos[index] || {
              startTime: 0,
              endTime: null,
              isMuted: false,
              videoDuration: null
            },
            needsTransformation: transformer ? true : false,
            isTransformed: false
          }));
          const newUpload = {
            uploadId,
            files: fileItems,
            overallProgress: 0,
            status: "initializing",
            startTime: Date.now(),
            canResume: false,
            retryCount: 0,
            maxRetries: MAX_RETRIES2,
            fileName: filenameArray?.[0] || "",
            fileSize: blobs[0]?.size || 0,
            fileType: blobs[0]?.type || "",
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
          type: "upload",
          uploadId,
          blobArray: blobs,
          filenameArray,
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
      handleThumbnailRequest: async (message) => {
        const { uploadId, fileIndex } = message;
        if (fileIndex === void 0) return;
        const upload = get().getUpload(uploadId);
        if (!upload) {
          const worker = get().activeWorkers.get(uploadId);
          if (worker) {
            worker.postMessage({
              type: "thumbnail_error",
              uploadId,
              fileIndex,
              error: "Upload not found"
            });
          }
          return;
        }
        set((state) => {
          const uploadToUpdate = state.uploads.find((u) => u.uploadId === uploadId);
          if (uploadToUpdate) {
            uploadToUpdate.status = "generating_thumbnail";
            if (uploadToUpdate.files[fileIndex]) {
              uploadToUpdate.files[fileIndex].status = "generating_thumbnail";
            }
          }
        });
        try {
          const worker = get().activeWorkers.get(uploadId);
          if (!worker) {
            throw new Error("Worker not found");
          }
          worker.postMessage({
            type: "get_thumbnail_data",
            uploadId,
            fileIndex
          });
        } catch (error) {
          const worker = get().activeWorkers.get(uploadId);
          if (worker) {
            worker.postMessage({
              type: "thumbnail_error",
              uploadId,
              fileIndex,
              error: error instanceof Error ? error.message : "Failed to request thumbnail"
            });
          }
        }
      },
      generateThumbnail: async (uploadId, fileIndex, blob) => {
        const upload = get().getUpload(uploadId);
        if (!upload) throw new Error("Upload not found");
        try {
          const thumbnailBase64 = await generateVideoThumbnail(blob);
          set((state) => {
            const uploadToUpdate = state.uploads.find((u) => u.uploadId === uploadId);
            if (uploadToUpdate && uploadToUpdate.files[fileIndex]) {
              uploadToUpdate.files[fileIndex].status = "uploading";
            }
          });
          return thumbnailBase64;
        } catch (error) {
          set((state) => {
            const uploadToUpdate = state.uploads.find((u) => u.uploadId === uploadId);
            if (uploadToUpdate && uploadToUpdate.files[fileIndex]) {
              uploadToUpdate.files[fileIndex].status = "uploading";
            }
          });
          throw error;
        }
      },
      handleModificationRequest: async (message) => {
        const { uploadId, fileIndex } = message;
        if (fileIndex === void 0) return;
        const upload = get().getUpload(uploadId);
        if (!upload) {
          return;
        }
        set((state) => {
          const uploadToUpdate = state.uploads.find((u) => u.uploadId === uploadId);
          if (uploadToUpdate) {
            uploadToUpdate.status = "modifying";
            uploadToUpdate.currentModifyingIndex = fileIndex;
            if (uploadToUpdate.files[fileIndex]) {
              uploadToUpdate.files[fileIndex].status = "modifying";
            }
          }
        });
        try {
          const worker = get().activeWorkers.get(uploadId);
          if (!worker) {
            return;
          }
          worker.postMessage({
            type: "get_file_data",
            uploadId,
            fileIndex
          });
        } catch (error) {
        }
      },
      handleTransformationRequest: async (message) => {
        const { uploadId, fileIndex, transformer } = message;
        if (fileIndex === void 0) return;
        const upload = get().getUpload(uploadId);
        if (!upload) return;
        set((state) => {
          const uploadToUpdate = state.uploads.find((u) => u.uploadId === uploadId);
          if (uploadToUpdate) {
            uploadToUpdate.status = "transforming";
            if (uploadToUpdate.files[fileIndex]) {
              uploadToUpdate.files[fileIndex].status = "transforming";
            }
          }
        });
        try {
          const worker = get().activeWorkers.get(uploadId);
          if (worker) {
            worker.postMessage({
              type: "get_file_data_for_trans",
              // New worker message type
              uploadId,
              fileIndex,
              transformer
            });
          }
        } catch (error) {
        }
      },
      modifyFile: async (uploadId, fileIndex, blob, config) => {
        const upload = get().getUpload(uploadId);
        if (!upload) throw new Error("Upload not found");
        set((state) => {
          const uploadToUpdate = state.uploads.find((u) => u.uploadId === uploadId);
          if (uploadToUpdate && uploadToUpdate.files[fileIndex]) {
            uploadToUpdate.files[fileIndex].modificationProgress = 0;
            uploadToUpdate.files[fileIndex].status = "modifying";
          }
        });
        const updateStoreProgress = (progress) => {
          set((state) => {
            const uploadToUpdate = state.uploads.find((u) => u.uploadId === uploadId);
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
            } else if (typeof customResult === "object" && customResult !== null) {
              const qualityKey = config.quality?.toString() || "medium";
              if (customResult[qualityKey]) {
                return customResult[qualityKey];
              }
            }
          }
          let modifiedBlob;
          if (config?.type === "image" || blob.type.startsWith("image/")) {
            modifiedBlob = await processImage(blob, config.quality || "medium", updateStoreProgress);
          } else if (config?.type === "video" || blob.type.startsWith("video/")) {
            const uploadToUpdate = useUploadProgress.getState().uploads.find((u) => u.uploadId === uploadId);
            if (!uploadToUpdate) throw new Error("Can not find upload data!");
            modifiedBlob = await processVideo(blob, config.quality || "medium", config.videoKey || "0", uploadToUpdate.files[fileIndex], updateStoreProgress);
          } else if (config?.type === "audio" || blob.type.startsWith("audio/")) {
            modifiedBlob = await processAudio(blob, config.quality || "medium", updateStoreProgress);
          } else {
            modifiedBlob = blob;
          }
          set((state) => {
            const uploadToUpdate = state.uploads.find((u) => u.uploadId === uploadId);
            if (uploadToUpdate && uploadToUpdate.files[fileIndex]) {
              uploadToUpdate.files[fileIndex].isModified = true;
              uploadToUpdate.files[fileIndex].status = "pending";
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
            const uploadToUpdate = state.uploads.find((u) => u.uploadId === uploadId);
            if (uploadToUpdate && uploadToUpdate.files[fileIndex]) {
              uploadToUpdate.files[fileIndex].status = "failed";
              uploadToUpdate.files[fileIndex].error = error instanceof Error ? error.message : "Modification failed";
            }
          });
          throw error;
        }
      },
      updateProgress: (uploadId, params) => {
        set((state) => {
          const upload = state.uploads.find((u) => u.uploadId === uploadId);
          if (!upload) return;
          upload.overallProgress = params.progress;
          upload.progress = params.progress;
          if (params?.status) upload.status = params?.status;
          if (params?.error) upload.error = params?.error;
          if (params?.speed !== void 0) upload.speed = params?.speed;
          if (params?.timeRemaining !== void 0) upload.timeRemaining = params?.timeRemaining;
          if (upload.files.length === 1 && upload.files[0]) {
            upload.files[0].progress = params.progress;
            if (params?.status) upload.files[0].status = params?.status;
            if (params?.error) upload.files[0].error = params?.error;
          }
          const calculator = speedCalculators.get(uploadId);
          if (calculator && params?.progress < 100) {
            const now = Date.now();
            calculator.samples.push({ timestamp: now, progress: params.progress });
            calculator.samples = calculator.samples.filter((s) => now - s.timestamp < 1e4);
            if (calculator.samples.length >= 2) {
              const oldest = calculator.samples[0];
              const latest = calculator.samples[calculator.samples.length - 1];
              const timeDiff = (latest.timestamp - oldest.timestamp) / 1e3;
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
          const calculator = speedCalculators.get(message.uploadId);
          if (calculator && overallProgress < 100) {
            const now = Date.now();
            calculator.samples.push({ timestamp: now, progress: overallProgress });
            calculator.samples = calculator.samples.filter((s) => now - s.timestamp < 1e4);
            if (calculator.samples.length >= 2) {
              const oldest = calculator.samples[0];
              const latest = calculator.samples[calculator.samples.length - 1];
              const timeDiff = (latest.timestamp - oldest.timestamp) / 1e3;
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
          const upload = state.uploads.find((u) => u.uploadId === uploadId);
          if (!upload) return;
          upload.endTime = Date.now();
          upload.status = success ? "completed" : "failed";
          upload.overallProgress = success ? 100 : upload.overallProgress;
          upload.progress = success ? 100 : upload.progress;
          if (error) upload.error = error;
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
        if (!upload || upload?.status !== "paused") {
          return;
        }
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
        if (!upload || upload.retryCount >= upload.maxRetries) {
          return;
        }
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
        worker.postMessage({
          type: "resume",
          uploadId
        });
      },
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
                      const fileType = metadata.type?.split("/")[0] || "document";
                      const chunkSize = CHUNK_SIZES2[fileType] || CHUNK_SIZES2.document;
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
                        sessionId: record.allFilesSessionId?.[index],
                        needsModification: record.modificationConfigs?.[index]?.needsModification || false,
                        isModified: record.modificationConfigs?.[index]?.isModified || false
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
                    maxRetries: record.maxRetries || MAX_RETRIES2,
                    fileName: record.filenames?.[0] || "",
                    fileSize: record.fileSize || 0,
                    fileType: record.fileType || "",
                    progress: overallProgress,
                    endpoint: record.endpoint,
                    method: record.method,
                    postData: record.postData,
                    metadata: record.metadata,
                    modificationConfigs: record.modificationConfigs,
                    videoStartTime: record.videoStartTime,
                    videoEndTime: record.videoEndTime,
                    duration: record.duration,
                    uploadType: record.uploadType
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
        const { showToast } = getUploadMediaConfig();
        worker.onmessage = async (event) => {
          const message = event.data;
          switch (message.type) {
            case "request_token":
              try {
                const { getCookie } = getUploadMediaConfig();
                const token = getCookie ? await getCookie() : null;
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
            case "request_encrypt":
              try {
                const { encryptQueryString } = getUploadMediaConfig();
                const encrypted = encryptQueryString ? await encryptQueryString(message.data) : JSON.stringify(message.data);
                const workerInstance = get().activeWorkers.get(uploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: "encrypt_response",
                    requestId: message.requestId,
                    encrypted
                  });
                }
              } catch (error) {
                const workerInstance = get().activeWorkers.get(uploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: "encrypt_response",
                    requestId: message.requestId,
                    encrypted: null,
                    error: error instanceof Error ? error.message : "Encryption failed"
                  });
                }
              }
              break;
            case "AUTH_REDIRECT":
              if (typeof window !== "undefined") {
                window.location.href = message.data?.url || "/auth";
              }
              break;
            case "request_modification":
              get().handleModificationRequest(message);
              break;
            case "request_thumbnail":
              get().handleThumbnailRequest(message);
              break;
            case "request_transformation":
              get().handleTransformationRequest(message);
              break;
            case "send_thumbnail_data":
              try {
                const { uploadId: reqUploadId, fileIndex, blob } = message;
                if (!blob) {
                  throw new Error("No blob received from worker");
                }
                let blobToProcess;
                if (blob instanceof Blob) {
                  blobToProcess = blob;
                } else if (blob instanceof ArrayBuffer) {
                  const upload = get().getUpload(reqUploadId);
                  const fileType = upload?.files[fileIndex]?.fileType || "video/mp4";
                  blobToProcess = new Blob([blob], { type: fileType });
                } else {
                  throw new Error("Invalid blob data received");
                }
                const thumbnailBase64 = await generateVideoThumbnail(blobToProcess);
                const workerInstance = get().activeWorkers.get(reqUploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: "thumbnail_complete",
                    uploadId: reqUploadId,
                    fileIndex,
                    thumbnailBase64
                  });
                }
                set((state) => {
                  const uploadToUpdate = state.uploads.find((u) => u.uploadId === reqUploadId);
                  if (uploadToUpdate && uploadToUpdate.files[fileIndex]) {
                    uploadToUpdate.files[fileIndex].status = "uploading";
                    uploadToUpdate.status = "uploading";
                  }
                });
              } catch (error) {
                const { uploadId: reqUploadId, fileIndex } = message;
                const workerInstance = get().activeWorkers.get(reqUploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: "thumbnail_error",
                    uploadId: reqUploadId,
                    fileIndex,
                    error: error instanceof Error ? error.message : "Thumbnail generation failed"
                  });
                }
                set((state) => {
                  const uploadToUpdate = state.uploads.find((u) => u.uploadId === reqUploadId);
                  if (uploadToUpdate && uploadToUpdate.files[fileIndex]) {
                    uploadToUpdate.files[fileIndex].status = "uploading";
                    uploadToUpdate.status = "uploading";
                  }
                });
              }
              break;
            case "send_file_data":
              try {
                const { uploadId: reqUploadId, fileIndex, blob, config } = message;
                if (!blob) {
                  throw new Error("No blob received from worker");
                }
                let blobToModify;
                if (blob instanceof Blob) {
                  blobToModify = blob;
                } else if (blob instanceof ArrayBuffer) {
                  const upload = get().getUpload(reqUploadId);
                  const fileType = upload?.files[fileIndex]?.fileType || "video/mp4";
                  blobToModify = new Blob([blob], { type: fileType });
                } else {
                  throw new Error("Invalid blob data received");
                }
                const modifiedBlob = await get().modifyFile(reqUploadId, fileIndex, blobToModify, config);
                const workerInstance = get().activeWorkers.get(reqUploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: "modification_complete",
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
                    type: "modification_error",
                    uploadId: errUploadId,
                    fileIndex,
                    error: error instanceof Error ? error.message : "Modification failed"
                  });
                }
                set((state) => {
                  const uploadToUpdate = state.uploads.find((u) => u.uploadId === errUploadId);
                  if (uploadToUpdate) {
                    uploadToUpdate.status = "failed";
                    uploadToUpdate.error = error instanceof Error ? error.message : "Modification failed";
                    if (uploadToUpdate.files[fileIndex]) {
                      uploadToUpdate.files[fileIndex].status = "failed";
                      uploadToUpdate.files[fileIndex].error = error instanceof Error ? error.message : "Modification failed";
                    }
                  }
                });
              }
              break;
            case "upload_started":
              break;
            case "resumed":
              break;
            case "upload_paused":
              break;
            case "progress":
            case "chunk_progress":
              get().updateUploadProgress(message);
              break;
            case "success":
              get().finalizeUpload(uploadId, true, message.data);
              showToast.success(message.message || "Upload completed successfully");
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
              showToast.error(message.message || "Upload failed");
              break;
            case "init_error":
              get().finalizeUpload(uploadId, false, void 0, `Initialization error: ${message.message}`);
              showToast.error(message.message || "Failed to initialize upload");
              break;
            case "paused":
              break;
            case "cancelled":
              break;
            case "clear_error":
              break;
            case "finalize_error":
              break;
            case "progress_cleared":
              break;
            case "resume_available":
              get().handleResumeResponse(message);
              break;
            case "no_resume_data":
              showToast.warning(`No resume data found for ${uploadId}.`);
              break;
            case "max_retries_reached":
              get().finalizeUpload(uploadId, false, void 0, message.message);
              showToast.warning(message.message || "Maximum retries reached");
              break;
            case "pause_error":
              console.error("[Worker] Pause error:", message.message);
              showToast.error(`Failed to pause: ${message.message}`);
              break;
            case "resume_error":
              console.error("[Worker] Resume error:", message.message);
              showToast.error(`Failed to resume: ${message.message}`);
              break;
            case "cancel_error":
              console.error("[Worker] Cancel error:", message.message);
              showToast.error(`Failed to cancel: ${message.message}`);
              break;
            case "progress_error":
              console.error("[Worker] Progress error:", message.message);
              break;
            case "send_file_data_for_trans":
              try {
                const { uploadId: reqUploadId, fileIndex, blob, transformer } = message;
                if (!blob) throw new Error("No blob received");
                let blobToTransform;
                if (blob instanceof Blob) {
                  blobToTransform = blob;
                } else {
                  const upload = get().getUpload(reqUploadId);
                  const fileType = upload?.files[fileIndex]?.fileType || "image/jpeg";
                  blobToTransform = new Blob([blob], { type: fileType });
                }
                const qualities = transformer?.qualities || [transformer?.quality || "medium"];
                const transformedResults = {};
                for (const q of qualities) {
                  const config = {
                    type: blobToTransform.type.startsWith("video/") ? "video" : "image",
                    quality: q,
                    ...transformer
                  };
                  transformedResults[q.toString()] = await get().modifyFile(reqUploadId, fileIndex, blobToTransform, config);
                }
                const workerInstance = get().activeWorkers.get(reqUploadId);
                if (workerInstance) {
                  workerInstance.postMessage({
                    type: "transformation_complete",
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
                    type: "transformation_error",
                    uploadId: errUploadId,
                    fileIndex,
                    error: error instanceof Error ? error.message : "Transformation failed"
                  });
                }
              }
              break;
            default:
              if (event.data?.data?.status && event.data?.data?.message) {
                if (event.data?.data?.status === "success") {
                  showToast.success(`Message from upload: ${event.data?.data?.message}`);
                } else if (event.data?.data?.status === "error" || event.data?.data?.status === "fail") {
                  showToast.error(`Message from upload: ${event.data?.data?.message}`);
                }
              }
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
      get totalProgress() {
        const { uploads } = get();
        if (uploads.length === 0) return 0;
        return uploads.reduce((sum, upload) => sum + upload.overallProgress, 0) / uploads.length;
      },
      get activeUploads() {
        return get().uploads.filter(
          (u) => u.status === "uploading" || u.status === "initializing" || u.status === "modifying"
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
        uploads: state.uploads.filter(
          (u) => u?.status === "paused" || u?.status === "failed"
        )
      })
    }
  )
);
var processImage = async (file, quality, onProgress) => {
  if (file.type === "image/gif") {
    onProgress(100);
    return new Blob([file], { type: file.type });
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      onProgress(20);
      const img = new Image();
      img.onload = () => {
        onProgress(40);
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Failed to get canvas context"));
          return;
        }
        let maxWidth, maxHeight, qualityLevel, isUpscaling = false, isDownscaling = false;
        const originalFormat = file.type;
        if (typeof quality === "number") {
          qualityLevel = Math.max(0, Math.min(150, quality)) / 100;
          maxWidth = 1280;
          maxHeight = 720;
        } else {
          switch (quality) {
            case "high":
              maxWidth = 1920;
              maxHeight = 1080;
              qualityLevel = 0.95;
              break;
            case "medium":
              maxWidth = 1280;
              maxHeight = 720;
              qualityLevel = 0.8;
              break;
            case "low":
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
        if (quality === "high" && (width < maxWidth || height < maxHeight)) {
          const scaleX = maxWidth / width;
          const scaleY = maxHeight / height;
          const enhancementFactor = Math.min(scaleX, scaleY, 1.2);
          if (enhancementFactor > 1) {
            width = Math.round(width * enhancementFactor);
            height = Math.round(height * enhancementFactor);
          }
        }
        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const finalPixels = width * height;
        if (width > originalWidth || height > originalHeight) {
          isUpscaling = true;
          qualityLevel = 1;
        }
        if (finalPixels < originalPixels) {
          isDownscaling = true;
        }
        if (!isUpscaling && !isDownscaling && quality === "high") {
          onProgress(100);
          resolve(file);
          return;
        }
        onProgress(60);
        canvas.width = width;
        canvas.height = height;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, width, height);
        if (!isUpscaling || quality === "high") {
          try {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            const original = new Uint8ClampedArray(data);
            const sharpenKernel = [0, -0.5, 0, -0.5, 3, -0.5, 0, -0.5, 0];
            const sharpenStrength = isUpscaling ? 0.5 : isDownscaling ? 0.4 : 0.3;
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
                  data[idx + c] = Math.max(0, Math.min(
                    255,
                    Math.round(original[idx + c] * (1 - sharpenStrength) + sum * sharpenStrength)
                  ));
                }
              }
            }
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
            console.warn("Image enhancement failed:", error);
          }
        }
        onProgress(80);
        const outputFormat = isDownscaling ? "image/jpeg" : originalFormat === "image/png" ? "image/png" : "image/webp";
        const encodingQuality = isDownscaling ? qualityLevel : 1;
        canvas.toBlob((blob) => {
          onProgress(100);
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error("Failed to create image blob"));
          }
        }, outputFormat, encodingQuality);
      };
      img.onerror = () => {
        reject(new Error("Failed to load image"));
      };
      img.src = e.target?.result;
    };
    reader.onerror = () => {
      reject(new Error("Failed to read image file"));
    };
    reader.readAsDataURL(file);
  });
};
var processVideo = async (file, quality, videoKey, filedata, onProgress) => {
  const { videoState } = getUploadMediaConfig();
  const { clearVideoState } = videoState.getState();
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
    }
  });
  if (videoKey) {
    clearVideoState(videoKey);
  }
  const fileType = file.type;
  const lastModifiedDate = (/* @__PURE__ */ new Date()).getTime();
  const main_file = new File([file], filedata.fileName, {
    type: fileType,
    lastModified: lastModifiedDate
  });
  return await trimmer.trimVideo(main_file, {
    startTime: filedata?.startTime,
    endTime: filedata?.endTime,
    mute: filedata?.isMuted,
    quality,
    useFFmpeg: true,
    outputFormat: "mp4"
  });
};
var processAudio = async (file, quality, onProgress) => {
  const trimmer = new AudioTrimmer({
    onProgress(progress) {
      onProgress(progress);
    },
    onError(error) {
      console.error("[AudioTrimmer Error]", error);
      onProgress(0);
    }
  });
  return await trimmer.trimAudio(file, {
    quality,
    useFFmpeg: true,
    outputFormat: "mp3"
  });
};
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
async function generateVideoThumbnail(videoBlob) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("Failed to get canvas context"));
      return;
    }
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    const cleanup = () => {
      URL.revokeObjectURL(video.src);
      video.remove();
      canvas.remove();
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Thumbnail generation timeout"));
    }, 3e4);
    video.onloadedmetadata = () => {
      const seekTime = Math.min(5, video.duration * 0.5);
      video.currentTime = seekTime;
    };
    video.onseeked = () => {
      try {
        canvas.width = 320;
        canvas.height = 180;
        const videoAspect = video.videoWidth / video.videoHeight;
        const canvasAspect = canvas.width / canvas.height;
        let sourceX = 0;
        let sourceY = 0;
        let sourceWidth = video.videoWidth;
        let sourceHeight = video.videoHeight;
        if (videoAspect > canvasAspect) {
          sourceWidth = video.videoHeight * canvasAspect;
          sourceX = (video.videoWidth - sourceWidth) / 2;
        } else {
          sourceHeight = video.videoWidth / canvasAspect;
          sourceY = (video.videoHeight - sourceHeight) / 2;
        }
        ctx.drawImage(
          video,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          canvas.width,
          canvas.height
        );
        canvas.toBlob((blob) => {
          if (!blob) {
            cleanup();
            clearTimeout(timeout);
            reject(new Error("Failed to create thumbnail blob"));
            return;
          }
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64 = reader.result;
            if (blob.size > 1024 * 1024) {
              canvas.toBlob((optimizedBlob) => {
                if (!optimizedBlob) {
                  cleanup();
                  clearTimeout(timeout);
                  reject(new Error("Failed to optimize thumbnail"));
                  return;
                }
                const optimizedReader = new FileReader();
                optimizedReader.onloadend = () => {
                  cleanup();
                  clearTimeout(timeout);
                  resolve(optimizedReader.result);
                };
                optimizedReader.onerror = () => {
                  cleanup();
                  clearTimeout(timeout);
                  reject(new Error("Failed to read optimized thumbnail"));
                };
                optimizedReader.readAsDataURL(optimizedBlob);
              }, "image/jpeg", 0.8);
            } else {
              cleanup();
              clearTimeout(timeout);
              resolve(base64);
            }
          };
          reader.onerror = () => {
            cleanup();
            clearTimeout(timeout);
            reject(new Error("Failed to read thumbnail"));
          };
          reader.readAsDataURL(blob);
        }, "image/jpeg", 1);
      } catch (error) {
        cleanup();
        clearTimeout(timeout);
        reject(error);
      }
    };
    video.onerror = () => {
      cleanup();
      clearTimeout(timeout);
      reject(new Error("Failed to load video for thumbnail"));
    };
    video.src = URL.createObjectURL(videoBlob);
  });
}

// src/utils/sessionId.ts
function generateSessionId() {
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  return `${randomStr}-${timestamp}`;
}

// src/manager/UploadManager.ts
var UploadManager = class {
  worker = null;
  uploads = /* @__PURE__ */ new Map();
  config;
  eventListeners = /* @__PURE__ */ new Map();
  constructor(config = {}) {
    this.config = {
      workerUrl: config.workerUrl || new URL("./upload.worker.ts", import.meta.url).href,
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
   * Initialize and setup Web Worker
   */
  initializeWorker() {
    try {
      this.worker = new Worker(this.config.workerUrl, { type: "module" });
      this.worker.onmessage = (event) => {
        this.handleWorkerMessage(event.data);
      };
      this.worker.onerror = (error) => {
        console.log(error);
        this.config.onError?.(new Error(`Worker error: ${error.message}`));
      };
    } catch (error) {
      console.error("Failed to initialize worker:", error);
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
          totalChunks: Math.ceil(file.size / (CHUNK_SIZES[file.type.split("/")[0]] || 1024 * 1024)),
          status: "pending",
          needsModification: false,
          isModified: false
        })),
        overallProgress: 0,
        status: "initializing",
        startTime: Date.now(),
        retryCount: 0,
        maxRetries: MAX_RETRIES,
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
export {
  UploadManager,
  VideoTrimmer,
  cleanupUploadResources,
  getUploadMediaConfig,
  setUploadMediaConfig,
  useUploadActions,
  useUploadProgress,
  useVideoTrimmer
};
