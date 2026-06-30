import { defineConfig } from 'tsup';

export default defineConfig([
  // Main bundle (framework agnostic)
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    outDir: 'dist',
    platform: 'browser',
    target: 'es2020',
    external: [
      '@ffmpeg/ffmpeg',
      '@ffmpeg/util',
      '@ffmpeg/core',
    ],
    esbuildOptions(options) {
      options.define = {
        ...options.define,
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      };
    },
  },
  // React bundle
  {
    entry: ['src/react/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    outDir: 'dist/react',
    platform: 'browser',
    target: 'es2020',
    external: [
      'react',
      'react-dom',
      'zustand',
      '@ffmpeg/ffmpeg',
      '@ffmpeg/util',
      '@ffmpeg/core',
    ],
    esbuildOptions(options) {
      options.define = {
        ...options.define,
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      };
    },
  },
  // Worker bundle
  {
    entry: ['src/worker/upload.worker.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    outDir: 'dist/worker',
    platform: 'browser',
    target: 'es2020',
    external: [
      '@ffmpeg/ffmpeg',
      '@ffmpeg/util',
      '@ffmpeg/core',
    ],
  },
]);