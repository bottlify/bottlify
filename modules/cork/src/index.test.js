/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from './index.js';
import { Tables, ownLayout, pagesFor } from './runtime/layout.js';

test('the engine factory answers a runtime with every name of the contract', ()=>{
    const layout = ownLayout({ ramSize: 1 << 20 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
    const runtime = createEngine({
        memory, layout, config: {}, read: ()=>0xf4,
        imports: { trap: ()=>0, getEflags: ()=>0, x87Read: ()=>0, rdtsc: ()=>0n },
    });
    for (const name of ['entryOf', 'run', 'noteHot', 'translatePending', 'invalidatePage',
        'diagnostics'])
    {
        assert.equal(typeof runtime[/** @type {keyof typeof runtime} */ (name)], 'function', name);
    }
    assert.equal(runtime.entryOf(0x1000), -1);
    assert.equal(runtime.diagnostics().regions, 0);
});

test('the package resolves by name and exposes its building blocks', async()=>{
    // The core loads this package by URL and a 64-bit engine is meant to
    // reuse the pieces exported here, so the names in `exports` are a
    // contract: a subpath that stops resolving breaks a consumer, not a test.
    const root = await import('@bottlify/cork');
    assert.equal(root.createEngine, createEngine);
    const wasm = await import('@bottlify/cork/wasm');
    assert.equal(typeof wasm.ModuleBuilder, 'function');
    const runtime = await import('@bottlify/cork/runtime');
    assert.equal(typeof runtime.createCorkRuntime, 'function');
});
