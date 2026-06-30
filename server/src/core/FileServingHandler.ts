/**
 * @upload-media/server - FileServingHandler
 */
import { createReadStream } from 'fs';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { NormalizedResponse, MetadataRepository } from '../types';

const FALLBACK_MIME_TYPES: Record<string, string> = {
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
};

const PREFETCH_COUNT = 2;

interface ChunkData {
    buffer: Buffer;
    chunkNumber: number;
}

export class FileServingHandler {
    constructor(
        private rootDir?: string,
        private database?: MetadataRepository,
        private cacheMaxAge: string = '1d'
    ) { }

    async serveFile(
        ref: string,
        res: NormalizedResponse,
        startByte?: number,
        endByte?: number
    ): Promise<void> {
        try {
            const fileId = this.extractFileId(ref);
            if (!this.database) {
                await this.serveFromDisk(ref, res, startByte, endByte);
                return;
            }

            const fileRecord = await this.database.getFileById(fileId);

            if (!fileRecord) {
                res.status(404);
                res.json({ error: 'File metadata not found' });
                return;
            }

            switch (fileRecord.storageProvider) {
                case 'database':
                    await this.serveFromDatabase(fileRecord, res, startByte, endByte);
                    break;

                case 'local':
                case 'disk':
                    await this.serveFromDisk(fileRecord.storageRef || fileId, res, startByte, endByte, fileRecord);
                    break;

                default:
                    if (fileRecord.url && fileRecord.url.startsWith('http')) {
                        res.status(302);
                        res.header('Location', fileRecord.url);
                        res.header('X-Served-By', 'upload-media-proxy-redirect');
                        res.end();
                    } else {
                        await this.serveFromDatabase(fileRecord, res, startByte, endByte);
                    }
            }
        } catch (error) {
            this.handleError(error, res);
        }
    }

    private async serveFromDisk(
        ref: string,
        res: NormalizedResponse,
        start?: number,
        end?: number,
        file?: any
    ): Promise<void> {
        if (!this.rootDir) {
            throw new Error('rootDir is required for local disk serving');
        }

        let fullPath: string;

        if (ref.includes('/') || ref.includes('\\')) {
            fullPath = path.join(this.rootDir, ref);
        } else {
            const uploadType = file?.uploadType || 'avatar';
            fullPath = path.join(this.rootDir, uploadType, ref);

            if (!await this.fileExists(fullPath)) {
                fullPath = path.join(this.rootDir, ref);
            }
        }

        if (!fullPath.startsWith(this.rootDir)) {
            res.status(403);
            res.json({ error: 'Forbidden - Path traversal detected' });
            return;
        }

        try {
            const stat = await fs.stat(fullPath);
            const mimeType = file?.contentType || this.getMimeTypeFromExtension(fullPath);

            this.setHeaders(res, mimeType, stat.size, stat.ino, stat.mtime);

            if (start !== undefined && end !== undefined) {
                res.status(206);
                res.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
                res.header('Content-Length', String(end - start + 1));
                const stream = createReadStream(fullPath, { start, end });
                await res.pipeFrom(stream);
            } else {
                res.status(200);
                res.header('Content-Length', String(stat.size));
                const stream = createReadStream(fullPath);
                await res.pipeFrom(stream);
            }
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                res.status(404);
                res.json({ error: 'File not found on disk' });
            } else {
                throw err;
            }
        }
    }

    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    private async serveFromDatabase(
        file: any,
        res: NormalizedResponse,
        start?: number,
        end?: number
    ): Promise<void> {
        const database = this.database;
        if (!database || !database.getChunk) {
            throw new Error('Database repository does not support chunk serving');
        }

        const chunkSize = file.chunkSize || 2 * 1024 * 1024;
        const fileSize = file.size;
        const startByte = start ?? 0;
        const endByte = end ?? (fileSize - 1);

        // Validate range
        if (startByte < 0 || startByte >= fileSize || endByte < 0 || endByte >= fileSize || startByte > endByte) {
            console.warn(`⚠️ Invalid range: ${startByte}-${endByte} for file size ${fileSize}`);
            res.status(416);
            res.header('Content-Range', `bytes */${fileSize}`);
            res.end();
            return;
        }

        const totalBytes = endByte - startByte + 1;

        this.setHeaders(res, file.contentType, fileSize, file.id, new Date(file.updatedAt || Date.now()));

        if (start !== undefined && start > 0) {
            res.status(206);
            res.header('Content-Range', `bytes ${startByte}-${endByte}/${fileSize}`);
        } else {
            res.status(200);
        }

        res.header('Content-Length', String(totalBytes));

        const startChunk = Math.floor(startByte / chunkSize);
        const endChunk = Math.floor(endByte / chunkSize);

        let clientDisconnected = false;
        let streamDestroyed = false;

        const onClientDisconnect = () => { clientDisconnected = true; };

        const mediaStream = new OptimizedDatabaseMediaStream(
            database,
            file.id,
            startChunk,
            endChunk,
            chunkSize,
            startByte,
            endByte,
            fileSize
        );

        mediaStream.on('error', (error) => {
            streamDestroyed = true;
            if (!clientDisconnected && !res.raw.headersSent && res.raw.writable) {
                try { res.status(500).json({ error: 'Stream error: ' + error.message }); } catch (e) { }
            }
        });

        mediaStream.on('close', () => { streamDestroyed = true; });

        const rawRes = res.raw;
        rawRes.on('close', onClientDisconnect);

        try {
            if (rawRes.destroyed || rawRes.writableEnded || !rawRes.writable) {
                mediaStream.destroy();
                return;
            }
            await res.pipeFrom(mediaStream);
        } catch (err) {
            if (!rawRes.headersSent) {
                try { res.status(500).json({ error: 'Error streaming file' }); } catch (e) { }
            }
        } finally {
            rawRes.removeListener('close', onClientDisconnect);
            if (!streamDestroyed) mediaStream.destroy();
        }
    }

    private setHeaders(res: NormalizedResponse, mimeType: string, size: number, id: any, mtime: Date) {
        res.header('Content-Type', mimeType);
        res.header('Cache-Control', `public, max-age=${this.getCacheSeconds()}`);
        res.header('ETag', this.generateETag(id, mtime));
        res.header('Accept-Ranges', 'bytes');
        res.header('Access-Control-Allow-Origin', '*');
    }

    private handleError(error: any, res: NormalizedResponse) {
        if (error instanceof Error) {
            if (error.message.includes('ENOENT') || error.message.includes('not found')) {
                res.status(404);
                res.json({ error: 'File not found' });
            } else if (error.message.includes('Forbidden')) {
                res.status(403);
                res.json({ error: 'Forbidden' });
            } else {
                res.status(500);
                res.json({ error: 'Internal server error', details: error.message });
            }
        } else {
            res.status(500);
            res.json({ error: 'Internal server error' });
        }
    }

    private extractFileId(ref: string): string {
        if (!ref) return '';
        const parts = ref.split('/');
        let filename = parts.length > 1 ? parts[parts.length - 1] : parts[0];
        filename = filename.replace(/\.[^/.]+$/, '');
        return filename || ref;
    }

    private getMimeTypeFromExtension(fullPath: string): string {
        const ext = path.extname(fullPath).toLowerCase();

        if (FALLBACK_MIME_TYPES[ext]) {
            return FALLBACK_MIME_TYPES[ext];
        }

        if (ext.match(/^\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i)) {
            return `image/${ext.slice(1).replace('jpg', 'jpeg')}`;
        }
        if (ext.match(/^\.(mp4|webm|mov|avi|mkv|flv|wmv|m4v)$/i)) {
            return `video/${ext.slice(1)}`;
        }
        if (ext.match(/^\.(mp3|wav|m4a|aac|flac|ogg)$/i)) {
            return `audio/${ext.slice(1)}`;
        }

        return 'application/octet-stream';
    }

    private getCacheSeconds(): number {
        const match = this.cacheMaxAge.match(/(\d+)([mhd]?)/);
        if (!match) return 86400;

        const [, num, unit] = match;
        const value = parseInt(num, 10);

        switch (unit) {
            case 'm': return value * 60;
            case 'h': return value * 3600;
            case 'd': return value * 86400;
            default: return value;
        }
    }

    private generateETag(inode: number | string, mtime: Date): string {
        return `"${inode}-${mtime.getTime()}"`;
    }
}

/**
 * OptimizedDatabaseMediaStream - Proper chunk size calculation
 */
export class OptimizedDatabaseMediaStream extends Readable {
    private currentChunk: number;
    private readonly endChunk: number;
    private readonly fileId: string;
    private readonly fileChunkSize: number;
    private readonly startOffset: number;
    private readonly endOffset: number;
    private readonly fileSize: number;
    private readonly totalChunks: number;
    public destroyed = false;
    private isReading = false;
    private prefetchQueue: Map<number, Promise<ChunkData | null>> = new Map();
    private prefetchInProgress = false;
    private database: MetadataRepository;

    constructor(
        database: MetadataRepository,
        fileId: string,
        startChunk: number,
        endChunk: number,
        fileChunkSize: number,
        startOffset: number,
        endOffset: number,
        fileSize: number
    ) {
        super({ highWaterMark: 1024 * 1024, objectMode: false, autoDestroy: true });
        this.database = database;
        this.fileId = fileId;
        this.currentChunk = startChunk;
        this.endChunk = endChunk;
        this.fileChunkSize = fileChunkSize;
        this.startOffset = startOffset;
        this.endOffset = endOffset;
        this.fileSize = fileSize;
        this.totalChunks = Math.ceil(fileSize / fileChunkSize);
    }

    /** Starting byte of a given chunk in the logical file */
    private getChunkStartByte(chunkNumber: number): number {
        return chunkNumber * this.fileChunkSize;
    }

    private async fetchChunk(chunkNumber: number): Promise<ChunkData | null> {
        try {
            const raw = await this.database.getChunk(this.fileId, chunkNumber);
            if (!raw) {
                console.warn(`⚠️ Missing chunk ${chunkNumber} for file ${this.fileId}`);
                return null;
            }
            const buffer = this.normalizeBuffer(raw);
            if (!buffer || buffer.length === 0) {
                console.warn(`⚠️ Chunk ${chunkNumber} is empty or unreadable`);
                return null;
            }

            return { buffer, chunkNumber };
        } catch (err) {
            console.error(`Error fetching chunk ${chunkNumber}:`, err);
            return null;
        }
    }

    private normalizeBuffer(input: any): Buffer | null {
        if (!input) return null;
        if (Buffer.isBuffer(input)) return input;
        if (input && typeof input === 'object' && input._bsontype === 'Binary') {
            if (input.buffer) return Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.from(input.buffer);
            try { return Buffer.from(input); } catch { return null; }
        }
        if (input && typeof input === 'object' && input.buffer) {
            if (Buffer.isBuffer(input.buffer)) return input.buffer;
            if (ArrayBuffer.isView(input.buffer)) return Buffer.from(input.buffer.buffer, input.buffer.byteOffset, input.buffer.byteLength);
            if (input.buffer instanceof ArrayBuffer) return Buffer.from(input.buffer);
            try { return Buffer.from(input.buffer); } catch { }
        }
        if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
        if (typeof input === 'string') return Buffer.from(input, 'utf-8');
        try { const c = Buffer.from(input); return c.length > 0 ? c : null; } catch { return null; }
    }

    private prefetchChunks(): void {
        if (this.prefetchInProgress || this.destroyed) return;
        this.prefetchInProgress = true;
        for (let i = 1; i <= PREFETCH_COUNT; i++) {
            const n = this.currentChunk + i;
            if (n > this.endChunk || this.prefetchQueue.has(n)) continue;
            const p = this.fetchChunk(n);
            this.prefetchQueue.set(n, p);
            p.finally(() => { setTimeout(() => this.prefetchQueue.delete(n), 2000); });
        }
        this.prefetchInProgress = false;
    }

    async _read(): Promise<void> {
        if (this.destroyed || this.isReading) return;
        if (this.currentChunk > this.endChunk) { this.push(null); this.cleanup(); return; }
        this.isReading = true;

        try {
            let chunkData: ChunkData | null;
            if (this.prefetchQueue.has(this.currentChunk)) {
                chunkData = await this.prefetchQueue.get(this.currentChunk)!;
                this.prefetchQueue.delete(this.currentChunk);
            } else {
                chunkData = await this.fetchChunk(this.currentChunk);
            }

            if (!chunkData) {
                this.isReading = false;
                this.destroy(new Error(`Missing chunk ${this.currentChunk} for file ${this.fileId}`));
                return;
            }
            if (this.destroyed) { this.isReading = false; return; }

            const bufLen = chunkData.buffer.length;
            const chunkStartByte = this.getChunkStartByte(this.currentChunk);

            let sliceStart = 0;
            let sliceEnd = bufLen;

            // Adjust for the requested byte range's start within this chunk
            const rangeStartChunk = Math.floor(this.startOffset / this.fileChunkSize);
            if (this.currentChunk === rangeStartChunk) {
                sliceStart = this.startOffset - chunkStartByte;
            }

            // Adjust for the requested byte range's end within this chunk
            const rangeEndChunk = Math.floor(this.endOffset / this.fileChunkSize);
            if (this.currentChunk === rangeEndChunk) {
                sliceEnd = Math.min(bufLen, this.endOffset - chunkStartByte + 1);
            }

            sliceStart = Math.max(0, Math.min(sliceStart, bufLen));
            sliceEnd = Math.max(0, Math.min(sliceEnd, bufLen));

            if (sliceStart >= sliceEnd) {
                this.currentChunk++;
                this.isReading = false;
                setImmediate(() => this._read());
                return;
            }

            const dataToSend = chunkData.buffer.subarray(sliceStart, sliceEnd);
            const canPush = this.push(dataToSend);
            chunkData = null; // help GC
            this.currentChunk++;
            this.isReading = false;

            if (!this.destroyed && this.currentChunk <= this.endChunk) this.prefetchChunks();
            if (canPush && this.currentChunk <= this.endChunk && !this.destroyed) setImmediate(() => this._read());
        } catch (err) {
            this.isReading = false;
            if (!this.destroyed) this.destroy(err as Error);
        }
    }

    private cleanup(): void { this.prefetchQueue.clear(); }

    _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        this.destroyed = true;
        this.isReading = false;
        this.cleanup();
        callback(error);
    }
}