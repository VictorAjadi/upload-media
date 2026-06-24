/**
 * @upload-media/client - Worker Setup Utility
 * Helps developers properly initialize and configure Web Workers
 */

export interface WorkerSetupConfig {
  workerPath?: string;
  workerOptions?: WorkerOptions;
  enableDebug?: boolean;
  maxWorkers?: number;
}

/**
 * WorkerSetup - Utility class for managing Web Workers
 */
export class WorkerSetup {
  private workers: Map<string, Worker> = new Map();
  private config: WorkerSetupConfig;

  constructor(config: WorkerSetupConfig = {}) {
    this.config = {
      workerPath: config.workerPath || './upload.worker.js',
      maxWorkers: config.maxWorkers || 4,
      enableDebug: config.enableDebug || false,
    };
  }

  /**
   * Create or retrieve a worker
   */
  getWorker(workerId = 'default'): Worker | null {
    // Check if worker already exists
    if (this.workers.has(workerId)) {
      return this.workers.get(workerId)!;
    }

    // Check if we've exceeded max workers
    if (this.workers.size >= this.config.maxWorkers!) {
      console.warn(`Maximum workers (${this.config.maxWorkers}) reached`);
      return null;
    }

    try {
      const worker = new Worker(this.config.workerPath!, {
        type: 'module',
      });

      if (this.config.enableDebug) {
        worker.onmessage = (event) => {
          console.log('[Worker] Message:', event.data);
        };
      }

      worker.onerror = (error) => {
        console.error(`[Worker ${workerId}] Error:`, error);
        this.removeWorker(workerId);
      };

      this.workers.set(workerId, worker);
      return worker;
    } catch (error) {
      console.error('Failed to create worker:', error);
      return null;
    }
  }

  /**
   * Remove/terminate a worker
   */
  removeWorker(workerId = 'default'): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      try {
        worker.terminate();
      } catch (error) {
        console.warn(`Failed to terminate worker ${workerId}:`, error);
      }
      this.workers.delete(workerId);
    }
  }

  /**
   * Terminate all workers
   */
  terminateAll(): void {
    this.workers.forEach((worker) => {
      try {
        worker.terminate();
      } catch (error) {
        console.warn('Failed to terminate worker:', error);
      }
    });
    this.workers.clear();
  }

  /**
   * Send message to worker
   */
  postMessage(workerId: string, message: any): boolean {
    const worker = this.getWorker(workerId);
    if (!worker) {
      return false;
    }

    try {
      worker.postMessage(message);
      return true;
    } catch (error) {
      console.error('Failed to post message to worker:', error);
      return false;
    }
  }

  /**
   * Get worker count
   */
  getWorkerCount(): number {
    return this.workers.size;
  }

  /**
   * Check if worker is available
   */
  isWorkerAvailable(workerId = 'default'): boolean {
    return this.workers.has(workerId);
  }

  /**
   * Enable debug logging for all workers
   */
  enableDebug(): void {
    this.config.enableDebug = true;
  }

  /**
   * Disable debug logging
   */
  disableDebug(): void {
    this.config.enableDebug = false;
  }
}

/**
 * Create a singleton worker setup instance
 */
let workerSetupInstance: WorkerSetup | null = null;

export function getWorkerSetup(config?: WorkerSetupConfig): WorkerSetup {
  if (!workerSetupInstance) {
    workerSetupInstance = new WorkerSetup(config);
  }
  return workerSetupInstance;
}

/**
 * Reset worker setup singleton
 */
export function resetWorkerSetup(): void {
  workerSetupInstance?.terminateAll();
  workerSetupInstance = null;
}

/**
 * Check if Web Workers are supported
 */
export function isWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}

/**
 * Check if specific worker features are available
 */
export function getWorkerCapabilities(): {
  supported: boolean;
  moduleWorkers: boolean;
  sharedArrayBuffer: boolean;
  transferable: boolean;
} {
  return {
    supported: typeof Worker !== 'undefined',
    moduleWorkers: typeof Worker !== 'undefined',
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    transferable: true, // All modern browsers support Transferable objects
  };
}
