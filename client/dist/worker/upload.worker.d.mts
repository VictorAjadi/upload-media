/**
 * upload.worker.ts (v2)
 *
 * Simplified for backend-driven processing:
 * - No modification/transformation round-trips
 * - No thumbnail generation
 * - Just chunked upload with pause/resume/cancel
 */
type WorkerProgress = {
    uploadId: string;
    fileCount: number;
    currentFileIndex: number;
    currentChunkIndex: number;
    completedFiles: number;
    allFilesSessionId: string[];
    overallProgress: string;
    startTime: number;
    filenames: string[];
    postData?: Record<string, any>;
    metadata?: any[];
    endpoint?: string;
    method?: string;
    uploadType?: string;
    status?: string;
    errorMessage?: string;
    lastUpdated?: number;
    retryCount?: number;
    maxRetriesReached?: boolean;
    transformer?: any;
} | null;

export type { WorkerProgress };
