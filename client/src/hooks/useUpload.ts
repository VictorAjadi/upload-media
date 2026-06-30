/**
 * React hook for file uploads – Zustand powered
 * Exports all store actions and state selectors.
 * Should ONLY be imported from '@upload-media/client/react'
 */

import { useEffect, useCallback } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { useUploadProgress as vanillaStore } from '../store/useUploadProgress';
import { generateSessionId } from '../utils/sessionId';
import { UploadOptions } from '../types';

export { useUploadProgress } from '../store/useUploadProgress';

export function useUpload() {
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
    getUpload,
  } = useStore(
    vanillaStore,
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
      getUpload: state.getUpload,
    }))
  );

  // ─── Optional: check for resumable uploads on mount ──────────────
  useEffect(() => {
    checkForResumableUploads().catch(console.error);
  }, [checkForResumableUploads]);

  // ─── Convenience `upload` function (combines add + initialize) ────
  const upload = useCallback(
    async (files: File[], fieldnames: string[], options: UploadOptions) => {
      if (!files || files.length === 0) {
        throw new Error('No files provided');
      }
      if (files.length !== fieldnames.length) {
        throw new Error('Files and fieldnames length mismatch');
      }

      const uploadId = options.uploadId || generateSessionId();

      // Step 1: add upload to store (metadata)
      addUpload({
        uploadId,
        fileName: files[0]?.name || '',
        fileSize: files[0]?.size || 0,
        fileType: files[0]?.type || '',
        endpoint: options.endpoint || '/upload',
        method: options.method || 'POST',
        postData: options.postData,
        metadata: options.metadata,
        uploadType: options.uploadType || 'file',
      });

      // Step 2: start the actual upload (worker)
      initializeUpload({
        uploadId,
        blobs: files,
        filenameArray: files.map((f) => f.name),
        endpoint: options.endpoint || '/upload',
        method: options.method || 'POST',
        postData: options.postData,
        metadata: options.metadata,
        uploadType: options.uploadType || 'file',
        transformer: options.transformer,
      });

      return uploadId;
    },
    [addUpload, initializeUpload]
  );

  // ─── Expose everything ──────────────────────────────────────────────
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
    terminateAllWorkers: vanillaStore.getState().terminateAllWorkers,
  };
}