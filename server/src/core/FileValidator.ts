/**
 * @upload-media/server - FileValidator
 *
 * Pure, side-effect-free validation helpers. Kept separate from the
 * engine so they're trivially unit-testable and reusable from custom
 * framework adapters or scripts.
 */

import { MediaKind, UploadTypeConfig } from '../types';
import { getMimeKind } from '../constants';

export class ValidationError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = statusCode;
  }
}

export function detectKind(contentType: string): MediaKind {
  return getMimeKind(contentType);
}

export function assertKindAllowed(kind: MediaKind, uploadType: UploadTypeConfig): void {
  if (!uploadType.allowedKinds.includes(kind)) {
    throw new ValidationError(
      `Media kind "${kind}" is not allowed for upload type "${uploadType.name}". ` +
      `Allowed kinds: ${uploadType.allowedKinds.join(', ')}`
    );
  }
}

export function assertWithinLimit(size: number, limit: number, label: string): void {
  if (size > limit) {
    const limitMb = (limit / (1024 * 1024)).toFixed(1);
    throw new ValidationError(`${label} exceeds the ${limitMb}MB limit`);
  }
}

export function assertRequiredFields(fields: Record<string, any>, required: string[]): void {
  const missing = required.filter((key) => fields[key] === undefined || fields[key] === null || fields[key] === '');
  if (missing.length > 0) {
    throw new ValidationError(`Missing required field(s): ${missing.join(', ')}`);
  }
}

export function parseIntSafe(value: any, fallback?: number): number {
  const parsed = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    if (fallback !== undefined) return fallback;
    throw new ValidationError(`Expected a numeric value, received "${value}"`);
  }
  return parsed;
}

export function parseJsonSafe<T = any>(value: any, fallback: T): T {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function parseBooleanFlag(value: any): boolean {
  return value === true || value === 'true' || value === '1' || value === 1;
}
