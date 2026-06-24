import {
    useUploadActions,
    useUploadProgress,
    setUploadMediaConfig,
} from '@upload-media/client'

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
const videoGallery = document.getElementById('videoGallery');
const videoGalleryContent = document.getElementById('videoGalleryContent');

const { initializeUpload } = useUploadActions();

// Configure toast notifications
setUploadMediaConfig({
    showToast: {
        success: (msg) => console.log("✅ Success:", msg),
        error: (msg) => console.log("❌ Error:", msg),
        info: (msg) => console.log("ℹ️ Info:", msg),
        warning: (msg) => console.log("⚠️ Warning:", msg),
    }
});

// ============================================================
// 1. VIDEO UPLOAD (Chunked - Default)
// ============================================================
uploadBtn.addEventListener('click', () => {
    const files = Array.from(fileInput.files);
    if (files.length === 0) {
        alert('Please select files');
        return;
    }

    // Check if any video files are selected
    const hasVideo = files.some(f => f.type.startsWith('video/'));
    const uploadType = hasVideo ? 'video' : 'avatar';
    const uploadId = 'upload_' + uploadType + '_' + Date.now();

    console.log(`🚀 Starting ${uploadType.toUpperCase()} upload:`, uploadId);

    initializeUpload({
        uploadId,
        blobs: files,
        filenameArray: files.map(f => f.name),
        endpoint: `http://localhost:3000/api/upload?uploadType=${uploadType}`,
        method: 'POST',
        // Custom metadata
        metadata: {
            uploadType: uploadType,
            timestamp: new Date().toISOString()
        }
    });
});

// ============================================================
// 2. VIDEO UPLOAD WITH THUMBNAILS
// ============================================================
const uploadVideoThumbBtn = document.getElementById('uploadVideoThumbBtn');
if (uploadVideoThumbBtn) {
    uploadVideoThumbBtn.addEventListener('click', () => {
        const files = Array.from(fileInput.files);
        if (files.length === 0) {
            alert('Please select files');
            return;
        }

        const videoFiles = files.filter(f => f.type.startsWith('video/'));
        if (videoFiles.length === 0) {
            alert('Please select at least one video file');
            return;
        }

        const uploadId = 'upload_thumb_' + Date.now();
        console.log('🎬 Starting VIDEO UPLOAD with thumbnails:', uploadId);

        initializeUpload({
            uploadId,
            blobs: videoFiles,
            filenameArray: videoFiles.map(f => f.name),
            endpoint: 'http://localhost:3000/api/upload?uploadType=video&generateThumbnails=true',
            method: 'POST',
            metadata: {
                generateThumbnails: true,
                thumbnailCount: 3,
                thumbnailSize: '320x180'
            }
        });
    });
}

// ============================================================
// 3. NON-CHUNKED UPLOAD (Direct - for small files)
// ============================================================
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

            // Determine upload type based on file
            const uploadType = file.type.startsWith('video/') ? 'video' : 'avatar';
            formData.append('uploadType', uploadType);

            // Add custom metadata
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

            // Add to gallery based on file type
            if (result.file) {
                const fileData = result.file;
                const url = fileData.url || `http://localhost:3000/uploads/${uploadType}/${fileData.id}`;

                if (file.type.startsWith('image/')) {
                    addToGallery(file.name, url);
                } else if (file.type.startsWith('video/')) {
                    addToVideoGallery(file.name, url, fileData.thumbnailUrl);
                }
            }
        } catch (error) {
            console.error(`❌ Direct upload failed for ${file.name}:`, error);
        }
    }
});

// ============================================================
// 4. MULTI-FIELD UPLOAD (Post with Image + Video)
// ============================================================
uploadFieldsBtn.addEventListener('click', () => {
    const files = Array.from(fileInput.files);
    if (files.length < 2) {
        alert('Please select at least 2 files (e.g. an image and a video)');
        return;
    }

    const uploadId = 'upload_fields_' + Date.now();
    console.log('🚀 Starting MULTI-FIELD upload:', uploadId);

    // Map files to fieldnames based on their type
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
        postData: {
            caption: 'This is a test post with image and video',
            tags: ['test', 'upload', 'premium', 'multi-field']
        },
        metadata: fieldnames.map(name => ({ fieldname: name }))
    });
});

// ============================================================
// 5. TRANSFORMED VIDEO UPLOAD (Quality/Format conversion)
// ============================================================
uploadTransBtn.addEventListener('click', () => {
    const files = Array.from(fileInput.files);
    if (files.length === 0) {
        alert('Please select files');
        return;
    }

    const videoFiles = files.filter(f => f.type.startsWith('video/'));
    if (videoFiles.length === 0) {
        alert('Please select at least one video file');
        return;
    }

    const uploadId = 'upload_trans_' + Date.now();
    console.log('🔄 Starting TRANSFORMED video upload:', uploadId);

    initializeUpload({
        uploadId,
        blobs: videoFiles,
        filenameArray: videoFiles.map(f => f.name),
        endpoint: 'http://localhost:3000/api/upload?uploadType=video',
        method: 'POST',
        transformer: {
            // Video transformation options
            video: {
                codec: 'h264',
                bitrate: '2M',
                fps: 30,
                resolution: '1280x720'
            },
            format: 'video/mp4',
            quality: 'high'
        },
        metadata: {
            transformed: true,
            originalFormat: videoFiles[0]?.type || 'unknown'
        }
    });
});

// ============================================================
// 6. MULTI-QUALITY VIDEO UPLOAD (Multiple quality levels)
// ============================================================
uploadMultiBtn.addEventListener('click', () => {
    const files = Array.from(fileInput.files);
    if (files.length === 0) {
        alert('Please select files');
        return;
    }

    const videoFiles = files.filter(f => f.type.startsWith('video/'));
    if (videoFiles.length === 0) {
        alert('Please select at least one video file');
        return;
    }

    const uploadId = 'upload_multi_' + Date.now();
    console.log('📊 Starting MULTI-QUALITY video upload:', uploadId);

    initializeUpload({
        uploadId,
        blobs: videoFiles,
        filenameArray: videoFiles.map(f => f.name),
        endpoint: 'http://localhost:3000/api/upload?uploadType=video',
        method: 'POST',
        transformer: {
            qualities: ['1080p', '720p', '480p', '360p'],
            format: 'video/mp4',
            video: {
                codec: 'h264',
                adaptiveBitrate: true
            }
        },
        metadata: {
            multiQuality: true,
            qualities: ['1080p', '720p', '480p', '360p']
        }
    });
});

// ============================================================
// 7. DRAG & DROP
// ============================================================
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

// ============================================================
// 8. FILE INPUT CHANGE HANDLER
// ============================================================
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

// ============================================================
// 9. REAL-TIME PROGRESS SUBSCRIPTION
// ============================================================
useUploadProgress.subscribe((state) => {
    uploadList.innerHTML = '';

    if (!state.uploads || !Array.isArray(state.uploads)) return;

    state.uploads.forEach(upload => {
        const item = document.createElement('div');
        item.className = 'upload-item';

        const progress = Math.round(upload.overallProgress || 0);
        const status = upload.status || 'pending';
        const name = upload.fileName || 'Unknown File';
        const fileType = upload.fileType || '';

        // Determine upload mode and type
        const isChunked = upload.uploadId?.includes('chunked') || upload.chunkCount > 1;
        const isVideo = fileType.startsWith('video/');
        const modeLabel = isChunked ? '📦 Chunked' : '📄 Direct';
        const typeIcon = isVideo ? '🎬' : '🖼️';

        item.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                <span><strong>${typeIcon} ${name}</strong></span>
                <span>${progress}%</span>
            </div>
            <div class="progress-container" style="background: #e2e8f0; border-radius: 4px; overflow: hidden; height: 8px; width: 100%;">
                <div class="progress-bar" style="width: ${progress}%; background: ${isVideo ? '#8b5cf6' : '#3b82f6'}; height: 100%; transition: width 0.2s ease;"></div>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 0.8rem; margin-top: 0.5rem; color: #94a3b8">
                <span>${modeLabel}</span>
                <span>Status: <strong style="color: ${status === 'completed' ? '#10b981' : status === 'error' ? '#ef4444' : '#6b7280'}">${status}</strong></span>
                <span>${isVideo ? '🎬 Video' : '🖼️ Image'}</span>
            </div>
        `;
        uploadList.appendChild(item);

        // ✅ If completed, add to appropriate gallery
        if (status === 'completed' && upload.fileId) {
            const baseUrl = `http://localhost:3000/uploads/${upload.uploadType || 'avatar'}`;
            const url = upload.url || `${baseUrl}/${upload.fileId}`;

            if (fileType.startsWith('image/')) {
                addToGallery(name, url);
            } else if (fileType.startsWith('video/')) {
                const thumbnailUrl = upload.thumbnailUrl || `${baseUrl}/thumbnails/${upload.fileId}`;
                addToVideoGallery(name, url, thumbnailUrl);
            }
        }
    });
});

// ============================================================
// 10. IMAGE GALLERY HELPER
// ============================================================
function addToGallery(filename, url) {
    if (!galleryContent) return;

    // Check if already in gallery
    if (galleryContent.querySelector(`[data-url="${url}"]`)) {
        return;
    }

    if (gallery) gallery.style.display = 'block';

    const item = document.createElement('div');
    item.setAttribute('data-url', url);
    item.style.cssText = 'margin: 10px; text-align: center; display: inline-block;';

    item.innerHTML = `
        <img src="${url}" 
             alt="${filename}" 
             style="max-width: 200px; max-height: 200px; border-radius: 8px; object-fit: cover; border: 2px solid #e2e8f0;"
             onerror="this.style.display='none'; this.nextElementSibling.textContent='Failed to load'"
        >
        <p style="font-size: 0.8rem; margin-top: 4px; color: #6b7280; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${filename}</p>
    `;

    galleryContent.appendChild(item);
}

// ============================================================
// 11. VIDEO GALLERY HELPER
// ============================================================
function addToVideoGallery(filename, url, thumbnailUrl) {
    if (!videoGalleryContent) return;

    // Check if already in gallery
    if (videoGalleryContent.querySelector(`[data-url="${url}"]`)) {
        return;
    }

    if (videoGallery) videoGallery.style.display = 'block';

    const item = document.createElement('div');
    item.setAttribute('data-url', url);
    item.style.cssText = 'margin: 10px; text-align: center; display: inline-block;';

    const thumbnail = thumbnailUrl || url;

    item.innerHTML = `
        <div style="position: relative; cursor: pointer;" onclick="this.querySelector('video').play();">
            <video 
                src="${url}" 
                poster="${thumbnail}"
                style="max-width: 200px; max-height: 200px; border-radius: 8px; object-fit: cover; border: 2px solid #e2e8f0; background: #000;"
                controls
                preload="metadata"
            ></video>
            <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 48px; color: white; text-shadow: 0 0 10px rgba(0,0,0,0.5); pointer-events: none;">▶</div>
        </div>
        <p style="font-size: 0.8rem; margin-top: 4px; color: #6b7280; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${filename}</p>
    `;

    videoGalleryContent.appendChild(item);
}

console.log('📹 Video Upload System Ready!');
console.log('🖼️ Image Gallery: Supported');
console.log('🎬 Video Gallery: Supported');
console.log('📦 Chunked Uploads: Supported');
console.log('🔄 Video Transformation: Supported');
console.log('📊 Multi-Quality Videos: Supported');