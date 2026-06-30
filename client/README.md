# upload-media-client

🚀 **A Premium, Worker-Powered Upload Orchestration Engine for the Modern Web.**

`upload-media-client` is more than a simple file uploader; it is a professional-grade client-side processing, state-management, and reliability pipeline. Designed to handle massive files (up to 4GB+) and volatile network environments, it leverages Web Workers and IndexedDB to provide a desktop-grade experience in any web browser.

---

## ✨ Features at a Glance

- 🧵 **Worker-First Pipeline**: Heavy encryption, checksumming, and multipart encoding happen off the main thread.
- 🧱 **Resumable Chunking**: Intelligent splitting of files with persistable session state via IndexedDB.
- 🔄 **Total Persistence**: Survives page refreshes, tab closures, and browser crashes.
- 📊 **Real-Time Analytics**: Built-in speed calculators, ETAs, and per-file progress tracking.
- ⚙️ **Backend Processing Integration**: Request video variant encoding, audio extraction, and image resizing/compression from the server via custom `transformer` options.
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
*   **Safe Chunking**: Piles and feeds file chunks to the network stack off-thread, keeping memory overhead at zero.

### 3. The Persistence Layer (IndexedDB)
*   **Manifests**: Stores the upload plan (endpoints, headers, file paths).
*   **Checkpointing**: Saves the byte-offset and chunk index of successfully acknowledged data.
*   **Blobs**: Holds file references so users don't re-select files after a refresh.

---

## 🚀 Implementation Guides

### 1. React Setup (Recommended)

Import the built-in React hooks directly from `upload-media-client/react` to orchestrate state and actions reactively.

#### Code Example (components/FileUploader.tsx)

```typescript
import { useRef } from 'react';
import { useUpload } from 'upload-media-client/react';

export function FileUploader() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // useUpload exposes both the reactive state and standard control actions
  const { 
    uploads, 
    totalProgress, 
    upload, 
    pauseUpload, 
    resumeUpload, 
    cancelUpload 
  } = useUpload();

  const handleUpload = async () => {
    const files = Array.from(fileInputRef.current?.files || []);
    if (files.length === 0) return;

    // This launches a multi-file chunked upload, fully persisted in IndexedDB
    const uploadId = await upload(
      files,
      files.map(() => 'file'), // Form fieldnames mapping
      {
        endpoint: 'http://localhost:3000/api/upload',
        method: 'POST',
        uploadType: 'video', // Backend type config
        postData: { userId: '123' },
        // Backend media processing options
        transformer: {
          type: 'video',
          qualities: ['1080p', '720p', '480p'], // Request multiple video qualities
          format: 'video/mp4',
          generateThumbnail: true
        }
      }
    );
    console.log('Upload started:', uploadId);
  };

  return (
    <div className="space-y-6 p-6 bg-slate-900 rounded-lg text-white">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="block w-full"
      />
      
      <button
        onClick={handleUpload}
        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 font-medium"
      >
        Upload Files
      </button>

      {/* Overall progress bar */}
      <div className="w-full bg-slate-800 rounded h-2">
        <div
          className="h-full bg-blue-500 transition-all duration-300"
          style={{ width: `${totalProgress}%` }}
        />
      </div>

      {/* Individual upload list */}
      <div className="space-y-3">
        {uploads.map(upload => (
          <div key={upload.uploadId} className="p-4 bg-slate-800 rounded">
            <div className="flex justify-between mb-2">
              <span className="font-bold">{upload.fileName}</span>
              <span className="text-sm">{Math.round(upload.overallProgress)}%</span>
            </div>
            <div className="w-full bg-slate-700 rounded h-1.5 mb-2">
              <div
                className="h-full bg-green-500 transition-all duration-300"
                style={{ width: `${upload.overallProgress}%` }}
              />
            </div>
            <div className="flex gap-2">
              {upload.status === 'uploading' ? (
                <>
                  <button 
                    onClick={() => pauseUpload(upload.uploadId)} 
                    className="text-xs bg-yellow-600 px-2 py-1 rounded hover:bg-yellow-700"
                  >
                    Pause
                  </button>
                  <button 
                    onClick={() => cancelUpload(upload.uploadId)} 
                    className="text-xs bg-red-600 px-2 py-1 rounded hover:bg-red-700"
                  >
                    Cancel
                  </button>
                </>
              ) : upload.status === 'paused' ? (
                <button 
                  onClick={() => resumeUpload(upload.uploadId)} 
                  className="text-xs bg-blue-600 px-2 py-1 rounded hover:bg-blue-700"
                >
                  Resume
                </button>
              ) : null}
            </div>
            <p className="text-xs text-slate-400 mt-2">
              Status: <span className="font-semibold text-slate-300">{upload.status}</span> {upload.error && `- ${upload.error}`}
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
      "upload-media-client": "https://unpkg.com/upload-media-client@latest/dist/index.mjs",
      "zustand/vanilla": "https://unpkg.com/zustand@latest/esm/vanilla.mjs",
      "zustand/middleware": "https://unpkg.com/zustand@latest/esm/middleware.mjs",
      "immer": "https://unpkg.com/immer@latest/dist/immer.mjs"
    }
  }
  </script>
</head>
<body>
  <input type="file" id="fileInput" multiple />
  <button id="uploadBtn">Upload (Chunked)</button>
  <button id="uploadMultiBtn">Upload (Multi-Quality)</button>
  <button id="uploadDirectBtn">Upload (Direct)</button>
  <div id="uploadList"></div>
  <div id="gallery"></div>

  <script type="module" src="upload.js"></script>
</body>
</html>
```

#### JavaScript (upload.js)
```javascript
import { useUploadActions, useUploadProgress, setUploadMediaConfig } from 'upload-media-client';

const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const uploadMultiBtn = document.getElementById('uploadMultiBtn');
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
        method: 'POST',
        uploadType: 'avatar'
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
        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('uploadType', 'avatar');

            const response = await fetch('http://localhost:3000/api/upload?uploadType=avatar', {
                method: 'POST',
                body: formData
            });
            const result = await response.json();
            console.log(`✅ Direct upload success:`, result);
        } catch (error) {
            console.error(`❌ Direct upload failed for ${file.name}:`, error);
        }
    }
});

// 3. MULTI-QUALITY CHUNKED UPLOAD
uploadMultiBtn.addEventListener('click', () => {
    const files = Array.from(fileInput.files || []);
    if (files.length === 0) {
        alert('Please select files');
        return;
    }

    initializeUpload({
        uploadId: 'upload_multi_' + Date.now(),
        blobs: files,
        filenameArray: files.map(f => f.name),
        endpoint: 'http://localhost:3000/api/upload?uploadType=video',
        method: 'POST',
        uploadType: 'video',
        transformer: {
            qualities: ['high', 'medium', 80, 40], // Transcode multiple qualities (resolution labels or quality percentage)
            format: 'video/mp4',
            video: {
                quality: 60,
                adaptiveBitrate: true
            },
            audio: {
                audioBitrate: '128k',
                quality: 85
            },
            image: {
                quality: 90
            }
        }
    });
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
import { useUploadActions, useUploadProgress } from 'upload-media-client';

export default {
  setup() {
    const files = ref<File[]>([]);
    const { initializeUpload } = useUploadActions();
    const { uploads, totalProgress } = useUploadProgress();

    const handleUpload = () => {
      if (!files.value?.length) return;

      const fileList = Array.from(files.value);
      initializeUpload({
        uploadId: `upload_${Date.now()}`,
        blobs: fileList,
        filenameArray: fileList.map(f => f.name),
        endpoint: '/api/upload',
        uploadType: 'file' // Matches allowed uploadType on server
      });
    };

    return { files, handleUpload, uploads, totalProgress };
  }
};
```

#### Svelte
```typescript
<script>
  import { useUploadActions, useUploadProgress } from 'upload-media-client';

  let fileInput;
  const { initializeUpload } = useUploadActions();
  const { uploads, totalProgress } = useUploadProgress();

  function handleUpload() {
    const files = Array.from(fileInput.files);
    if (!files.length) return;

    initializeUpload({
      uploadId: `upload_${Date.now()}`,
      blobs: files,
      filenameArray: files.map(f => f.name),
      endpoint: '/api/upload',
      uploadType: 'file'
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
import { setUploadMediaConfig } from 'upload-media-client';

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
| `blobs` | `Blob[]` | Yes | Array of File/Blob objects to upload. |
| `filenameArray` | `string[]` | Yes | Filenames corresponding to each blob index. |
| `uploadType` | `string` | Yes | Target configuration type on the server (e.g. `'video'`, `'avatar'`). |
| `endpoint` | `string` | Yes | Server URL for chunk ingestion. |
| `method` | `string` | No | HTTP method (default: `'POST'`). |
| `metadata` | `object[]` | No | Array of metadata objects matching each blob index. |
| `postData` | `object` | No | Extra form fields sent as part of the chunk payload. |
| `transformer` | `object` | No | Transformation instructions for server-side processing. |
| `transformer.type` | `'image' \| 'video' \| 'audio'` | No | Categories matching the uploaded media format. |
| `transformer.quality` | `'high' \| 'medium' \| 'low' \| number` | No | Target encoding quality label or percentage value. |
| `transformer.qualities` | `string[]` | No | Named resolutions/configurations to generate custom variants (e.g. `['1080p', '720p']`). |
| `transformer.format` | `string` | No | Desired output mimetype (e.g. `'video/mp4'`, `'image/webp'`). |
| `transformer.startTime` | `number` | No | Trim start point in seconds for video/audio. |
| `transformer.endTime` | `number` | No | Trim end point in seconds for video/audio. |
| `transformer.mute` | `boolean` | No | Mutes audio track of processed video variants. |
| `transformer.generateThumbnail`| `boolean` | No | Instructs backend to generate poster frames. |

---

## 🎨 Server-Side Media Processing Configuration

Since media processing runs on the server, you simply pass the desired conversion, variant, and trimming actions inside the `transformer` config.

```typescript
import { useUpload } from 'upload-media-client/react';

const { upload } = useUpload();

// Upload a video and trigger high-speed server-side variant encoding & trimming
await upload(
  [file], 
  [file.name], 
  {
    endpoint: '/api/upload',
    uploadType: 'video',
    transformer: {
      type: 'video',
      startTime: 12.5,                // Trim: start at 12.5 seconds
      endTime: 55.0,                  // Trim: end at 55.0 seconds
      mute: false,                    // Keep audio track
      generateThumbnail: true,        // Generate static PNG thumbnail
      thumbnailTimeSeconds: 5,        // Extract thumbnail at second 5
      qualities: ['1080p', '720p', '480p'] // Generate multiple quality variants
    }
  }
);
```

---

## 📊 The Analytics Engine

`upload-media-client` includes professional-grade speed tracking:

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
MIT © 2026 UploadMedia. Distributed as part of the upload-media ecosystem.

---

*(Last Updated: 2026)*