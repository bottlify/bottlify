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
import { closureProblems, packageProblems, sourceClosure } from './check-package.mjs';

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

test('a source entry needs every module it imports packed, and no type a comment names', ()=>{
    const sources = {
        'src/entry.js': [
            '/** @param {import(\'./types.js\').T} t */',
            "import { a } from './a.js';",
            "export { b } from './dir/b.js';",
            "const later = ()=>import('./lazy.js');",
        ].join('\n'),
        // A worker started beside itself is a module of the package too.
        'src/a.js': "import './side.js';\nnew Worker(new URL('./a.worker.js', import.meta.url));",
        'src/dir/b.js': "import { c } from '../c.js';",
        'src/side.js': '', 'src/c.js': '', 'src/lazy.js': '', 'src/a.worker.js': '',
    };
    /** @param {string} path */
    const read = path=>/** @type {Record<string, string>} */ (sources)[path];
    assert.deepEqual(sourceClosure(['src/entry.js'], read), ['src/a.js', 'src/a.worker.js',
        'src/c.js', 'src/dir/b.js', 'src/entry.js', 'src/lazy.js', 'src/side.js']);
    const entry = { exports: { '.': './dist/core.js', './entry': './src/entry.js' } };
    const files = ['src/entry.js', 'src/a.js', 'src/a.worker.js', 'src/side.js', 'src/dir/b.js',
        'src/lazy.js'].map(path=>({ path }));
    assert.deepEqual(closureProblems(files, entry, read),
        ['src/c.js: imported by a source entry, not in the tarball']);
});
