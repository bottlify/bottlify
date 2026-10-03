/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The publish gate with the prebuilt binaries optional: a `dist/` that leaves
 * out the video decoder passes; when a binary is present it is still held to a
 * size floor, and a missing file the package actually promises still fails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageProblems } from './check-package.mjs';

const manifest = {
    exports: {
        '.': './dist/core.js',
        './engine.worker.js': './dist/engine.worker.js',
        './worklet.js': './dist/worklet.js',
        './video-decoder.wasm': './dist/vendor/video-decoder.wasm',
        './package.json': './package.json',
    },
};

/** The files every build has, without any optional vendor binary. */
const core = [
    { path: 'dist/core.js', size: 4096 },
    { path: 'dist/engine.worker.js', size: 4096 },
    { path: 'dist/worklet.js', size: 4096 },
    { path: 'dist/vendor/manifest.json', size: 64 },
    { path: 'dist/cork/index.js', size: 4096 },
    { path: 'dist/cork/translator.worker.js', size: 4096 },
    { path: 'package.json', size: 64 },
    { path: 'LICENSE', size: 64 },
    { path: 'THIRD-PARTY-NOTICES.md', size: 64 },
];

test('a dist without the optional binaries passes', ()=>{
    assert.deepEqual(packageProblems(core, manifest), []);
});

test('a binary present is held to the size floor', ()=>{
    const files = [...core, { path: 'dist/vendor/video-decoder.wasm', size: 1024 }];
    const problems = packageProblems(files, manifest);
    assert.ok(problems.some(problem=>problem.includes('dist/vendor/video-decoder.wasm')),
        JSON.stringify(problems));
});

test('a full-size binary passes', ()=>{
    const files = [...core, { path: 'dist/vendor/video-decoder.wasm', size: 300 * 1024 }];
    assert.deepEqual(packageProblems(files, manifest), []);
});

test('a file the package promises and is not optional still fails', ()=>{
    const files = core.filter(file=>file.path !== 'dist/worklet.js');
    const problems = packageProblems(files, manifest);
    assert.ok(problems.some(problem=>problem.includes('dist/worklet.js')),
        JSON.stringify(problems));
});

test('a package without its translator fails', ()=>{
    const files = core.filter(file=>!file.path.startsWith('dist/cork/'));
    const problems = packageProblems(files, manifest);
    assert.ok(problems.some(problem=>problem.includes('dist/cork/index.js')),
        JSON.stringify(problems));
});
