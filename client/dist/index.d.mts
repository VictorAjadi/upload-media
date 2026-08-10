import * as immer from 'immer';
import * as zustand_middleware from 'zustand/middleware';
import * as zustand_vanilla from 'zustand/vanilla';

interface UploadMediaConfig {
    getCookie?: () => Promise<string | null> | string | null;
    encryptQueryString?: (data: any) => string | Promise<string>;
    showToast: {
        success: (msg: string) => void;
        error: (msg: string) => void;
        info: (msg: string) => void;
        warning: (msg: string) => void;
    };
    videoState: {
        getState: () => {
            videos: Record<number, {
                startTime?: number;
                endTime?: number | null;
                isMuted?: boolean;
                videoDuration?: number | null;
            }>;
            clearVideoState: (key: string) => void;
        };
    };
    customTransformer?: (blob: Blob, options: any, onProgress: (p: number) => void) => Promise<Blob | Record<string, Blob>>;
}
declare const setUploadMediaConfig: (config: Partial<UploadMediaConfig>) => void;
declare const getUploadMediaConfig: () => UploadMediaConfig;

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
    responseData?: any;
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
    mockNetworkDropRate?: number;
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
    mockNetworkDropRate?: number;
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
interface UploadResult {
    status: 'success' | 'error';
    uploadId: string;
    message: string;
    data?: any;
    error?: string;
    allFilesSessionId?: string[];
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
    transformer?: TransformerConfig;
    mockNetworkDropRate?: number;
}
declare const useUploadProgress: Omit<Omit<zustand_vanilla.StoreApi<UploadProgressState>, "persist"> & {
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
declare const useUploadActions: () => {
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
};
declare const cleanupUploadResources: () => void;

/**
 * UploadManager - Core upload orchestration class
 * Handles file uploads with chunking, resume, and worker management
 */

interface UploadManagerConfig {
    workerUrl?: string;
    onProgress?: (progress: UploadProgress) => void;
    onComplete?: (result: UploadResult) => void;
    onError?: (error: Error) => void;
    storageKey?: string;
}
declare class UploadManager {
    private worker;
    private uploads;
    private config;
    private eventListeners;
    constructor(config?: UploadManagerConfig);
    /**
     * Get default worker URL based on environment and format
     */
    private getDefaultWorkerUrl;
    /**
     * Fallback method to get worker URL without import.meta
     */
    private getWorkerUrlFallback;
    /**
     * Initialize and setup Web Worker
     */
    private initializeWorker;
    /**
     * Handle messages from Worker
     */
    private handleWorkerMessage;
    /**
     * Handle transformation request from worker
     */
    private handleTransformationRequest;
    /**
     * Upload files with optional chunking and resume support
     */
    upload(files: File[], fieldnames: string[], options: UploadOptions): Promise<UploadResult>;
    /**
     * Pause an active upload
     */
    pause(uploadId: string): void;
    /**
     * Resume a paused upload
     */
    resume(uploadId: string): void;
    /**
     * Cancel an upload
     */
    cancel(uploadId: string): void;
    /**
     * Remove upload from tracking
     */
    remove(uploadId: string): void;
    /**
     * Get all uploads
     */
    getUploads(): UploadProgress[];
    /**
     * Get specific upload
     */
    getUpload(uploadId: string): UploadProgress | undefined;
    /**
     * Event listener support
     */
    on(event: string, callback: Function): () => void;
    /**
     * Emit events
     */
    private emit;
    /**
     * Update upload progress
     */
    private updateProgress;
    /**
     * Handle upload completion
     */
    private handleUploadSuccess;
    /**
     * Handle upload error
     */
    private handleUploadError;
    /**
     * Handle token request from worker
     */
    private handleTokenRequest;
    /**
     * Provide token to worker
     */
    provideToken(token: string): void;
    /**
     * Save state to localStorage
     */
    private saveToStorage;
    /**
     * Restore state from localStorage
     */
    private restoreFromStorage;
    /**
     * Set worker URL dynamically (useful for consumers)
     */
    setWorkerUrl(url: string): void;
    /**
     * Cleanup and destroy
     */
    destroy(): void;
}

export { type AddUploadParams, type FileMetadata, type FileUploadItem, type InitializeUploadParams, type Quality, type QualityConfig, type TransformerConfig, type UpdateProgressParams, UploadManager, type UploadManagerConfig, type UploadMediaConfig, type UploadOptions, type UploadProgress, type UploadProgressState, type UploadResult, type UploadStatus, type WorkerMessage, cleanupUploadResources, getUploadMediaConfig, setUploadMediaConfig, useUploadActions, useUploadProgress };
