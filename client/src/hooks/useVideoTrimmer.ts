import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { QUALITY_MAPPINGS } from '../constants';
import { TrimOptions, EventCallbacks, VideoMetadata } from '../types';

class ResourceManager {
  private resources: Set<() => void> = new Set();
  private ffmpegInstance: any = null;
  private encoders: Set<any> = new Set();
  private decoders: Set<any> = new Set();
  private videoFrames: Set<any> = new Set();

  register(cleanup: () => void): void {
    this.resources.add(cleanup);
  }

  registerEncoder(encoder: any): void {
    this.encoders.add(encoder);
  }

  registerDecoder(decoder: any): void {
    this.decoders.add(decoder);
  }

  registerVideoFrame(frame: any): void {
    this.videoFrames.add(frame);
  }

  removeVideoFrame(frame: any): void {
    this.videoFrames.delete(frame);
  }

  setFFmpeg(instance: any): void {
    this.ffmpegInstance = instance;
  }

  cleanup(): void {
    // Clean up video frames first
    this.videoFrames.forEach(frame => {
      try {
        if (frame && typeof frame.close === 'function') {
          frame.close();
        }
      } catch (error) {
        console.warn('VideoFrame cleanup error:', error);
      }
    });
    this.videoFrames.clear();

    // Clean up encoders
    this.encoders.forEach(encoder => {
      try {
        if (encoder && encoder.state !== 'closed') {
          encoder.close();
        }
      } catch (error) {
        console.warn('Encoder cleanup error:', error);
      }
    });
    this.encoders.clear();

    // Clean up decoders
    this.decoders.forEach(decoder => {
      try {
        if (decoder && decoder.state !== 'closed') {
          decoder.close();
        }
      } catch (error) {
        console.warn('Decoder cleanup error:', error);
      }
    });
    this.decoders.clear();

    // Clean up other resources
    this.resources.forEach(cleanup => {
      try {
        cleanup();
      } catch (error) {
        console.warn('Cleanup error:', error);
      }
    });
    this.resources.clear();

    if (this.ffmpegInstance) {
      this.ffmpegInstance = null;
    }
  }
}

export class VideoTrimmer {
  private abortController: AbortController | null = null;
  private isProcessing = false;
  private resources = new ResourceManager();
  private ffmpeg: any = null;
  private ffmpegLoaded = false;

  constructor(private callbacks: EventCallbacks = {}) { }

  public async trimVideo(file: File, options: TrimOptions): Promise<Blob> {
    if (this.isProcessing) {
      throw new Error('Another trimming operation is already in progress');
    }

    this.validateInputs(file, options);

    this.isProcessing = true;
    this.abortController = new AbortController();

    try {
      return await this.performTrimming(file, options);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      this.callbacks.onError?.(errorMessage);
      throw new Error(errorMessage);
    } finally {
      this.cleanup();
    }
  }

  private validateInputs(file: File, options: TrimOptions): void {
    if (!file || file.size === 0) {
      throw new Error('Invalid or empty file provided');
    }

    if (!file.type.startsWith('video/')) {
      throw new Error('File must be a video');
    }

    if (options.startTime != null && (!isFinite(options.startTime) || options.startTime < 0)) {
      throw new Error('Invalid start time specified');
    }

    if (options.endTime != null && (!isFinite(options.endTime) || options.endTime < 0)) {
      throw new Error('Invalid end time specified');
    }
  }

  private async performTrimming(file: File, options: TrimOptions): Promise<Blob> {
    // Step 1: Get metadata
    const metadata = await this.getEnhancedVideoMetadata(file);
    this.emitProgress(10);

    // Step 2: Validate time bounds
    const { startTime, endTime } = this.validateTimeBounds(options, metadata.duration);
    this.emitProgress(15);

    // Step 3: Smart method selection with performance priority
    const method = this.selectOptimalMethod(file, options, metadata, endTime - startTime);
    this.emitProgress(20);

    //console.log(`Using trimming method: ${method}`);

    switch (method) {
      case 'webcodecs':
        return await this.trimWithWebCodecs(file, startTime, endTime, options, metadata);
      case 'optimized-recording':
        return await this.trimWithOptimizedRecording(file, startTime, endTime, options, metadata);
      case 'ffmpeg':
        try {
          return await this.trimWithOptimizedFFmpeg(file, startTime, endTime, options, metadata);
        } catch (error) {
          //console.warn('FFmpeg failed, falling back to WebCodecs:', error);
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

  private selectOptimalMethod(
    file: File,
    options: TrimOptions,
    _metadata: VideoMetadata,
    trimDuration: number
  ): 'ffmpeg' | 'webcodecs' | 'optimized-recording' {

    // Never use FFmpeg by default due to CORS/CDN issues
    if (options.useFFmpeg) {
      //console.warn('FFmpeg explicitly requested but may fail due to CDN issues');
      return 'ffmpeg';
    }

    // Performance-based selection - prioritize reliable methods
    const fileSizeMB = file.size / (1024 * 1024);
    const isLargeFile = fileSizeMB > 50;
    const isLongTrim = trimDuration > 60;

    // Prefer WebCodecs for modern browsers and compatible formats
    if (this.supportsWebCodecs() &&
      (file.type.includes('mp4') || file.type.includes('webm')) &&
      !isLargeFile && !isLongTrim) {
      return 'webcodecs';
    }

    // Default to optimized recording (most reliable and fast)
    return 'optimized-recording';
  }

  private async trimWithOptimizedFFmpeg(
    file: File,
    startTime: number,
    endTime: number,
    options: TrimOptions,
    metadata: VideoMetadata
  ): Promise<Blob> {
    try {
      const ffmpeg = await this.loadFFmpeg();
      this.emitProgress(25);

      const inputFileName = `input.${this.getFileExtension(file.type)}`;
      const outputFormat = options.outputFormat || 'mp4';
      const outputFileName = `output.${outputFormat}`;

      // Write input file
      await ffmpeg.writeFile(inputFileName, await fetchFile(file));
      this.emitProgress(35);

      // Optimized FFmpeg command
      const duration = endTime - startTime;
      const args = [
        '-i', inputFileName,
        '-ss', startTime.toFixed(3),
        '-t', duration.toFixed(3),
        '-avoid_negative_ts', 'make_zero'
      ];

      // Fast mode optimizations
      if (options.fastMode !== false) {
        args.push(
          '-c', 'copy',
          '-avoid_negative_ts', 'make_zero'
        );
      } else {
        // Re-encoding mode
        const quality = options.quality || 'medium';
        const qConfig = QUALITY_MAPPINGS.video[quality];

        args.push('-crf', qConfig.crf.toString(), '-preset', qConfig.preset, '-maxrate', qConfig.bitrate, '-bufsize', (parseInt(qConfig.bitrate) * 2).toString() + 'M');

        // Audio handling
        if (options.mute || !metadata.hasAudio) {
          args.push('-an');
        } else {
          args.push('-c:a', 'aac', '-b:a', '128k');
        }

        // Video encoding
        if (outputFormat === 'mp4') {
          args.push(
            '-c:v', 'libx264',
            '-movflags', '+faststart',
            '-profile:v', 'baseline',
            '-level', '3.1'
          );

          if (metadata.width > 1920 || metadata.height > 1080) {
            args.push('-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease');
          }
        }
      }

      args.push(outputFileName);

      // Execute
      await ffmpeg.exec(args);
      this.emitProgress(90);

      // Read output
      const data = await ffmpeg.readFile(outputFileName);

      // Cleanup
      try {
        await ffmpeg.deleteFile(inputFileName);
        await ffmpeg.deleteFile(outputFileName);
      } catch (e) {
        //console.warn('FFmpeg cleanup error:', e);
      }

      this.emitProgress(100);

      const mimeType = this.getMimeTypeFromFormat(outputFormat);
      //@ts-ignore
      return new Blob([data], { type: mimeType });

    } catch (error) {
      //console.warn('FFmpeg trimming failed:', error);
      throw error;
    }
  }

  async loadFFmpeg(): Promise<FFmpeg> {
    if (this.ffmpeg && this.ffmpegLoaded) {
      return this.ffmpeg;
    }

    try {
      this.ffmpeg = new FFmpeg();

      this.ffmpeg.on('progress', ({ progress }: { progress: number }) => {
        const adjustedProgress = 25 + (progress * 65);
        this.emitProgress(adjustedProgress);
      });

      const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

      await this.ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });

      this.ffmpegLoaded = true;
      this.resources.setFFmpeg(this.ffmpeg);

      return this.ffmpeg;

    } catch (error) {
      throw new Error('FFmpeg not available');
    }
  }
  // Enhanced WebCodecs implementation
  private async trimWithWebCodecs(
    file: File,
    startTime: number,
    endTime: number,
    options: TrimOptions,
    metadata: VideoMetadata
  ): Promise<Blob> {
    this.emitProgress(30);

    try {
      const { VideoDecoder, VideoEncoder, VideoFrame } = window as any;

      if (!VideoDecoder || !VideoEncoder || !VideoFrame) {
        throw new Error('WebCodecs not supported');
      }

      const chunks: Uint8Array[] = [];
      let frameCount = 0;
      const targetFrameRate = options.fastMode ? 24 : Math.min(metadata.frameRate, 30);
      const frameDuration = 1 / targetFrameRate;

      // Optimized encoder dimensions and settings
      const { width, height } = this.getSafeEncoderDimensions(metadata.width, metadata.height);

      const encoderConfig = {
        codec: 'avc1.42001f', // H.264 baseline profile - most compatible
        width,
        height,
        bitrate: this.calculateWebCodecsBitrate(options, width, height, targetFrameRate),
        framerate: targetFrameRate,
        keyInterval: Math.floor(targetFrameRate * 2),
        latencyMode: 'realtime' as const,
        bitrateMode: 'constant' as const,
      };
      const encoder = new VideoEncoder({
        output: (chunk: any) => {
          try {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            chunks.push(data);
          } catch (error) {
            console.warn('Chunk processing error:', error);
          }
        },
        error: (error: Error) => {
          throw new Error(`WebCodecs encoding error: ${error.message}`);
        }
      });

      encoder.configure(encoderConfig);
      this.resources.registerEncoder(encoder);
      this.emitProgress(40);

      // Optimized video element
      const video = await this.createOptimizedVideo(file);
      await this.seekToTime(video, startTime);
      this.emitProgress(50);

      // Optimized canvas
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', {
        alpha: false,
        desynchronized: true,
        powerPreference: 'high-performance'
      })!;

      this.resources.register(() => canvas.remove());

      return new Promise(async (resolve, reject) => {
        let currentTime = startTime;
        let encodedFrames = 0;
        const totalFrames = Math.ceil((endTime - startTime) * targetFrameRate);
        const batchSize = options.fastMode ? 5 : 3; // Process frames in batches

        const processBatch = async () => {
          try {
            for (let i = 0; i < batchSize && currentTime < endTime; i++) {
              if (this.abortController?.signal.aborted) {
                reject(new Error('Operation cancelled'));
                return;
              }

              // Seek and capture frame
              video.currentTime = currentTime;
              await new Promise(resolveSeek => setTimeout(resolveSeek, 16)); // Small delay instead of seeked event

              // Draw to canvas
              //@ts-expect-error
              ctx.drawImage(video, 0, 0, metadata.width, metadata.height, 0, 0, width, height);

              // Create and encode VideoFrame
              const videoFrame = new VideoFrame(canvas, {
                timestamp: frameCount * frameDuration * 1_000_000,
                duration: frameDuration * 1_000_000
              });

              this.resources.registerVideoFrame(videoFrame);

              try {
                if (encoder.state === 'configured') {
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

            // Update progress
            const progress = 50 + (encodedFrames / totalFrames) * 45;
            this.emitProgress(Math.min(95, progress));

            if (currentTime >= endTime) {
              // Finish encoding
              await encoder.flush();

              if (chunks.length === 0) {
                reject(new Error('No frames were encoded'));
                return;
              }

              // Combine chunks
              const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
              const combined = new Uint8Array(totalLength);
              let offset = 0;

              for (const chunk of chunks) {
                combined.set(chunk, offset);
                offset += chunk.length;
              }

              this.emitProgress(100);
              resolve(new Blob([combined], { type: 'video/mp4' }));
            } else {
              // Continue processing
              setTimeout(processBatch, 8); // Faster processing
            }

          } catch (error) {
            reject(error);
          }
        };

        processBatch();
      });

    } catch (error) {
      console.warn('WebCodecs trimming failed:', error);
      return await this.trimWithOptimizedRecording(file, startTime, endTime, options, metadata);
    }
  }

  private calculateWebCodecsBitrate(options: TrimOptions, width: number, height: number, frameRate: number): number {
    const pixels = width * height;
    const quality = options.quality || 'medium';

    // More aggressive bitrate calculations for speed
    const bppRates: Record<string, number> = {
      low: 0.05,    // bits per pixel per frame
      medium: 0.1,  // reduced from 0.15
      high: 0.15    // reduced from 0.25
    };

    let bitrate = pixels * frameRate * bppRates[quality];

    // Apply limits
    bitrate = Math.max(500000, Math.min(8000000, bitrate));

    return Math.floor(bitrate);
  }

  // Enhanced recording method with better performance
  private async trimWithOptimizedRecording(
    file: File,
    startTime: number,
    endTime: number,
    options: TrimOptions,
    metadata: VideoMetadata
  ): Promise<Blob> {
    this.emitProgress(30);

    const video = await this.createOptimizedVideo(file);
    const duration = endTime - startTime;

    // More conservative dimensions for better performance
    const { width, height } = this.getOptimalDimensions(
      metadata.width,
      metadata.height,
      options.fastMode
    );

    // Create optimized canvas
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.style.display = 'none';

    const ctx = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
      willReadFrequently: false
    })!;

    document.body.appendChild(canvas);
    this.resources.register(() => canvas.remove());

    this.emitProgress(40);

    // Optimized stream settings
    const frameRate = options.fastMode ? 24 : Math.min(30, Math.max(20, metadata.frameRate));
    const stream = canvas.captureStream(frameRate);

    // Add audio if needed
    if (!options.mute && metadata.hasAudio) {
      await this.addOptimizedAudio(stream, video);
    }

    this.emitProgress(50);

    // Use most compatible codec
    const mimeType = this.getBestRecordingMimeType();
    const bitrate = this.calculateOptimalBitrate(options.quality || 'medium', duration, metadata);

    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: bitrate,
      audioBitsPerSecond: options.mute ? undefined : 128000
    });

    const chunks: Blob[] = [];
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
          reject(new Error('No video data recorded'));
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
        video.playbackRate = 1.0;
        await video.play();

        let startTimestamp = performance.now();
        let lastProgressUpdate = 0;
        const frameInterval = 1000 / frameRate;

        const renderFrame = () => {
          if (isCompleted || this.abortController?.signal.aborted) {
            return;
          }

          const elapsed = (performance.now() - startTimestamp) / 1000;

          if (elapsed >= duration || video.currentTime >= endTime) {
            video.pause();
            if (recorder.state === 'recording') {
              recorder.stop();
            }
            return;
          }

          try {
            // Optimized rendering

            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(video, 0, 0, width, height);

            // Throttled progress updates
            const now = performance.now();
            if (now - lastProgressUpdate > 300) { // Less frequent updates
              const progress = 60 + (elapsed / duration) * 35;
              this.emitProgress(Math.min(95, progress));
              lastProgressUpdate = now;
            }

            requestAnimationFrame(renderFrame);

          } catch (error) {
            console.warn('Frame rendering error:', error);
            setTimeout(renderFrame, frameInterval);
          }
        };

        renderFrame();

        // Safety timeout
        const safetyTimeout = setTimeout(() => {
          if (!isCompleted) {
            video.pause();
            if (recorder.state === 'recording') {
              recorder.stop();
            }
          }
        }, (duration * 1000) + 5000);

        this.resources.register(() => clearTimeout(safetyTimeout));

      } catch (error) {
        if (!isCompleted) {
          reject(error);
        }
      }
    });
  }

  // Rest of the methods with minor optimizations
  private async getEnhancedVideoMetadata(file: File): Promise<VideoMetadata> {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      const url = URL.createObjectURL(file);

      this.resources.register(() => {
        URL.revokeObjectURL(url);
        video.src = '';
        video.remove();
      });

      const timeout = setTimeout(() => reject(new Error('Metadata timeout')), 8000); // Reduced timeout

      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener('loadedmetadata', onLoad);
        video.removeEventListener('error', onError);
      };

      const onLoad = async () => {
        cleanup();

        if (!isFinite(video.duration) || video.duration <= 0) {
          reject(new Error('Invalid video duration'));
          return;
        }

        // Quick metadata extraction
        let frameRate = 30;
        let hasAudio = true; // Assume has audio for speed

        resolve({
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
          hasAudio,
          frameRate,
          bitrate: Math.round((file.size * 8) / video.duration),
          codec: file.type.includes('mp4') ? 'h264' : 'vp8',
          audioCodec: file.type.includes('mp4') ? 'aac' : 'opus'
        });
      };

      const onError = (e: any) => {
        cleanup();
        reject(new Error(`Failed to load video metadata: ${e.message || 'Unknown error'}`));
      };

      video.addEventListener('loadedmetadata', onLoad);
      video.addEventListener('error', onError);
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.src = url;
    });
  }

  private validateTimeBounds(options: TrimOptions, duration: number): { startTime: number; endTime: number } {
    const startTime = Math.max(0, Math.min(options.startTime ?? 0, duration - 0.033));
    const endTime = Math.min(duration, Math.max(options.endTime ?? duration, startTime + 0.033));

    if (endTime < startTime) {
      throw new Error(`Invalid time range: ${startTime}s - ${endTime}s (duration: ${duration}s)`);
    }

    return { startTime, endTime };
  }

  private supportsWebCodecs(): boolean {
    return typeof window !== 'undefined' &&
      'VideoDecoder' in window &&
      'VideoEncoder' in window &&
      'VideoFrame' in window;
  }

  private getSafeEncoderDimensions(width: number, height: number): { width: number; height: number } {
    // Ensure dimensions are multiples of 16 and reasonable size
    let w = Math.max(16, Math.floor(width / 16) * 16);
    let h = Math.max(16, Math.floor(height / 16) * 16);

    // More conservative limits for better performance
    const maxWidth = 1280;
    const maxHeight = 720;

    if (w > maxWidth || h > maxHeight) {
      const aspectRatio = w / h;
      if (aspectRatio > 1) {
        w = maxWidth;
        h = Math.floor((maxWidth / aspectRatio) / 16) * 16;
      } else {
        h = maxHeight;
        w = Math.floor((maxHeight * aspectRatio) / 16) * 16;
      }
    }

    return { width: Math.max(16, w), height: Math.max(16, h) };
  }

  private async createOptimizedVideo(file: File): Promise<HTMLVideoElement> {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      const url = URL.createObjectURL(file);

      this.resources.register(() => {
        URL.revokeObjectURL(url);
        video.src = '';
        video.remove();
      });

      const timeout = setTimeout(() => {
        reject(new Error('Video loading timeout'));
      }, 15000); // Reduced timeout

      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener('canplaythrough', onReady);
        video.removeEventListener('error', onError);
      };

      const onReady = () => {
        cleanup();
        resolve(video);
      };

      const onError = (e: any) => {
        cleanup();
        reject(new Error(`Video load failed: ${e.message || 'Unknown error'}`));
      };

      video.addEventListener('canplaythrough', onReady, { once: true });
      video.addEventListener('error', onError, { once: true });

      // Optimized settings
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      video.disablePictureInPicture = true;
      //@ts-expect-error
      video.disableRemotePlaybook = true;
      video.controls = false;
      video.style.display = 'none';

      document.body.appendChild(video);
      video.src = url;
    });
  }

  private async seekToTime(video: HTMLVideoElement, time: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (Math.abs(video.currentTime - time) < 0.1) { // Less precise seeking for speed
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        video.removeEventListener('seeked', onSeeked);
        reject(new Error('Seek timeout'));
      }, 2000); // Reduced timeout

      const onSeeked = () => {
        clearTimeout(timeout);
        video.removeEventListener('seeked', onSeeked);
        resolve();
      };

      video.addEventListener('seeked', onSeeked, { once: true });
      video.currentTime = Math.max(0, Math.min(time, video.duration - 0.001));
    });
  }

  private async addOptimizedAudio(stream: MediaStream, video: HTMLVideoElement): Promise<void> {
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        latencyHint: 'playback',
        sampleRate: 44100 // Reduced sample rate for performance
      });

      const source = audioContext.createMediaElementSource(video);
      const destination = audioContext.createMediaStreamDestination();

      source.connect(destination);
      source.connect(audioContext.destination);

      destination.stream.getAudioTracks().forEach(track => {
        stream.addTrack(track);
      });

      this.resources.register(() => {
        audioContext.close().catch(() => { });
      });

    } catch (error) {
      console.warn('Audio processing failed:', error);
    }
  }

  private getOptimalDimensions(width: number, height: number, fastMode?: boolean): { width: number; height: number } {
    // Ensure even numbers for video encoding
    let w = Math.max(2, Math.floor(width / 2) * 2);
    let h = Math.max(2, Math.floor(height / 2) * 2);

    const aspectRatio = w / h;

    // More aggressive scaling in fast mode
    const maxDimension = fastMode ? 1280 : 1920;
    const minDimension = 320;

    // Scale down large videos
    if (w > maxDimension || h > maxDimension) {
      if (w > h) {
        w = maxDimension;
        h = Math.floor((maxDimension / aspectRatio) / 2) * 2;
      } else {
        h = maxDimension;
        w = Math.floor((maxDimension * aspectRatio) / 2) * 2;
      }
    }

    // Scale up very small videos
    if (w < minDimension && h < minDimension) {
      if (w > h) {
        w = minDimension;
        h = Math.floor((minDimension / aspectRatio) / 2) * 2;
      } else {
        h = minDimension;
        w = Math.floor((minDimension * aspectRatio) / 2) * 2;
      }
    }

    return {
      width: Math.max(2, w),
      height: Math.max(2, h)
    };
  }

  private getBestRecordingMimeType(): string {
    const preferredTypes = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=h264,opus',
      'video/mp4;codecs=h264,aac',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4'
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

    return 'video/webm';
  }

  private getFileExtension(mimeType: string): string {
    const extensions: Record<string, string> = {
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
      'video/x-msvideo': 'avi',
      'video/x-matroska': 'mkv'
    };

    return extensions[mimeType] || 'mp4';
  }

  private getMimeTypeFromFormat(format: string): string {
    const mimeTypes: Record<string, string> = {
      'mp4': 'video/mp4',
      'webm': 'video/webm',
      'mkv': 'video/x-matroska',
      'mov': 'video/quicktime',
      'avi': 'video/x-msvideo',
      'flv': 'video/x-flv'
    };

    return mimeTypes[format] || 'video/mp4';
  }

  private calculateOptimalBitrate(
    quality: string = 'medium',
    duration: number,
    metadata: VideoMetadata
  ): number {
    const baseRates = {
      low: 800000,     // 0.8 Mbps
      medium: 2000000, // 2 Mbps  
      high: 4000000    // 4 Mbps
    };

    let bitrate = baseRates[quality as keyof typeof baseRates] || baseRates.medium;

    // Resolution adjustments
    const pixels = metadata.width * metadata.height;
    if (pixels > 2073600) { // 1080p+
      bitrate *= 1.3;
    } else if (pixels > 921600) { // 720p
      bitrate *= 1.0;
    } else if (pixels < 307200) { // Below 480p
      bitrate *= 0.6;
    }

    // Frame rate adjustments
    if (metadata.frameRate > 30) {
      bitrate *= Math.min(1.5, metadata.frameRate / 30);
    }

    // Duration adjustments
    if (duration > 60) bitrate *= 0.9;
    if (duration > 300) bitrate *= 0.8;

    return Math.max(500000, Math.floor(bitrate));
  }

  private emitProgress(progress: number): void {
    const clampedProgress = Math.max(0, Math.min(100, Math.round(progress)));
    this.callbacks.onProgress?.(clampedProgress);
  }

  private cleanup(): void {
    this.resources.cleanup();
    this.isProcessing = false;
    this.abortController = null;
  }

  public cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.callbacks.onCancel?.();
    }
    this.cleanup();
  }

  public isProcessingVideo(): boolean {
    return this.isProcessing;
  }

  // Enhanced static method with better defaults
  public static async trim(
    file: File,
    options: TrimOptions & { preferredMethod?: 'auto' | 'ffmpeg' | 'webcodecs' | 'recording' }
  ): Promise<Blob> {
    const callbacks: EventCallbacks = {
      onProgress: options.onProgress,
      onError: (error) => console.error('VideoTrimmer error:', error),
      onComplete: (blob) => console.log('VideoTrimmer completed:', blob.size, 'bytes')
    };

    const trimmer = new VideoTrimmer(callbacks);

    // Set fastMode as default for better performance
    const enhancedOptions = {
      ...options,
      fastMode: options.fastMode !== false, // Default to true
      quality: options.quality || 'medium'
    };

    // Override method selection if specified
    if (options.preferredMethod && options.preferredMethod !== 'auto') {
      if (options.preferredMethod === 'ffmpeg') {
        enhancedOptions.useFFmpeg = true;
      }
    }

    return trimmer.trimVideo(file, enhancedOptions);
  }

  // Utility method to get video info without trimming
  public static async getVideoInfo(file: File): Promise<VideoMetadata> {
    const trimmer = new VideoTrimmer();
    try {
      return await trimmer.getEnhancedVideoMetadata(file);
    } finally {
      trimmer.cleanup();
    }
  }

  // Enhanced capabilities check
  public static getCapabilities(): {
    ffmpegSupported: boolean;
    webCodecsSupported: boolean;
    supportedInputFormats: string[];
    supportedOutputFormats: string[];
    recommendedMethod: string;
  } {
    const supportedInputs = [
      'video/mp4', 'video/webm', 'video/quicktime',
      'video/x-msvideo', 'video/x-matroska'
    ];

    const supportedOutputs = ['mp4', 'webm'];

    // Determine best method for this environment
    let recommendedMethod = 'optimized-recording'; // Safest default

    if (typeof window !== 'undefined' && 'VideoDecoder' in window && 'VideoEncoder' in window) {
      recommendedMethod = 'webcodecs';
    }

    return {
      ffmpegSupported: typeof window !== 'undefined',
      webCodecsSupported: typeof window !== 'undefined' &&
        'VideoDecoder' in window &&
        'VideoEncoder' in window,
      supportedInputFormats: supportedInputs,
      supportedOutputFormats: supportedOutputs,
      recommendedMethod
    };
  }

  // Method to estimate processing time with better accuracy
  public static estimateProcessingTime(
    file: File,
    trimDuration: number,
    method: 'ffmpeg' | 'webcodecs' | 'recording' = 'auto' as any,
    fastMode: boolean = true
  ): number {
    const fileSizeMB = file.size / (1024 * 1024);
    const speedMultiplier = fastMode ? 0.6 : 1.0;

    // Updated estimates based on optimizations
    const baseEstimates = {
      ffmpeg: Math.max(3, (trimDuration * 0.2 + fileSizeMB * 0.08) * speedMultiplier),
      webcodecs: Math.max(2, (trimDuration * 0.6 + fileSizeMB * 0.03) * speedMultiplier),
      recording: Math.max(trimDuration * 1.05, (trimDuration * 1.1 + fileSizeMB * 0.01) * speedMultiplier)
    };

    if (method === 'auto' as any) {
      // Return optimized recording estimate (most reliable)
      return baseEstimates.recording;
    }

    return baseEstimates[method] || baseEstimates.recording;
  }

  // New method to suggest optimal settings
  public static suggestOptimalSettings(file: File, trimDuration: number): {
    quality: 'high' | 'medium' | 'low';
    fastMode: boolean;
    preferredMethod: 'ffmpeg' | 'webcodecs' | 'recording';
    outputFormat: 'mp4' | 'webm';
  } {
    const fileSizeMB = file.size / (1024 * 1024);
    const isLargeFile = fileSizeMB > 100;
    const isLongTrim = trimDuration > 120;

    // Quality suggestion
    let quality: 'high' | 'medium' | 'low' = 'medium';
    if (fileSizeMB < 10 && trimDuration < 30) {
      quality = 'high';
    } else if (isLargeFile || isLongTrim) {
      quality = 'low';
    }

    // Fast mode suggestion
    const fastMode = isLargeFile || isLongTrim || fileSizeMB > 50;

    // Method suggestion
    let preferredMethod: 'ffmpeg' | 'webcodecs' | 'recording' = 'recording';
    if (this.getCapabilities().webCodecsSupported && !isLargeFile && file.type.includes('mp4')) {
      preferredMethod = 'webcodecs';
    }

    // Format suggestion
    const outputFormat = file.type.includes('webm') ? 'webm' as const : 'mp4' as const;

    return {
      quality,
      fastMode,
      preferredMethod,
      outputFormat
    };
  }
}

export const useVideoTrimmer = (callbacks: EventCallbacks = {}) => {
  const trimmer = new VideoTrimmer(callbacks);
  return {
    trimVideo: (file: File, options: TrimOptions) => trimmer.trimVideo(file, options),
    getCapabilities: () => VideoTrimmer.getCapabilities(),
    suggestSettings: (file: File, trimDuration: number) => VideoTrimmer.suggestOptimalSettings(file, trimDuration)
  };
};
