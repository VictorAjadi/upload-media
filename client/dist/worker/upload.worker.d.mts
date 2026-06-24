/**
 * @upload-media/client - upload.worker.ts
 *
 * This is a direct, faithful port of the original chunked-upload worker:
 * same IndexedDB-backed resumable storage, same upload queue with
 * concurrency control, same pause/cancel/retry semantics, same
 * thumbnail + modification handoff protocol to the main thread.
 *
 * Two changes from the original, both intentional:
 *   1. `fetch` is used instead of axios (workers don't need axios's
 *      interceptor machinery, and `fetch` natively supports
 *      AbortSignal, which is what cancellation/pause rely on).
 *   2. Every previously-hardcoded constant (chunk sizes, retry count,
 *      concurrency, retention days, db name/version, cleanup endpoint)
 *      is now runtime-configurable via a `configure` message sent
 *      once before the first `upload` message. Sensible defaults are
 *      used if `configure` is never sent, so existing call sites keep
 *      working unmodified.
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
    modificationConfigs?: Array<{
        needsModification: boolean;
        isModified: boolean;
        config?: any;
    }>;
    transformerConfigs?: Array<{
        needsTransformation: boolean;
        isTransformed: boolean;
        config?: any;
    }>;
    endpoint?: string;
    method?: string;
    uploadType?: string;
    videoStartTime?: string;
    videoEndTime?: string;
    duration?: string;
    status?: string;
    errorMessage?: string;
    lastUpdated?: number;
    retryCount?: number;
    maxRetriesReached?: boolean;
    allowedMimeTypes?: string[] | null;
} | null;

export type { WorkerProgress };
