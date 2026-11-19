/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDebugBufferFunctions, PDI } from './debug-buffer.js';

function machine(){
    const memory = new Uint8Array(0x10000);
    const view = new DataView(memory.buffer);
    let next = 0x1000;
    /** @type {Set<number>} */
    const live = new Set();
    /** @type {string[]} */
    const said = [];
    const fns = createDebugBufferFunctions({
        readMemory: (at, length)=>memory.slice(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        allocate: bytes=>{
            const at = next;
            next += (bytes + 15) & ~15;
            live.add(at);
            return at;
        },
        free: at=>live.delete(at),
        processId: 0x40,
        otherProcess: id=>id === 0x80,
        modules: ()=>[{ base: 0x400000, size: 0x5000, path: 'C:\\App\\game.exe' },
            { base: 0x7c800000, size: 0x20000, path: 'C:\\Windows\\system32\\kernel32.dll' }],
        heaps: ()=>[0x150000, 0x250000],
        divergence: api=>said.push(api),
    });
    return { fns, view, memory, live, said };
}

test('a query lists the modules and the heaps its flags ask for', ()=>{
    const { fns, view, memory, live } = machine();
    const buffer = fns.RtlCreateQueryDebugBuffer.handler();
    assert.notEqual(buffer, 0);
    assert.equal(fns.RtlQueryProcessDebugInformation.handler([0x40, PDI.MODULES, buffer]), 0);
    assert.equal(view.getUint32(buffer + 0x20, true), PDI.MODULES, 'InfoClassMask');
    assert.equal(view.getUint32(buffer + 0x38, true), 0, 'no heaps asked');
    const modules = view.getUint32(buffer + 0x30, true);
    assert.equal(view.getUint32(modules, true), 2);
    const second = modules + 4 + 0x11c;
    assert.equal(view.getUint32(second + 0x08, true), 0x7c800000, 'ImageBase');
    const offset = view.getUint16(second + 0x1a, true);
    assert.equal(new TextDecoder().decode(memory.subarray(second + 0x1c + offset,
        second + 0x1c + offset + 12)), 'kernel32.dll', 'OffsetToFileName');

    assert.equal(fns.RtlQueryProcessDebugInformation.handler(
        [0x40, PDI.HEAPS | PDI.HEAP_BLOCKS, buffer]), 0);
    assert.equal(view.getUint32(buffer + 0x20, true), PDI.HEAPS | PDI.HEAP_BLOCKS);
    const heaps = view.getUint32(buffer + 0x38, true);
    assert.equal(view.getUint32(heaps, true), 2);
    assert.equal(view.getUint32(heaps + 4 + 0x40, true), 0x250000, 'the second heap\'s base');

    assert.equal(fns.RtlDestroyQueryDebugBuffer.handler([buffer]), 0);
    assert.equal(live.size, 0, 'the buffer and every block it held given back');
    assert.equal(fns.RtlDestroyQueryDebugBuffer.handler([buffer]), 0xc000000d, 'once');
});

test('an id that names no process is STATUS_INVALID_CID; another process is said', ()=>{
    const { fns, said } = machine();
    const buffer = fns.RtlCreateQueryDebugBuffer.handler();
    assert.equal(fns.RtlQueryProcessDebugInformation.handler([0x44, PDI.MODULES, buffer]) >>> 0,
        0xc000000b, 'a thread\'s id');
    assert.equal(fns.RtlQueryProcessDebugInformation.handler([0x80, PDI.MODULES, buffer]) >>> 0,
        0xc0000002);
    assert.deepEqual(said, ['RtlQueryProcessDebugInformation']);
});
