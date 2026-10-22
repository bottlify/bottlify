/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCAN_WINDOW, charactersOf, readToTerminator, scanWindows } from './scan-windows.js';

/**
 * Memory whose regions end at `ends`, refusing a read across one as the
 * memory layer refuses one past a region's end, and recording every read.
 *
 * @param {number} size @param {number[]} [ends]
 */
function memoryOf(size, ends = [size]){
    const bytes = new Uint8Array(size);
    /** @type {[number, number][]} */
    const reads = [];
    return {
        bytes,
        reads,
        /** @param {number} address @param {number} length */
        readMemory(address, length){
            for (const end of ends)
            {
                assert.ok(address >= end || address + length <= end, `read of ${length} bytes`
                    + ` at 0x${address.toString(16)} runs past an end at 0x${end.toString(16)}`);
            }
            reads.push([address, length]);
            return bytes.slice(address, address + length);
        },
    };
}

/** @param {string} text */
const wide = text=>new Uint8Array(Uint16Array.from(text, c=>c.charCodeAt(0)).buffer);

test('a window ends at the next multiple of its size, so none reaches across one', ()=>{
    const memory = memoryOf(0x1000);
    const windows = [];
    for (const piece of scanWindows(memory, 0x1f0))
    {
        windows.push(piece.length);
        if (windows.length === 3)
        {
            break;
        }
    }
    assert.deepEqual(windows, [SCAN_WINDOW - 0xf0, SCAN_WINDOW, SCAN_WINDOW]);
    assert.deepEqual(memory.reads.map(([at])=>at), [0x1f0, 0x200, 0x300]);
});

test('a window holds whole units: one its end would split is read alone, across it', ()=>{
    const memory = memoryOf(0x1000);
    /** @type {[number, number][]} */
    const seen = [];
    for (const piece of scanWindows(memory, 0x2fd, 2))
    {
        seen.push(memory.reads[memory.reads.length - 1]);
        assert.equal(piece.length % 2, 0);
        if (seen.length === 4)
        {
            break;
        }
    }
    assert.deepEqual(seen, [[0x2fd, 2], [0x2ff, 2], [0x301, 0xfe], [0x3ff, 2]]);
    const dwords = memoryOf(0x1000);
    const lengths = [];
    for (const piece of scanWindows(dwords, 0x3fa, 4))
    {
        lengths.push(piece.length);
        if (lengths.length === 3)
        {
            break;
        }
    }
    assert.deepEqual(lengths, [4, 4, 0xfc], 'a dword over the edge, then the window after it');
});

test('a window memory gives short of what was asked is the last', ()=>{
    // A memory that hands back what it holds rather than refusing, as one
    // whose process is gone answers nothing.
    const memory = memoryOf(0x150, []);
    const lengths = [...scanWindows(memory, 0x40)].map(piece=>piece.length);
    assert.deepEqual(lengths, [0xc0, 0x50]);
});

test('a string ending just short of the end of its region is read without reading past it', ()=>{
    for (const offset of [8, 9, 0x100 + 8])
    {
        const memory = memoryOf(0x2000, [0x1000, 0x2000]);
        const text = new TextEncoder().encode('a name\0');
        const at = 0x1000 - offset - text.length;
        memory.bytes.set(text, at);
        const { bytes, terminated } = readToTerminator(memory, at, 1, 4096);
        assert.equal(new TextDecoder().decode(bytes), 'a name', `ending ${offset} short`);
        assert.equal(terminated, true);

        const units = wide('a name\0');
        memory.bytes.set(units, 0x2000 - offset - units.length);
        const read = readToTerminator(memory, 0x2000 - offset - units.length, 2, 4096);
        assert.equal(charactersOf(read.bytes, 2), 'a name', `wide, ending ${offset} short`);
        assert.equal(read.terminated, true);
    }
});

test('a wide terminator is a zero unit, not two zero bytes that straddle two', ()=>{
    const memory = memoryOf(0x1000);
    memory.bytes.set([0x41, 0x00, 0x00, 0x42, 0x43, 0x00, 0x00, 0x00], 0x200);
    const { bytes, terminated } = readToTerminator(memory, 0x200, 2);
    assert.equal(charactersOf(bytes, 2), 'A䈀C');
    assert.equal(terminated, true);
});

test('the limit counts characters before the terminator; one at the limit is terminated', ()=>{
    const memory = memoryOf(0x1000);
    memory.bytes.set(new TextEncoder().encode('abcdef\0'), 0x100);
    assert.deepEqual(readToTerminator(memory, 0x100, 1, 6),
        { bytes: new TextEncoder().encode('abcdef'), terminated: true });
    assert.deepEqual(readToTerminator(memory, 0x100, 1, 4),
        { bytes: new TextEncoder().encode('abcd'), terminated: false });
    const before = memory.reads.length;
    assert.deepEqual(readToTerminator(memory, 0x100, 1, 0),
        { bytes: new Uint8Array(0), terminated: false });
    assert.equal(memory.reads.length, before, 'no room is no read');
});

test('a string memory ends inside is what memory holds of it, unterminated', ()=>{
    const memory = memoryOf(0x110, []);
    memory.bytes.fill(0x61, 0x100, 0x110);
    assert.deepEqual(readToTerminator(memory, 0x100, 1),
        { bytes: new Uint8Array(16).fill(0x61), terminated: false });
});

test('characters come out of bytes as Latin-1 or UTF-16, however many there are', ()=>{
    assert.equal(charactersOf(Uint8Array.of(0x41, 0xe9)), 'Aé');
    assert.equal(charactersOf(wide('Ж€'), 2), 'Ж€');
    const long = 'x'.repeat(100000);
    assert.equal(charactersOf(new TextEncoder().encode(long)), long);
    assert.equal(charactersOf(wide(long), 2), long);
});
