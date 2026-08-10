import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ProcessedMediaVariant, MediaProcessorOptions, ProcessingResult, Quality, QualityConfig, VideoProcessingConfig, AudioProcessingConfig, ImageProcessingConfig } from '../types';

export interface ExtendedProcessingResult extends ProcessingResult {
    outputPath?: string;
    variantPaths?: Record<string, string>;
    cleanupFn?: () => Promise<void>;
}

interface ResolvedQuality {
    width?: number;
    height?: number;
    videoBitrate?: string;
    audioBitrate?: string;
    crf?: number;
    preset?: string;
}

function ensureBuffer(input: Buffer | Uint8Array | ArrayBuffer): Buffer {
    if (Buffer.isBuffer(input)) return input;
    if (input instanceof ArrayBuffer) return Buffer.from(input);
    if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    return Buffer.from(input as any);
}

function normaliseFormat(format: string): string {
    return format.replace(/^(video|audio|image)\//, '');
}

function loadSharp(): any {
    try { return require('sharp'); } catch { return null; }
}

function loadFluentFfmpeg(): any {
    try { return require('fluent-ffmpeg'); } catch { return null; }
}

function resolveFfmpegPath(customPath?: string): string | null {
    if (customPath) return customPath;
    try { const p = require('@ffmpeg-installer/ffmpeg').path; if (p) return p; } catch { }
    try { const p = require('ffmpeg-static'); if (p) return p; } catch { }
    try {
        const cmd = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
        require('child_process').execSync(`"${cmd}" -version`, { stdio: 'ignore' });
        return cmd;
    } catch { }
    console.warn('[MediaProcessor] FFmpeg not found — video/audio processing disabled.');
    return null;
}

function resolveFfprobePath(customPath?: string, ffmpegPath?: string | null): string | null {
    if (customPath) return customPath;
    try { const p = require('@ffprobe-installer/ffprobe').path; if (p) return p; } catch { }
    if (ffmpegPath) {
        const probe = path.join(
            path.dirname(ffmpegPath),
            process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
        );
        try {
            require('child_process').execSync(`"${probe}" -version`, { stdio: 'ignore' });
            return probe;
        } catch { }
    }
    return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
}

const RESOLUTION_MAP: Record<string, { width: number; height: number }> = {
    '2160p': { width: 3840, height: 2160 },
    '4k': { width: 3840, height: 2160 },
    '1440p': { width: 2560, height: 1440 },
    '2k': { width: 2560, height: 1440 },
    '1080p': { width: 1920, height: 1080 },
    '720p': { width: 1280, height: 720 },
    '540p': { width: 960, height: 540 },
    '480p': { width: 854, height: 480 },
    '360p': { width: 640, height: 360 },
    '240p': { width: 426, height: 240 },
    '144p': { width: 256, height: 144 },
};

function parseResolution(res?: string): { width: number; height: number } | undefined {
    if (!res) return undefined;
    return RESOLUTION_MAP[res.toLowerCase()];
}

interface LadderTier {
    crf: number;
    videoBitrate: string;
    maxBitrate: string;
    bufsize: string;
    audioBitrate: string;
    preset: string;
}

const RESOLUTION_ENCODING_LADDER: Record<string, LadderTier> = {
    '2160p': { crf: 17, videoBitrate: '14000k', maxBitrate: '21000k', bufsize: '28000k', audioBitrate: '192k', preset: 'slow' },
    '4k': { crf: 17, videoBitrate: '14000k', maxBitrate: '21000k', bufsize: '28000k', audioBitrate: '192k', preset: 'slow' },
    '1440p': { crf: 19, videoBitrate: '7500k', maxBitrate: '11250k', bufsize: '15000k', audioBitrate: '192k', preset: 'medium' },
    '2k': { crf: 19, videoBitrate: '7500k', maxBitrate: '11250k', bufsize: '15000k', audioBitrate: '192k', preset: 'medium' },
    '1080p': { crf: 20, videoBitrate: '4000k', maxBitrate: '6000k', bufsize: '8000k', audioBitrate: '160k', preset: 'medium' },
    '720p': { crf: 21, videoBitrate: '2200k', maxBitrate: '3300k', bufsize: '4400k', audioBitrate: '128k', preset: 'fast' },
    '540p': { crf: 23, videoBitrate: '1300k', maxBitrate: '1950k', bufsize: '2600k', audioBitrate: '128k', preset: 'fast' },
    '480p': { crf: 24, videoBitrate: '900k', maxBitrate: '1350k', bufsize: '1800k', audioBitrate: '96k', preset: 'faster' },
    '360p': { crf: 26, videoBitrate: '650k', maxBitrate: '975k', bufsize: '1300k', audioBitrate: '96k', preset: 'faster' },
    '240p': { crf: 28, videoBitrate: '400k', maxBitrate: '600k', bufsize: '800k', audioBitrate: '64k', preset: 'veryfast' },
    '144p': { crf: 30, videoBitrate: '200k', maxBitrate: '300k', bufsize: '400k', audioBitrate: '64k', preset: 'veryfast' },
};

const X264_PRESET_ORDER = [
    'veryslow', 'slower', 'slow', 'medium', 'fast', 'faster', 'veryfast', 'superfast', 'ultrafast',
] as const;
type X264Preset = typeof X264_PRESET_ORDER[number];

function resolveRuntimePreset(
    basePreset: string,
    cpuCount: number,
    concurrentVariants: number,
    speedProfile: 'quality' | 'balanced' | 'speed',
): X264Preset {
    const baseIndex = X264_PRESET_ORDER.indexOf(basePreset as X264Preset);
    const safeBaseIndex = baseIndex === -1 ? X264_PRESET_ORDER.indexOf('medium') : baseIndex;

    const threadsPerProcess = Math.max(1, Math.floor(cpuCount / Math.max(1, concurrentVariants)));

    let step = 0;
    if (threadsPerProcess <= 1) step += 1;

    if (speedProfile === 'speed') step += 2;
    else if (speedProfile === 'quality') step -= 1;

    const targetIndex = Math.min(
        X264_PRESET_ORDER.length - 1,
        Math.max(0, safeBaseIndex + step),
    );
    return X264_PRESET_ORDER[targetIndex];
}

function getLadderTier(resolution?: string): LadderTier | null {
    if (!resolution) return null;
    return RESOLUTION_ENCODING_LADDER[resolution.toLowerCase()] ?? null;
}

function resolveVideoQuality(cfg: QualityConfig | undefined, quality: Quality | undefined): ResolvedQuality {
    if (cfg) {
        const dims = parseResolution(cfg.resolution);
        const ladder = getLadderTier(cfg.resolution);
        return {
            width: cfg.width ?? dims?.width,
            height: cfg.height ?? dims?.height,
            videoBitrate: cfg.videoBitrate ?? ladder?.videoBitrate ?? resolveNamedVideoBitrate(quality),
            audioBitrate: cfg.audioBitrate ?? ladder?.audioBitrate ?? resolveNamedAudioBitrate(quality),
            crf: cfg.crf ?? ladder?.crf ?? resolveCrf(quality),
            preset: (cfg as any).preset ?? ladder?.preset ?? resolveNamedPreset(quality),
        };
    }
    return {
        videoBitrate: resolveNamedVideoBitrate(quality),
        audioBitrate: resolveNamedAudioBitrate(quality),
        crf: resolveCrf(quality),
        preset: resolveNamedPreset(quality),
    };
}

function resolveNamedVideoBitrate(quality: Quality | undefined): string {
    if (typeof quality === 'number') return `${quality}k`;
    switch (quality) {
        case 'high': return '4500k';
        case 'low': return '800k';
        default: return '2500k';
    }
}

function resolveNamedAudioBitrate(quality: Quality | undefined): string {
    switch (quality) {
        case 'high': return '192k';
        case 'low': return '96k';
        default: return '128k';
    }
}

function resolveNamedPreset(quality: Quality | undefined): string {
    switch (quality) {
        case 'high': return 'medium';
        case 'low': return 'veryfast';
        default: return 'faster';
    }
}

function resolveCrf(quality: Quality | undefined): number {
    if (typeof quality === 'number') {
        return Math.round(51 - (Math.min(100, Math.max(0, quality)) / 100) * 51);
    }
    switch (quality) {
        case 'high': return 18;
        case 'low': return 28;
        default: return 23;
    }
}


const TIER_SOURCE_BITRATE_FACTOR: Record<string, number> = {
    '2160p': 0.85, '4k': 0.85,
    '1440p': 0.75, '2k': 0.75,
    '1080p': 0.65,
    '720p': 0.55,
    '540p': 0.50,
    '480p': 0.45,
    '360p': 0.40,
    '240p': 0.35,
    '144p': 0.30,
};

const DEFAULT_TIER_SOURCE_FACTOR = 0.55;
const MIN_VIDEO_BITRATE_KBPS = 80;

function kbpsToString(kbps: number): string {
    return `${Math.max(MIN_VIDEO_BITRATE_KBPS, Math.round(kbps))}k`;
}

function parseKbps(bitrateStr: string | undefined): number | null {
    if (!bitrateStr) return null;
    const n = parseInt(bitrateStr, 10);
    return isNaN(n) ? null : n;
}

/**
 * Clamp a tier's ladder-default video bitrate down toward the source's own
 * bitrate when the source is leaner than the ladder assumes. Returns the
 * (possibly unchanged) videoBitrate plus matching maxBitrate/bufsize so the
 * VBV window stays internally consistent with whatever target we land on.
 */
function clampTierToSourceBitrate(
    resolution: string | undefined,
    ladderVideoBitrateKbps: number,
    sourceBitrateKbps: number | null,
): { videoBitrate: string; maxBitrate: string; bufsize: string } | null {
    if (!sourceBitrateKbps || sourceBitrateKbps <= 0) return null;

    const factor = (resolution && TIER_SOURCE_BITRATE_FACTOR[resolution.toLowerCase()])
        ?? DEFAULT_TIER_SOURCE_FACTOR;

    const sourceDerivedTarget = sourceBitrateKbps * (factor === "" ? 0 : factor);

    // Only clamp DOWN. If the source-derived target is already above the
    // ladder default, the ladder default is doing fine on its own — leave it.
    if (sourceDerivedTarget >= ladderVideoBitrateKbps) return null;

    const videoBitrateKbps = Math.max(MIN_VIDEO_BITRATE_KBPS, sourceDerivedTarget);
    const maxBitrateKbps = videoBitrateKbps * 1.5;
    const bufsizeKbps = videoBitrateKbps * 2;

    return {
        videoBitrate: kbpsToString(videoBitrateKbps),
        maxBitrate: kbpsToString(maxBitrateKbps),
        bufsize: kbpsToString(bufsizeKbps),
    };
}

function resolveMaxBitrate(cfg: QualityConfig | undefined, avgBitrate: string): string {
    if (cfg?.resolution) {
        const tier = getLadderTier(cfg.resolution);
        if (tier) return tier.maxBitrate;
    }
    const n = parseInt(avgBitrate, 10);
    return isNaN(n) ? avgBitrate : `${Math.round(n * 1.5)}k`;
}

function resolveBufsize(cfg: QualityConfig | undefined, avgBitrate: string): string {
    if (cfg?.resolution) {
        const tier = getLadderTier(cfg.resolution);
        if (tier) return tier.bufsize;
    }
    const n = parseInt(avgBitrate, 10);
    return isNaN(n) ? avgBitrate : `${n * 2}k`;
}

function resolveImageQuality(cfg: QualityConfig | undefined, quality: Quality | undefined): number {
    if (cfg?.quality !== undefined) return resolveImageQualityValue(cfg.quality);
    return resolveImageQualityValue(quality);
}

function resolveImageQualityValue(quality: Quality | undefined): number {
    if (typeof quality === 'number') return Math.max(1, Math.min(100, quality));
    switch (quality) {
        case 'high': return 90;
        case 'low': return 60;
        default: return 80;
    }
}

function resolveImageDimensions(
    cfg: QualityConfig | undefined, quality: Quality | undefined
): { width?: number; height?: number } {
    if (cfg) {
        if (cfg.width || cfg.height) return { width: cfg.width, height: cfg.height };
        if (cfg.maxDimension) return { width: cfg.maxDimension, height: cfg.maxDimension };
        if (cfg.resolution) {
            const dims = parseResolution(cfg.resolution);
            if (dims) return { width: dims.width, height: dims.height };
        }
    }
    switch (quality) {
        case 'high': return { width: 1920, height: 1080 };
        case 'low': return { width: 800, height: 600 };
        default: return { width: 1280, height: 720 };
    }
}

function resolveAudioBitrate(cfg: QualityConfig | undefined, quality: Quality | undefined): string {
    if (cfg?.audioBitrate) return cfg.audioBitrate;
    if (typeof quality === 'number') return `${Math.max(64, Math.min(320, quality * 3))}k`;
    switch (quality) {
        case 'high': return '320k';
        case 'low': return '96k';
        default: return '192k';
    }
}

class Semaphore {
    private queue: Array<() => void> = [];
    private count: number;
    constructor(max: number) { this.count = max; }

    acquire(): Promise<void> {
        if (this.count > 0) { this.count--; return Promise.resolve(); }
        return new Promise<void>((resolve) => this.queue.push(resolve));
    }

    release(): void {
        if (this.queue.length > 0) this.queue.shift()!();
        else this.count++;
    }
}

class TempFileManager {
    private files = new Set<string>();
    private dir: string;
    private sessionId: string;

    constructor(dir: string) {
        this.dir = dir;
        this.sessionId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        fs.mkdirSync(dir, { recursive: true });
    }

    create(ext: string, variantId: string = 'tmp'): string {
        const safeId = variantId.replace(/[^a-zA-Z0-9_-]/g, '_');
        const name = `upload_proc_${this.sessionId}_${safeId}${ext}`;
        const fullPath = path.join(this.dir, name);
        this.files.add(fullPath);
        return fullPath;
    }

    register(filePath: string): void { this.files.add(filePath); }

    async cleanup(retries = 3, delayMs = 500): Promise<void> {
        await new Promise((r) => setTimeout(r, delayMs));
        const remaining = new Set<string>();
        for (const f of this.files) {
            let deleted = false;
            for (let attempt = 0; attempt < retries; attempt++) {
                try {
                    if (fs.existsSync(f)) await fs.promises.unlink(f);
                    deleted = true;
                    break;
                } catch {
                    if (attempt < retries - 1)
                        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
                }
            }
            if (!deleted) remaining.add(f);
        }
        this.files.clear();
        if (remaining.size > 0)
            console.warn('[MediaProcessor] Failed to clean up temp files:', [...remaining]);
    }
}

// assembleChunksToDisk has been deprecated to favor explicit filesystem stream usage

function buildScaleFilter(width: number | undefined, height: number | undefined): string | null {
    if (!width && !height) return null;
    if (width && height) {
        return [
            `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=fast_bilinear`,
            `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
            `scale=trunc(iw/2)*2:trunc(ih/2)*2`,
        ].join(',');
    }
    if (width) return `scale=${width}:-2:flags=fast_bilinear`;
    if (height) return `scale=-2:${height}:flags=fast_bilinear`;
    return null;
}

const HW_ENCODERS_PRIORITY = ['h264_nvenc', 'h264_qsv', 'h264_amf'] as const;
type HwEncoder = typeof HW_ENCODERS_PRIORITY[number];

interface HwProbeResult {
    encoder: HwEncoder | null;
    extraArgs: string[];
}

let _hwProbeCache: HwProbeResult | null = null;
let _hwProbeInflight: Promise<HwProbeResult> | null = null;

function extraArgsFor(enc: HwEncoder): string[] {
    if (enc === 'h264_nvenc') {
        return ['-rc:v vbr', '-cq 23', '-b_ref_mode middle'];
    }
    if (enc === 'h264_qsv') {
        return ['-global_quality 23', '-look_ahead 1'];
    }
    // h264_amf
    return ['-rc cqp', '-qp_i 23', '-qp_p 25'];
}

function extraArgsForAbr(enc: HwEncoder): string[] {
    if (enc === 'h264_nvenc') {
        return ['-rc:v cbr'];
    }
    if (enc === 'h264_qsv') {
        return ['-look_ahead 0'];
    }
    // h264_amf
    return ['-rc cbr'];
}

function canActuallyEncode(ffmpegBin: string, encoder: HwEncoder, extraArgs: string[]): boolean {
    try {
        const { execSync } = require('child_process');
        const argsStr = extraArgs.join(' ');
        execSync(
            `"${ffmpegBin}" -hide_banner -loglevel error -f lavfi -i color=c=black:s=64x64:d=0.1 ` +
            `-frames:v 1 -c:v ${encoder} ${argsStr} -f null -`,
            { stdio: 'ignore', timeout: 5_000 },
        );
        return true;
    } catch {
        return false;
    }
}

async function probeHardwareEncoder(
    ffmpegBin: string,
    _ffmpegModule: any,
): Promise<HwProbeResult> {
    if (_hwProbeCache) return _hwProbeCache;
    if (_hwProbeInflight) return _hwProbeInflight;

    _hwProbeInflight = (async (): Promise<HwProbeResult> => {
        try {
            const { execSync } = require('child_process');
            const out: string = execSync(`"${ffmpegBin}" -encoders -v quiet`, {
                encoding: 'utf8',
                timeout: 10_000,
            });

            for (const enc of HW_ENCODERS_PRIORITY) {
                if (!out.includes(enc)) continue;

                const extraArgs = extraArgsFor(enc);

                const works = canActuallyEncode(ffmpegBin, enc, extraArgs);
                if (!works) {
                    console.log(`[MediaProcessor] ${enc} is compiled in but not functional on this machine (driver/GPU unavailable) — skipping.`);
                    continue;
                }

                //console.log(`[MediaProcessor] Hardware encoder detected and verified working: ${enc}`);
                _hwProbeCache = { encoder: enc, extraArgs };
                return _hwProbeCache;
            }
        } catch (e) {
            //console.warn('[MediaProcessor] HW encoder probe failed, using libx264:', (e as Error).message);
        }

        //console.log('[MediaProcessor] No working hardware encoder found — using libx264.');
        _hwProbeCache = { encoder: null, extraArgs: [] };
        return _hwProbeCache;
    })();

    const result = await _hwProbeInflight;
    _hwProbeInflight = null;
    return result;
}

function buildAudioFilterChain(bitrateStr: string): string {
    const k = parseInt(bitrateStr, 10);
    const fcut = k <= 64 ? 14000 : k <= 128 ? 17000 : 20000;

    return [
        'aresample=48000',
        'highpass=f=80:poles=2',
        `lowpass=f=${fcut}:poles=2`
    ].join(',');
}

function resolveVbrQuality(bitrateStr: string): number {
    const k = parseInt(bitrateStr, 10);
    if (k >= 320) return 0;
    if (k >= 256) return 1;
    if (k >= 192) return 2;
    if (k >= 160) return 3;
    if (k >= 128) return 4;
    if (k >= 96) return 5;
    if (k >= 64) return 7;
    return 9;
}

export class MediaProcessor {
    private tempDir: string;
    private ffmpegPath: string | null;
    private ffprobePath: string | null;
    private semaphore: Semaphore;
    private timeoutMs: number;
    private speedProfile: 'quality' | 'balanced' | 'speed';
    private hwProbePromise: Promise<HwProbeResult> | null = null;

    private _sharp: any = undefined;
    private _sharpLoaded = false;
    private _ffmpeg: any = undefined;
    private _ffmpegLoaded = false;

    constructor(options: MediaProcessorOptions = {}) {
        this.tempDir = options.tempDir ?? path.join(os.tmpdir(), 'upload-media-proc');
        const cpus = os.cpus().length;
        const maxConcurrency = options.maxConcurrency ?? Math.min(4, Math.max(1, cpus));
        this.ffmpegPath = resolveFfmpegPath(options.ffmpegPath);
        this.ffprobePath = resolveFfprobePath(options.ffprobePath, this.ffmpegPath);
        this.semaphore = new Semaphore(maxConcurrency);
        this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
        this.speedProfile = (options as any).speedProfile ?? 'balanced';
        fs.mkdirSync(this.tempDir, { recursive: true });

        if (this.ffmpegPath) {
            this.hwProbePromise = probeHardwareEncoder(this.ffmpegPath, null);
        }
    }

    private get sharp(): any {
        if (!this._sharpLoaded) { this._sharp = loadSharp(); this._sharpLoaded = true; }
        return this._sharp;
    }

    private get ffmpeg(): any {
        if (!this._ffmpegLoaded) {
            this._ffmpeg = loadFluentFfmpeg();
            this._ffmpegLoaded = true;
            if (this._ffmpeg && this.ffmpegPath) this._ffmpeg.setFfmpegPath(this.ffmpegPath);
            if (this._ffmpeg && this.ffprobePath) this._ffmpeg.setFfprobePath(this.ffprobePath);
        }
        return this._ffmpeg;
    }

    private get canProcessImages(): boolean { return this.sharp !== null; }
    private get canProcessMedia(): boolean { return this.ffmpeg !== null && this.ffmpegPath !== null; }
    
    getTempDir(): string { return this.tempDir; }

    // ── Image processing ──────────────────────────────────────────────────────

    async processImage(
        inputBuffer: Buffer | Uint8Array | ArrayBuffer,
        originalMimeType: string,
        config: ImageProcessingConfig,
    ): Promise<ProcessingResult> {
        const safeBuffer = ensureBuffer(inputBuffer);
        if (!this.canProcessImages) {
            console.warn('[MediaProcessor] Sharp not installed — returning original image.');
            return { buffer: safeBuffer, mimeType: originalMimeType, extension: inferImageFormat(originalMimeType) };
        }
        const qualityConfigs = config.qualityConfigs;
        if (qualityConfigs && qualityConfigs.length > 1) {
            const results = await Promise.all(
                qualityConfigs.map(async (qc) => ({
                    id: qc.id,
                    buffer: await this.processImageSingle(this.sharp, safeBuffer, originalMimeType, {
                        ...config, qualityConfig: qc,
                        quality: qc.quality ?? config.quality,
                        format: qc.format ?? config.format,
                    }),
                })),
            );
            const variants: Record<string, Buffer> = {};
            for (const r of results) variants[r.id] = r.buffer;
            const firstId = qualityConfigs[0].id;
            return {
                variants, buffer: variants[firstId],
                mimeType: resolveImageOutputMime(config.format ?? qualityConfigs[0].format, originalMimeType),
                extension: resolveImageOutputExt(config.format ?? qualityConfigs[0].format, originalMimeType),
            };
        }
        const buffer = await this.processImageSingle(this.sharp, safeBuffer, originalMimeType, config);
        return {
            buffer,
            mimeType: resolveImageOutputMime(config.format, originalMimeType),
            extension: resolveImageOutputExt(config.format, originalMimeType),
        };
    }

    private async processImageSingle(
        sharp: any, inputBuffer: Buffer, originalMimeType: string, config: ImageProcessingConfig,
    ): Promise<Buffer> {
        if (originalMimeType === 'image/gif') return inputBuffer;
        const dims = resolveImageDimensions(config.qualityConfig, config.quality);
        const quality = resolveImageQuality(config.qualityConfig, config.quality);
        const outputFormat = config.qualityConfig?.format ?? config.format ?? inferImageFormat(originalMimeType);
        let pipeline = sharp(inputBuffer);
        if (dims.width || dims.height) {
            pipeline = pipeline.resize(dims.width ?? null, dims.height ?? null, { fit: 'inside', withoutEnlargement: true });
        }
        switch (outputFormat) {
            case 'jpeg': case 'jpg': pipeline = pipeline.jpeg({ quality, progressive: true, mozjpeg: true }); break;
            case 'webp': pipeline = pipeline.webp({ quality, effort: 4 }); break;
            case 'png': pipeline = pipeline.png({ compressionLevel: Math.round((100 - quality) / 10) }); break;
            case 'avif': pipeline = pipeline.avif({ quality, effort: 4 }); break;
            default: pipeline = pipeline.jpeg({ quality, progressive: true }); break;
        }
        return await pipeline.toBuffer();
    }

    // ── Video processing ──────────────────────────────────────────────────────

    async processVideo(
        inputBuffer: Buffer | Uint8Array | ArrayBuffer,
        originalMimeType: string,
        originalFilename: string,
        config: VideoProcessingConfig,
    ): Promise<ProcessingResult> {
        const safeBuffer = ensureBuffer(inputBuffer);
        if (!this.canProcessMedia) {
            console.warn('[MediaProcessor] FFmpeg not available — returning original video.');
            return { buffer: safeBuffer, mimeType: originalMimeType, extension: path.extname(originalFilename).slice(1) || 'mp4' };
        }
        await this.semaphore.acquire();
        const tmp = new TempFileManager(this.tempDir);
        try {
            const inputExt = path.extname(originalFilename) || inferVideoExt(originalMimeType);
            const inputPath = tmp.create(inputExt, 'source');
            await fs.promises.writeFile(inputPath, safeBuffer);
            
            const generator = this.processVideoYieldingFromPath(inputPath, originalMimeType, originalFilename, config);
            const first = await generator.next();
            if (first.done || !first.value) {
                return { cleanupFn: async () => {} } as any;
            }
            
            return {
                mimeType: first.value.mimeType,
                extension: first.value.extension,
                thumbnail: first.value.thumbnail,
                variantPaths: { [first.value.id]: first.value.path },
                outputPath: first.value.path,
                generator,
                cleanupFn: async () => {},
            } as any;
        } finally {
            this.semaphore.release();
            // tmp.cleanup is delegated to the generator
        }
    }

    async *processVideoYieldingFromPath(
        inputPath: string,
        originalMimeType: string,
        originalFilename: string,
        config: VideoProcessingConfig,
    ): AsyncGenerator<ProcessedMediaVariant, void, unknown> {
        if (!this.canProcessMedia) {
            console.warn('[MediaProcessor] FFmpeg not available — returning passthrough.');
            yield {
                id: 'single',
                isPrimary: true,
                path: inputPath,
                mimeType: originalMimeType,
                extension: path.extname(originalFilename).slice(1) || 'mp4',
            };
            return;
        }

        await this.semaphore.acquire();
        const tmp = new TempFileManager(this.tempDir);
        let acquired = true;
        const releaseOnce = () => { if (acquired) { acquired = false; this.semaphore.release(); } };

        try {
            const generator = this._encodeVideoYieldingFromPath(inputPath, originalMimeType, originalFilename, config, tmp);
            for await (const variant of generator) {
                yield variant;
            }
        } finally {
            try { await tmp.cleanup(); } finally { releaseOnce(); }
        }
    }

    async processVideoFromPath(
        inputPath: string,
        originalMimeType: string,
        originalFilename: string,
        config: VideoProcessingConfig,
    ): Promise<ExtendedProcessingResult> {
        if (!this.canProcessMedia) {
            console.warn('[MediaProcessor] FFmpeg not available — returning passthrough.');
            return {
                outputPath: inputPath,
                mimeType: originalMimeType,
                extension: path.extname(originalFilename).slice(1) || 'mp4',
                cleanupFn: async () => { },
            };
        }

        await this.semaphore.acquire();
        const tmp = new TempFileManager(this.tempDir);
        let acquired = true;

        try {
            const result = await this._encodeVideoFromPath(
                inputPath, originalMimeType, originalFilename, config, tmp,
            );

            const releaseOnce = () => {
                if (acquired) { acquired = false; this.semaphore.release(); }
            };

            return {
                ...result,
                cleanupFn: async () => {
                    try { await tmp.cleanup(); } finally { releaseOnce(); }
                },
            };
        } catch (err) {
            acquired = false;
            this.semaphore.release();
            await tmp.cleanup().catch(() => { });
            throw err;
        }
    }

    private async _encodeVideoFromPath(
        inputPath: string,
        originalMimeType: string,
        originalFilename: string,
        config: VideoProcessingConfig,
        tmp: TempFileManager,
    ): Promise<ExtendedProcessingResult> {
        const generator = this._encodeVideoYieldingFromPath(inputPath, originalMimeType, originalFilename, config, tmp);
        const variants: Record<string, string> = {};
        let firstPath: string | undefined;
        let mimeType: string | undefined;
        let extension: string | undefined;

        for await (const variant of generator) {
            variants[variant.id] = variant.path;
            if (!firstPath) {
                firstPath = variant.path;
                mimeType = variant.mimeType;
                extension = variant.extension;
            }
        }

        return {
            outputPath: firstPath || '',
            variantPaths: variants,
            mimeType: mimeType || 'video/mp4',
            extension: extension || 'mp4',
        };
    }

    private async probeSourceBitrateKbps(inputPath: string): Promise<number | null> {
        if (!this.ffmpeg) return null;
        try {
            const metadata: any = await new Promise((resolve, reject) => {
                this.ffmpeg.ffprobe(inputPath, (err: Error, data: any) => {
                    if (err) reject(err); else resolve(data);
                });
            });
            // Prefer the video stream's own bit_rate; fall back to container-level.
            const videoStream = metadata?.streams?.find((s: any) => s.codec_type === 'video');
            const raw = videoStream?.bit_rate ?? metadata?.format?.bit_rate;
            const bps = raw != null ? parseInt(raw, 10) : NaN;
            if (isNaN(bps) || bps <= 0) return null;
            return bps / 1000; // bits/sec -> kbps
        } catch {
            return null;
        }
    }

    private async *_encodeVideoYieldingFromPath(
        inputPath: string,
        originalMimeType: string,
        originalFilename: string,
        config: VideoProcessingConfig,
        tmp: TempFileManager,
    ): AsyncGenerator<ProcessedMediaVariant, void, unknown> {
        const outputFormat = normaliseFormat(config.format ?? 'mp4');
        const outputMime = `video/${outputFormat}`;

        const sourceBitrateKbps = await this.probeSourceBitrateKbps(inputPath);

        const thumbnailPromise: Promise<Buffer | undefined> =
            config.generateThumbnail !== false
                ? this.generateVideoThumbnailBuffer(inputPath, config.thumbnailTimeSeconds, tmp, 'thumb')
                : Promise.resolve(undefined);

        if (config.qualityConfigs && config.qualityConfigs.length > 1) {
            const cpuCount = os.cpus().length || 2;
            const threadsPerProcess = Math.max(1, cpuCount);

            const primaryQc = config.qualityConfigs[0];
            const primaryPath = tmp.create(`.${outputFormat}`, primaryQc.id);
            await this.runFFmpegVideo(inputPath, primaryPath, outputFormat, config, primaryQc, threadsPerProcess, 1, sourceBitrateKbps);

            const thumbnail = await thumbnailPromise;

            yield {
                id: primaryQc.id,
                isPrimary: true,
                path: primaryPath,
                mimeType: outputMime,
                extension: outputFormat,
                thumbnail,
            };

            const remainingQcs = config.qualityConfigs.slice(1);
            if (remainingQcs.length > 0) {
                const parallelJobs = remainingQcs.map(async (qc) => {
                    const outputPath = tmp.create(`.${outputFormat}`, qc.id);
                    await this.runFFmpegVideo(inputPath, outputPath, outputFormat, config, qc, threadsPerProcess, remainingQcs.length, sourceBitrateKbps);
                    return {
                        id: qc.id,
                        isPrimary: false,
                        path: outputPath,
                        mimeType: outputMime,
                        extension: outputFormat,
                        thumbnail: undefined,
                    };
                });

                for (const job of parallelJobs) {
                    yield await job;
                }
            }
            return;
        }

        // Single quality
        const outputPath = tmp.create(`.${outputFormat}`, 'single');
        await this.runFFmpegVideo(inputPath, outputPath, outputFormat, config, undefined, undefined, 1, sourceBitrateKbps);
        const thumbnail = await thumbnailPromise;
        
        yield {
            id: 'single',
            isPrimary: true,
            path: outputPath,
            mimeType: outputMime,
            extension: outputFormat,
            thumbnail,
        };
    }

    private async runFFmpegVideo(
        inputPath: string,
        outputPath: string,
        format: string,
        config: VideoProcessingConfig,
        qc: QualityConfig | undefined,
        threadsPerProcess?: number,
        concurrentVariants: number = 1,
        sourceBitrateKbps: number | null = null,
    ): Promise<void> {
        let hwProbe: HwProbeResult = { encoder: null, extraArgs: [] };
        if (this.hwProbePromise) {
            try { hwProbe = await this.hwProbePromise; } catch { }
        }

        const requestedCodec = qc?.codec ?? config.codec ?? 'libx264';

        if (hwProbe.encoder && requestedCodec === 'libx264') {
            try {
                await this._executeFfmpegVideoCommand(
                    inputPath, outputPath, format, config, qc, hwProbe.encoder, undefined,
                    threadsPerProcess, concurrentVariants, sourceBitrateKbps,
                );
                return;
            } catch (err: any) {
                //console.warn(`[MediaProcessor] Hardware encoding (${hwProbe.encoder}) failed. Retrying with libx264... Error: ${err.message}`);
                await fs.promises.unlink(outputPath).catch(() => { });
            }
        }

        await this._executeFfmpegVideoCommand(
            inputPath, outputPath, format, config, qc, requestedCodec, [],
            threadsPerProcess, concurrentVariants, sourceBitrateKbps,
        );
    }

    private async _executeFfmpegVideoCommand(
        inputPath: string,
        outputPath: string,
        format: string,
        config: VideoProcessingConfig,
        qc: QualityConfig | undefined,
        actualCodec: string,
        extraCodecArgsInput: string[] | undefined,
        threadsPerProcess?: number,
        concurrentVariants: number = 1,
        sourceBitrateKbps: number | null = null,
    ): Promise<void> {

        return new Promise((resolve, reject) => {
            if (!this.ffmpeg) return reject(new Error('[MediaProcessor] fluent-ffmpeg is not installed.'));

            const q = resolveVideoQuality(qc, config.quality);
            const outputFormat = normaliseFormat(format);

            const isSoftwareX264 = actualCodec === 'libx264';

            const explicitPreset = (qc as any)?.preset;
            const preset = explicitPreset
                ?? resolveRuntimePreset(
                    q.preset ?? 'medium',
                    os.cpus().length || 2,
                    concurrentVariants,
                    this.speedProfile,
                );

            let videoBitrate = q.videoBitrate!;
            let maxBitrate = resolveMaxBitrate(qc, q.videoBitrate!);
            let bufsize = resolveBufsize(qc, q.videoBitrate!);

            let clampApplied = false;

            const ladderKbps = parseKbps(q.videoBitrate);
            if (ladderKbps != null) {
                const clamped = clampTierToSourceBitrate(qc?.resolution, ladderKbps, sourceBitrateKbps);
                if (clamped) {
                    videoBitrate = clamped.videoBitrate;
                    maxBitrate = clamped.maxBitrate;
                    bufsize = clamped.bufsize;
                    clampApplied = true;
                    /*                     console.log(
                                            `[MediaProcessor] ${qc?.id ?? 'single'}: source-bitrate-aware clamp ` +
                                            `${q.videoBitrate} -> ${videoBitrate} (source ~${Math.round(sourceBitrateKbps!)}k) ` +
                                            `— switching to ABR mode for a real size ceiling`,
                                        ); */
                }
            }

            let cmd = this.ffmpeg(inputPath)
                .addInputOptions(`-fflags +genpts`)
                .addInputOptions(`-analyzeduration 20M`)
                .addInputOptions(`-probesize 20M`);

            if (config.startTime != null && config.startTime > 0)
                cmd = cmd.inputOptions(`-ss ${config.startTime}`);
            if (config.endTime != null) {
                const dur = config.endTime - (config.startTime ?? 0);
                if (dur > 0) cmd = cmd.inputOptions(`-t ${dur}`);
            }

            cmd = cmd.videoCodec(actualCodec);

            if ((isSoftwareX264 || actualCodec === 'libx265') && !clampApplied) {
                cmd = cmd.addOutputOptions(`-crf ${q.crf}`);
            }
            if (isSoftwareX264 || actualCodec === 'libx265') {
                cmd = cmd.addOutputOptions(`-preset ${preset}`);
            }

            const isHwEncoder = extraCodecArgsInput === undefined;
            const extraCodecArgs: string[] = isHwEncoder
                ? (clampApplied
                    ? extraArgsForAbr(actualCodec as HwEncoder)
                    : extraArgsFor(actualCodec as HwEncoder))
                : extraCodecArgsInput;

            if (extraCodecArgs.length > 0) {
                for (const arg of extraCodecArgs) {
                    cmd = cmd.addOutputOptions(arg);
                }
            }

            cmd = cmd
                .addOutputOptions(`-b:v ${videoBitrate}`)
                .addOutputOptions(`-maxrate ${maxBitrate}`)
                .addOutputOptions(`-bufsize ${bufsize}`)
                .addOutputOptions(`-g 48`)
                .addOutputOptions(`-keyint_min 48`)
                .addOutputOptions(`-sc_threshold 0`)
                .addOutputOptions(`-movflags +faststart`);

            if (isSoftwareX264 && threadsPerProcess && threadsPerProcess > 0) {
                cmd = cmd.addOutputOptions(`-threads ${threadsPerProcess}`);
            }

            if (isSoftwareX264) {
                if (this.speedProfile === 'speed') {
                    cmd = cmd.addOutputOptions(`-x264-params bframes=0:rc-lookahead=10`);
                } else if (this.speedProfile === 'balanced') {
                    cmd = cmd.addOutputOptions(`-x264-params rc-lookahead=20`);
                }
            }

            const scaleFilter = buildScaleFilter(q.width, q.height);

            const hwPixFmtFilter = !isSoftwareX264 ? 'format=nv12' : null;

            if (config.mute) {
                cmd = cmd.noAudio();
                const vf = [scaleFilter, hwPixFmtFilter].filter(Boolean).join(',');
                if (vf) cmd = cmd.addOutputOptions(`-vf ${vf}`);
            } else {
                const audioBitrate = q.audioBitrate ?? '128k';
                const audioFilter = buildAudioFilterChain(audioBitrate);

                if (scaleFilter || hwPixFmtFilter) {
                    const videoChain = [scaleFilter, hwPixFmtFilter].filter(Boolean).join(',');
                    cmd = cmd.complexFilter(
                        `[0:v]${videoChain}[v];[0:a]${audioFilter}[a]`,
                        ['v', 'a'],
                    );
                } else {
                    cmd = cmd
                        .addOutputOptions(`-af ${audioFilter}`)
                        .addOutputOptions(`-vf copy`);
                }

                cmd = cmd
                    .audioCodec('aac')
                    .audioBitrate(audioBitrate)
                    .addOutputOptions(`-ar 48000`)
                    .addOutputOptions(`-ac 2`)
                    .addOutputOptions(`-profile:a aac_low`);
            }

            cmd = cmd.format(outputFormat).output(outputPath);

            let timer: NodeJS.Timeout | null = null;
            // Guard against fluent-ffmpeg's known double-fire of error+exit events.
            // Once the promise is settled, subsequent resolve/reject calls are no-ops.
            let settled = false;
            const safeResolve = () => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(); } };
            const safeReject = (err: Error) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); reject(err); } };

            if (this.timeoutMs > 0) {
                timer = setTimeout(() => {
                    try { cmd.kill('SIGKILL'); } catch { }
                    safeReject(new Error(
                        `[MediaProcessor] FFmpeg timed out after ${this.timeoutMs / 1000}s ` +
                        `encoding variant (crf=${q.crf}, preset=${preset}, ` +
                        `res=${q.width ?? '?'}x${q.height ?? '?'}).`,
                    ));
                }, this.timeoutMs);
            }

            cmd
                .on('progress', (progress: any) => {
                    if (config.onProgress) {
                        try { config.onProgress({ ...progress, variantId: qc?.id ?? 'single' }); } catch { }
                    }
                })
                .on('end', () => safeResolve())
                .on('error', (err: Error) => safeReject(err))
                .run();
        });
    }

    // ── Audio processing ──────────────────────────────────────────────────────

    async processAudio(
        inputBuffer: Buffer | Uint8Array | ArrayBuffer,
        originalMimeType: string,
        originalFilename: string,
        config: AudioProcessingConfig,
    ): Promise<ProcessingResult> {
        const safeBuffer = ensureBuffer(inputBuffer);
        if (!this.canProcessMedia) {
            console.warn('[MediaProcessor] FFmpeg not available — returning original audio.');
            return { buffer: safeBuffer, mimeType: originalMimeType, extension: path.extname(originalFilename).slice(1) || 'mp3' };
        }
        await this.semaphore.acquire();
        const tmp = new TempFileManager(this.tempDir);
        try {
            const inputExt = path.extname(originalFilename) || inferAudioExt(originalMimeType);
            const inputPath = tmp.create(inputExt, 'source');
            await fs.promises.writeFile(inputPath, safeBuffer);
            return await this._encodeAudioFromPath(inputPath, originalMimeType, config, tmp);
        } finally {
            await tmp.cleanup();
            this.semaphore.release();
        }
    }

    async *processAudioYieldingFromPath(
        inputPath: string,
        originalMimeType: string,
        originalFilename: string,
        config: AudioProcessingConfig,
    ): AsyncGenerator<ProcessedMediaVariant, void, unknown> {
        if (!this.canProcessMedia) {
            console.warn('[MediaProcessor] FFmpeg not available — returning passthrough.');
            yield {
                id: 'single', isPrimary: true, path: inputPath, mimeType: originalMimeType,
                extension: path.extname(originalFilename).slice(1) || 'mp3'
            };
            return;
        }
        await this.semaphore.acquire();
        const tmp = new TempFileManager(this.tempDir);
        let acquired = true;
        const releaseOnce = () => { if (acquired) { acquired = false; this.semaphore.release(); } };
        try {
            const result = await this._encodeAudioFromPath(inputPath, originalMimeType, config, tmp);
            yield {
                id: 'single', isPrimary: true, path: result.outputPath!, mimeType: result.mimeType, extension: result.extension
            };
        } finally {
            try { await tmp.cleanup(); } finally { releaseOnce(); }
        }
    }

    async processAudioFromPath(
        inputPath: string,
        originalMimeType: string,
        originalFilename: string,
        config: AudioProcessingConfig,
    ): Promise<ExtendedProcessingResult> {
        if (!this.canProcessMedia) {
            console.warn('[MediaProcessor] FFmpeg not available — returning passthrough.');
            return {
                outputPath: inputPath, mimeType: originalMimeType,
                extension: path.extname(originalFilename).slice(1) || 'mp3',
                cleanupFn: async () => { },
            };
        }
        await this.semaphore.acquire();
        const tmp = new TempFileManager(this.tempDir);
        let acquired = true;
        try {
            const result = await this._encodeAudioFromPath(inputPath, originalMimeType, config, tmp);
            const releaseOnce = () => { if (acquired) { acquired = false; this.semaphore.release(); } };
            return {
                ...result,
                cleanupFn: async () => { try { await tmp.cleanup(); } finally { releaseOnce(); } },
            };
        } catch (err) {
            acquired = false;
            this.semaphore.release();
            await tmp.cleanup().catch(() => { });
            throw err;
        }
    }

    private async _encodeAudioFromPath(
        inputPath: string, originalMimeType: string, config: AudioProcessingConfig, tmp: TempFileManager,
    ): Promise<ExtendedProcessingResult> {
        const outputFormat = normaliseFormat(config.format ?? 'mp3');
        const outputMime = inferAudioMime(outputFormat);

        if (config.qualityConfigs && config.qualityConfigs.length > 1) {
            const variantSpecs = config.qualityConfigs.map((qc) => ({
                qc,
                outputPath: tmp.create(`.${outputFormat}`, qc.id),
            }));

            await Promise.all(
                variantSpecs.map(({ qc, outputPath }) =>
                    this.runFFmpegAudio(inputPath, outputPath, outputFormat, {
                        ...config, qualityConfig: qc,
                        quality: qc.quality ?? config.quality,
                        audioBitrate: qc.audioBitrate ?? config.audioBitrate,
                    })
                )
            );

            const variantPaths: Record<string, string> = {};
            for (const { qc, outputPath } of variantSpecs) {
                variantPaths[qc.id] = outputPath;
            }

            const firstId = config.qualityConfigs[0].id;
            return {
                variants: {}, variantPaths,
                buffer: undefined, outputPath: variantPaths[firstId],
                mimeType: outputMime, extension: outputFormat,
            };
        }

        const outputPath = tmp.create(`.${outputFormat}`, 'single');
        await this.runFFmpegAudio(inputPath, outputPath, outputFormat, config);
        const buffer = await fs.promises.readFile(outputPath);
        return { buffer, outputPath, mimeType: outputMime, extension: outputFormat };
    }

    private runFFmpegAudio(
        inputPath: string, outputPath: string, format: string, config: AudioProcessingConfig,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.ffmpeg) return reject(new Error('[MediaProcessor] fluent-ffmpeg is not installed.'));

            const bitrate = resolveAudioBitrate(config.qualityConfig, config.quality);
            const outputFormat = normaliseFormat(format);

            const audioFilter = buildAudioFilterChain(bitrate);

            const codecMap: Record<string, string> = {
                mp3: 'libmp3lame', aac: 'aac', ogg: 'libvorbis',
                m4a: 'aac', wav: 'pcm_s16le', flac: 'flac',
            };

            let cmd = this.ffmpeg(inputPath)
                .addInputOptions(`-analyzeduration 10M`)
                .addInputOptions(`-probesize 10M`);

            if (config.startTime != null && config.startTime > 0)
                cmd = cmd.inputOptions(`-ss ${config.startTime}`);
            if (config.endTime != null) {
                const dur = config.endTime - (config.startTime ?? 0);
                if (dur > 0) cmd = cmd.inputOptions(`-t ${dur}`);
            }

            const audioCodec = codecMap[outputFormat] ?? 'libmp3lame';

            cmd = cmd
                .noVideo()
                .audioCodec(audioCodec)
                .addOutputOptions(`-af ${audioFilter}`)
                .addOutputOptions(`-ar 48000`)
                .addOutputOptions(`-ac 2`);

            if (audioCodec === 'libmp3lame') {
                const vbrQ = resolveVbrQuality(bitrate);
                cmd = cmd.addOutputOptions(`-q:a ${vbrQ}`);
            } else if (audioCodec === 'libvorbis') {
                const vbrQ = Math.max(0, Math.min(10, Math.round(parseInt(bitrate, 10) / 32)));
                cmd = cmd.addOutputOptions(`-q:a ${vbrQ}`);
            } else {
                cmd = cmd.audioBitrate(bitrate);
            }

            cmd = cmd.format(outputFormat).output(outputPath);

            let timer: NodeJS.Timeout | null = null;
            let settled = false;
            const safeResolve = () => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(); } };
            const safeReject = (err: Error) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); reject(err); } };

            if (this.timeoutMs > 0) {
                timer = setTimeout(() => {
                    try { cmd.kill('SIGKILL'); } catch { }
                    safeReject(new Error(`[MediaProcessor] FFmpeg audio timed out after ${this.timeoutMs / 1000}s`));
                }, this.timeoutMs);
            }

            cmd
                .on('end', () => safeResolve())
                .on('error', (err: Error) => safeReject(err))
                .run();
        });
    }

    // ── Thumbnail generation ──────────────────────────────────────────────────

    async generateVideoThumbnail(
        inputBuffer: Buffer | Uint8Array | ArrayBuffer, originalFilename: string, timeSeconds?: number,
    ): Promise<Buffer> {
        const safeBuffer = ensureBuffer(inputBuffer);
        if (!this.canProcessMedia) throw new Error('[MediaProcessor] FFmpeg not available for thumbnail generation');
        await this.semaphore.acquire();
        const tmp = new TempFileManager(this.tempDir);
        try {
            const inputPath = tmp.create(path.extname(originalFilename) || '.mp4', 'source');
            await fs.promises.writeFile(inputPath, safeBuffer);
            return await this.generateVideoThumbnailBuffer(inputPath, timeSeconds, tmp, 'thumb');
        } finally {
            await tmp.cleanup();
            this.semaphore.release();
        }
    }

    async generateVideoThumbnailFromPath(inputPath: string, timeSeconds?: number): Promise<Buffer> {
        if (!this.canProcessMedia) throw new Error('[MediaProcessor] FFmpeg not available for thumbnail generation');
        const tmp = new TempFileManager(this.tempDir);
        try {
            return await this.generateVideoThumbnailBuffer(inputPath, timeSeconds, tmp, 'thumb');
        } finally {
            await tmp.cleanup();
        }
    }

    private generateVideoThumbnailBuffer(
        inputPath: string, timeSeconds: number | undefined, tmp: TempFileManager, variantId: string = 'thumb',
    ): Promise<Buffer> {
        return new Promise(async (resolve, reject) => {
            if (!this.ffmpeg) return reject(new Error('[MediaProcessor] fluent-ffmpeg is not installed.'));

            let seekTime: number;
            if (timeSeconds != null && timeSeconds > 0) {
                seekTime = timeSeconds;
            } else {
                seekTime = 5;
                try {
                    const duration = await this.getVideoDuration(inputPath, this.ffmpeg);
                    if (duration > 0) seekTime = Math.max(0.1, duration * 0.1);
                } catch { }
            }

            const outputPath = tmp.create('.jpg', variantId);
            let settled = false;
            const timer = setTimeout(
                () => { if (!settled) { settled = true; reject(new Error('[MediaProcessor] Thumbnail timed out after 30s')); } }, 30_000,
            );

            this.ffmpeg(inputPath)
                .seekInput(seekTime)
                .frames(1)
                .videoFilters('scale=320:180:flags=fast_bilinear:force_original_aspect_ratio=decrease')
                .outputOptions([
                    '-q:v 4',
                    '-update 1',
                ])
                .output(outputPath)
                .on('end', async () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    try {
                        const raw = await fs.promises.readFile(outputPath);
                        resolve(this.sharp ? await this.sharp(raw).jpeg({ quality: 80, mozjpeg: true }).toBuffer() : raw);
                    } catch (err) { reject(err); }
                })
                .on('error', (err: Error) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } })
                .run();
        });
    }

    private getVideoDuration(inputPath: string, ffmpeg: any): Promise<number> {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(inputPath, (err: Error, metadata: any) => {
                if (err) return reject(err);
                resolve(metadata?.format?.duration ?? 0);
            });
        });
    }

    // ── Public helpers (used by UploadEngine) ─────────────────────────────────



    async writeTempFile(buffer: Buffer | Uint8Array | ArrayBuffer, ext: string): Promise<string> {
        const safeBuffer = ensureBuffer(buffer);
        const name = `upload_tmp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}${ext}`;
        const fullPath = path.join(this.tempDir, name);
        await fs.promises.writeFile(fullPath, safeBuffer);
        return fullPath;
    }

    async deleteTempFile(filePath: string): Promise<void> {
        try { if (fs.existsSync(filePath)) await fs.promises.unlink(filePath); } catch { }
    }
}

// ── MIME / extension helpers ──────────────────────────────────────────────────

function resolveImageOutputMime(format: string | undefined, original: string): string {
    const f = format ?? inferImageFormat(original);
    const map: Record<string, string> = {
        jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png',
        webp: 'image/webp', avif: 'image/avif', gif: 'image/gif',
    };
    return map[f] ?? original;
}

function resolveImageOutputExt(format: string | undefined, original: string): string {
    const f = format ?? inferImageFormat(original);
    return f === 'jpeg' ? 'jpg' : f;
}

function inferImageFormat(mimeType: string): string {
    if (mimeType.includes('png')) return 'png';
    if (mimeType.includes('webp')) return 'webp';
    if (mimeType.includes('avif')) return 'avif';
    if (mimeType.includes('gif')) return 'gif';
    return 'jpeg';
}

function inferVideoExt(mimeType: string): string {
    if (mimeType.includes('webm')) return '.webm';
    if (mimeType.includes('quicktime')) return '.mov';
    if (mimeType.includes('x-msvideo')) return '.avi';
    if (mimeType.includes('x-matroska')) return '.mkv';
    return '.mp4';
}

function inferAudioExt(mimeType: string): string {
    if (mimeType.includes('wav')) return '.wav';
    if (mimeType.includes('ogg')) return '.ogg';
    if (mimeType.includes('aac')) return '.aac';
    if (mimeType.includes('flac')) return '.flac';
    if (mimeType.includes('mp4') || mimeType.includes('m4a')) return '.m4a';
    return '.mp3';
}

function inferAudioMime(format: string): string {
    const map: Record<string, string> = {
        mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
        aac: 'audio/aac', flac: 'audio/flac', m4a: 'audio/mp4',
    };
    return map[format] ?? 'audio/mpeg';
}