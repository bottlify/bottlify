/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VIRTUAL_MEMORY, accessibleSpan, createProcessMemory } from './process-memory.js';
import { VIRTUAL_READ, VIRTUAL_WRITE } from './cross-process.js';

const SELF = 0xffffffff;
const STATUS_PARTIAL_COPY = 0x8000000d;
const ERROR_PARTIAL_COPY = 299;
const ERROR_NOACCESS = 998;
const MEM_COMMIT = 0x1000;
const PAGE_NOACCESS = 0x01;
const PAGE_READONLY = 0x02;
const PAGE_READWRITE = 0x04;
const PAGE_EXECUTE_READ = 0x20;
const PAGE_GUARD = 0x100;

/**
 * A process of eight pages, each with the protection given (committed unless
 * 0), its bytes, the errors it was left and what was written through the
 * patcher.
 *
 * @param {number[]} protections
 */
function processOf(protections){
    const bytes = new Uint8Array(protections.length * 0x1000);
    /** @type {number[]} */
    const errors = [];
    /** @type {number[]} */
    const patched = [];
    const memory = createProcessMemory({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        patchMemory: (address, data)=>{
            patched.push(address);
            bytes.set(data, address);
            return true;
        },
        pageState: address=>{
            const protect = protections[Math.floor(address / 0x1000)] ?? 0;
            return { state: protect === 0 ? 0x10000 : MEM_COMMIT, protect,
                end: address - address % 0x1000 + 0x1000 };
        },
        processTarget: handle=>(handle === SELF ? { here: true } : { error: 6 }),
        setLastError: code=>errors.push(code),
    });
    const view = new DataView(bytes.buffer);
    return { memory, bytes, errors, patched, view, native: /** @type {any} */ (memory)[VIRTUAL_MEMORY] };
}

test('a page not committed, inaccessible or guarded ends what can be read, a read-only one writes',
    ()=>{
        /** @param {number} page */
        const state = page=>[
            { state: MEM_COMMIT, protect: PAGE_READWRITE },
            { state: MEM_COMMIT, protect: PAGE_READONLY },
            { state: MEM_COMMIT, protect: PAGE_READWRITE | PAGE_GUARD },
            { state: MEM_COMMIT, protect: PAGE_NOACCESS },
        ][page / 0x1000] ?? { state: 0x2000, protect: 0 };
        assert.equal(accessibleSpan(state, 0x800, 0x3000, false), 0x1800);
        assert.equal(accessibleSpan(state, 0x800, 0x3000, true), 0x800);
        assert.equal(accessibleSpan(state, 0x100, 0x10, false), 0x10);
        assert.equal(accessibleSpan(state, 0x3000, 4, false), 0, 'PAGE_NOACCESS');
        assert.equal(accessibleSpan(state, 0x4000, 4, false), 0, 'reserved only');
    });

test('a read stops where the source or the destination refuses, and says how far it got', ()=>{
    // Wine's virtual.c test_VirtualAllocEx: a destination two of whose pages
    // are inaccessible from 0x2000 takes 0x2000 bytes, STATUS_PARTIAL_COPY.
    const { memory, native, bytes, view, errors } = processOf([
        PAGE_READWRITE, PAGE_READWRITE, PAGE_READWRITE, PAGE_READWRITE,
        PAGE_READWRITE, PAGE_READWRITE, PAGE_NOACCESS, PAGE_NOACCESS, PAGE_READWRITE]);
    bytes.fill(7, 0, 0x4000);
    assert.equal(native.read([SELF, 0, 0x4000, 0x4000, 0x8000]), STATUS_PARTIAL_COPY);
    assert.equal(view.getUint32(0x8000, true), 0x2000);
    assert.equal(bytes[0x5fff], 7);
    assert.equal(bytes[0x6000], 0, 'nothing past the inaccessible page');

    view.setUint32(0x8000, 0xdeadbeef, true);
    assert.equal(memory.ReadProcessMemory.handler([SELF, 0x5000, 0, 0x2000, 0x8000]), 0);
    assert.equal(errors.at(-1), ERROR_PARTIAL_COPY);
    assert.equal(view.getUint32(0x8000, true), 0x1000, 'the count, failed or not');

    assert.equal(memory.ReadProcessMemory.handler([SELF, 0, 0x4000, 0, 0x8000]), 1, 'nothing');
    assert.equal(view.getUint32(0x8000, true), 0);

    view.setUint32(0x8000, 0xdeadbeef, true);
    assert.equal(memory.ReadProcessMemory.handler([0x44, 0, 0x4000, 4, 0x8000]), 0);
    assert.equal(errors.at(-1), 6, 'ERROR_INVALID_HANDLE');
    assert.equal(view.getUint32(0x8000, true), 0, 'a refused read counts nothing');
});

test('a write goes to the first page it cannot write; a source short of its count writes none',
    ()=>{
        const { memory, native, bytes, view, errors } = processOf([
            PAGE_READWRITE, PAGE_NOACCESS, PAGE_READWRITE, PAGE_READWRITE, PAGE_READWRITE]);
        bytes.fill(9, 0, 0x1000);
        view.setUint32(0x4000, 0xdeadbeef, true);
        assert.equal(native.write([SELF, 0x2000, 0, 0x2000, 0x4000]), STATUS_PARTIAL_COPY);
        assert.equal(view.getUint32(0x4000, true), 0);
        assert.equal(bytes[0x2000], 0);
        assert.equal(memory.WriteProcessMemory.handler([SELF, 0x2000, 0, 0x2000, 0x4000]), 0);
        assert.equal(errors.at(-1), ERROR_PARTIAL_COPY);
        assert.equal(view.getUint32(0x4000, true), 0);

        // virtual.c: a target writable for its first pages takes those, counted.
        assert.equal(native.write([SELF, 0x800, 0x2000, 0x1000, 0x4000]), STATUS_PARTIAL_COPY);
        assert.equal(view.getUint32(0x4000, true), 0x800);
        assert.equal(memory.WriteProcessMemory.handler([SELF, 0x800, 0x2000, 0x1000, 0x4000]), 0);
        assert.equal(view.getUint32(0x4000, true), 0x800, 'WriteProcessMemory counts it too');
    });

test('WriteProcessMemory writes over code that only executes; read-only memory is refused', ()=>{
    // virtual.c: PAGE_READONLY is ERROR_NOACCESS with the count untouched,
    // PAGE_EXECUTE_READ is written; NtWriteVirtualMemory writes neither.
    const { memory, native, bytes, view, errors, patched } = processOf([
        PAGE_READWRITE, PAGE_READONLY, PAGE_EXECUTE_READ, PAGE_READWRITE]);
    bytes.fill(5, 0, 0x10);
    view.setUint32(0x3000, 0xdeadbeef, true);
    assert.equal(memory.WriteProcessMemory.handler([SELF, 0x1000, 0, 0x10, 0x3000]), 0);
    assert.equal(errors.at(-1), ERROR_NOACCESS);
    assert.equal(view.getUint32(0x3000, true), 0xdeadbeef, 'the count left as it was');
    assert.equal(native.write([SELF, 0x1000, 0, 0x10, 0x3000]), STATUS_PARTIAL_COPY);
    assert.equal(view.getUint32(0x3000, true), 0);

    assert.equal(memory.WriteProcessMemory.handler([SELF, 0x2000, 0, 0x10, 0x3000]), 1);
    assert.equal(view.getUint32(0x3000, true), 0x10);
    assert.equal(bytes[0x200f], 5);
    assert.deepEqual(patched, [0x2000], 'through the patcher, which lifts the protection');
    assert.equal(native.write([SELF, 0x2004, 0, 0x10, 0x3000]), STATUS_PARTIAL_COPY);

    assert.equal(memory.WriteProcessMemory.handler([SELF, 0x1000, 0, 0, 0x3000]), 1,
        'nothing to write is written, whatever the protection');
    assert.equal(view.getUint32(0x3000, true), 0);
});

test('a child\'s memory is copied in the child, no more than the caller can take', async()=>{
    /** @type {any[]} */
    const asked = [];
    const bytes = new Uint8Array(0x3000);
    const view = new DataView(bytes.buffer);
    const caller = {};
    const memory = /** @type {any} */ (createProcessMemory({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        pageState: address=>({ state: MEM_COMMIT,
            protect: address >= 0x1000 && address < 0x2000 ? PAGE_NOACCESS : PAGE_READWRITE }),
        processTarget: ()=>({ child: { id: 8 } }),
        setLastError: ()=>{},
        currentThread: ()=>caller,
        setLastErrorFor: ()=>{},
        askChild: (record, call)=>{
            asked.push(call);
            const room = /** @type {number} */ (call.args[2]);
            return Promise.resolve(call.call === VIRTUAL_READ
                ? { result: 0, error: null, outs: [null, new Uint8Array(room).fill(3),
                    null, new Uint8Array([room, 0, 0, 0])] }
                : { result: 0, error: null, outs: [null, null, null, null, null,
                    new Uint8Array([0x10, 0, 0, 0])] });
        },
    }));
    // Asked for no more than the caller's buffer takes before its
    // inaccessible page: 0x10 of 0x20.
    assert.equal(await memory[VIRTUAL_MEMORY].read([0x44, 0x7000, 0xff0, 0x20, 0x2100]),
        STATUS_PARTIAL_COPY);
    assert.deepEqual(asked[0], { call: VIRTUAL_READ, args: [0x7000, { out: 0x10 }, 0x10,
        { out: 4 }] });
    assert.equal(view.getUint32(0x2100, true), 0x10);
    assert.equal(bytes[0xfff], 3);

    bytes.fill(4, 0x2200, 0x2210);
    assert.equal(await memory.WriteProcessMemory.handler([0x44, 0x7000, 0x2200, 0x10, 0x2100]), 1);
    assert.equal(asked[1].call, VIRTUAL_WRITE);
    assert.deepEqual(asked[1].args.slice(2), [0x10, 0x10, 1, { out: 4 }]);
    assert.deepEqual([...asked[1].args[1].in], new Array(0x10).fill(4));
    assert.equal(view.getUint32(0x2100, true), 0x10);
});

test('the child answers its own copies over its own pages', ()=>{
    const { native, bytes, view } = processOf([PAGE_READWRITE, PAGE_READONLY]);
    const { [VIRTUAL_READ]: read, [VIRTUAL_WRITE]: write } = native.served;
    bytes.fill(6, 0, 4);
    assert.equal(read.handler([0, 0x800, 4, 0x900]), 0);
    assert.deepEqual([...bytes.subarray(0x800, 0x804)], [6, 6, 6, 6]);
    assert.equal(view.getUint32(0x900, true), 4);
    // Fewer bytes than counted came: the write is refused, its count 0.
    assert.equal(write.handler([0x10, 0x800, 2, 4, 0, 0x900]), STATUS_PARTIAL_COPY);
    assert.equal(view.getUint32(0x900, true), 0);
    assert.equal(write.handler([0x1000, 0x800, 4, 4, 1, 0x900]), 0xc0000005,
        'WriteProcessMemory\'s refusal of read-only memory');
});
