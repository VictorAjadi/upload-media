import { FFmpeg } from '@ffmpeg/ffmpeg';
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

/**
 * @upload-media/client - Type Definitions
 */
type UploadStatus = 'pending' | 'initializing' | 'uploading' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'modifying' | 'generating_thumbnail' | 'error';
interface UploadOptions {
    /** Upload endpoint URL */
    endpoint: string;
    /** HTTP method (POST or PATCH) */
    method: 'POST' | 'PATCH';
    /** Video/Image quality ('high', 'medium', 'low') */
    quality?: 'high' | 'medium' | 'low';
    /** Maximum number of files allowed */
    maxFiles?: number;
    /** Number of concurrent uploads */
    concurrentUploads?: number;
    /** Upload priority */
    priority?: 'high' | 'normal' | 'low';
    /** Whether to transform/process media */
    transform?: boolean;
    /** Custom upload ID */
    uploadId?: string;
    /** Additional form data to send */
    postData?: Record<string, any>;
    /** Request metadata */
    metadata?: Record<string, any>[];
    /** Video start time (for trimming) */
    videoStartTime?: number | string;
    /** Video end time (for trimming) */
    videoEndTime?: number | string;
    /** Video duration */
    duration?: string;
    /** Media transformation options */
    transformer?: {
        /** 0-100 quality for images, or specific quality type */
        quality?: number | 'high' | 'medium' | 'low';
        /** List of qualities to generate (multi-output) */
        qualities?: (number | 'high' | 'medium' | 'low')[];
        /** Auto-transform based on network or config */
        auto?: boolean;
        /** Output format if applicable */
        format?: string;
    };
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
    needsModification?: boolean;
    isModified?: boolean;
    modificationProgress?: number;
    startTime?: number;
    endTime?: number | null;
    isMuted?: boolean;
    videoDuration?: number | null;
    needsTransformation?: boolean;
    isTransformed?: boolean;
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
    metadata?: any[];
    modificationConfigs?: any[];
    videoStartTime?: string;
    videoEndTime?: string;
    duration?: string;
    currentModifyingIndex?: number;
    uploadType?: string;
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
    chunkProgress?: string;
    status?: UploadStatus;
    message?: string;
    error?: string;
    data?: any;
    allFilesSessionId?: string[];
    canResume?: boolean;
    clearType?: 'all' | 'completed' | 'failed' | 'single';
    uploadIds?: string[];
    modifiedBlob?: Blob;
    blob?: Blob;
    config?: any;
    requestId?: string;
    [key: string]: any;
}
interface UpdateProgressParams {
    progress: number;
    status?: UploadStatus;
    error?: string;
    speed?: number;
    timeRemaining?: number;
}
interface ModificationConfig {
    needsModification: boolean;
    isModified?: boolean;
    config?: {
        type: 'image' | 'video';
        quality?: 'high' | 'medium' | 'low';
        videoKey?: string;
    };
}
interface UploadResult {
    status: 'success' | 'error';
    uploadId: string;
    message: string;
    data?: any;
    error?: string;
    allFilesSessionId?: string[];
}
interface TrimOptions {
    startTime?: number | null;
    endTime?: number | null;
    quality?: 'high' | 'medium' | 'low';
    mute?: boolean;
    onProgress?: (progress: number) => void;
    useFFmpeg?: boolean;
    outputFormat?: 'mp4' | 'webm' | 'mkv' | 'mov' | 'avi' | 'flv';
    fastMode?: boolean;
}
interface EventCallbacks {
    onProgress?: (progress: number) => void;
    onError?: (error: string) => void;
    onComplete?: (result: Blob) => void;
    onCancel?: () => void;
}
interface VideoMetadata {
    duration: number;
    width: number;
    height: number;
    hasAudio: boolean;
    frameRate: number;
    bitrate?: number;
    codec?: string;
    audioCodec?: string;
}
interface AudioTrimOptions {
    startTime?: number | null;
    endTime?: number | null;
    quality?: 'high' | 'medium' | 'low';
    onProgress?: (progress: number) => void;
    useFFmpeg?: boolean;
    outputFormat?: 'mp3' | 'wav' | 'aac' | 'ogg' | 'm4a';
}
interface AudioEventCallbacks {
    onProgress?: (progress: number) => void;
    onError?: (error: string) => void;
    onComplete?: (result: Blob) => void;
}

declare class VideoTrimmer {
    private callbacks;
    private abortController;
    private isProcessing;
    private resources;
    private ffmpeg;
    private ffmpegLoaded;
    constructor(callbacks?: EventCallbacks);
    trimVideo(file: File, options: TrimOptions): Promise<Blob>;
    private validateInputs;
    private performTrimming;
    private selectOptimalMethod;
    private trimWithOptimizedFFmpeg;
    loadFFmpeg(): Promise<FFmpeg>;
    private trimWithWebCodecs;
    private calculateWebCodecsBitrate;
    private trimWithOptimizedRecording;
    private getEnhancedVideoMetadata;
    private validateTimeBounds;
    private supportsWebCodecs;
    private getSafeEncoderDimensions;
    private createOptimizedVideo;
    private seekToTime;
    private addOptimizedAudio;
    private getOptimalDimensions;
    private getBestRecordingMimeType;
    private getFileExtension;
    private getMimeTypeFromFormat;
    private calculateOptimalBitrate;
    private emitProgress;
    private cleanup;
    cancel(): void;
    isProcessingVideo(): boolean;
    static trim(file: File, options: TrimOptions & {
        preferredMethod?: 'auto' | 'ffmpeg' | 'webcodecs' | 'recording';
    }): Promise<Blob>;
    static getVideoInfo(file: File): Promise<VideoMetadata>;
    static getCapabilities(): {
        ffmpegSupported: boolean;
        webCodecsSupported: boolean;
        supportedInputFormats: string[];
        supportedOutputFormats: string[];
        recommendedMethod: string;
    };
    static estimateProcessingTime(file: File, trimDuration: number, method?: 'ffmpeg' | 'webcodecs' | 'recording', fastMode?: boolean): number;
    static suggestOptimalSettings(file: File, trimDuration: number): {
        quality: 'high' | 'medium' | 'low';
        fastMode: boolean;
        preferredMethod: 'ffmpeg' | 'webcodecs' | 'recording';
        outputFormat: 'mp4' | 'webm';
    };
}
declare const useVideoTrimmer: (callbacks?: EventCallbacks) => {
    trimVideo: (file: File, options: TrimOptions) => Promise<Blob>;
    getCapabilities: () => {
        ffmpegSupported: boolean;
        webCodecsSupported: boolean;
        supportedInputFormats: string[];
        supportedOutputFormats: string[];
        recommendedMethod: string;
    };
    suggestSettings: (file: File, trimDuration: number) => {
        quality: "high" | "medium" | "low";
        fastMode: boolean;
        preferredMethod: "ffmpeg" | "webcodecs" | "recording";
        outputFormat: "mp4" | "webm";
    };
};

interface AddUploadParams {
    uploadId: string;
    fileName: string;
    fileSize: number;
    fileType: string;
    endpoint: string;
    method?: string;
    postData?: Record<string, any>;
    metadata?: any[];
    videoStartTime?: string;
    videoEndTime?: string;
    duration?: string;
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
    modificationConfigs?: ModificationConfig[];
    videoStartTime?: string;
    videoEndTime?: string;
    duration?: string;
    uploadType: string;
    transformer?: {
        quality?: number | 'high' | 'medium' | 'low';
        auto?: boolean;
        format?: string;
    };
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
    handleModificationRequest: (message: WorkerMessage) => void;
    pauseUpload: (uploadId: string) => void;
    resumeUpload: (uploadId: string) => void;
    cancelUpload: (uploadId: string) => void;
    retryUpload: (uploadId: string) => void;
    removeUpload: (uploadId: string) => void;
    clearCompleted: () => void;
    clearFailed: () => void;
    clearAll: () => void;
    checkForResumableUploads: () => Promise<void>;
    handleResumeResponse: (message: WorkerMessage) => void;
    createWorker: (uploadId: string) => Worker;
    terminateWorker: (uploadId: string) => void;
    terminateAllWorkers: () => void;
    processUploadQueue: () => void;
    enqueueUpload: (params: InitializeUploadParams) => void;
    modifyFile: (uploadId: string, fileIndex: number, blob: Blob, config: any) => Promise<Blob>;
    generateThumbnail: (uploadId: string, fileIndex: number, blob: Blob) => Promise<string>;
    handleThumbnailRequest: (message: WorkerMessage) => Promise<void>;
    handleTransformationRequest: (message: WorkerMessage) => Promise<void>;
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
    clearCompleted: () => void;
    clearFailed: () => void;
    clearAll: () => void;
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
     * Cleanup and destroy
     */
    destroy(): void;
}

export { type AddUploadParams, type AudioEventCallbacks, type AudioTrimOptions, type EventCallbacks, type FileUploadItem, type InitializeUploadParams, type ModificationConfig, type TrimOptions, type UpdateProgressParams, UploadManager, type UploadManagerConfig, type UploadMediaConfig, type UploadOptions, type UploadProgress, type UploadProgressState, type UploadResult, type UploadStatus, type VideoMetadata, VideoTrimmer, type WorkerMessage, cleanupUploadResources, getUploadMediaConfig, setUploadMediaConfig, useUploadActions, useUploadProgress, useVideoTrimmer };
