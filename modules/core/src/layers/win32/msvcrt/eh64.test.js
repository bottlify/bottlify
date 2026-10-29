/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNWIND_KIND, createTableReader, readFuncInfo3, readFuncInfo4 } from './eh64.js';
import { compressed } from '../../../../scripts/lib/eh-tables.mjs';

const BASE = 0x400000;

/**
 * A flat image: bytes written at RVAs, read back through the reader the
 * runtime uses.
 */
function image(){
    const bytes = new Uint8Array(0x4000);
    let cursor = 0x100;
    return {
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address - BASE, address - BASE + length),
        /**
         * Lays `parts` (bytes and 32-bit words) down at the next free RVA.
         *
         * @param {(number[] | { int: number })[]} parts
         */
        put(...parts){
            const rva = cursor;
            for (const part of parts)
            {
                if (Array.isArray(part))
                {
                    bytes.set(part, cursor);
                    cursor += part.length;
                }
                else
                {
                    new DataView(bytes.buffer).setInt32(cursor, part.int, true);
                    cursor += 4;
                }
            }
            return rva;
        },
        /** @param {number} rva @param {number[]} words */
        words(rva, words){
            words.forEach((word, index)=>new DataView(bytes.buffer)
                .setInt32(rva + index * 4, word, true));
        },
    };
}

test('compressed numbers: the low bits of the first byte give the length', ()=>{
    // One to five bytes, each read as the runtime's table says: the value
    // shifted past a length mark of 0, 01, 011, 0111, or a full word after 1111.
    const cases = /** @type {[number, number[]][]} */ ([
        [0, [0x00]], [3, [0x06]], [127, [0xfe]],
        [128, [0x01, 0x02]], [200, [0x21, 0x03]],
        [1 << 14, [0x03, 0x00, 0x02]],
        [1 << 21, [0x07, 0x00, 0x00, 0x02]],
        [0x12345678, [0x0f, 0x78, 0x56, 0x34, 0x12]],
    ]);
    for (const [value, bytes] of cases)
    {
        assert.deepEqual(compressed(value), bytes, `${value} encodes as the table says`);
        const read = createTableReader((at, length)=>
            Uint8Array.from({ length }, (_, index)=>bytes[at + index] ?? 0));
        assert.deepEqual(read.compressed(0), { value, length: bytes.length },
            `${value} decodes`);
    }
});

test('FH4 tables: the unwind map by backward distances, try blocks, handlers, IP map', ()=>{
    const memory = image();
    // States 0 and 1 chain to the empty state, 2 to 1; 1 runs a funclet,
    // 2 destroys an object at frame+0x28, 0 nothing.
    const entry0 = compressed(1 << 2 | UNWIND_KIND.NONE);
    const entry1Head = compressed((entry0.length + 1) << 2 | UNWIND_KIND.FUNCLET);
    const entry1Size = entry1Head.length + 4;
    const unwind = memory.put(compressed(3), entry0, entry1Head, { int: 0x1500 },
        compressed(entry1Size << 2 | UNWIND_KIND.OBJECT), { int: 0x1600 }, compressed(0x28));
    const handlers = memory.put(compressed(2),
        [0x01 | 0x02 | 0x04], compressed(8), { int: 0x2000 }, compressed(0x40), { int: 0x1100 },
        [0x01 | 0x10], compressed(0x40), { int: 0x1200 }, compressed(0x33));
    const tries = memory.put(compressed(1), compressed(1), compressed(1), compressed(2),
        { int: handlers });
    const ips = memory.put(compressed(3), compressed(0), compressed(0),
        compressed(0x10), compressed(2), [0x0f], { int: 0x20 }, compressed(1));
    const info = memory.put([0x08 | 0x10 | 0x20], { int: unwind }, { int: tries }, { int: ips });

    const fn = readFuncInfo4(createTableReader(memory.readMemory), BASE, BASE + info,
        BASE + 0x1000);
    assert.deepEqual(fn.unwind, [
        { to: -1, action: 0, kind: UNWIND_KIND.NONE, object: 0 },
        { to: -1, action: BASE + 0x1500, kind: UNWIND_KIND.FUNCLET, object: 0 },
        { to: 1, action: BASE + 0x1600, kind: UNWIND_KIND.OBJECT, object: 0x28 },
    ]);
    assert.deepEqual(fn.tries, [{ low: 1, high: 1, catchHigh: 2, handlers: [
        { adjectives: 8, type: BASE + 0x2000, catchObject: 0x40, handler: BASE + 0x1100,
            frame: 0, continuations: [] },
        { adjectives: 0x40, type: 0, catchObject: 0, handler: BASE + 0x1200, frame: 0,
            continuations: [BASE + 0x1000 + 0x33] },
    ] }]);
    assert.equal(fn.ehs, true);
    assert.equal(fn.isCatch, false);
    // Deltas from the function's start, states biased by one.
    assert.equal(fn.stateAt(BASE + 0x1000), -1);
    assert.equal(fn.stateAt(BASE + 0x100f), -1);
    assert.equal(fn.stateAt(BASE + 0x1010), 1);
    assert.equal(fn.stateAt(BASE + 0x102f), 1);
    assert.equal(fn.stateAt(BASE + 0x1030), 0);
});

test('FH4 tables: a catch funclet\'s frame offset, and an IP map per separated segment', ()=>{
    const memory = image();
    const first = memory.put(compressed(1), compressed(0), compressed(3));
    const second = memory.put(compressed(2), compressed(0), compressed(5), compressed(8),
        compressed(6));
    const segments = memory.put(compressed(2), { int: 0x1000 }, { int: first },
        { int: 0x3000 }, { int: second });
    const info = memory.put([0x01 | 0x02], { int: segments }, compressed(0x68));
    const read = createTableReader(memory.readMemory);

    const funclet = readFuncInfo4(read, BASE, BASE + info, BASE + 0x3000);
    assert.equal(funclet.isCatch, true);
    assert.equal(funclet.catchFrame, 0x68);
    assert.equal(funclet.stateAt(BASE + 0x3004), 4);
    assert.equal(funclet.stateAt(BASE + 0x3008), 5);
    assert.equal(readFuncInfo4(read, BASE, BASE + info, BASE + 0x1000).stateAt(BASE + 0x1000), 2);
});

test('FH3 tables: the state is the last IP entry at or before the address', ()=>{
    const memory = image();
    const unwind = memory.put({ int: -1 }, { int: 0 }, { int: 0 }, { int: 0x1500 });
    const handlers = memory.put({ int: 8 }, { int: 0x2000 }, { int: 0x40 }, { int: 0x1100 },
        { int: 0x48 });
    const tries = memory.put({ int: 0 }, { int: 0 }, { int: 1 }, { int: 1 }, { int: handlers });
    const ips = memory.put({ int: 0x1000 }, { int: -1 }, { int: 0x1011 }, { int: 0 },
        { int: 0x1021 }, { int: 1 }, { int: 0x1030 }, { int: -1 });
    const info = memory.put({ int: 0x19930522 }, { int: 2 }, { int: unwind }, { int: 1 },
        { int: tries }, { int: 4 }, { int: ips }, { int: 0x30 }, { int: 0 }, { int: 1 });

    const fn = readFuncInfo3(createTableReader(memory.readMemory), BASE, BASE + info);
    assert.ok(fn);
    assert.deepEqual(fn.unwind.map(entry=>entry.to), [-1, 0]);
    assert.equal(fn.unwind[1].action, BASE + 0x1500);
    assert.equal(fn.tries[0].handlers[0].frame, 0x48);
    assert.equal(fn.ehs, true);
    // A call's return address is the byte after it, still the call's state.
    assert.deepEqual([0x1000, 0x1010, 0x1011, 0x1020, 0x1021, 0x102f, 0x1030, 0x2000]
        .map(rva=>fn.stateAt(BASE + rva)), [-1, -1, 0, 0, 1, 1, -1, -1]);
    assert.equal(fn.stateAt(BASE + 0x0fff), -1);

    // An unknown magic is no table at all.
    memory.words(info, [0x12345678]);
    assert.equal(readFuncInfo3(createTableReader(memory.readMemory), BASE, BASE + info), null);
});
