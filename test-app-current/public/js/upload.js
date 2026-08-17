/**
 * @upload-media/client - Vanilla JS Test Harness
 * Full implementation with pause, resume, cancel, retry, and gallery
 */

import {
    useUploadActions,
    useUploadProgress,
    setUploadMediaConfig,
} from '@upload-media/client'

// ─── DOM Elements ──────────────────────────────────────────────────────────

const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const uploadDirectBtn = document.getElementById('uploadDirectBtn');
const uploadFieldsBtn = document.getElementById('uploadFieldsBtn');
const uploadTransBtn = document.getElementById('uploadTransBtn');
const uploadMultiBtn = document.getElementById('uploadMultiBtn');
const uploadList = document.getElementById('uploadList');
const dropZone = document.getElementById('dropZone');
const gallery = document.getElementById('gallery');
const galleryContent = document.getElementById('galleryContent');

// ─── Store Actions ──────────────────────────────────────────────────────────

const {
    initializeUpload,
    pauseUpload,
    resumeUpload,
    cancelUpload,
    retryUpload,
    removeUpload,
    clearCompleted,
    clearFailed,
    clearAll,
    checkForResumableUploads,
} = useUploadActions();

// ─── Quality Presets ──────────────────────────────────────────────────────

export const YOUTUBE_VIDEO_QUALITIES = [
    { id: '4k', label: '4K (2160p)', quality: 'high', resolution: '2160p', width: 3840, height: 2160, videoBitrate: '16000k', audioBitrate: '256k', codec: 'h264' },
    { id: '1440p', label: '1440p', quality: 'high', resolution: '1440p', width: 2560, height: 1440, videoBitrate: '8000k', audioBitrate: '192k', codec: 'h264' },
    { id: '1080p', label: 'Full HD (1080p)', quality: 'high', resolution: '1080p', width: 1920, height: 1080, videoBitrate: '4000k', audioBitrate: '192k', codec: 'h264' },
    { id: '720p', label: 'HD (720p)', quality: 'medium', resolution: '720p', width: 1280, height: 720, videoBitrate: '2000k', audioBitrate: '128k', codec: 'h264' },
    { id: '480p', label: 'SD (480p)', quality: 'medium', resolution: '480p', width: 854, height: 480, videoBitrate: '1000k', audioBitrate: '96k', codec: 'h264' },
    { id: '360p', label: 'Low (360p)', quality: 'low', resolution: '360p', width: 640, height: 360, videoBitrate: '500k', audioBitrate: '64k', codec: 'h264' },
    { id: '240p', label: 'Very Low (240p)', quality: 'low', resolution: '240p', width: 426, height: 240, videoBitrate: '250k', audioBitrate: '32k', codec: 'h264' }
];

// ─── Toast Configuration ──────────────────────────────────────────────────

setUploadMediaConfig({
    showToast: {
        success: (msg) => console.log("✅ Success:", msg),
        error: (msg) => console.log("❌ Error:", msg),
        info: (msg) => console.log("ℹ️ Info:", msg),
        warning: (msg) => console.log("⚠️ Warning:", msg),
    }
});

// ─── 1. CHUNKED UPLOAD (Via Worker) ──────────────────────────────────────

uploadBtn.addEventListener('click', () => {
    const files = Array.from(fileInput.files);
    if (files.length === 0) {
        alert('Please select files');
        return;
    }

    const file = files[0];
    const uploadType = file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'avatar';
    const uploadId = 'upload_' + uploadType + '_' + Date.now();

    console.log(`🚀 Starting ${uploadType.toUpperCase()} upload:`, uploadId);

    initializeUpload({
        uploadId,
        blobs: files,
        filenameArray: files.map(f => f.name),
        endpoint: `http://localhost:3000/api/upload?uploadType=${uploadType}`,
        method: 'POST',
        headers: { Authorization: 'Bearer secret-token-123' },
        metadata: {
            uploadType: uploadType,
            timestamp: new Date().toISOString()
        }
    });
});

// ─── 2. DIRECT UPLOAD (Non-Chunked) ──────────────────────────────────────

uploadDirectBtn.addEventListener('click', async () => {
    const files = Array.from(fileInput.files);
    if (files.length === 0) {
        alert('Please select files');
        return;
    }

    console.log('📄 Starting NON-CHUNKED upload');

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const uploadId = 'upload_direct_' + Date.now() + '_' + i;

        try {
            const formData = new FormData();
            formData.append('file', file);

            const uploadType = file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'avatar';
            formData.append('uploadType', uploadType);
            formData.append('metadata', JSON.stringify({
                originalName: file.name,
                fileSize: file.size,
                mimeType: file.type,
                uploadId: uploadId
            }));

            console.log(`📤 Uploading ${file.name} (direct/non-chunked)...`);

            const response = await fetch(`http://localhost:3000/api/upload?uploadType=${uploadType}`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }

            const result = await response.json();
            console.log(`✅ Direct upload success:`, result);

            if (result.file) {
                const fileData = result.file;
                const url = fileData.url || `http://localhost:3000/${uploadType}/${fileData.id}?token=secret-token-123`;

                if (file.type.startsWith('image/')) {
                    addToGallery(file.name, url, 'image');
                } else if (file.type.startsWith('video/')) {
                    addToGallery(file.name, url, 'video');
                } else if (file.type.startsWith('audio/')) {
                    addToGallery(file.name, url, 'audio');
                }
            } else if (result.isProcessing && result.fileId) {
                // If it's processing in the background, attach an SSE listener to watch it finish!
                attachSSE(result.fileId, uploadType, file.name);
            }
        } catch (error) {
            console.error(`❌ Direct upload failed for ${file.name}:`, error);
        }
    }
});

// ─── 3. MULTI-FIELD UPLOAD ──────────────────────────────────────────────

uploadFieldsBtn.addEventListener('click', () => {
    const files = Array.from(fileInput.files);
    if (files.length < 2) {
        alert('Please select at least 2 files (e.g. an image and a video)');
        return;
    }

    const uploadId = 'upload_fields_' + Date.now();
    console.log('🚀 Starting MULTI-FIELD upload:', uploadId);

    const fieldnames = files.map(f => {
        if (f.type.startsWith('video/')) return 'postVideos';
        if (f.type.startsWith('image/')) return 'postImage';
        return 'postFiles';
    });

    initializeUpload({
        uploadId,
        blobs: files,
        filenameArray: files.map(f => f.name),
        endpoint: 'http://localhost:3000/api/upload?uploadType=video',
        method: 'POST',
        headers: { Authorization: 'secret-token-123' },
        postData: {
            caption: 'This is a test post with image and video',
            tags: ['test', 'upload', 'premium', 'multi-field']
        },
        metadata: fieldnames.map(name => ({ fieldname: name }))
    });
});

// ─── 4. TRANSFORMED UPLOAD ──────────────────────────────────────────────

uploadTransBtn.addEventListener('click', () => {
    const files = Array.from(fileInput.files);
    if (files.length === 0) {
        alert('Please select files');
        return;
    }

    const file = files[0];
    const isVideo = file.type.startsWith('video/');
    const isImage = file.type.startsWith('image/');
    const isAudio = file.type.startsWith('audio/');
    const uploadType = isVideo ? 'video' : isAudio ? 'audio' : 'avatar';

    if (!isVideo && !isImage && !isAudio) {
        alert('Please select an image, audio, or video file to transform');
        return;
    }

    const uploadId = 'upload_trans_' + Date.now();
    console.log(`🔄 Starting TRANSFORMED ${isVideo ? 'video' : isAudio ? 'audio' : 'image'} upload:`, uploadId);

    let transformer;
    if (isVideo) {
        transformer = {
            type: 'video',
            codec: 'h264',
            bitrate: '2M',
            fps: 30,
            resolution: '1280x720',
            format: 'video/mp4',
            quality: 'high'
        };
    } else if (isAudio) {
        transformer = {
            type: 'audio',
            format: 'audio/mp3',
            audioBitrate: '192k',
            quality: 'high'
        };
    } else {
        transformer = {
            type: 'image',
            width: 800,
            height: 800,
            format: 'image/webp',
            quality: 'high'
        };
    }

    initializeUpload({
        uploadId,
        blobs: [file],
        filenameArray: [file.name],
        endpoint: `http://localhost:3000/api/upload?uploadType=${uploadType}`,
        method: 'POST',
        headers: { Authorization: 'secret-token-123' },
        transformer,
        metadata: {
            transformed: true,
            originalFormat: file.type || 'unknown'
        }
    });
});

// ─── 5. MULTI-QUALITY UPLOAD ─────────────────────────────────────────────

uploadMultiBtn.addEventListener('click', () => {
    const files = Array.from(fileInput.files);
    if (files.length === 0) {
        alert('Please select files');
        return;
    }

    const file = files[0];
    const isVideo = file.type.startsWith('video/');
    const isImage = file.type.startsWith('image/');
    const isAudio = file.type.startsWith('audio/');
    const uploadType = isVideo ? 'video' : isAudio ? 'audio' : 'avatar';

    if (!isVideo && !isImage && !isAudio) {
        alert('Please select an image, audio, or video file for multi-quality');
        return;
    }

    const uploadId = 'upload_multi_' + Date.now();
    console.log(`📊 Starting MULTI-QUALITY ${isVideo ? 'video' : isAudio ? 'audio' : 'image'} upload:`, uploadId);

    let transformer;
    if (isVideo) {
        transformer = {
            type: 'video',
            qualities: ['1080p', '720p', '360p', '480p'],
            format: 'video/mp4',
            generateThumbnail: true,
            thumbnailTimeSeconds: 5,
            auto: false
        };
    } else if (isAudio) {
        transformer = {
            type: 'audio',
            qualityConfigs: [
                // Spotify-like realistic streaming bitrates to prioritize small size over perfect quality
                { id: 'high', audioBitrate: '128k', format: 'mp3' },
                { id: 'medium', audioBitrate: '96k', format: 'mp3' },
                { id: 'low', audioBitrate: '64k', format: 'mp3' }
            ],
            auto: false
        };
    } else {
        transformer = {
            type: 'image',
            qualityConfigs: [
                { id: 'large', width: 1920, format: 'webp', quality: 90 },
                { id: 'medium', width: 1280, format: 'webp', quality: 80 },
                { id: 'thumbnail', width: 320, format: 'webp', quality: 60 }
            ],
            auto: false
        };
    }

    initializeUpload({
        uploadId,
        blobs: [file],
        filenameArray: [file.name],
        endpoint: `http://localhost:3000/api/upload?uploadType=${uploadType}`,
        method: 'POST',
        headers: { Authorization: 'secret-token-123' },
        postData: {
            title: 'My Media',
            description: 'A great upload'
        },
        transformer
    });
});

// ─── 6. DRAG & DROP ──────────────────────────────────────────────────────

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
        fileInput.files = e.dataTransfer.files;
        updateFileList(e.dataTransfer.files);
    }
});

// ─── 7. FILE INPUT CHANGE ──────────────────────────────────────────────

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        updateFileList(e.target.files);
    }
});

function updateFileList(files) {
    const fileList = document.getElementById('fileList');
    if (!fileList) return;

    fileList.innerHTML = '';
    Array.from(files).forEach(file => {
        const item = document.createElement('div');
        item.className = 'file-item';
        const icon = file.type.startsWith('video/') ? '🎬' :
            file.type.startsWith('image/') ? '🖼️' : '📄';
        item.textContent = `${icon} ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`;
        fileList.appendChild(item);
    });
}

// ─── 8. GALLERY HELPERS & SSE ───────────────────────────────────────────

const connectedSSEs = new Set();
function attachSSE(fileId, uploadType, fileName) {
    if (connectedSSEs.has(fileId)) return;
    connectedSSEs.add(fileId);
    
    console.log(`🔌 Connecting to SSE for fileId: ${fileId}...`);
    const evtSource = new EventSource(`/api/events/${fileId}`);
    
    evtSource.addEventListener('connected', (e) => {
        console.log('🔗 SSE Connected:', JSON.parse(e.data).message);
    });

    evtSource.addEventListener('media_processing_started', (e) => {
        console.log('🎬 SSE: Processing started:', JSON.parse(e.data));
    });

    evtSource.addEventListener('media_variant_ready', (e) => {
        const data = JSON.parse(e.data);
        console.log('📥 SSE: Variant ready!', data);
        addToGallery(`${fileName} (${data.quality})`, data.url, uploadType);
    });

    evtSource.addEventListener('media_processing_finished', (e) => {
        const data = JSON.parse(e.data);
        console.log('✅ SSE: Processing completely finished!', data);
    });

    evtSource.addEventListener('close', () => {
        console.log('🚪 SSE: Server closed connection.');
        evtSource.close();
    });

    evtSource.onerror = (err) => {
        console.error('⚠️ SSE Error:', err);
        evtSource.close();
    };
}

function addToGallery(filename, url, type = 'image') {
    if (!galleryContent) return;

    if (galleryContent.querySelector(`[data-url="${url}"]`)) {
        return;
    }

    if (gallery) gallery.style.display = 'block';

    const item = document.createElement('div');
    item.setAttribute('data-url', url);
    item.style.cssText = 'margin: 10px; text-align: center; display: inline-block; vertical-align: top; max-width: 220px;';

    let mediaHtml = '';
    if (type === 'video') {
        mediaHtml = `
            <video src="${url}" 
                   controls 
                   style="max-width: 200px; max-height: 200px; border-radius: 8px; object-fit: cover; border: 2px solid #e2e8f0; background: #000;"
                   onerror="this.style.display='none'; this.nextElementSibling.textContent='Failed to load video'"
            ></video>
        `;
    } else if (type === 'audio') {
        mediaHtml = `
            <audio src="${url}" 
                   controls 
                   style="width: 200px; display: block; border-radius: 8px;"
                   onerror="this.style.display='none'; this.nextElementSibling.textContent='Failed to load audio'"
            ></audio>
        `;
    } else {
        mediaHtml = `
            <img src="${url}" 
                 alt="${filename}" 
                 style="max-width: 200px; max-height: 200px; border-radius: 8px; object-fit: cover; border: 2px solid #e2e8f0;"
                 onerror="this.style.display='none'; this.nextElementSibling.textContent='Failed to load image'"
            >
        `;
    }

    item.innerHTML = `
        ${mediaHtml}
        <p style="font-size: 0.8rem; margin-top: 4px; color: #6b7280; width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${filename}">${filename}</p>
    `;

    galleryContent.appendChild(item);
}

// ─── 9. REAL-TIME PROGRESS WITH CONTROLS ──────────────────────────────

useUploadProgress.subscribe((state) => {
    if (!uploadList) return;
    uploadList.innerHTML = '';

    if (!state.uploads || !Array.isArray(state.uploads)) return;

    // Show uploads in reverse order (newest first)
    const uploads = [...state.uploads].reverse();

    uploads.forEach(upload => {
        const item = document.createElement('div');
        item.className = 'upload-item';
        item.style.cssText = `
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 12px;
            transition: all 0.2s ease;
        `;

        const progress = Math.round(upload.overallProgress || 0);
        const status = upload.status || 'pending';
        const name = upload.fileName || 'Unknown File';
        const fileType = upload.fileType || '';
        const isVideo = fileType.startsWith('video/');
        const isAudio = fileType.startsWith('audio/');
        const isChunked = upload.uploadId?.includes('chunked') || upload.uploadId?.includes('upload_');
        const modeLabel = isChunked ? '📦 Chunked' : '📄 Direct';
        const typeIcon = isVideo ? '🎬' : isAudio ? '🎵' : '🖼️';
        const speed = upload.speed ? `${(upload.speed * 100).toFixed(1)}%/s` : '—';
        const timeRemaining = upload.timeRemaining ? `${Math.ceil(upload.timeRemaining)}s` : '—';

        // Status colors
        const statusColors = {
            'pending': '#94a3b8',
            'initializing': '#f59e0b',
            'uploading': '#3b82f6',
            'paused': '#8b5cf6',
            'completed': '#10b981',
            'failed': '#ef4444',
            'cancelled': '#6b7280',
            'processing': '#f59e0b',
            'error': '#ef4444'
        };

        // ─── Resolve actual processing status ──────────────────────────────
        let displayStatus = status;
        let displayProgress = progress;
        
        if (status === 'completed' && upload.responseData?.isProcessing) {
            displayStatus = 'processing';
            displayProgress = 100;
        }

        const statusColor = statusColors[displayStatus] || '#94a3b8';

        // Check if we need to attach SSE for chunked uploads
        if (status === 'completed' && upload.responseData?.isProcessing && upload.responseData?.fileId) {
            attachSSE(upload.responseData.fileId, isVideo ? 'video' : isAudio ? 'audio' : 'image', name);
        }

        // ─── Build HTML with controls ──────────────────────────────
        let controlsHTML = '';

        if (displayStatus === 'uploading' || displayStatus === 'initializing') {
            controlsHTML = `
                <button class="btn-pause" data-uploadid="${upload.uploadId}" style="background: #f59e0b; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 0.8rem;">
                    ⏸️ Pause
                </button>
            `;
        } else if (status === 'paused') {
            controlsHTML = `
                <button class="btn-resume" data-uploadid="${upload.uploadId}" style="background: #3b82f6; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 0.8rem;">
                    ▶️ Resume
                </button>
                <button class="btn-cancel" data-uploadid="${upload.uploadId}" style="background: #ef4444; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 0.8rem; margin-left: 6px;">
                    ✖️ Cancel
                </button>
            `;
        } else if (status === 'failed') {
            controlsHTML = `
                <button class="btn-retry" data-uploadid="${upload.uploadId}" style="background: #10b981; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 0.8rem;">
                    🔄 Retry
                </button>
                <button class="btn-remove" data-uploadid="${upload.uploadId}" style="background: #6b7280; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 0.8rem; margin-left: 6px;">
                    🗑️ Remove
                </button>
            `;
        } else if (status === 'completed') {
            controlsHTML = `
                <button class="btn-remove" data-uploadid="${upload.uploadId}" style="background: #6b7280; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 0.8rem;">
                    🗑️ Remove
                </button>
            `;
        } else if (status === 'cancelled') {
            controlsHTML = `
                <button class="btn-remove" data-uploadid="${upload.uploadId}" style="background: #6b7280; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 0.8rem;">
                    🗑️ Remove
                </button>
            `;
        }

        item.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; flex-wrap: wrap; gap: 8px;">
                <div style="flex: 1; min-width: 150px;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-weight: 600; font-size: 0.95rem;">${typeIcon} ${name}</span>
                        <span style="font-size: 0.7rem; background: #e2e8f0; padding: 2px 8px; border-radius: 12px; color: #475569;">${modeLabel}</span>
                    </div>
                    <div style="font-size: 0.75rem; color: #94a3b8; margin-top: 2px;">
                        ${isVideo ? '🎬 Video' : isAudio ? '🎵 Audio' : '🖼️ Image'} • ${(upload.fileSize || 0) > 0 ? (upload.fileSize / 1024 / 1024).toFixed(2) : '—'} MB
                        ${upload.retryCount > 0 ? `• 🔄 Retry ${upload.retryCount}` : ''}
                    </div>
                </div>
                <div style="text-align: right; min-width: 100px;">
                    <span style="font-size: 1.2rem; font-weight: 700; color: ${statusColor};">${progress}%</span>
                    <div style="font-size: 0.7rem; color: #94a3b8;">
                        ⚡ ${speed} • ⏱️ ${timeRemaining}
                    </div>
                </div>
            </div>

            <div style="position: relative; width: 100%; background: #e2e8f0; border-radius: 6px; height: 8px; overflow: hidden; margin: 8px 0;">
                <div style="width: ${progress}%; background: ${status === 'completed' ? '#10b981' : status === 'failed' ? '#ef4444' : status === 'paused' ? '#8b5cf6' : '#3b82f6'}; height: 100%; transition: width 0.3s ease; border-radius: 6px;"></div>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 8px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 0.75rem; color: ${statusColor}; font-weight: 500;">
                        ${status.toUpperCase()}
                    </span>
                    ${upload.error ? `<span style="font-size: 0.7rem; color: #ef4444;">⚠️ ${upload.error}</span>` : ''}
                </div>
                <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                    ${controlsHTML}
                </div>
            </div>

            ${upload.files && upload.files.length > 1 ? `
                <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #e2e8f0; font-size: 0.7rem; color: #94a3b8;">
                    📎 ${upload.files.length} files
                    ${upload.files.map((f, i) => `<span key="${i}">${f.fileName} (${Math.round(f.progress || 0)}%)</span>`).join(' • ')}
                </div>
            ` : ''}
        `;

        uploadList.appendChild(item);

        // ─── Attach event listeners ────────────────────────────────
        const pauseBtn = item.querySelector('.btn-pause');
        const resumeBtn = item.querySelector('.btn-resume');
        const cancelBtn = item.querySelector('.btn-cancel');
        const retryBtn = item.querySelector('.btn-retry');
        const removeBtn = item.querySelector('.btn-remove');

        if (pauseBtn) {
            pauseBtn.addEventListener('click', () => {
                const id = pauseBtn.dataset.uploadid;
                console.log(`⏸️ Pausing upload: ${id}`);
                pauseUpload(id);
            });
        }

        if (resumeBtn) {
            resumeBtn.addEventListener('click', () => {
                const id = resumeBtn.dataset.uploadid;
                console.log(`▶️ Resuming upload: ${id}`);
                resumeUpload(id);
            });
        }

        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                const id = cancelBtn.dataset.uploadid;
                console.log(`✖️ Cancelling upload: ${id}`);
                cancelUpload(id);
            });
        }

        if (retryBtn) {
            retryBtn.addEventListener('click', () => {
                const id = retryBtn.dataset.uploadid;
                console.log(`🔄 Retrying upload: ${id}`);
                retryUpload(id);
            });
        }

        if (removeBtn) {
            removeBtn.addEventListener('click', () => {
                const id = removeBtn.dataset.uploadid;
                console.log(`🗑️ Removing upload: ${id}`);
                removeUpload(id);
            });
        }

        // ─── If completed, add to gallery ──────────────────────────
        if (status === 'completed' && upload.fileId) {
            const baseUrl = `http://localhost:3000/${upload.uploadType || 'avatar'}`;
            const url = upload.url || `${baseUrl}/${upload.fileId}?token=secret-token-123`;

            if (fileType.startsWith('image/')) {
                addToGallery(name, url, 'image');
            } else if (fileType.startsWith('video/')) {
                addToGallery(name, url, 'video');
            } else if (fileType.startsWith('audio/')) {
                addToGallery(name, url, 'audio');
            }
        }
    });
});

// ─── 10. BULK ACTIONS ──────────────────────────────────────────────────

// Add bulk action buttons to the UI
const bulkActions = document.createElement('div');
bulkActions.style.cssText = 'display: flex; gap: 10px; margin-top: 20px; flex-wrap: wrap;';
bulkActions.innerHTML = `
    <button id="clearCompletedBtn" class="btn secondary" style="background: #10b981;">✅ Clear Completed</button>
    <button id="clearFailedBtn" class="btn secondary" style="background: #ef4444;">❌ Clear Failed</button>
    <button id="clearAllBtn" class="btn secondary" style="background: #6b7280;">🗑️ Clear All</button>
    <button id="checkResumeBtn" class="btn secondary" style="background: #8b5cf6;">🔄 Check Resumable</button>
`;

// Insert after upload list
if (uploadList) {
    uploadList.parentNode.insertBefore(bulkActions, uploadList.nextSibling);
}

document.getElementById('clearCompletedBtn')?.addEventListener('click', () => {
    console.log('🧹 Clearing completed uploads...');
    clearCompleted();
});

document.getElementById('clearFailedBtn')?.addEventListener('click', () => {
    console.log('🧹 Clearing failed uploads...');
    clearFailed();
});

document.getElementById('clearAllBtn')?.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear ALL uploads?')) {
        console.log('🧹 Clearing ALL uploads...');
        clearAll();
    }
});

document.getElementById('checkResumeBtn')?.addEventListener('click', () => {
    console.log('🔄 Checking for resumable uploads...');
    checkForResumableUploads();
});

// ─── 11. KEYBOARD SHORTCUTS ───────────────────────────────────────────

document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+C = Clear completed
    if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        document.getElementById('clearCompletedBtn')?.click();
    }
    // Ctrl+Shift+F = Clear failed
    if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        document.getElementById('clearFailedBtn')?.click();
    }
    // Ctrl+Shift+A = Clear all
    if (e.ctrlKey && e.shiftKey && e.key === 'A') {
        document.getElementById('clearAllBtn')?.click();
    }
    // Ctrl+Shift+R = Check resumable
    if (e.ctrlKey && e.shiftKey && e.key === 'R') {
        document.getElementById('checkResumeBtn')?.click();
    }
});

// ─── 12. INITIALIZATION ─────────────────────────────────────────────────

console.log('📹 Video Upload System Ready!');
console.log('🖼️ Image Gallery: Supported');
console.log('🎬 Video Gallery: Supported');
console.log('📦 Chunked Uploads: Supported');
console.log('🔄 Video Transformation: Supported');
console.log('📊 Multi-Quality Videos: Supported');
console.log('⏸️ Pause/Resume/Cancel: Supported');
console.log('🔄 Retry: Supported');
console.log('🧹 Clear Actions: Supported');
console.log('⌨️ Keyboard Shortcuts: Ctrl+Shift+C/F/A/R');

// Check for resumable uploads on load
checkForResumableUploads().catch(console.error);