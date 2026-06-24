# @upload-media/client

🚀 **A Premium, Worker-Powered Upload Orchestration Engine for the Modern Web.**

`@upload-media/client` is more than a simple file uploader; it is a professional-grade client-side processing, state-management, and reliability pipeline. Designed to handle massive files (up to 4GB+) and volatile network environments, it leverages Web Workers and IndexedDB to provide a desktop-grade experience in any web browser.

---

## ✨ Features at a Glance

- 🧵 **Worker-First Pipeline**: Heavy encryption, checksumming, and multipart encoding happen off the main thread.
- 🧱 **Resumable Chunking**: Intelligent splitting of files with persistable session state via IndexedDB.
- 🔄 **Total Persistence**: Survives page refreshes, tab closures, and browser crashes.
- 📊 **Real-Time Analytics**: Built-in speed calculators, ETAs, and per-file progress tracking.
- ✂️ **Browser-Side Trimming/Quality Modification**: Trim and transcode videos/audio in-browser using **WASM FFmpeg**.
- 🖼️ **Client-Side Previews**: Immediate JPEG/Canvas thumbnails for zero-latency UI feedback.
- 🛠️ **State Management**: Built-in Zustand store for reactive progress tracking.
- ⚡ **Framework Agnostic**: Works with React, Vue, Svelte, Solid, Angular or Vanilla JS.

---

## 🏗️ Technical Architecture

The library follows a strict **Message-Oriented Architecture** to ensure that the UI thread remains completely responsive, regardless of the upload volume.

### 1. The Orchestrator (Main Thread)
*   **Actions**: Exposes methods like `initializeUpload`, `pauseUpload`, and `resumeUpload`.
*   **State Machine**: A Zustand-based reactive store providing a "single source of truth" for the entire UI.
*   **Bridge**: Communicates with the background worker using the standard `postMessage` API.

### 2. The Worker (Background Thread)
*   **Queue Manager**: Handles concurrency limits to prevent network socket exhaustion.
*   **Heartbeat**: Monitors connectivity and triggers retries on transient network failures.
*   **WASM Bridge**: Mounts an internal instance of FFmpeg for on-the-fly media manipulation.

### 3. The Persistence Layer (IndexedDB)
*   **Manifests**: Stores the upload plan (endpoints, headers, file paths).
*   **Checkpointing**: Saves the byte-offset and chunk index of successfully acknowledged data.
*   **Blobs**: Holds file references so users don't re-select files after a refresh.

---

## 🚀 Implementation Guides

### 1. React Setup (Recommended)

#### Step 1: Create the Zustand Bridge Hook

```typescript
// hooks/useUploadProgress.ts
import { useStore } from 'zustand';
// Import the raw vanilla store instance 
import { useUploadProgress as vanillaUploadProgressStore } from '@upload-media/client';

/**
 * Create a reactive React hook from the vanilla store.
 * This satisfies the syntax: useUploadProgress((state) => state.uploads)
 */
export const useUploadProgress = <T>(selector: (state: any) => T): T => {
  return useStore(vanillaUploadProgressStore, selector);
};
```

#### Step 2: Build Your React Component

```typescript
// components/FileUploader.tsx
import { useRef } from 'react';
import { useUploadActions,useUploadProgress } from '@upload-media/client';

export function FileUploader() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { initializeUpload, pauseUpload, resumeUpload, cancelUpload } = useUploadActions();
  
  // Subscribe to upload state reactively
  const uploads = useUploadProgress(s => s.uploads);
  const totalProgress = useUploadProgress(s => s.totalProgress);

  const handleUpload = () => {
    const files = Array.from(fileInputRef.current?.files || []);
    if (files.length === 0) return;

    initializeUpload({
      uploadId: `upload_${Date.now()}`,
      blobs: files,
      filenameArray: files.map(f => f.name),
      endpoint: 'http://localhost:3000/api/upload',
      method: 'POST',
      // Optional: Add custom data or field mappings
      metadata: files.map((_, i) => ({ fieldname: 'files' })),
      postData: { userId: '123', category: 'photos' }
    });
  };

  return (
    <div className="space-y-6 p-6 bg-slate-900 rounded-lg">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="block w-full"
      />
      
      <button
        onClick={handleUpload}
        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
      >
        Upload Files
      </button>

      {/* Overall progress bar */}
      <div className="w-full bg-slate-800 rounded h-2">
        <div
          className="h-full bg-blue-500 transition-all"
          style={{ width: `${totalProgress}%` }}
        />
      </div>

      {/* Individual upload list */}
      <div className="space-y-3">
        {uploads.map(upload => (
          <div key={upload.uploadId} className="p-4 bg-slate-800 rounded">
            <div className="flex justify-between mb-2">
              <span className="font-bold">{upload.fileName}</span>
              <span className="text-sm">{upload.overallProgress}%</span>
            </div>
            <div className="w-full bg-slate-700 rounded h-1.5 mb-2">
              <div
                className="h-full bg-green-500 transition-all"
                style={{ width: `${upload.overallProgress}%` }}
              />
            </div>
            <div className="flex gap-2">
              {upload.status === 'uploading' ? (
                <>
                  <button 
                    onClick={() => pauseUpload(upload.uploadId)} 
                    className="text-xs bg-yellow-600 px-2 py-1 rounded"
                  >
                    Pause
                  </button>
                  <button 
                    onClick={() => cancelUpload(upload.uploadId)} 
                    className="text-xs bg-red-600 px-2 py-1 rounded"
                  >
                    Cancel
                  </button>
                </>
              ) : upload.status === 'paused' ? (
                <button 
                  onClick={() => resumeUpload(upload.uploadId)} 
                  className="text-xs bg-blue-600 px-2 py-1 rounded"
                >
                  Resume
                </button>
              ) : null}
            </div>
            <p className="text-xs text-slate-400 mt-2">
              Status: {upload.status} {upload.error && `- ${upload.error}`}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
```

### 2. Vanilla JavaScript (CDN)

#### HTML Setup
```html
<!DOCTYPE html>
<html>
<head>
  <!-- CDN Import Map -->
  <script type="importmap">
  {
    "imports": {
      "@upload-media/client": "https://unpkg.com/@upload-media/client@latest/dist/index.mjs",
      "zustand/vanilla": "https://unpkg.com/zustand@latest/esm/vanilla.mjs",
      "zustand/middleware": "https://unpkg.com/zustand@latest/esm/middleware.mjs",
      "immer": "https://unpkg.com/immer@latest/dist/immer.mjs",
      "@ffmpeg/ffmpeg": "https://unpkg.com/@ffmpeg/ffmpeg@latest/dist/esm/index.js",
      "@ffmpeg/util": "https://unpkg.com/@ffmpeg/util@latest/dist/esm/index.js"
    }
  }
  </script>
</head>
<body>
  <input type="file" id="fileInput" multiple />
  <button id="uploadBtn">Upload (Chunked)</button>
  <button id="uploadDirectBtn">Upload (Direct)</button>
  <div id="uploadList"></div>
  <div id="gallery"></div>

  <script type="module" src="upload.js"></script>
</body>
</html>
```

#### JavaScript (upload.js)
```javascript
import { useUploadActions, useUploadProgress, setUploadMediaConfig } from '@upload-media/client';

const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const uploadDirectBtn = document.getElementById('uploadDirectBtn');
const uploadList = document.getElementById('uploadList');
const gallery = document.getElementById('gallery');

const { initializeUpload } = useUploadActions();

// Configure global settings
setUploadMediaConfig({
    maxConcurrent: 3,
    maxRetries: 5,
    showToast: {
        success: (msg) => console.log("✅ Success:", msg),
        error: (msg) => console.log("❌ Error:", msg),
        info: (msg) => console.log("ℹ️ Info:", msg),
    }
});

// 1. CHUNKED UPLOAD (Resumable)
uploadBtn.addEventListener('click', () => {
    const files = Array.from(fileInput.files || []);
    if (files.length === 0) {
        alert('Please select files');
        return;
    }

    initializeUpload({
        uploadId: 'upload_chunked_' + Date.now(),
        blobs: files,
        filenameArray: files.map(f => f.name),
        endpoint: 'http://localhost:3000/api/upload?uploadType=avatar',
        method: 'POST'
    });
});

// 2. DIRECT UPLOAD (Non-Chunked)
uploadDirectBtn.addEventListener('click', async () => {
    const files = Array.from(fileInput.files || []);
    if (files.length === 0) {
        alert('Please select files');
        return;
    }

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const uploadId = 'upload_direct_' + Date.now() + '_' + i;

        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('uploadType', 'avatar');

            const response = await fetch('http://localhost:3000/api/upload?uploadType=avatar', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const result = await response.json();
            console.log(`✅ Direct upload success:`, result);

            // Add to gallery if image
            if (file.type.startsWith('image/') && result.url) {
                addToGallery(file.name, result.url);
            }
        } catch (error) {
            console.error(`❌ Direct upload failed for ${file.name}:`, error);
        }
    }
});

// Subscribe to real-time progress
useUploadProgress.subscribe((state) => {
    uploadList.innerHTML = '';

    if (!state.uploads || !Array.isArray(state.uploads)) return;

    state.uploads.forEach(upload => {
        const item = document.createElement('div');
        item.className = 'upload-item';

        const progress = Math.round(upload.overallProgress || 0);
        const status = upload.status || 'pending';
        const name = upload.fileName || 'Unknown File';

        item.innerHTML = `
            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                <span><strong>${name}</strong></span>
                <span>${progress}%</span>
            </div>
            <div style="background: #e2e8f0; border-radius: 4px; overflow: hidden; height: 8px; width: 100%;">
                <div style="width: ${progress}%; background: #3b82f6; height: 100%; transition: width 0.2s ease;"></div>
            </div>
            <div style="font-size: 0.8rem; margin-top: 0.5rem; color: #94a3b8">
                Status: <strong>${status}</strong>
            </div>
        `;
        uploadList.appendChild(item);

        // Add to gallery if completed image
        if (status === 'completed' && upload.fileType?.startsWith('image/')) {
            const url = upload.url || `http://localhost:3000/uploads/avatar/${upload.uploadId}`;
            addToGallery(name, url);
        }
    });
});

// Gallery helper
function addToGallery(filename, url) {
    if (gallery.querySelector(`[data-url="${url}"]`)) return;

    const item = document.createElement('div');
    item.setAttribute('data-url', url);
    item.style.cssText = 'margin: 10px; text-align: center;';

    item.innerHTML = `
        <img src="${url}" alt="${filename}" 
             style="max-width: 200px; max-height: 200px; border-radius: 8px; object-fit: cover;">
        <p style="font-size: 0.9rem; margin-top: 8px; color: #6b7280;">${filename}</p>
    `;

    gallery.appendChild(item);
}
```

### 3. Other Frameworks

#### Vue 3 (Composition API)
```typescript
import { ref } from 'vue';
import { useUploadActions,useUploadProgress } from '@upload-media/client';

export default {
  setup() {
    const files = ref(null);
    const { initializeUpload } = useUploadActions();
    const { uploads, totalProgress } = useUploadProgress();

    const handleUpload = () => {
      if (!files.value?.length) return;

      initializeUpload({
        uploadId: `upload_${Date.now()}`,
        blobs: Array.from(files.value),
        endpoint: '/api/upload'
      });
    };

    return { files, handleUpload, uploads, totalProgress };
  }
};
```

#### Svelte
```typescript
<script>
  import { useUploadActions,useUploadProgress } from '@upload-media/client';

  let fileInput;
  const { initializeUpload } = useUploadActions();
  const { uploads, totalProgress } = useUploadProgress();

  function handleUpload() {
    const files = Array.from(fileInput.files);
    if (!files.length) return;

    initializeUpload({
      uploadId: `upload_${Date.now()}`,
      blobs: files,
      endpoint: '/api/upload'
    });
  }
</script>

<div class="uploader">
  <input type="file" multiple bind:this={fileInput} />
  <button on:click={handleUpload}>Upload</button>
  
  <div class="progress" style="width: {$totalProgress}%"></div>
  
  {#each $uploads as upload (upload.uploadId)}
    <div class="upload-item">
      <p>{upload.fileName}: {upload.overallProgress}%</p>
    </div>
  {/each}
</div>
```

---

## 🛠️ Core Methods & Hooks

### 1. `useUploadActions()` Hook
Returns a suite of functions to control active sessions:

| Method | Parameters | Description |
| :--- | :--- | :--- |
| `initializeUpload(params)` | `UploadPayload` | Starts a new batch or resumes an interrupted one. |
| `pauseUpload(uploadId)` | `uploadId: string` | Stops all active network requests for the session. |
| `resumeUpload(uploadId)` | `uploadId: string` | Re-triggers the worker to start the chunk loop. |
| `cancelUpload(uploadId)` | `uploadId: string` | Terminates the session and purges its IndexedDB data. |
| `clearUploads(type)` | `type: 'completed' \| 'failed'` | Removes completed or failed uploads from state. |
| `getUpload(uploadId)` | `uploadId: string` | Retrieve a specific upload session by ID. |
| `totalProgress()` | `getter` | Average overall progress across all active sessions. |
| `activeUploads()` | `getter` | Number of active uploads. |
| `completedUploads()` | `getter` | Number of completed uploads. |
| `failedUploads()` | `getter` | Number of failed uploads. |


### 2. `useUploadProgress((state) => ...)` Hook

A reactive Zustand store representing the live state.

**Available Selectors:**
```typescript
// Get all uploads
const uploads = useUploadProgress(s => s.uploads);

// Get specific upload
const upload = useUploadProgress(s => s.getUpload(uploadId));

// Get aggregated progress
const totalProgress = useUploadProgress(s => s.totalProgress);
const activeCount = useUploadProgress(s => s.activeUploads);

// Subscribe to all changes
useUploadProgress.subscribe(state => {
  console.log('Upload state changed:', state);
});
```

### 3. Configuration via `setUploadMediaConfig()`

```typescript
import { setUploadMediaConfig } from '@upload-media/client';

setUploadMediaConfig({
  maxConcurrent: 3,              // Parallel uploads
  maxRetries: 5,                 // Retry attempts per chunk
  retryDelay: 1000,              // Base delay (exponential backoff)
  chunkSizes: {
    video: 5 * 1024 * 1024,      // 5MB for videos
    image: 1 * 1024 * 1024,      // 1MB for images
    default: 2 * 1024 * 1024     // 2MB fallback
  },
  hooks: {
    beforeProcess: async (file) => {
      // Custom preprocessing (e.g., watermarking)
      return file;
    }
  }
});
```

---

## 📁 `initializeUpload` Payload Reference

| Key | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `uploadId` | `string` | Yes | Unique session identifier. |
| `blobs` | `File[]` | Yes | Array of File/Blob objects. |
| `endpoint` | `string` | Yes | Server URL for chunk ingestion. |
| `method` | `string` | No | HTTP method (default: 'POST'). |
| `metadata` | `object[]` | No | Maps blobs to fieldname keys. |
| `postData` | `object` | No | Extra form fields sent with every chunk. |
| `transformer` | `object` | No | Transformation config (quality, format). |
| `transformer.quality` | `'high' \| 'medium' \| 'low' \| number` | No | Quality level or percentage (0-100). |
| `transformer.qualities` | `string[]` | No | Generate multiple variants: ['high', 'medium', 'low']. |
| `transformer.format` | `string` | No | Output format (e.g., 'image/jpeg', 'video/mp4'). |

---

## ✂️ Media Trimming/ Quality Modification & Processing

The library includes browser-side WASM tools for trimming videos and audio without server processing.

```typescript
import { useVideoTrimmer, useAudioTrimmer } from '@upload-media/client';

// Video trimming
const { trim: trimVideo, cancel } = useVideoTrimmer();
const trimmedVideo = await trimVideo(videoFile, {
  startTime: 10,  // seconds
  endTime: 60,    // seconds
  quality: 'medium'
});

// Audio trimming
const { trim: trimAudio } = useAudioTrimmer();
const trimmedAudio = await trimAudio(audioFile, {
  startTime: 0,
  endTime: 30,
  quality: 'high'
});

// Integrated trimming with upload
initializeUpload({
  blobs: [videoFile],
  transform: true,           // Enable WASM processing
  videoStartTime: 10,
  videoEndTime: 60,
  endpoint: '/api/upload'
});
```

**⚠️ Note:** WASM trimming requires Cross-Origin Isolation headers:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

---

## 📊 The Analytics Engine

`@upload-media/client` includes professional-grade speed tracking:

- **Sliding Window Average**: Tracks the last 5 successful network transfers for consistent speed calculation.
- **Bytes-Per-Second**: Calculated by dividing transferred bytes by elapsed time.
- **ETA**: Calculated as `(TotalBytes - Transferred) / CurrentSpeed`.

Access via the state store:
```typescript
const stats = useUploadProgress(s => ({
  speed: s.speed,           // B/s
  totalProgress: s.totalProgress,
  timeRemaining: s.timeRemaining // seconds
}));
```

---

## 💾 Persistence & Resumability

The engine automatically persists upload state to IndexedDB:

```typescript
// Manually resume interrupted uploads
const { resumeUpload } = useUploadActions();
const state = useUploadProgress.getState();

state.uploads
  .filter(u => u.status === 'paused' || u.status === 'initializing')
  .forEach(u => resumeUpload(u.uploadId));
```

---

## 🤔 Troubleshooting

| Symptom | Cause | Solution |
| :--- | :--- | :--- |
| **Worker initialization error** | Cross-Domain | Ensure `workerUrl` is on the same origin (or CORS headers allow). |
| **Progress stuck at 100%** | Finalization | Client waiting for `status: 'success'` response from server. |
| **Memory usage high** | Concurrency | Reduce `maxConcurrentUploads` in config. |
| **SharedArrayBuffer error** | Missing headers | Add COOP/COEP headers if using WASM trimming. |

---

## 🛡️ Security Best Practices

1. **Token Rotation**: Use `setUploadMediaConfig` hooks to refresh credentials.
2. **Payload Validation**: Specify `allowedMimeTypes` to prevent unvalidated uploads.
3. **Cleanup**: Call `clearUploads('completed')` periodically to keep IndexedDB lean.

---

## 📊 Technical Specifications
- **Concurrency Support**: Up to 10 parallel chunks (adjustable).
- **Format Support**: Any binary type (Blobs, ArrayBuffers, Files).
- **Runtime**: Chrome 80+, Safari 13+, Firefox 75+, Edge 80+.
- **Memory Management**: Uses `Blob.slice()` for zero-RAM overhead on multi-gigabyte files.

---

## 📄 License
MIT © 2026 UploadMedia. Distributed as part of the @upload-media ecosystem.

---

*(Last Updated: 2026)*