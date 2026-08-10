/**
 * upload.worker.ts (v3)
 *
 * Stateless, hardware-optimized chunked upload worker.
 *
 * v3 changes:
 * - IndexedDB Storage Durability Shield (persistent storage request)
 * - Quota capacity monitoring before upload start
 * - Foundation for stateless token handshake (Phase 2)
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
    completedChunksMap?: Record<string, boolean>;
} | null;

export type { WorkerProgress };
