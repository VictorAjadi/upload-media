import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { QUALITY_MAPPINGS } from '../constants';
import { AudioTrimOptions, AudioEventCallbacks } from '../types';

class AudioResourceManager {
  private resources: Set<() => void> = new Set();
  private ffmpegInstance: any = null;

  register(cleanup: () => void): void {
    if (typeof cleanup === 'function') {
      this.resources.add(cleanup);
    }
  }

  setFFmpeg(instance: any): void {
    if (this.ffmpegInstance && this.ffmpegInstance !== instance) {
      try {
        this.ffmpegInstance.terminate?.();
      } catch (error) {
        console.warn('Audio cleanup error:', error);
      }
    }
    this.ffmpegInstance = instance;
  }

  cleanup(): void {
    this.resources.forEach(cleanup => {
      try {
        cleanup();
      } catch (error) {
        console.warn('Audio cleanup error:', error);
      }
    });
    this.resources.clear();

    if (this.ffmpegInstance) {
      try {
        this.ffmpegInstance.terminate?.();
      } catch (error) {
        console.warn('Audio cleanup error:', error);
      }
      this.ffmpegInstance = null;
    }
  }
}

export class AudioTrimmer {
  private isProcessing = false;
  private resources = new AudioResourceManager();
  private ffmpeg: any = null;
  private ffmpegLoaded = false;

  constructor(private callbacks: AudioEventCallbacks = {}) { }

  public async trimAudio(file: File | Blob, options: AudioTrimOptions): Promise<Blob> {
    if (this.isProcessing) {
      throw new Error('Another audio processing operation is already in progress');
    }

    if (!file || !(file instanceof Blob)) {
      throw new Error('Invalid file provided');
    }

    this.isProcessing = true;

    try {
      return await this.performAudioTrimming(file, options);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('[AudioTrimmer] Error:', errorMessage);
      this.callbacks.onError?.(errorMessage);
      throw error;
    } finally {
      this.resources.cleanup();
      this.isProcessing = false;
    }
  }

  private async performAudioTrimming(file: File | Blob, options: AudioTrimOptions): Promise<Blob> {
    const metadata = await this.getAudioMetadata(file);
    const ffmpeg = await this.loadFFmpeg();
    this.emitProgress(15);

    const startTime = options.startTime ?? 0;
    const endTime = options.endTime ?? metadata.duration;
    const duration = endTime - startTime;

    if (duration <= 0) {
      throw new Error('Invalid trim duration');
    }

    const inputExt = this.getFileExtension(file.type) || 'mp3';
    const inputFileName = `input.${inputExt}`;
    const outputFormat = options.outputFormat || 'mp3';
    const outputFileName = `output.${outputFormat}`;

    // Write input file
    await ffmpeg.writeFile(inputFileName, await fetchFile(file));
    this.emitProgress(30);

    const quality = options.quality || 'medium';
    const qConfig = QUALITY_MAPPINGS.audio[quality];

    const args = [
      '-i', inputFileName,
      '-ss', startTime.toFixed(3),
      '-t', duration.toFixed(3),
      '-b:a', qConfig.bitrate,
      outputFileName
    ];

    // Execute
    await ffmpeg.exec(args);
    this.emitProgress(90);

    // Read output
    const data = await ffmpeg.readFile(outputFileName);

    // Cleanup files in FFmpeg FS
    try {
      await ffmpeg.deleteFile(inputFileName);
      await ffmpeg.deleteFile(outputFileName);
    } catch (e) {
      console.warn('[AudioTrimmer] Failed to cleanup FFmpeg files:', e);
    }

    this.emitProgress(100);

    const mimeType = this.getMimeTypeFromFormat(outputFormat);
    return new Blob([data as any], { type: mimeType });
  }

  private async getAudioMetadata(file: File | Blob): Promise<{ duration: number }> {
    return new Promise((resolve, reject) => {
      const audio = new Audio();
      const url = URL.createObjectURL(file);

      const cleanup = () => {
        URL.revokeObjectURL(url);
        audio.remove();
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Audio metadata timeout'));
      }, 5000);

      const handleMetadata = () => {
        clearTimeout(timeout);
        const duration = audio.duration;

        if (!isFinite(duration) || isNaN(duration)) {
          cleanup();
          reject(new Error('Invalid audio duration'));
          return;
        }

        cleanup();
        resolve({ duration });
      };

      const handleError = () => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error('Failed to load audio metadata'));
      };

      audio.addEventListener('loadedmetadata', handleMetadata, { once: true });
      audio.addEventListener('error', handleError, { once: true });

      audio.preload = 'metadata';
      audio.src = url;
    });
  }

  private async loadFFmpeg(): Promise<FFmpeg> {
    if (this.ffmpeg && this.ffmpegLoaded) {
      return this.ffmpeg;
    }

    try {
      this.ffmpeg = new FFmpeg();

      this.ffmpeg.on('progress', ({ progress }: { progress: number }) => {
        const adjustedProgress = 20 + (progress * 70);
        this.emitProgress(Math.min(100, Math.max(0, adjustedProgress)));
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
      console.error('[AudioTrimmer] FFmpeg load failed:', error);
      throw new Error('FFmpeg not available for audio processing');
    }
  }

  private emitProgress(progress: number): void {
    const clampedProgress = Math.min(100, Math.max(0, Math.round(progress)));
    this.callbacks.onProgress?.(clampedProgress);
  }

  private getFileExtension(mimeType: string): string {
    const map: Record<string, string> = {
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/aac': 'aac',
      'audio/ogg': 'ogg',
      'audio/mp4': 'm4a',
      'audio/x-m4a': 'm4a'
    };
    return map[mimeType] || 'mp3';
  }

  private getMimeTypeFromFormat(format: string): string {
    const map: Record<string, string> = {
      'mp3': 'audio/mpeg',
      'wav': 'audio/wav',
      'aac': 'audio/aac',
      'ogg': 'audio/ogg',
      'm4a': 'audio/mp4'
    };
    return map[format] || 'audio/mpeg';
  }
}

export const useAudioTrimmer = (callbacks: AudioEventCallbacks = {}) => {
  const trimmer = new AudioTrimmer(callbacks);
  return {
    trimAudio: (file: File | Blob, options: AudioTrimOptions) => trimmer.trimAudio(file, options)
  };
};