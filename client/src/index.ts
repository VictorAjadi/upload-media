/**
 * @upload-media/client - Framework-agnostic core
 * For React hooks, import from '@upload-media/client/react'
 */

// Core exports - framework agnostic
export * from './config';
export * from './store/useUploadProgress';
export * from './manager/UploadManager';
export * from './types';

// Export vanilla alternatives to React hooks
// These don't use React
export { UploadManager } from './manager/UploadManager';

// DO NOT export React hooks from here!
// They should only be imported from '@upload-media/client/react'