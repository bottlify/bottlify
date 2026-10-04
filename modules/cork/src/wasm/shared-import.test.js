/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Body, ModuleBuilder, ValType } from './encoder.js';
import { SHARED_MAX_PAGES, withSharedMemoryImport } from './shared-import.js';

/**
 * A module importing a function, a global, a table and a memory, the memory
 * last, with a function that stores through it and calls the import.
 */
function built(){
    const m = new ModuleBuilder();
    const unary = m.type({ params: [ValType.i32], results: [] });
    const imported = m.importFunction('env', 'note', unary);
    m.importGlobal('env', 'base', ValType.i32, false);
    m.importTable('env', 'table', 4);
    m.importMemory('env', 'memory', { min: 1 });
    const store = m.type({ params: [ValType.i32, ValType.i32], results: [] });
    m.function(store, [], new Body().localGet(0).localGet(1).store('i32', { offset: 0 })
        .localGet(1).call(imported).toBytes(), { exportAs: 'store' });
    return m.toBytes();
}

test('a module whose memory import is rewritten links to a shared memory and writes it', ()=>{
    const bytes = built();
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const env = {
        memory,
        note: (/** @type {number} */ value)=>noted.push(value),
        base: 0,
        table: new WebAssembly.Table({ initial: 4, element: 'anyfunc' }),
    };
    /** @type {number[]} */
    const noted = [];
    assert.throws(()=>new WebAssembly.Instance(new WebAssembly.Module(bytes), { env }),
        /shared/, 'declared unshared, it does not link');
    const rewritten = withSharedMemoryImport(bytes);
    const { store } = /** @type {any} */ (new WebAssembly.Instance(
        new WebAssembly.Module(/** @type {Uint8Array<ArrayBuffer>} */ (rewritten)), { env })
        .exports);
    store(0x40, 0x12345678);
    assert.equal(new DataView(memory.buffer).getUint32(0x40, true), 0x12345678);
    assert.deepEqual(noted, [0x12345678], 'the other imports kept');
    assert.ok(SHARED_MAX_PAGES === 65536);
});

test('a module that imports no memory is left as it was', ()=>{
    const m = new ModuleBuilder();
    const type = m.type({ params: [], results: [ValType.i32] });
    m.function(type, [], new Body().i32const(7).toBytes(), { exportAs: 'seven' });
    const bytes = m.toBytes();
    assert.deepEqual([...withSharedMemoryImport(bytes)], [...bytes]);
});
