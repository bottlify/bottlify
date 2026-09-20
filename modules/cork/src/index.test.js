/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from './index.js';

test('the engine factory exists and refuses until the runtime is built', ()=>{
    assert.equal(typeof createEngine, 'function');
    assert.throws(()=>createEngine(/** @type {any} */ ({})), { message: 'cork: not built yet' });
});

test('the package resolves by name and exposes its building blocks', async()=>{
    // The core loads this package by URL and a 64-bit engine is meant to
    // reuse the pieces exported here, so the names in `exports` are a
    // contract: a subpath that stops resolving breaks a consumer, not a test.
    const root = await import('@bottlify/cork');
    assert.equal(root.createEngine, createEngine);
    const wasm = await import('@bottlify/cork/wasm');
    assert.equal(typeof wasm.ModuleBuilder, 'function');
    // A name the type checker cannot resolve yet, held in a variable so it
    // does not try: the file arrives with the runtime step.
    const runtime = '@bottlify/cork/runtime';
    await assert.rejects(import(runtime), (/** @type {any} */ e)=>{
        // Not built yet: the file is missing, which is the one failure
        // allowed here. A misspelt `exports` entry fails differently
        // (ERR_PACKAGE_PATH_NOT_EXPORTED), and that is what this pins.
        assert.equal(e.code, 'ERR_MODULE_NOT_FOUND', e.message);
        return true;
    });
});
