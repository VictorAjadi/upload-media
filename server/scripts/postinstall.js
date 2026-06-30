#!/usr/bin/env node

const { execSync } = require('child_process');
const os = require('os');

console.log('\n📦 upload-media-server: Dependencies check...\n');

// Check Sharp
try {
    require.resolve('sharp');
    console.log('✅ Sharp - image processing enabled');
} catch {
    console.log('⚠️  Sharp not found - npm install sharp');
}

// Check fluent-ffmpeg
try {
    require.resolve('fluent-ffmpeg');
    console.log('✅ fluent-ffmpeg - video/audio processing available');
} catch {
    console.log('⚠️  fluent-ffmpeg not found - npm install fluent-ffmpeg');
}

// Check FFmpeg binary (from @ffmpeg-installer/ffmpeg or system)
let ffmpegFound = false;
try {
    const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
    if (ffmpegPath) {
        ffmpegFound = true;
        console.log('✅ FFmpeg binary - video/audio processing enabled');
    }
} catch {
    try {
        execSync('ffmpeg -version', { stdio: 'ignore' });
        ffmpegFound = true;
        console.log('✅ FFmpeg found in system PATH');
    } catch {
        console.log('⚠️  FFmpeg not found');
    }
}

if (!ffmpegFound) {
    console.log('   Options:');
    console.log('   - npm install @ffmpeg-installer/ffmpeg');
    if (os.platform() === 'win32') {
        console.log('   - winget install ffmpeg');
    } else if (os.platform() === 'darwin') {
        console.log('   - brew install ffmpeg');
    } else {
        console.log('   - sudo apt install ffmpeg');
    }
}

console.log('\n✅ upload-media-server ready!\n');