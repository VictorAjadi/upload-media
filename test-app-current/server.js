const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const {
  UploadEngine,
  createExpressAdapter,
  createExpressFileServingMiddleware,
  DatabaseStorageAdapter,
  MongooseRepository
} = require('@upload-media/server');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const app = express();
const port = 3000;

// 1. CRITICAL: Add Security Headers required for WebAssembly/FFmpeg
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

// Setup EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve your public assets
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mjs') || filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
  }
}));

// Serve node_modules assets to the browser safely
app.use('/node_modules', express.static(path.join(__dirname, 'node_modules'), {
  dotfiles: 'allow',
  fallthrough: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
  }
}));

// ============================================
// STEP 1: Connect to MongoDB
// ============================================
mongoose.connect('mongodb://localhost:27017/upload_media_test', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// ============================================
// STEP 2: Initialize MongooseRepository
// ============================================
const database = new MongooseRepository({
  mongooseConnection: mongoose.connection,
  // Optional: Add hooks for custom behavior
  // hooks: {
  //   beforeCreateFile: async (file, ctx) => {
  //     console.log('📝 Creating file:', file.originalName);
  //     return file;
  //   },
  //   afterCreateFile: async (file, ctx) => {
  //     console.log('✅ File created:', file.id);
  //     return file;
  //   }
  // }
});

// ============================================
// STEP 3: Multi-Route File Serving with Strict Buckets & Auth
// ============================================
app.use('/avatar', createExpressFileServingMiddleware({
  database,
  strictBucketAccess: true,
  cacheMaxAge: '7d'
}));

app.use('/video', createExpressFileServingMiddleware({
  database,
  strictBucketAccess: true,
  cacheMaxAge: '7d',
  onBeforeServe: async (fileId, req) => {
    // Custom auth logic for videos!
    const token = req.headers.authorization || req.query.token;
    if (token !== 'secret-token-123' && token !== 'Bearer secret-token-123') {
      throw new Error('Unauthorized Access to premium videos');
    }
  }
}));

app.use('/audio', createExpressFileServingMiddleware({
  database,
  strictBucketAccess: true,
  cacheMaxAge: '7d'
}));

// ============================================
// STEP X: Server Sent Events (SSE) Setup
// ============================================
const sseClients = new Map(); // Map<fileId, res>

app.get('/api/events/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  
  sseClients.set(fileId, res);
  // Send initial ping
  res.write(`event: connected\ndata: ${JSON.stringify({ message: "SSE linked" })}\n\n`);

  req.on('close', () => { sseClients.delete(fileId); });
});

function emitEvent(fileId, eventType, data) {
  const client = sseClients.get(fileId);
  if (client) {
    client.write(`event: ${eventType}\n`);
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

// ============================================
// STEP 4: Configure Upload Engine with DatabaseStorageAdapter
// ============================================
const engine = new UploadEngine({
  database: database,
  mediaProcessor: {
    ffmpegPath: ffmpegPath,
    tempDir: './temp-uploads',
    
    // 'balanced' — good quality + reasonable speed (default)
    // 'speed'    — fastest possible encode, slightly lower quality
    // 'quality'  — best quality, slowest encode
    speedProfile: 'balanced',
    
    // Set timeoutMs: 0 for infinite processing times on long workflows (prevents 1800s aborts)
    timeoutMs: 0,
    
    // maxConcurrency caps how many upload sessions can process simultaneously.
    // Each session can spawn multiple parallel variant encodes on its own.
    // Rule of thumb: set to number of CPU cores / 2 for mixed-workload servers,
    // or leave unset to let the library auto-detect (min(4, cpuCount)).
    // maxConcurrency: 4,
  },
  storages: {
    database: new DatabaseStorageAdapter({
      database: database,
      prefetchCount: 3 // Number of chunks to prefetch (default: 2)
    })
  },
  defaultStorage: 'database', // Use database storage as default
  defaultUploadType: 'avatar',
  autoRespond: false,
  uploadTypes: {
    avatar: {
      name: 'avatar',
      allowedKinds: ['image'],
      limits: { image: 5 * 1024 * 1024 }
    },
    video: {
      name: 'video',
      allowedKinds: ['video'],
      limits: { video: 100 * 1024 * 1024 },
      thumbnails: true
    },
    audio: {
      name: 'audio',
      allowedKinds: ['audio'],
      limits: { audio: 50 * 1024 * 1024 }
    }
  },
  onProcessingStart: (fileId, sessionId, context) => {
    console.log(`🚀 [Hooks] Background media processing started for file: ${context?.filename} (Session: ${sessionId})`);
    emitEvent(fileId, 'media_processing_started', { fileId, message: 'Processing started...' });
  },
  onVariantComplete: (variantRecord, parentFileId) => {
    console.log(`🔄 [Hooks] Variant completed: ${variantRecord.metadata?.quality || variantRecord.originalName} for parent ID: ${parentFileId}`);
    emitEvent(parentFileId, 'media_variant_ready', { 
        quality: variantRecord.metadata?.quality, 
        url: variantRecord.url 
    });
  },
  onUploadComplete: (file) => {
    if (file.metadata?.isVariant) return; // Skip logging variants here since onVariantComplete handles them
    console.log('🎉 [Hooks] Upload/Processing totally complete for file:', file.originalName);
    console.log('📊 File ID:', file.id);
    console.log('💾 Storage ref:', file.storageRef);
    console.log('📦 Chunks:', file.chunkCount);
    emitEvent(file.id, 'media_processing_finished', file);
    
    // Close the SSE stream when finished
    const client = sseClients.get(file.id);
    if(client) {
        client.write(`event: close\ndata: {}\n\n`);
        client.end();
        sseClients.delete(file.id);
    }
  }
});

const expressAdapter = createExpressAdapter();

// Routes
app.get('/', (req, res) => {
  res.render('index');
});

// ============================================
// STEP 5: Upload endpoint
// ============================================
app.post('/api/upload', expressAdapter.wrap(async (req, res) => {
  console.log('--- Incoming Upload Request ---');
  const result = await engine.handle(req, res);
  //sconsole.log(result)
  // If the upload is complete, we have access to fields and named files
  if (result.status === 'success' && (result.progress === 100 || !result.chunkIndex)) {
    console.log('✅ Upload Finalized!');
    //console.log('Fields:', req.fields); // Access form fields
    //console.log('File Mapping:', Object.keys(req.fileFields || {})); // Access named fields

    // Demonstrate access to a specific named field if it exists
    if (req.fileFields && req.fileFields['postImage']) {
      //console.log('📸 Captured postImage:', req.fileFields['postImage'].originalName);
    }

    // You can access additional file info from the database
    if (result.file) {
      const fileRecord = await database.getFileById(result.file.id);
      // console.log('📁 File record from DB:', fileRecord);
    }

    return {
      ...result,
      message: 'Upload complete! Files stored in MongoDB via DatabaseStorageAdapter',
      onBackground: async () => {
        console.log('🕒 Starting background task for:', result.file?.id || 'multiple files');
        // Example: Process the uploaded file
        if (result.file) {
          // You can access chunks from the database here
          const chunks = await database.getChunk(result.file.id, 0);
          console.log('📦 Retrieved first chunk size:', chunks?.length || 0);
        }
        await new Promise(r => setTimeout(r, 2000)); // Simulate work
        console.log('✨ Background task finished!');
      }
    };
  }

  return result;
}));

// ============================================
// STEP 6: Clean up MongoDB connection on app shutdown
// ============================================
process.on('SIGINT', async () => {
  await mongoose.connection.close();
  console.log('MongoDB connection closed');
  process.exit(0);
});

app.listen(port, () => {
  console.log(`Test app listening at http://localhost:${port}`);
  console.log(`Uploads will be served from MongoDB via DatabaseStorageAdapter`);
  console.log('MongoDB connection: mongodb://localhost:27017/upload_media_test');
});

/* 
const express = require('express');
const path = require('path');
const {
  UploadEngine,
  InMemoryRepository,
  LocalDiskStorageAdapter,
  createExpressAdapter,
  createExpressFileServingMiddleware
} = require('@upload-media/server');

const app = express();
const port = 3000;

// 1. CRITICAL: Add Security Headers required for WebAssembly/FFmpeg
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

// Setup EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve your public assets
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mjs') || filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
  }
}));

// Serve node_modules assets to the browser safely
app.use('/node_modules', express.static(path.join(__dirname, 'node_modules'), {
  dotfiles: 'allow',
  fallthrough: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
  }
}));
let database = new InMemoryRepository();
// File serving middleware
app.use("/uploads", createExpressFileServingMiddleware(
  {
    rootDir: path.join(__dirname, 'uploads'),
  },
  { database, cacheMaxAge: '7d' }
));

// Configure Upload Media Engine
const engine = new UploadEngine({
  database: database,
  storages: {
    disk: new LocalDiskStorageAdapter({
      rootDir: path.join(__dirname, 'uploads'),
      publicBaseUrl: `http://localhost:${port}/uploads`
    })
  },
  defaultStorage: 'disk',
  defaultUploadType: 'avatar',
  uploadTypes: {
    avatar: {
      name: 'avatar',
      allowedKinds: ['image'],
      limits: { image: 5 * 1024 * 1024 }
    },
    video: {
      name: 'video',
      allowedKinds: ['video'],
      limits: { video: 100 * 1024 * 1024 },
      thumbnails: true
    }
  },
  onUploadComplete: (file) => {
  }
});

const expressAdapter = createExpressAdapter();

// Routes
app.get('/', (req, res) => {
  res.render('index');
});

// Single endpoint for all uploads
app.post('/api/upload', expressAdapter.wrap(async (req, res) => {
  console.log('--- Incoming Upload Request ---');
  const result = await engine.handle(req, res);

  // If the upload is complete, we have access to fields and named files
  if (result.status === 'success' && (result.progress === 100 || !result.chunkIndex)) {
    console.log('✅ Upload Finalized!');
    console.log('Fields:', req.fields); // Access form fields
    console.log('File Mapping:', Object.keys(req.fileFields || {})); // Access named fields

    // Demonstrate access to a specific named field if it exists
    if (req.fileFields['postImage']) {
      console.log('Captured postImage:', req.fileFields['postImage'].originalName);
    }

    return {
      ...result,
      message: 'Upload complete! Processing in background...',
      onBackground: async () => {
        console.log('🕒 Starting background task for:', result.file?.id || 'multiple files');
        await new Promise(r => setTimeout(r, 2000)); // Simulate work
        console.log('✨ Background task finished!');
      }
    };
  }

  return result;
}));

app.listen(port, () => {
  console.log(`Test app listening at http://localhost:${port}`);
  console.log(`Uploads will be served from: http://localhost:${port}/uploads`);
});
*/