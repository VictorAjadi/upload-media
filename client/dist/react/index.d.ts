import * as immer from 'immer';
import * as zustand_middleware from 'zustand/middleware';
import * as zustand from 'zustand';

type UploadStatus = 'pending' | 'initializing' | 'uploading' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'processing' | 'error';
type Quality = 'high' | 'medium' | 'low' | number;
interface QualityConfig {
    id: string;
    label: string;
    quality?: Quality;
    resolution?: string;
    videoBitrate?: string;
    audioBitrate?: string;
    width?: number;
    height?: number;
    codec?: string;
    maxDimension?: number;
    format?: string;
    [key: string]: any;
}
interface TransformerConfig {
    type?: 'image' | 'video' | 'audio';
    quality?: Quality;
    format?: string;
    qualityConfigs?: QualityConfig[];
    qualities?: string[];
    startTime?: number;
    endTime?: number;
    mute?: boolean;
    videoBitrate?: string;
    resolution?: string;
    codec?: string;
    generateThumbnail?: boolean;
    thumbnailTimeSeconds?: number;
    audioBitrate?: string;
    width?: number;
    height?: number;
    [key: string]: any;
}
interface FileUploadItem {
    fileIndex: number;
    fileName: string;
    fileSize: number;
    fileType: string;
    progress: number;
    chunkIndex: number;
    totalChunks: number;
    status: UploadStatus;
    error?: string;
    sessionId?: string;
    isProcessing?: boolean;
    processingProgress?: number;
    processedSize?: number;
}
interface FileMetadata {
    size?: number;
    type?: string;
    fieldname?: string;
}
interface UploadProgress {
    uploadId: string;
    files: FileUploadItem[];
    overallProgress: number;
    status: UploadStatus;
    speed?: number;
    timeRemaining?: number;
    startTime: number;
    endTime?: number;
    canResume?: boolean;
    error?: string;
    retryCount: number;
    maxRetries: number;
    allFilesSessionId?: string[];
    fileName?: string;
    fileSize?: number;
    fileType?: string;
    progress?: number;
    endpoint?: string;
    method?: string;
    postData?: Record<string, any>;
    metadata?: Array<FileMetadata>;
    uploadType?: string;
}
interface UploadOptions {
    endpoint: string;
    method: 'POST' | 'PATCH';
    maxFiles?: number;
    concurrentUploads?: number;
    priority?: 'high' | 'normal' | 'low';
    uploadId?: string;
    postData?: Record<string, any>;
    uploadType?: string;
    metadata?: Array<FileMetadata>;
    transformer?: TransformerConfig;
}
interface UpdateProgressParams {
    progress: number;
    status?: UploadStatus;
    error?: string;
    speed?: number;
    timeRemaining?: number;
}
interface WorkerMessage {
    type: string;
    uploadId: string;
    fileIndex?: number;
    fileName?: string;
    chunkIndex?: number;
    totalChunks?: number;
    progress?: string;
    overallProgress?: string;
    fileProgress?: string;
    status?: UploadStatus;
    message?: string;
    error?: string;
    data?: any;
    allFilesSessionId?: string[];
    canResume?: boolean;
    clearType?: 'all' | 'completed' | 'failed' | 'single';
    uploadIds?: string[];
    requestId?: string;
    [key: string]: any;
}

interface UploadProgressState {
    uploads: UploadProgress[];
    activeWorkers: Map<string, Worker>;
    uploadQueue: Map<string, InitializeUploadParams>;
    concurrentUploads: number;
    addUpload: (params: AddUploadParams) => void;
    initializeUpload: (params: InitializeUploadParams) => void;
    updateProgress: (uploadId: string, params: UpdateProgressParams) => void;
    updateUploadProgress: (message: WorkerMessage) => void;
    finalizeUpload: (uploadId: string, success: boolean, data?: any, error?: string) => void;
    pauseUpload: (uploadId: string) => void;
    resumeUpload: (uploadId: string) => void;
    cancelUpload: (uploadId: string) => void;
    retryUpload: (uploadId: string) => void;
    removeUpload: (uploadId: string) => void;
    clearCompleted: () => Promise<void>;
    clearFailed: () => Promise<void>;
    clearAll: () => Promise<void>;
    checkForResumableUploads: () => Promise<void>;
    handleResumeResponse: (message: WorkerMessage) => void;
    createWorker: (uploadId: string) => Worker;
    terminateWorker: (uploadId: string) => void;
    terminateAllWorkers: () => void;
    processUploadQueue: () => void;
    enqueueUpload: (params: InitializeUploadParams) => void;
    getUpload: (uploadId: string) => UploadProgress | undefined;
    totalProgress: number;
    activeUploads: number;
    completedUploads: number;
    failedUploads: number;
    pausedUploads: number;
    hasUploads: boolean;
    hasActiveUploads: boolean;
    canResumeAnyUpload: boolean;
}
interface AddUploadParams {
    uploadId: string;
    fileName: string;
    fileSize: number;
    fileType: string;
    endpoint: string;
    method?: string;
    postData?: Record<string, any>;
    metadata?: any[];
    uploadType: string;
}
interface InitializeUploadParams {
    uploadId: string;
    blobs: Blob[];
    filenameArray: string[];
    endpoint: string;
    method?: string;
    postData?: Record<string, any>;
    metadata?: any[];
    uploadType: string;
    transformer?: any;
}
declare const useUploadProgress: Omit<Omit<zustand.StoreApi<UploadProgressState>, "persist"> & {
    persist: {
        setOptions: (options: Partial<zustand_middleware.PersistOptions<UploadProgressState, unknown>>) => void;
        clearStorage: () => void;
        rehydrate: () => Promise<void> | void;
        hasHydrated: () => boolean;
        onHydrate: (fn: (state: UploadProgressState) => void) => () => void;
        onFinishHydration: (fn: (state: UploadProgressState) => void) => () => void;
        getOptions: () => Partial<zustand_middleware.PersistOptions<UploadProgressState, unknown>>;
    };
}, "setState"> & {
    setState(nextStateOrUpdater: UploadProgressState | Partial<UploadProgressState> | ((state: immer.WritableDraft<UploadProgressState>) => void), shouldReplace?: boolean | undefined): void;
};

declare function useUpload(): {
    uploads: UploadProgress[];
    totalProgress: number;
    activeUploads: number;
    completedUploads: number;
    failedUploads: number;
    pausedUploads: number;
    hasUploads: boolean;
    hasActiveUploads: boolean;
    canResumeAnyUpload: boolean;
    upload: (files: File[], fieldnames: string[], options: UploadOptions) => Promise<string>;
    addUpload: (params: AddUploadParams) => void;
    initializeUpload: (params: InitializeUploadParams) => void;
    updateProgress: (uploadId: string, params: UpdateProgressParams) => void;
    pauseUpload: (uploadId: string) => void;
    resumeUpload: (uploadId: string) => void;
    cancelUpload: (uploadId: string) => void;
    retryUpload: (uploadId: string) => void;
    removeUpload: (uploadId: string) => void;
    clearCompleted: () => Promise<void>;
    clearFailed: () => Promise<void>;
    clearAll: () => Promise<void>;
    checkForResumableUploads: () => Promise<void>;
    createWorker: (uploadId: string) => Worker;
    terminateWorker: (uploadId: string) => void;
    getUpload: (uploadId: string) => UploadProgress | undefined;
    terminateAllWorkers: () => void;
};

/**
 * React hook for accessing upload state
 */
declare function useUploadState(uploadId?: string): {
    currentUpload: any;
    allUploads: any;
    totalProgress: any;
    activeCount: any;
    isActive: boolean;
    isPaused: boolean;
    isFailed: boolean;
    isCompleted: boolean;
};

export { useUpload, useUploadProgress, useUploadState };
