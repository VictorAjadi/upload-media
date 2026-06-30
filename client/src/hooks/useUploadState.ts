/**
 * React hook for accessing upload state
 */

import { useStore } from 'zustand';
import { useUploadProgress as vanillaUploadProgressStore } from '../store/useUploadProgress';

const useUploadProgress = <T>(selector: (state: any) => T): T => {
    return useStore(vanillaUploadProgressStore, selector);
};

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