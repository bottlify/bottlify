/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The wide tier's build pass (`scripts/ram-memory.mjs`) on a module made here:
 * calls of the imports of `ram` become accesses of a second memory, the
 * imports go and the functions after them keep working under their new
 * numbers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRamMemory } from '../scripts/ram-memory.mjs';
import { Body, ModuleBuilder, ValType } from './wasm/encoder.js';
import { memory64 } from './wasm/features.js';
import { withSharedMemoryImport } from './wasm/shared-import.js';
import { allowMemory64, ifRoom } from './testing/memory64.js';

const I64_ADD = 0x7c;

/**
 * A module as the linker leaves the tier: its own memory, imports of `ram`
 * among the others, and a function that goes through each -- `go(a)` stores
 * 0x11223344 at `a` of the RAM, notes what it loads back there and what its own
 * memory holds at 64, copies those four bytes eight on and fills four more
 * with 0x5a past them.
 */
function linked(){
    const m = new ModuleBuilder();
    const note = m.type({ params: [ValType.i32], results: [] });
    const load = m.type({ params: [ValType.i64], results: [ValType.i32] });
    const store = m.type({ params: [ValType.i64, ValType.i32], results: [] });
    const copy = m.type({ params: [ValType.i64, ValType.i64, ValType.i64], results: [] });
    const fill = m.type({ params: [ValType.i64, ValType.i32, ValType.i64], results: [] });
    m.importMemory('env', 'memory', { min: 1 });
    const load32 = m.importFunction('ram', 'load32', load);
    const first = m.importFunction('env', 'first', note);
    const store32 = m.importFunction('ram', 'store32', store);
    const ramCopy = m.importFunction('ram', 'copy', copy);
    const ramFill = m.importFunction('ram', 'fill', fill);
    const second = m.importFunction('env', 'second', note);
    const go = m.type({ params: [ValType.i64], results: [] });
    m.function(go, [], new Body()
        .localGet(0).i32const(0x11223344).call(store32)
        .localGet(0).call(load32).call(first)
        .i32const(64).load('i32', { offset: 0 }).call(second)
        .localGet(0).i64const(8n).op(I64_ADD).localGet(0).i64const(4n).call(ramCopy)
        .localGet(0).i64const(12n).op(I64_ADD).i32const(0x5a).i64const(4n).call(ramFill)
        .toBytes(), { exportAs: 'go' });
    return m.toBytes();
}

/** @param {boolean} shared */
function ran(shared){
    allowMemory64();
    const bytes = withRamMemory(linked());
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared });
    const ram = memory64(2 ** 33, shared);
    new DataView(memory.buffer).setUint32(64, 0xfeedf00d, true);
    /** @type {number[]} */
    const noted = [];
    const module = new WebAssembly.Module(/** @type {Uint8Array<ArrayBuffer>} */ (
        shared ? withSharedMemoryImport(bytes) : bytes));
    assert.deepEqual(WebAssembly.Module.imports(module).map(one=>`${one.module}.${one.name}`),
        ['env.memory', 'env.ram', 'env.first', 'env.second']);
    const { go } = /** @type {any} */ (new WebAssembly.Instance(module, { env: { memory, ram,
        first: (/** @type {number} */ value)=>noted.push(value >>> 0),
        second: (/** @type {number} */ value)=>noted.push(value >>> 0) } }).exports);
    // Past 4 GiB: an address is the quadword whole.
    go(0x100010010n);
    assert.deepEqual(noted, [0x11223344, 0xfeedf00d]);
    const written = new Uint8Array(ram.buffer).slice(0x100010010, 0x100010020);
    assert.equal(Buffer.from(written).toString('hex'), '4433221100000000443322115a5a5a5a');
    assert.equal(new DataView(memory.buffer).getUint32(0x10, true), 0, 'its own memory untouched');
}

test('calls of ram\'s imports become accesses of the second memory, the rest renumbered',
    ifRoom(()=>ran(false)));

test('both memories declared shared link to shared ones', ifRoom(()=>ran(true)));

test('a module that imports nothing from ram, or an import the pass has no instruction for,'
    + ' is refused', ()=>{
    const none = new ModuleBuilder();
    none.importMemory('env', 'memory', { min: 1 });
    none.function(none.type({ params: [], results: [] }), [], new Body().toBytes());
    assert.throws(()=>withRamMemory(none.toBytes()), /imports nothing from ram/);
    const other = new ModuleBuilder();
    other.importMemory('env', 'memory', { min: 1 });
    other.importFunction('ram', 'swap', other.type({ params: [], results: [] }));
    assert.throws(()=>withRamMemory(other.toBytes()), /no instruction for ram\.swap/);
});
