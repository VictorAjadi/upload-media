/**
 * @upload-media/client — Storage Durability Shield
 *
 * Browsers classify IndexedDB under "best-effort" temporary storage by default.
 * Under device memory pressure the disk space manager will silently evict
 * IndexedDB records without warning — breaking in-flight chunk caches and
 * destroying upload resume state.
 *
 * This module requests explicit persistent storage classification from the
 * browser's Storage API, monitors quota headroom, and provides early-warning
 * signals before the runtime runs out of space mid-upload.
 *
 * Reference: https://storage.spec.whatwg.org/#persistence
 */

/// <reference lib="webworker" />

// ── Types ────────────────────────────────────────────────────────────────────

export interface StorageQuota {
  /** Bytes currently consumed by this origin */
  usage: number;
  /** Total bytes the browser has allocated for this origin */
  quota: number;
  /** Remaining bytes available */
  available: number;
}

export interface DurabilityStatus {
  /** Whether the browser granted persistent storage */
  persisted: boolean;
  /** Current quota snapshot (null if StorageManager unavailable) */
  quota: StorageQuota | null;
  /** Whether the API is available at all in this context */
  apiAvailable: boolean;
}

export interface CapacityCheck {
  /** Whether there is enough space for the upload */
  sufficient: boolean;
  /** Bytes remaining after accounting for current usage */
  availableBytes: number;
  /** The safety threshold used (2× requested) */
  requiredBytes: number;
}

// ── Safety multiplier ────────────────────────────────────────────────────────
// We require 2× the remaining upload size as headroom. This accounts for
// IndexedDB journaling overhead, temporary write amplification from
// compaction, and the fact that we store both file blobs and progress
// metadata in separate object stores.
const HEADROOM_MULTIPLIER = 2;

// ── Core API ─────────────────────────────────────────────────────────────────

/**
 * Request persistent storage from the browser. This tells the host OS to
 * classify this origin's storage as "persistent" — protected from
 * background cleanup routines and silent eviction.
 *
 * This is a **best-effort** request. Firefox grants it automatically for
 * installed PWAs; Chrome uses a heuristic based on engagement score,
 * bookmarks, and whether a service worker is registered. Safari always
 * returns false but does not actively evict in most scenarios.
 *
 * Safe to call from a Worker context (navigator.storage is available in
 * DedicatedWorkerGlobalScope since Chrome 55+, Firefox 57+).
 */
export async function requestPersistentStorage(): Promise<DurabilityStatus> {
  // Guard: StorageManager may not exist in older browsers or restricted contexts
  if (typeof navigator === 'undefined' || !navigator.storage) {
    return { persisted: false, quota: null, apiAvailable: false };
  }

  let persisted = false;

  // Check if we already have persistent storage before requesting it.
  // persist() may show a permission prompt in some browsers — we avoid
  // that if the grant is already in place.
  try {
    persisted = await navigator.storage.persisted();
  } catch {
    // persisted() not available — fall through to request
  }

  if (!persisted) {
    try {
      persisted = await navigator.storage.persist();
    } catch {
      // persist() threw — browser does not support it or denied silently
      persisted = false;
    }
  }

  const quota = await getQuota();

  return { persisted, quota, apiAvailable: true };
}

/**
 * Query the current storage quota for this origin.
 * Returns null if the StorageManager estimate API is unavailable.
 */
export async function getQuota(): Promise<StorageQuota | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return null;
  }

  try {
    const estimate = await navigator.storage.estimate();
    const usage = estimate.usage ?? 0;
    const quota = estimate.quota ?? 0;
    return {
      usage,
      quota,
      available: Math.max(0, quota - usage),
    };
  } catch {
    return null;
  }
}

/**
 * Check whether the origin has enough storage capacity for a given upload.
 *
 * @param totalRemainingBytes - Total bytes still to be cached in IndexedDB
 *   (sum of un-uploaded file sizes, not the full file size if some chunks
 *    have already been sent and cleared).
 */
export async function checkStorageCapacity(
  totalRemainingBytes: number
): Promise<CapacityCheck> {
  const requiredBytes = totalRemainingBytes * HEADROOM_MULTIPLIER;

  const quota = await getQuota();
  if (!quota) {
    // API unavailable — assume sufficient rather than blocking the upload.
    // The worst case is the browser evicts data, which is the same behavior
    // we'd get without this module at all.
    return { sufficient: true, availableBytes: Infinity, requiredBytes };
  }

  return {
    sufficient: quota.available >= requiredBytes,
    availableBytes: quota.available,
    requiredBytes,
  };
}

/**
 * Format bytes into a human-readable string for warning messages.
 */
export function formatBytes(bytes: number): string {
  if (bytes === Infinity) return '∞';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
