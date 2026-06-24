/**
 * @upload-media/client - React Hooks
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { useStore } from 'zustand'; // Bridges the vanilla store to React
import { UploadManager, UploadManagerConfig } from '../manager/UploadManager';
import { UploadOptions } from '../types';

// 1. Import your raw vanilla store instance 
import { useUploadProgress as vanillaUploadProgressStore } from '../store/useUploadProgress';

/**
 * 2. Create a reactive React hook from the vanilla store.
 * This satisfies the syntax: useUploadProgress((state) => state.uploads)
 */
const useUploadProgress = <T>(selector: (state: any) => T): T => {
  return useStore(vanillaUploadProgressStore, selector);
};

/**
 * useUpload - Main hook for file uploads
 */
export function useUpload(config?: UploadManagerConfig) {
  const managerRef = useRef<UploadManager | null>(null);
  const storeUploads = useUploadProgress((state) => state.uploads);
  const addUpload = useUploadProgress((state) => state.addUpload);
  const updateProgress = useUploadProgress((state) => state.updateProgress);
  const totalProgress = useUploadProgress((state) => state.totalProgress);
  const activeCount = useUploadProgress((state) => state.activeUploads);

  useEffect(() => {
    managerRef.current = new UploadManager({
      ...config,
      onProgress: (progress) => {
        updateProgress(progress.uploadId, {
          progress: progress.overallProgress,
          status: progress.status,
          error: progress.error
        });
        config?.onProgress?.(progress);
      },
      onComplete: (result) => {
        config?.onComplete?.(result);
      },
      onError: (error) => {
        config?.onError?.(error);
      },
    });

    return () => {
      managerRef.current?.destroy();
    };
  }, []);

  const upload = useCallback(
    async (files: File[], fieldnames: string[], options: UploadOptions) => {
      if (!managerRef.current) {
        throw new Error('Upload manager not initialized');
      }
      return managerRef.current.upload(files, fieldnames, options);
    },
    []
  );

  const pause = useCallback((uploadId: string) => {
    managerRef.current?.pause(uploadId);
  }, []);

  const resume = useCallback((uploadId: string) => {
    managerRef.current?.resume(uploadId);
  }, []);

  const cancel = useCallback((uploadId: string) => {
    managerRef.current?.cancel(uploadId);
  }, []);

  const remove = useCallback((uploadId: string) => {
    managerRef.current?.remove(uploadId);
  }, []);

  return {
    upload,
    pause,
    resume,
    cancel,
    remove,
    uploads: storeUploads,
    addUpload,
    manager: managerRef.current,
    totalProgress,
    activeCount
  };
}

/**
 * useVideoTrim - Hook for video trimming
 */
export function useVideoTrim() {
  const trimmerRef = useRef<any>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  const trim = useCallback(
    async (file: File, startTime: number, endTime: number, quality = 'medium') => {
      setIsProcessing(true);
      setProgress(0);

      try {
        const { VideoTrimmer } = await import('./useVideoTrimmer');

        const trimmer = new VideoTrimmer({
          onProgress: setProgress,
          onComplete: () => setIsProcessing(false),
          onError: (error) => {
            console.error('Trim error:', error);
            setIsProcessing(false);
          },
        });

        trimmerRef.current = trimmer;

        const result = await trimmer.trimVideo(file, {
          startTime,
          endTime,
          quality: quality as any,
        });

        return result;
      } catch (error) {
        setIsProcessing(false);
        throw error;
      }
    },
    []
  );

  const cancel = useCallback(() => {
    trimmerRef.current?.cancel();
  }, []);

  return {
    trim,
    cancel,
    isProcessing,
    progress,
  };
}

/**
 * useAudioTrim - Hook for audio trimming
 */
export function useAudioTrim() {
  const trimmerRef = useRef<any>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  const trim = useCallback(
    async (file: File, startTime: number, endTime: number, quality = 'medium') => {
      setIsProcessing(true);
      setProgress(0);

      try {
        const { AudioTrimmer } = await import('./useAudioTrimmer');

        const trimmer = new AudioTrimmer({
          onProgress: setProgress,
          onComplete: () => setIsProcessing(false),
          onError: (error) => {
            console.error('Trim error:', error);
            setIsProcessing(false);
          },
        });

        trimmerRef.current = trimmer;

        const result = await trimmer.trimAudio(file, {
          startTime,
          endTime,
          quality: quality as any,
        });

        return result;
      } catch (error) {
        setIsProcessing(false);
        throw error;
      }
    },
    []
  );

  const cancel = useCallback(() => {
    trimmerRef.current?.cancel();
  }, []);

  return {
    trim,
    cancel,
    isProcessing,
    progress,
  };
}
/**
 * useUploadState - Hook for accessing upload state
 */
export function useUploadState(uploadId?: string) {
  const uploads = useUploadProgress((state) => state.uploads);
  const getUpload = useUploadProgress((state) => state.getUpload);
  const totalProgress = useUploadProgress((state) => state.totalProgress);
  const activeCount = useUploadProgress((state) => state.activeUploads);

  const currentUpload = uploadId ? getUpload(uploadId) : uploads.find((u: any) => u.status === 'uploading');

  return {
    currentUpload,
    allUploads: uploads,
    totalProgress,
    activeCount,
    isActive: currentUpload?.status === 'uploading',
    isPaused: currentUpload?.status === 'paused',
    isFailed: currentUpload?.status === 'failed',
    isCompleted: currentUpload?.status === 'completed',
  };
}