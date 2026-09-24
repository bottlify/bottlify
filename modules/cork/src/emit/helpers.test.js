/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shared helper module: the five functions once, imported by every region
 * module rather than copied into each. Its signatures are what a region
 * module imports, so a mismatch is a link error at the first instantiation,
 * which every other emitter test would hit; this fixes the contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHelpersModule, HELPER_NAMES } from './helpers.js';
import { ownLayout, Tables, pagesFor } from '../runtime/layout.js';
import { createTestMachine } from '../testing/machine.js';

const layout = ownLayout({ ramSize: 1 << 20 });

test('the shared helpers module exports the five functions', ()=>{
    const bytes = buildHelpersModule(layout);
    const module = new WebAssembly.Module(/** @type {Uint8Array<ArrayBuffer>} */ (bytes));
    const names = WebAssembly.Module.exports(module).filter(one=>one.kind === 'function')
        .map(one=>one.name);
    assert.deepEqual(names, [...HELPER_NAMES]);
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
    const exports = /** @type {Record<string, Function>} */ (
        new WebAssembly.Instance(module, { env: { memory } }).exports);
    assert.equal(exports.materialise.length, 6, 'six flag parts in, the word out');
    assert.equal(exports.f80ToF64.length, 1, 'a wasm address in, an f64 out');
    assert.equal(exports.f64ToF80.length, 2, 'a value and an address in');
    assert.equal(exports.round.length, 2, 'a value and the control word in');
    assert.equal(exports.codeHit.length, 1, 'a store address in, the hit out');
});

test('a region module imports the helpers instead of defining them', ()=>{
    // A straight-line region's module defines one function of its own (the
    // region); the five helper bodies its neighbours used to carry are
    // imports now, so the module stays a few hundred bytes however small the
    // region is -- it was 3 745 B with the copies in it.
    const machine = createTestMachine();
    machine.write(0x1000, [0x40, 0xf4]); // inc eax; hlt
    const { bytes } = machine.translate(0x1000);
    assert.ok(bytes.length < 1000,
        `a two-instruction region's module is ${bytes.length} B`);
});
