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

test('a module with a section of megabytes is rewritten, as the interpreter tier\'s code is', ()=>{
    const bytes = built();
    // A custom section of eight megabytes after the others: a section too
    // large to pass as arguments, which a worker's stack is smaller for.
    const payload = 8 << 20;
    const name = [...new TextEncoder().encode('padding')];
    /** @param {number} value */
    const leb = value=>{
        const out = [(value & 0x7f) | (value >= 0x80 ? 0x80 : 0)];
        for (value = Math.floor(value / 128); value > 0; value = Math.floor(value / 128))
        {
            out.push((value & 0x7f) | (value >= 0x80 ? 0x80 : 0));
        }
        return out;
    };
    const body = [...leb(name.length), ...name];
    const head = [0, ...leb(body.length + payload), ...body];
    const big = new Uint8Array(bytes.length + head.length + payload);
    big.set(bytes);
    big.set(head, bytes.length);
    big.fill(0xab, bytes.length + head.length);
    const rewritten = withSharedMemoryImport(big);
    assert.equal(rewritten.length - big.length, withSharedMemoryImport(bytes).length - bytes.length,
        'the import section changed as in the small module, nothing else');
    assert.equal(rewritten[rewritten.length - 1], 0xab, 'the section after it copied whole');
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const instance = new WebAssembly.Instance(
        new WebAssembly.Module(/** @type {Uint8Array<ArrayBuffer>} */ (rewritten)),
        { env: { memory, note: ()=>{}, base: 0,
            table: new WebAssembly.Table({ initial: 4, element: 'anyfunc' }) } });
    /** @type {any} */ (instance.exports).store(0x10, 7);
    assert.equal(new DataView(memory.buffer).getUint32(0x10, true), 7);
});
