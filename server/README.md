# upload-media-server

🛸 **The Ultimate, Enterprise-Grade Media Upload & Processing Engine**

`upload-media-server` is the definitive backend library for building high-performance file ingestion pipelines. Whether you're building the next YouTube, an Instagram clone, or a secure document portal, this library provides the foundation for reliable, resumable, and highly processed uploads across any Node.js framework.

---

## 📋 Table of Contents

- [Core Architecture & Philosophy](#-core-architecture--philosophy)
- [Quick Start (Express)](#-quick-start-express)
- [Core Methods & Utilities](#-core-methods--utilities)
- [Configuration Reference](#-configuration-reference)
  - [UploadEngineConfig](#uploadengineconfig)
  - [Real-Time UIs & Background Processing (SSE)](#-real-time-uis--background-processing-sse)
  - [UploadTypeConfig](#uploadtypeconfig)
  - [FrontendTransformerConfig](#frontendtransformerconfig)
- [Framework Adapters](#-framework-adapters)
- [Storage Providers](#-storage-providers)
  - [S3StorageAdapter (AWS S3 & Compatible)](#s3storageadapter-aws-s3--compatible)
  - [CloudinaryStorageAdapter](#cloudinarystorageadapter)
  - [Complete Storage Adapter Comparison](#-complete-storage-adapter-comparison)
  - [LocalDiskStorageAdapter](#localdiskstorageadapter)
  - [DatabaseStorageAdapter](#databasestorageadapter)
- [Database Repositories](#-database-repositories)
- [Performance & Caching](#-performance--caching)
- [Media Serving](#-media-serving)
- [Hooks System](#-hooks-system)
- [Error Handling & Rollback](#-error-handling--rollback)
- [Testing](#-testing)
- [Technical Specifications](#-technical-specifications)
- [Multi-Server Deployment](#-multi-server-deployment)
  - [Option A: DatabaseStorageAdapter (Fully Stateless)](#option-a-databasestorageadapter-fully-stateless)
  - [Option B: S3 & Cloudinary Adapters + Sticky Sessions](#option-b-s3--cloudinary-adapters--sticky-sessions)
  - [Option C: Shared Filesystem (EFS / NFS)](#option-c-shared-filesystem-efs--nfs)
  - [Scaling Checklist](#scaling-checklist)
  - [Multi-Server Orchestration: The Heartbeat Model](#-multi-server-orchestration-the-heartbeat-model)
- [Troubleshooting](#-troubleshooting)

---

## 🏗️ Core Architecture & Philosophy

The engine is built on a **Modular Kernel** architecture. This design separates the concerns of I/O, validation, and persistence, allowing for extreme flexibility in production environments.

### The Lifecycle of an Upload

1. **Ingress & Normalization**: The `FrameworkAdapter` intercepts the incoming request and normalizes properties across various frameworks (Express `req`, Hono `ctx`, Fastify `req`) into a unified `NormalizedRequest` interface.

2. **Streaming Multipart Parsing**: The engine uses a high-speed, non-blocking parser that streams incoming data and distinguishes between **Binary Chunks** (file data) and **Protocol Fields** (session IDs, chunk indexes, metadata).

3. **Strict Validation Protocol & OOM Protection**:
   - **MIME Sniffing**: Validates file content against declared MIME type, preventing malicious uploads.
   - **Resource Quotas**: Validates against `UploadTypeConfig` for total size, file count, and chunk boundaries.
   - **Zero-Copy Disk Streaming**: Automatically flags large monolithic non-chunked streams (>50MB) and natively pipes them directly to an OS scratch disk layer. Bypasses the V8 Heap memory buffer entirely, ensuring stability during enterprise use.
   - **Stream-Parser Promise Tracking**: Implements a strict `pendingPromises` tracker against the event loop to prevent premature chunk termination, guaranteeing reliable `multipart/form-data` parsing in distributed edge topologies.

4. **Multi-Stage Persistence**:
   - **Staging**: Intermediate chunks written to temporary or "hot" storage.
   - **Resolution**: When the "Last Chunk" signal is received, reconciliation ensures no chunks are missing.

5. **Media Finalization**: 
   - **Reassembly**: Fragments are piped through a high-performance reassembly stream to write the final media object.
   - **Transformation**: Directs the file through the backend-driven `MediaProcessor` (utilizing `fluent-ffmpeg` and `sharp`). Executes multi-resolution/bitrate transcoding, adaptive variant generation, automatic audio extraction, and frame-seeking thumbnail capture according to the request's `transformer` payload.

6. **Persistence Layer**: Final `FileRecord` (along with refs to generated variants/thumbnails) is committed to the `MetadataRepository`.

7. **Egress**: The framework adapter handles the final HTTP response JSON payload.

---

## 🚀 Quick Start (Express)

```typescript
import {
  UploadEngine,
  S3StorageAdapter,
  LocalDiskStorageAdapter,
  MongooseRepository,
  createExpressAdapter,
  createExpressFileServingMiddleware
} from 'upload-media-server';
import mongoose from 'mongoose';

// ── Storage ──────────────────────────────────────
const s3 = new S3StorageAdapter({
  bucket: 'prod-bucket',
  region: 'us-east-1'
});

const local = new LocalDiskStorageAdapter({
  rootDir: './uploads',
  publicBaseUrl: 'http://localhost:3000/static'
});

// ── Database ─────────────────────────────────────
const database = new MongooseRepository({
  mongooseConnection: mongoose.connection
});

// ── Engine ────────────────────────────────────────
const engine = new UploadEngine({
  // ── Core Persistence ──
  storages: { s3, local },
  defaultStorage: 's3',
  database,
  
  // ── Performance & Scaling ──
  cache: redisCacheAdapter,             // Optional: Key-value cache for DB lookups
  cacheTtlSeconds: 300,                 // TTL for cached records (default: 300)
  autoRespond: true,                    // Let adapter handle HTTP framework res (default: true)
  hmacSecret: process.env.UPLOAD_HMAC,  // Secret for HMAC-signing stateless chunk upload tokens
  
  // ── Quotas & Hard Limits ──
  maxTotalSize: 5 * 1024 * 1024 * 1024, // Universal 5GB cap for the entire multipart payload
  maxFiles: 10,                         // Prevent abuse via massive file batch queues
  maxFieldSize: 1024 * 1024,            // Ensure form string properties don't exceed 1MB
  staleUploadRetentionMs: 86400000,     // 24h cleanup cycle for abandoned chunk sessions
  globalLimits: { video: 5e9 },         // Fallback fallback bounds
  globalChunkLimits: { video: 50e6 },   // Set hard multipart chunk fragmentation boundaries
  
  // ── Enterprise Processing & OOM Protection ──
  // Note: MultipartParser natively protects against OOMs by automatically 
  // piping streams >50MB direct to OS temp disks (Zero-Copy Transfer).
  mediaProcessor: {
    tempDir: '/var/tmp/upload-media', // Custom OS swap space location
    maxConcurrency: 2, // Limit concurrent FFmpeg pipelines
    timeoutMs: 0,      // Disable limits to allow infinite transcode durations
  },

  // ── Event Hooks ──
  onProcessingStart: async (fileId, sessionId, ctx) => {
    console.log(`[Background] FFmpeg detached for ${fileId}`);
  },
  onVariantComplete: async (variantFile, parentFileId) => {
    console.log(`[Stream] Finished resolving variant: ${variantFile.url}`);
  },
  onUploadComplete: async (file) => {
    console.log(`[Ready] Upload pipeline completed for ${file.id}`);
  },
  onError: (error, context) => {
    console.error(`[Engine] Fatal processing error:`, error, context);
  },

  // ── Route & Variant Archetypes ──
  defaultUploadType: 'avatar',
  uploadTypes: {
    avatar: {
      allowedKinds: ['image'],
      limits: { image: 5 * 1024 * 1024 },
      storage: 'local',
      thumbnails: true
    },
    video: {
      allowedKinds: ['video'],
      limits: { video: 500 * 1024 * 1024 },
      thumbnails: true,
      quality: 'high'
    }
  }
});

// ── Route ─────────────────────────────────────────
const adapter = createExpressAdapter();

app.post('/api/upload', adapter.wrap(async (req, res) => {
  const result = await engine.handle(req, res);

  if (result.status === 'success') {
    return {
      ...result,
      onBackground: async () => {
        // Runs AFTER response sent
        await User.updateProfile(req.fields.userId, req.fileFields['avatar'].url);
      }
    };
  }
  return result;
}));

// ── File Serving ──────────────────────────────────
app.use('/stream', createExpressFileServingMiddleware('./uploads', {
  database,
  cacheMaxAge: '30d'
}));
```

---

## 🛠️ Core Methods & Utilities

### `UploadEngine` Instance

| Method | Parameters | Returns | Description |
| :--- | :--- | :--- | :--- |
| `handle(req, res)` | `NormalizedRequest`, `NormalizedResponse` | `Promise<UploadResult>` | Primary entry point for orchestrating the entire upload lifecycle. Handles parsing, validation, storage, and finalization. |
| `cleanup(files)` | `FileRecord \| FileRecord[]` | `Promise<void>` | Removes files and metadata (for error handling). Use in catch blocks to rollback failed uploads. |
| `deleteFiles(fileIds)` | `string[]` | `Promise<number>` | Bulk deletion by IDs. Returns count of deleted files. |
| `getUploadType(name)` | `name: string` | `UploadTypeConfig` | Retrieve specific upload context configuration. Useful for dynamic validation. |
| `getStorage(name?)` | `name?: string` | `StorageAdapter` | Get configured storage adapter instance. Returns default if no name provided. |

### Usage Examples

```typescript
// Handle an upload
const result = await engine.handle(req, res);

// Clean up on error
try {
  await processFile(result.file);
} catch (err) {
  await engine.cleanup(result.file);
  throw err;
}

// Bulk delete old files
const deleted = await engine.deleteFiles(['file-1', 'file-2']);

// Get upload type config
const avatarConfig = engine.getUploadType('avatar');

// Get storage adapter
const s3Adapter = engine.getStorage('s3');
const defaultStorage = engine.getStorage(); // Returns default
```

### `UploadResult` Interface

```typescript
interface UploadResult {
  status: 'success' | 'error';
  files?: FileRecord[];          // Uploaded files
  fileFields?: Record<string, FileRecord>; // Named file fields
  fields?: Record<string, any>;   // Form fields
  error?: string;                 // Error message
  onBackground?: () => Promise<void>; // Background task hook
}
```

---

## ⚙️ Configuration Reference

### `UploadEngineConfig`

| Property | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `storages` | `Record<string, StorageAdapter>` | Yes | - | Map of storage provider adapters. |
| `defaultStorage` | `string` | Yes | - | Key of the primary storage provider. |
| `defaultUploadType` | `string` | No | - | Default upload configuration type name. |
| `database` | `MetadataRepository` | Yes | - | Metadata and chunk persistence implementation. |
| `cache` | `CacheAdapter` | No | - | Optional custom or Redis-backed key-value cache layer. |
| `cacheTtlSeconds` | `number` | No | `300` | TTL in seconds for cached repository records. |
| `uploadTypes` | `Record<string, UploadTypeConfig>` | Yes | - | Scenario configuration maps (limits, storage target, processing settings). |
| `globalLimits` | `SizeLimitMap` | No | - | Fallback maximum size limits by media kind. |
| `globalChunkLimits` | `SizeLimitMap` | No | - | Fallback maximum chunk size bounds by media kind. |
| `autoRespond` | `boolean` | No | `true` | When true context adapters reply directly to requests. |
| `maxFieldSize` | `number` | No | `1,048,576` (1MB) | Permissible size threshold for non-file form properties. |
| `maxFiles` | `number` | No | `10` | Concurrency limit on files uploaded in a batch. |
| `maxTotalSize` | `number` | No | - | Maximum cumulative size of all files in an upload request. |
| `staleUploadRetentionMs`| `number` | No | `86,400,000` (24h) | Cumulative TTL duration before partial chunk data is deleted. |
| `mediaProcessor` | `MediaProcessorOptions` | No | - | Options for parallel and customized FFmpeg/Sharp media processing. |
| `onProcessingStart` | `(fileId: string, sessionId: string, context: any) => void \| Promise<void>` | No | - | Fired dynamically exactly when a heavy background task (like FFmpeg) is detached into the background loops. |
| `onVariantComplete` | `(variantRecord: FileRecord, parentFileId: string) => void \| Promise<void>` | No | - | Real-time hook emitting sub-renders (e.g. 720p, 1080p, thumbnails) right as they finish, before full file completion. |
| `onUploadComplete` | `(file: FileRecord) => void \| Promise<void>` | No | - | Callback triggered immediately after complete finalization. |
| `onError` | `(err: Error, context: { uploadType?: string, sessionId?: string }) => void` | No | - | Centralized exception monitoring callback handler. |

---

### 🟢 Real-Time UIs & Background Processing (SSE)

When processing time-intensive assets like multi-quality videos, you can use `@upload-media`'s event hooks alongside Server-Sent Events (SSE) or WebSockets to instantly drop the frontend UI into a responsive asynchronous tracking interface while rendering completes in the background.

```typescript
const sseClients = new Map(); // Memory map tying File IDs to open HTTP Streams

// 1. Establish an SSE endpoint on your framework
app.get('/api/events/:fileId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  
  sseClients.set(req.params.fileId, res);
});

// 2. Configure the Engine to stream FFmpeg hook events to the UI
const engine = new UploadEngine({
  database, storages, defaultStorage: 's3',
  
  onProcessingStart: (fileId, sessionId, context) => {
    // Alert the client immediately that massive transcoding has natively detached
    const client = sseClients.get(fileId);
    if (client) {
      client.write(`event: media_processing_started\n`);
      client.write(`data: {"message": "FFmpeg transcoding Initialized"}\n\n`);
    }
  },
  
  onVariantComplete: (variantRecord, parentFileId) => {
    // Stream live sub-variant URLs (e.g. 1080p, 480p, thumbnails) as they individually complete
    const client = sseClients.get(parentFileId);
    if (client) {
      client.write(`event: media_variant_ready\n`);
      client.write(`data: {"quality":"${variantRecord.metadata?.quality}", "url":"${variantRecord.url}"}\n\n`);
    }
  },
  
  onUploadComplete: (file) => {
    if (file.metadata?.isVariant) return; // Prevent closing the socket on sub-variant ticks
    const client = sseClients.get(file.id);
    if(client) {
        client.write(`event: media_processing_finished\n`);
        client.write(`data: ${JSON.stringify({ final: file.url })}\n\n`);
        
        client.write(`event: close\ndata: {}\n\n`); // Clean up frontend DOM Listeners
        client.end();
        sseClients.delete(file.id); // Flush reference memory
    }
  }
});
```

---

### 💓 Enterprise Architecture: The Heartbeat Model

When processing large media files in enterprise environments, relying on a basic "I'm alive" process ping is insufficient. `@upload-media` enables **true liveness detection** by emitting deep telemetry (frames and bytes processed) through the `onProgress` and `onVariantComplete` hooks. 

This model allows you to outsource process orchestration and liveness monitoring to infrastructure like Kubernetes, keeping your Node.js application state clean. However, a production-grade heartbeat implementation requires handling several architectural edge cases:

#### 1. Decoupled Queues and Idempotency
If a container orchestrator (like Kubernetes) rotates a pod due to a perceived freeze, the pod will terminate ungracefully. 
* **Requirement:** State must be managed by an external message broker (e.g., BullMQ, RabbitMQ). When a pod is rotated, the broker should detect the disconnected consumer and re-queue the task idempotently to another worker node, freely overwriting partial state.

#### 2. False Positives & Orchestrator Timeouts
* **Requirement:** FFmpeg can temporarily hang during single-threaded operations (like parsing massive `moov` atoms or two-pass encoding sweeps). Your orchestrator's liveness probe timeout (e.g., 5 minutes) must be load-tested and dynamically configured based on expected payload sizes, preventing false-positive pod terminations.

#### 3. Telemetry Throttling
* **Requirement:** Processing hundreds of frames per second on small files can overwhelm telemetry platforms (e.g., Datadog, Prometheus). Ensure your `onProgress` hook is debounced or batched, emitting heartbeat metrics to the orchestrator layer (like Redis) no more than once every 3-5 seconds.

#### 4. Zombie Process Mitigation (PID 1)
* **Requirement:** Terminating a Node application will not universally kill detached or spawned FFmpeg processes. Ensure you trap `SIGTERM` signals in your application to aggressively terminate running `spawn()` jobs, and utilize an init system like `dumb-init` or `tini` as your Docker entrypoint to reap orphaned child processes.

---

### `MediaProcessorOptions`

Allows standard control over concurrent jobs running `fluent-ffmpeg` and `sharp` on the server host.

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `tempDir` | `string` | `os.tmpdir()` | Directory route used when generating temporary file variants. |
| `ffmpegPath` | `string` | `(auto)` | Specific location path config to FFmpeg binary executor. |
| `ffprobePath` | `string` | `(auto)` | Specific location path config to FFprobe binary executor. |
| `maxConcurrency` | `number` | `2` | Semaphore concurrent task processing limit for FFmpeg pipelines. |
| `timeoutMs` | `number` | `600,000` (10m) | Absolute timeout limit per media variant generation action. Provide `0` to disable timeouts entirely for massive uninterrupted workflows. |

---

### `UploadTypeConfig`

Scenario options specified under key categories matching `uploadType` fields.

| Property | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `name` | `string` | Yes | Identifier name mapping for the type layout. |
| `allowedKinds` | `MediaKind[]` | Yes | List of allowed mimetypes: `'image'`, `'video'`, `'audio'`, `'document'`. |
| `limits` | `SizeLimitMap` | Yes | Allowed total size threshold per file kind in bytes. |
| `chunkLimits` | `SizeLimitMap` | No | Bound constraints threshold per uploaded chunk. |
| `storage` | `string` | No | Override key for target storage provider. |
| `thumbnails` | `boolean` | No | Triggers passive post-finalization thumbnail outputs. |
| `quality` | `'high' \| 'medium' \| 'low' \| number` | No | Processing quality default setting rules. |
| `defaultMetadata` | `Record<string, any>`| No | Default key-values to inject into the database file records. |

---

### `FrontendTransformerConfig`

Transformation configurations requested inside client request parameters.

```typescript
interface FrontendTransformerConfig {
  type?: 'image' | 'video' | 'audio';
  
  // -- Quality Variant Options --
  quality?: 'high' | 'medium' | 'low' | number | string;
  qualities?: ResolutionLabel[]; // Generate multiple resolution-variants e.g. ['1080p', '720p']
  qualityConfigs?: QualityConfig[] | Record<string, QualityConfig>; // Explicit customized variant settings
  
  format?: string; // Container format override (e.g. 'video/mp4', 'mp3', 'webp')
  
  // -- Trimming and Modifications --
  startTime?: number; // Seek trimming offset start point in seconds
  endTime?: number;   // Seek trimming offset end point in seconds
  mute?: boolean;     // Disable audio tracks inside the variant.
  
  // -- Custom Video Specific overrides --
  videoBitrate?: string; // Overrides bitrates calculated from the resolution encoding ladder (e.g. '2500k')
  audioBitrate?: string; // Overrides default audio track encoding bitrate (e.g. '128k')
  resolution?: string;   // Resolution override
  codec?: string;        // Target encoder codec name (defaults to 'libx264')
  generateThumbnail?: boolean; // Poster frame extraction selector (default: true)
  thumbnailTimeSeconds?: number; // Target frame extraction time point offset
  
  // -- Image specific overrides --
  width?: number; // Width scale constraint
  height?: number; // Height scale constraint
}
```

---

## 🔌 Framework Adapters

### All 8 Adapters

The library provides framework-specific adapters that normalize incoming requests and outgoing responses while preserving the native API of each framework.

| Adapter | Factory | Best For |
| :--- | :--- | :--- |
| **Express** | `createExpressAdapter()` | Traditional Node.js servers. |
| **Hono** | `createHonoAdapter()` | Edge workers (Cloudflare, Deno). |
| **Fastify** | `createFastifyAdapter()` | High-performance REST APIs. |
| **Koa** | `createKoaAdapter()` | Modern async/await middleware. |
| **Next.js** | `createNextjsAdapter()` | App Router & Pages Router support. |
| **Elysia** | `createElysiaAdapter()` | Bun runtime optimization. |
| **Nuxt/H3** | `createH3Adapter()` | Nuxt 3 / Nitro integration. |
| **Raw Node** | `createRawNodeAdapter()` | HTTP IncomingMessage. |

### Usage Pattern (All Adapters)

The adapter pattern is consistent across all frameworks:

```typescript
// 1. Create the adapter for your framework
const adapter = createExpressAdapter(); // or createHonoAdapter(), etc.

// 2. Wrap your route handler
app.post('/upload', adapter.wrap(async (req, res) => {
  // 3. Call engine.handle() with the normalized request/response
  const result = await engine.handle(req, res);
  
  // 4. Return result (auto-serialized to JSON)
  return result;
}));
```

### Framework-Specific Examples

#### Express

```typescript
import { createExpressAdapter } from 'upload-media-server';

const adapter = createExpressAdapter();

app.post('/api/upload', adapter.wrap(async (req, res) => {
  const result = await engine.handle(req, res);
  return result;
}));
```

#### Hono

```typescript
import { Hono } from 'hono';
import { createHonoAdapter } from 'upload-media-server';

const app = new Hono();
const adapter = createHonoAdapter();

app.post('/api/upload', adapter.wrap(async (c) => {
  const result = await engine.handle(c.req.raw, c.res);
  return result;
}));
```

#### Fastify

```typescript
import fastify from 'fastify';
import { createFastifyAdapter } from 'upload-media-server';

const app = fastify();
const adapter = createFastifyAdapter();

app.post('/api/upload', adapter.wrap(async (req, reply) => {
  const result = await engine.handle(req, reply);
  return result;
}));
```

#### Next.js (App Router)

```typescript
import { createNextjsAdapter } from 'upload-media-server';

const adapter = createNextjsAdapter();

export async function POST(req: Request) {
  return adapter.wrap(async (req, res) => {
    const result = await engine.handle(req, res);
    return result;
  })(req);
}
```

#### Koa

```typescript
import Koa from 'koa';
import { createKoaAdapter } from 'upload-media-server';

const app = new Koa();
const adapter = createKoaAdapter();

app.use(adapter.wrap(async (ctx) => {
  const result = await engine.handle(ctx.req, ctx.res);
  return result;
}));
```

#### Elysia

```typescript
import { Elysia } from 'elysia';
import { createElysiaAdapter } from 'upload-media-server';

const app = new Elysia();
const adapter = createElysiaAdapter();

app.post('/api/upload', adapter.wrap(async ({ request, response }) => {
  const result = await engine.handle(request, response);
  return result;
}));
```

#### Nuxt/H3

```typescript
import { createH3Adapter } from 'upload-media-server';

const adapter = createH3Adapter();

export default defineEventHandler(adapter.wrap(async (event) => {
  const result = await engine.handle(event.node.req, event.node.res);
  return result;
}));
```

#### Raw Node

```typescript
import http from 'http';
import { createRawNodeAdapter } from 'upload-media-server';

const adapter = createRawNodeAdapter();

http.createServer(adapter.wrap(async (req, res) => {
  const result = await engine.handle(req, res);
  return result;
}));
```

### Adapter Options

All adapters accept an optional configuration object:

```typescript
const adapter = createExpressAdapter({
  autoRespond: true,        // Automatically send response (default: true)
  transformResponse: (result) => ({ 
    ...result, 
    timestamp: Date.now() 
  }), // Transform response before sending
  onError: (err) => { 
    console.error('Adapter error:', err); 
  } // Error handler
});
```

---

## 📁 Storage Providers

### S3StorageAdapter (AWS S3 & Compatible)

The S3StorageAdapter streams chunks directly to S3 using the native multipart upload API (`CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`). This means chunks bypass your server entirely and go straight to the S3 bucket.

#### How It Works

```typescript
/**
 * S3 Multipart Upload Flow:
 * 1. Client sends chunk → Server receives via streaming parser
 * 2. Server buffers chunks until minimum S3 part size (5MB) is reached
 * 3. Server calls UploadPart → Chunk streams directly to S3
 * 4. On final chunk, server calls CompleteMultipartUpload
 * 5. S3 returns signed URL for the assembled file
 */
```

**Key Architecture Decision:**
- Client chunk size (1-2MB) is **fully decoupled** from S3 part size (5MB minimum)
- The adapter internally buffers smaller chunks until the 5MB threshold
- This allows flexible frontend configuration without breaking S3 requirements

#### Basic Setup

```typescript
import { S3StorageAdapter } from 'upload-media-server';

const s3 = new S3StorageAdapter({
  bucket: 'my-uploads-bucket',
  region: 'us-east-1',
  // credentials auto-loaded from AWS SDK defaults:
  // - AWS_ACCESS_KEY_ID env var
  // - AWS_SECRET_ACCESS_KEY env var
  // - IAM role (if running on EC2/ECS/Lambda)
});
```

#### Providing Pre-Configured S3Client

If you already have a configured `S3Client` instance from `@aws-sdk/client-s3`, you can pass it directly:

```typescript
import { S3Client } from '@aws-sdk/client-s3';
import { S3StorageAdapter } from 'upload-media-server';

// Your pre-configured client (with custom retry logic, logging, etc.)
const s3Client = new S3Client({
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN // Optional for assumed roles
  },
  // Custom SDK configuration
  maxAttempts: 5,
  requestHandler: customRequestHandler // Optional: inject proxy, logging, etc.
});

// Pass your configured client to the adapter
const s3 = new S3StorageAdapter({
  bucket: 'my-uploads-bucket',
  region: 'us-east-1',
  client: s3Client // Your pre-configured client
  // If you provide `client`, all other SDK options (credentials, endpoint, etc.) are ignored
});
```

**Why Pass a Client?**
- ✅ Centralized S3 client configuration in your application
- ✅ Reuse across multiple adapters or services
- ✅ Inject custom middleware (logging, metrics, retry strategies)
- ✅ Assume IAM roles with session tokens
- ✅ Test with mocked S3Client instances

#### S3-Compatible Providers

The adapter works with any S3-compatible service by providing an `endpoint` and `forcePathStyle`:

```typescript
// Cloudflare R2
new S3StorageAdapter({
  bucket: 'my-r2-bucket',
  region: 'auto',
  endpoint: 'https://ACCOUNT_ID.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

// MinIO (self-hosted)
new S3StorageAdapter({
  bucket: 'my-bucket',
  region: 'us-east-1',
  endpoint: 'http://minio-server:9000',
  forcePathStyle: true, // Required for MinIO
  credentials: {
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin'
  }
});

// DigitalOcean Spaces
new S3StorageAdapter({
  bucket: 'my-space',
  region: 'nyc3',
  endpoint: 'https://nyc3.digitaloceanspaces.com',
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET
  }
});

// Wasabi (hot cloud storage)
new S3StorageAdapter({
  bucket: 'my-bucket',
  region: 'us-east-1',
  endpoint: 'https://s3.wasabisys.com',
  credentials: {
    accessKeyId: process.env.WASABI_ACCESS_KEY,
    secretAccessKey: process.env.WASABI_SECRET_KEY
  }
});
```

#### S3 Multipart Upload Details

The adapter implements S3's native multipart protocol:

```typescript
/**
 * Under the hood, for a 500MB file with 2MB client chunks:
 * 
 * 1. Client sends chunks 1, 2 (4MB total) → Server buffers
 * 2. Chunks 1-3 (6MB) exceed 5MB threshold → UploadPart #1 to S3
 * 3. Chunks 3, 4, 5 (6MB) → UploadPart #2 to S3
 * 4. ... repeats until final chunk
 * 5. Last chunk (may be < 5MB, which is allowed) → UploadPart #N
 * 6. CompleteMultipartUpload assembles all parts in S3
 * 7. File is ready in bucket, signed URL returned
 * 
 * Network flow: Client → Server → S3 bucket directly
 * Result: 500MB transferred to S3, not buffered on server
 */
```

#### Configuration Options

```typescript
interface S3StorageOptions {
  bucket: string;                    // Required: S3 bucket name
  region: string;                    // Required: AWS region
  credentials?: {                    // Optional: AWS credentials
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;           // For STS assumed roles
  };
  endpoint?: string;                 // Optional: For S3-compatible providers
  forcePathStyle?: boolean;          // Optional: Required for MinIO/DigitalOcean
  client?: S3Client;                 // Optional: Pre-configured S3Client instance
  buildPublicUrl?: (bucket: string, key: string) => string; // Custom URL builder
  buildKey?: (fileId: string, ctx: StorageContext) => string; // Custom key builder
  minPartSize?: number;              // Optional: Min bytes to buffer (default: 5MB)
}
```

#### Credentials Priority Order

1. `client` option (if provided, all others ignored)
2. `credentials` option (explicit credentials)
3. SDK defaults (env vars, IAM role, ~/.aws/credentials)

---

### CloudinaryStorageAdapter

The CloudinaryStorageAdapter uses **Cloudinary's official v2 SDK** and its native chunked upload API (`upload_large_stream`).

#### How It Works

```typescript
/**
 * Cloudinary v2 Chunked Upload Flow:
 * 1. Adapter calls cloudinary.uploader.upload_large_stream()
 * 2. Receives a Writable stream from Cloudinary SDK
 * 3. Server writes chunks as they arrive (no buffering needed)
 * 4. Cloudinary SDK handles chunking protocol & retries automatically
 * 5. Stream.end() signals completion
 * 6. Cloudinary confirms asset is ready
 * 7. Public URL returned
 */
```

**Why Cloudinary v2?**
- ✅ Official SDK handles all chunking protocol details
- ✅ Built-in retry semantics for network failures
- ✅ Automatic server-side chunk reassembly
- ✅ Direct transformation support (resize, format, filters)
- ✅ CDN delivery included with every upload

#### Setup

```typescript
import { CloudinaryStorageAdapter } from 'upload-media-server';

const cloudinary = new CloudinaryStorageAdapter({
  cloudName: 'your-cloud-name',
  apiKey: process.env.CLOUDINARY_API_KEY,
  apiSecret: process.env.CLOUDINARY_API_SECRET,
  folder: 'my-app/uploads' // Optional: prefix all uploads
});

// Or use pre-configured cloudinary instance
import cloudinaryLib from 'cloudinary';

const cloudinaryV2 = cloudinaryLib.v2;
cloudinaryV2.config({
  cloud_name: 'your-cloud-name',
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true // Always use HTTPS
});

const cloudinary = new CloudinaryStorageAdapter({
  cloudName: 'your-cloud-name',
  apiKey: process.env.CLOUDINARY_API_KEY,
  apiSecret: process.env.CLOUDINARY_API_SECRET,
  cloudinary: cloudinaryV2 // Pass your instance
});
```

#### Cloudinary Upload Options

The adapter automatically sets these v2 upload options:

```typescript
{
  public_id: buildPublicId(fileId, ctx),
  resource_type: 'auto', // Detects image/video/raw automatically
  use_filename: true,
  unique_filename: false,
  chunk_size: 6 * 1024 * 1024 // Cloudinary's internal chunking
}
```

#### Using Cloudinary Transformations

After upload, leverage Cloudinary's transformation API:

```typescript
// File uploaded to Cloudinary via adapter
const file = await database.getFileById(fileId);

// Use Cloudinary v2 to transform on-the-fly
const cloudinaryUrl = cloudinaryV2.url(file.storageRef, {
  width: 800,
  height: 600,
  crop: 'fill',
  quality: 'auto',
  format: 'webp'
});

// Or get thumbnail
const thumbUrl = cloudinaryV2.url(file.storageRef, {
  width: 200,
  height: 200,
  crop: 'thumb',
  gravity: 'face'
});
```

#### Configuration Options

```typescript
interface CloudinaryStorageOptions {
  cloudName: string;                          // Required: Cloudinary account
  apiKey: string;                             // Required: API key
  apiSecret: string;                          // Required: API secret
  folder?: string;                            // Optional: Public ID prefix
  cloudinary?: any;                           // Optional: Pre-configured v2 instance
  buildPublicId?: (fileId: string, ctx: StorageContext) => string; // Custom ID builder
  // Cloudinary v2 is auto-configured with secure: true
}
```

---

## 🏢 Complete Storage Adapter Comparison

| Feature | S3 | Cloudinary | Local Disk | Database |
|---------|-----|-----------|-----------|----------|
| **Protocol** | S3 Multipart API | Cloudinary v2 API | Filesystem | DB Binary Storage |
| **Cost Model** | Pay for storage | Pay per image/video ops | Free (hardware) | Manual |
| **Transformations** | Via Lambda/API | Built-in v2 API | Manual processing | Manual processing |
| **Best For** | Large scale, cost-optimized | Media first, instant transform | Dev/testing | Medium to Large files, backup |
| **Setup Complexity** | Medium | Low | Trivial | Low |
| **Client Injection** | ✅ Yes (S3Client) | ✅ Yes (v2 instance) | No | No |

---

### LocalDiskStorageAdapter

Perfect for development and small-scale deployments.

```typescript
new LocalDiskStorageAdapter({
  rootDir: './uploads',              // Required: storage path
  publicBaseUrl: '/static'            // Optional: URL prefix
});
```

---

### DatabaseStorageAdapter

Direct MongoDB/SQL storage adapter.

```typescript
new DatabaseStorageAdapter({
  database: database,
  prefetchCount: 3 // Number of chunks to prefetch (default: 2)
});
```

---

## 💾 Database Repositories

### Built-In Implementations

| Repository | Usage | Best For |
| :--- | :--- | :--- |
| `MongooseRepository` | `new MongooseRepository({ mongooseConnection })` | MongoDB. |
| `SQLRepository` | `new SQLRepository({ executor: knex, filesTable: 'uploads' })` | PostgreSQL, MySQL, SQLite. |
| `InMemoryRepository` | `new InMemoryRepository()` | Testing & development. |

### Custom Repository Implementation

Implement the `MetadataRepository` interface for any database:

```typescript
class MyRepository implements MetadataRepository {
  async createFile(file: FileRecord): Promise<FileRecord> {
    // Save to your database
    const saved = await myDB.insert(file);
    return saved;
  }
  
  async getFileById(id: string): Promise<FileRecord | null> {
    // Retrieve by ID
    return await myDB.findOne({ id });
  }
  
  async updateFile(id: string, updates: Partial<FileRecord>): Promise<FileRecord> {
    // Update record
    return await myDB.update({ id }, updates);
  }
  
  async deleteFiles(ids: string[]): Promise<number> {
    // Bulk delete
    const result = await myDB.delete({ id: { $in: ids } });
    return result.deletedCount;
  }
  
  async findFiles(query: any): Promise<FileRecord[]> {
    // Query files
    return await myDB.find(query);
  }
  
  async findChunks(sessionId: string): Promise<ChunkRecord[]> {
    // Find uploaded chunks for a session
    return await myDB.chunks.find({ sessionId });
  }
}
```

---

## 📈 Performance & Caching

### MongoDB Performance Cache

For high-traffic environments with MongoDB, use `@mongoose-performance-cache`:

```typescript
import { initCache } from '@mongoose-performance-cache';

export const cache = initCache({
  ttl: 600, // 10 minutes (recommended)
  enableSmartInvalidation: true, // Query-aware invalidation
  debug: false, // Set to true for detailed logging
  redis: { 
    host: 'localhost', 
    port: 6379 
  } // Optional; uses memory cache if omitted
});

const database = new MongooseRepository({
  mongooseConnection: mongoose.connection,
  onChunkSchemaInit: cache.applyCacheToQueries,
  onFileSchemaInit: cache.applyCacheToQueries
});
```

**Benefits:**
- Handles 1000+ RPS without database contention
- Smart invalidation keeps cache perfectly synced
- Zero-allocation hashing minimizes memory pressure

### Redis Hooks for Distributed Environments

For distributed environments, use Redis for chunk tracking:

```typescript
import { createClient } from 'redis';

const redis = createClient();

const engine = new UploadEngine({
  // ... config
  hooks: {
    afterPutObject: async (ctx) => {
      await redis.set(`chunk:${ctx.id}`, 'ready', 'EX', 86400);
    },
    beforeFindFiles: async (ctx) => {
      const cached = await redis.get(`files:${ctx.query.id}`);
      if (cached) return JSON.parse(cached);
    }
  }
});
```

---

## 🎞️ Media Serving

### File Serving Middleware

Deterministic dispatch based on `storageProvider` metadata:

```typescript
// Database-backed serving
app.use('/media', createExpressFileServingMiddleware({
  database,
  cacheMaxAge: '30d'
}));

// Local disk serving
app.use('/uploads', createExpressFileServingMiddleware({
  rootDir: './uploads',
  database
}));
```

### Features

- **Partial Content (Seek)**: Native `Accept-Ranges: bytes` support.
- **Identity Integrity**: File extension is virtual; actual MIME from database.
- **Performance Caching**: Compatible with Mongoose performance cache.
- **Lifecycle Hooks**: Inject auth via `onBeforeServe`, audit via `onAfterServe`.

### Serving Dispatch Logic

| `storageProvider` | Behavior |
| :--- | :--- |
| `'local'` | Streams from `rootDir` on disk. |
| `'database'` | Pipes binary chunks directly from SQL/MongoDB. |
| `'s3' / 'cloudinary' / other` | 302 redirect to provider's signed URL. |

### Custom Serving with Hooks

```typescript
app.use('/api/assets', createExpressFileServingMiddleware({
  database,
  onBeforeServe: async (fileId, req) => {
    // RBAC check
    if (!req.user.hasPremium) {
      throw new Error('Upgrade required');
    }
  },
  onAfterServe: async (file, stats) => {
    // Download auditing
    await logDownload(file.id, stats.bytes, stats.ip);
  }
}));
```

---

## 🎯 Hooks System

The engine provides a centralized event bus for injecting business logic:

### Storage Hooks

| Hook | Parameters | Use Case |
| :--- | :--- | :--- |
| `beforePutObject` | `(ctx: StorageContext)` | Pre-validation or encryption. |
| `afterPutObject` | `(ctx: StorageContext)` | Write-event notification. |
| `afterFinalize` | `(ctx: StorageContext)` | Post-reassembly processing. |

### Database Hooks

| Hook | Parameters | Use Case |
| :--- | :--- | :--- |
| `afterCreateFile` | `(file: FileRecord)` | Search index sync. |
| `beforeDeleteFiles` | `(ids: string[])` | Integrity checks. |
| `afterFindFiles` | `(files: FileRecord[])` | Path translation. |

### Example Implementation

```typescript
const engine = new UploadEngine({
  // ... config
  hooks: {
    afterCreateFile: async (file) => {
      // Sync to search index
      await elasticsearch.index({
        index: 'files',
        body: { 
          id: file.id, 
          name: file.originalName,
          uploadedAt: file.createdAt
        }
      });
    },
    beforeDeleteFiles: async (ids) => {
      // Validate ownership
      const owned = await File.find({ 
        _id: { $in: ids }, 
        userId: req.user.id 
      });
      if (owned.length !== ids.length) {
        throw new Error('Unauthorized deletion attempt');
      }
    },
    afterPutObject: async (ctx) => {
      // Track upload progress
      await redis.set(`upload:${ctx.id}:part`, ctx.partNumber);
    }
  }
});
```

---

## 🛡️ Error Handling & Rollback

In production, failures happen. Always clean up on error:

```typescript
app.post('/api/save', adapter.wrap(async (req, res) => {
  const result = await engine.handle(req, res);
  if (result.status !== 'success') return result;

  try {
    const video = req.fileFields['teaser'];
    await saveToBusinessLogic(video);
  } catch (err) {
    // 🗑️ Cleanup storage and engine DB entry
    await engine.cleanup(req.fileFields['teaser']);
    return { 
      status: 'error', 
      message: 'Transaction failed, files removed.' 
    };
  }
}));
```

### System Error Registry

| Code | HTTP | Origin | Resolution |
| :--- | :--- | :--- | :--- |
| `ERR_INVALID_MIME` | 415 | Server | File magic bytes don't match expected media type. Block upload. |
| `ERR_SIZE_EXCEEDED` | 413 | Server | File exceeds size limit in `UploadTypeConfig`. |
| `ERR_CHUNK_MISMATCH` | 400 | Server | Chunk hashes don't match. Trigger retry. |
| `ERR_PROCESSING_FAILED`| 500 | Server | Media transformation, variant transcoding, or thumbnail generation failed. Check FFmpeg logs. |
| `ERR_FFMPEG_NOT_FOUND` | 500 | Server | FFmpeg or FFprobe binaries not found on the host system. Install FFmpeg or configure `ffmpegPath`/`ffprobePath`. |
| `ERR_IDB_QUOTA_FULL` | N/A | Client | IndexedDB full. Call `manager.clear('completed')`. |
| `ERR_AUTH_EXPIRED` | 401 | Adapter | Refresh token using `onBackground` hook. |

---

## 🧪 Testing

### InMemory Repository for Unit Tests

```typescript
import { InMemoryRepository, UploadEngine } from 'upload-media-server';

const testEngine = new UploadEngine({
  database: new InMemoryRepository(),
  storages: { 
    memory: new LocalDiskStorageAdapter({ 
      rootDir: './test-uploads' 
    }) 
  },
  defaultStorage: 'memory',
  uploadTypes: { 
    test: { 
      allowedKinds: ['image'], 
      limits: { image: 10 * 1024 * 1024 } 
    } 
  }
});

// Test the engine
const result = await testEngine.handle(mockReq, mockRes);
expect(result.status).toBe('success');
```

---

## 📊 Technical Specifications

- **Runtime**: Node.js 16+, Bun 1.0+, Deno.
- **Language**: 100% Strict TypeScript.
- **Parser**: Stream-based Busboy derivative.
- **Max File Size**: Limited only by storage provider.
- **Concurrency**: Handles 1000+ simultaneous uploads per instance.
- **Chunk Size Decoupling**: Client sends 1-2MB chunks → Server buffers to 5MB S3 parts (for S3 adapter).
- **Cloudinary SDK**: Version v2 with `upload_large_stream()` API.

---

## 🌐 Multi-Server Deployment

When scaling horizontally (e.g., multiple EC2 instances behind an ALB), the core challenge is: **the client uploads Chunk 1 to Instance A, but the load balancer sends Chunk 5 to Instance B**. The library already handles this — you just need to pick the right storage adapter.

### Option A: DatabaseStorageAdapter (Fully Stateless)

**No sticky sessions. No shared disks. Any instance can handle any chunk.**

This is the recommended approach. Every chunk is written directly to your centralized database as a binary document. When the final chunk arrives at *any* instance, that instance:

1. Queries the shared DB for all chunks (via `assembleChunksToPath`)
2. Streams them to a temp file on local disk (`/tmp`)
3. Runs `MediaProcessor` (FFmpeg/Sharp) on the assembled file
4. Writes processed variants back to the DB via `putStream`
5. Cleans up the local temp file

```
       ┌─────────┐
       │  Client  │
       └────┬─────┘
            │  Chunks land on random instances
    ┌───────┼───────┐
    ▼       ▼       ▼
┌──────┐┌──────┐┌──────┐
│EC2 #1││EC2 #2││EC2 #3│  ← All stateless
└──┬───┘└──┬───┘└──┬───┘
   │       │       │
   └───────┼───────┘
           ▼
   ┌───────────────┐
   │ Shared Database│  ← Chunks stored as rows
   │  (Mongo/PG)   │
   └───────────────┘
```

```typescript
import { DatabaseStorageAdapter, MongooseRepository } from 'upload-media-server';

const database = new MongooseRepository({
  mongooseConnection: mongoose.connection
});

const storage = new DatabaseStorageAdapter({ database });

const engine = new UploadEngine({
  database,
  storages: { db: storage },
  defaultStorage: 'db',
  uploadTypes: {
    video: {
      allowedKinds: ['video'],
      limits: { video: 500 * 1024 * 1024 },
      thumbnails: true
    }
  }
});
```

**Why this works out of the box:**
- `writeChunk()` writes directly to the shared DB — no local state
- `assembleChunksToPath()` pulls all chunks from DB → streams to a local temp file for FFmpeg
- `putStream()` re-chunks processed variants back into the DB (respecting the original `chunkSize`)
- `finalize()` simply returns the `fileId` as the storage reference — no file "move" needed
- `ChunkReadStream` serves files directly from DB with range-request and prefetch support

### Option B: S3 & Cloudinary Adapters + Sticky Sessions

The `S3StorageAdapter` and `CloudinaryStorageAdapter` both maintain in-memory state during an active upload:
- **S3** caches `MultipartState` and small chunks in memory until they hit the 5MB part limit.
- **Cloudinary** keeps an active `upload_large_stream` connection open in memory across chunks.

Because of this local state, **all chunks for a given file must hit the same instance**.

You must configure your API Gateway or Load Balancer to route requests from the same client/session to the same EC2 instance. Without this, chunks will bounce between instances, leading to `400 Bad Request` or lost uploads.

**AWS Application Load Balancer (ALB):**
- Target Group → Attributes → Enable **Stickiness** (application-based cookie)

**Nginx (Using `ip_hash`):**
Ensures all requests from the same client IP always route to the same upstream server.
```nginx
upstream upload_backend {
    ip_hash;  # Crucial for routing chunks to the same instance!
    server ec2-instance-1:3000;
    server ec2-instance-2:3000;
    server ec2-instance-3:3000;
}

server {
    location /api/upload {
        proxy_pass http://upload_backend;
        client_max_body_size 0; # Disable Nginx upload payload limits
    }
}
```

**HAProxy (Using sticky cookies):**
```haproxy
backend upload_backend
    balance roundrobin
    cookie SRVNAME insert
    server inst1 ec2-instance-1:3000 cookie S1 check
    server inst2 ec2-instance-2:3000 cookie S2 check
```

```typescript
const s3 = new S3StorageAdapter({
  bucket: 'prod-uploads',
  region: 'us-east-1'
});

const engine = new UploadEngine({
  database,
  storages: { s3 },
  defaultStorage: 's3',
  uploadTypes: { /* ... */ }
});
```

**Trade-offs:**
- ✅ Files stream directly to the Cloud (S3/Cloudinary) — bypassing database binary storage.
- ✅ Processed media variants stream back natively via `putStream`.
- ⚠️ Requires sticky sessions — if an instance reboots mid-upload, that upload is lost.
- ⚠️ Holds raw chunks in memory (in `partCache` or `chunkCache`) until the final assembly — monitor process memory usage.

### Option C: Shared Filesystem (EFS / NFS)

Mount a network filesystem at the same path on every instance and use `LocalDiskStorageAdapter`:

```typescript
const local = new LocalDiskStorageAdapter({
  rootDir: '/mnt/efs/uploads',           // EFS mount point
  publicBaseUrl: 'https://cdn.example.com'
});

const engine = new UploadEngine({
  database,
  storages: { local },
  defaultStorage: 'local',
  uploadTypes: { /* ... */ }
});
```

**Trade-offs:**
- ✅ No sticky sessions needed — any instance reads/writes the same directory
- ✅ FFmpeg processes files in-place (no re-download step)
- ⚠️ EFS throughput can bottleneck on large concurrent uploads
- ⚠️ Additional AWS infrastructure cost

### Temp Directory Management (Crucial for EC2 / Docker)

Behind the scenes, the engine uses the host's temporary directory (`os.tmpdir()`) to assemble chunks and process media (via `fluent-ffmpeg` and `sharp`) **before** finally uploading them to your configured storage provider (S3, Cloudinary, or Database). 

If you are deploying horizontally scaling instances (like AWS EC2 or ECS), you **must** ensure each instance has sufficient local disk space attached (e.g. an EBS volume) to handle concurrently processing large video variants. 

If your default `/tmp` partition is too small, you can override the temporary directory for both the storage adapter and the media processor:

```typescript
const TEMP_VOLUME = '/mnt/ebs/upload-temp';

// 1. Configure the Storage Adapter to buffer assembled chunks here
const storage = new DatabaseStorageAdapter({ 
  database, 
  tempDir: TEMP_VOLUME 
});
// (Also available on S3StorageAdapter and CloudinaryStorageAdapter)

const engine = new UploadEngine({
  database,
  storages: { db: storage },
  defaultStorage: 'db',
  
  // 2. Configure the MediaProcessor to write FFmpeg variant outputs here
  mediaProcessor: {
    tempDir: TEMP_VOLUME,
    maxConcurrency: 2, // Important: Limit parallel FFmpeg tasks per instance
  },
  
  uploadTypes: { /* ... */ }
});
```

### Scaling Checklist

| Concern | What to configure |
| :--- | :--- |
| **Database** | Must be centralized (shared MongoDB/PostgreSQL) so all instances see the same `FileRecord` and chunk data. |
| **Storage Temp Space** | Provision sufficient EBS volume space for your EC2 instances and pass the mount path to `tempDir` on both the adapter and `UploadEngine` options. |
| **`mediaProcessor.maxConcurrency`** | Tune per instance to avoid CPU/memory oversubscription. E.g., for a 2-vCPU instance, set to `1` or `2`. |
| **`staleUploadRetentionMs`** | Set high enough to survive slow uploads across instances (default works for most cases). |
| **Cache layer** | Add `@mongoose-performance-cache` or Redis hooks to reduce DB round-trips for chunk lookups. |
| **Health checks** | Exclude `/api/upload` from health-check paths to avoid load balancer interference with long uploads. |

---

## 🤔 Troubleshooting

| Symptom | Probable Cause | Fix |
| :--- | :--- | :--- |
| **HTTP 413 Payload Too Large** | Nginx/Proxy limit | Increase `client_max_body_size` to `0`. |
| **Invalid MIME Type** | Sniffing failure | Ensure chunk overlaps with file magic header. |
| **Lost Chunks** | Improper cleanup | Configure `staleUploadRetentionMs` for your traffic. |
| **Video seek failed** | Range header missing | Use our serving middleware. |
| **Database contention** | High chunk volume | Integrate `@mongoose-performance-cache` or Redis. |
| **S3 UploadPart failed** | Part size < 5MB | Increase minPartSize or ensure buffering works. |
| **Cloudinary 401 error** | Invalid credentials | Check API key/secret and cloud name. |
| **Memory exhaustion** | Large files streaming | Set `quality: 'low'` or increase Node memory limit. |

---

## 📄 License

MIT © 2026 UploadMedia. Distributed as part of the upload-media ecosystem.

---

*Last Updated: 2026*