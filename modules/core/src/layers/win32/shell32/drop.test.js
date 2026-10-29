/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDropFunctions, dropPaths } from './drop.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';

/**
 * A drop block at 0x1000 as a program posts one, behind a kernel32 whose
 * GlobalLock answers it.
 *
 * @param {string[]} paths @param {{ wide?: boolean, outside?: boolean }} [options]
 */
function drop(paths, { wide = false, outside = false } = {}){
    const memory = new Uint8Array(0x4000);
    const view = new DataView(memory.buffer);
    view.setUint32(0x1000, 20, true);
    view.setInt32(0x1004, 10, true);
    view.setInt32(0x1008, 20, true);
    view.setUint32(0x100c, outside ? 1 : 0, true);
    view.setUint32(0x1010, wide ? 1 : 0, true);
    let at = 0x1014;
    // Each path and its terminator, then the one more that ends the list.
    for (const c of `${paths.join('\0')}\0\0`)
    {
        if (wide)
        {
            view.setUint16(at, c.charCodeAt(0), true);
            at += 2;
        }
        else
        {
            memory[at++] = c.charCodeAt(0);
        }
    }
    /** @type {number[]} */
    const freed = [];
    const kernel32 = {
        GlobalLock: { handler: (/** @type {number[]} */ [handle])=>(handle === 0x77 ? 0x1000 : 0) },
        GlobalUnlock: { handler: ()=>1 },
        GlobalSize: { handler: ()=>0x400 },
        GlobalFree: { handler: (/** @type {number[]} */ [handle])=>{
            freed.push(handle);
            return 0;
        } },
    };
    const fns = createDropFunctions({
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        library: name=>(name === 'KERNEL32.dll' ? kernel32 : undefined),
    }, decodeAnsi, text=>encodeAnsi(text));
    return { fns, memory, view, freed };
}

test('a list of dropped paths ends at its empty one', ()=>{
    const bytes = Uint8Array.from('a\0bc\0\0zz', c=>c.charCodeAt(0));
    assert.deepEqual(dropPaths(bytes, false), ['a', 'bc']);
});

test('DragQueryFile counts, measures and copies a dropped path', async()=>{
    // Wine's shellole drop test.
    for (const wide of [false, true])
    {
        const m = drop(['C:\\dummy.txt'], { wide });
        const query = wide ? m.fns.DragQueryFileW.handler : m.fns.DragQueryFileA.handler;
        assert.equal(await query([0x77, 0xffffffff, 0, 0]), 1);
        assert.equal(await query([0x77, 0xffffffff, 0xdeadbeef, 0xffffffff]), 1);
        assert.equal(await query([0x77, 0, 0, 0]), 12, 'its length');
        assert.equal(await query([0x77, 0, 0x2000, 0]), 12, 'no room: its length, nothing written');
        assert.equal(m.memory[0x2000], 0);
        assert.equal(await query([0x77, 0, 0x2000, 260]), 12);
        const unit = wide ? 2 : 1;
        assert.equal(m.memory[0x2000], 0x43);
        assert.equal(m.memory[0x2000 + 12 * unit], 0, 'terminated');
        m.memory.fill(0xaa, 0x2000, 0x2100);
        assert.equal(await query([0x77, 0, 0x2000, 2]), 1, 'cut to the room');
        assert.equal(m.memory[0x2000 + unit], 0);
        assert.equal(await query([0x77, 1, 0x2000, 260]), 0, 'past the last path');
        assert.equal(await query([0x55, 0xffffffff, 0, 0]), 0, 'no block');
    }
});

test('DragQueryPoint answers where the drop fell, and whether inside the client area', async()=>{
    for (const outside of [false, true])
    {
        const m = drop(['x'], { outside });
        assert.equal(await m.fns.DragQueryPoint.handler([0x77, 0x3000]), outside ? 0 : 1);
        assert.deepEqual([m.view.getInt32(0x3000, true), m.view.getInt32(0x3004, true)], [10, 20]);
    }
    const m = drop(['x']);
    await m.fns.DragFinish.handler([0x77]);
    assert.deepEqual(m.freed, [0x77], 'the block freed');
});
