/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MSG,
    RECT,
    WNDCLASSA,
    WNDCLASSEXA,
    readMessage,
    readU32,
    readWindowClass,
    writeMessage,
    writeRect,
    writeU32s,
    writeWindowClassA,
} from './structs.js';

function fakeMemory(size = 0x200){
    const bytes = new Uint8Array(size);
    return {
        bytes,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
    };
}

test('a DWORD is stored little-endian, the way the guest reads it', ()=>{
    const memory = fakeMemory();
    writeU32s(memory, 0x10, [0x12345678]);

    assert.deepEqual([...memory.bytes.subarray(0x10, 0x14)], [0x78, 0x56, 0x34, 0x12]);
    assert.equal(readU32(memory, 0x10), 0x12345678);
});

test('a DWORD comes back unsigned', ()=>{
    const memory = fakeMemory();
    writeU32s(memory, 0, [-1]);

    assert.equal(readU32(memory, 0), 0xffffffff,
        'a handle read as a negative number compares equal to nothing the guest passed');
});

test('every structure is exactly as long as its fields', ()=>{
    // A size that has drifted from the offsets is the failure that writes one
    // field past the end of a guest buffer.
    assert.equal(WNDCLASSA.SIZE, WNDCLASSA.lpszClassName + 4);
    assert.equal(WNDCLASSEXA.SIZE, WNDCLASSEXA.hIconSm + 4);
    assert.equal(MSG.SIZE, MSG.ptY + 4);
    assert.equal(RECT.SIZE, RECT.bottom + 4);
});

test('WNDCLASSEXA is WNDCLASSA shifted by the cbSize in front of it', ()=>{
    const extended = /** @type {Record<string, number>} */ (/** @type {unknown} */ (WNDCLASSEXA));
    const classic = /** @type {Record<string, number>} */ (/** @type {unknown} */ (WNDCLASSA));
    const shared = ['style', 'lpfnWndProc', 'cbClsExtra', 'cbWndExtra', 'hInstance',
        'hIcon', 'hCursor', 'hbrBackground', 'lpszMenuName', 'lpszClassName'];
    for (const field of shared)
    {
        assert.equal(extended[field], classic[field] + 4, `${field} moved by four, no more`);
    }
});

test('a class structure is read from the offsets its layout names', ()=>{
    const memory = fakeMemory();
    writeU32s(memory, 0x20, [
        WNDCLASSEXA.SIZE, 0x0003, 0x401000, 4, 8, 0x400000, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66,
    ]);

    const fields = readWindowClass(memory, 0x20, WNDCLASSEXA);
    assert.equal(fields.style, 0x0003);
    assert.equal(fields.wndProc, 0x401000);
    assert.equal(fields.classExtra, 4);
    assert.equal(fields.windowExtra, 8);
    assert.equal(fields.className, 0x55);
    assert.equal(fields.iconSm, 0x66);

    // The classic layout has no such field, and inventing one would hand the
    // caller whatever follows the structure in guest memory.
    assert.equal(readWindowClass(memory, 0x20, WNDCLASSA).iconSm, 0);
});

test('a class written back reads the same way it was read', ()=>{
    const memory = fakeMemory();
    const fields = {
        style: 3, wndProc: 0x401000, classExtra: 0, windowExtra: 8, instance: 0x400000,
        icon: 1, cursor: 2, background: 3, menuName: 0, className: 0x1234, iconSm: 9,
    };

    writeWindowClassA(memory, 0x40, fields);

    const read = readWindowClass(memory, 0x40, WNDCLASSA);
    assert.deepEqual(read, { ...fields, iconSm: 0 });
});

test('a MSG round-trips through the fields a dispatcher reads back', ()=>{
    const memory = fakeMemory();
    writeMessage(memory, 0x80, {
        hwnd: 0x40, message: 0x0100, wParam: 0x41, lParam: 0x001e0001, time: 7, x: 3, y: 4,
    });

    assert.deepEqual(readMessage(memory, 0x80),
        { hwnd: 0x40, message: 0x0100, wParam: 0x41, lParam: 0x001e0001 });
    assert.equal(readU32(memory, 0x80 + MSG.time), 7);
    assert.equal(readU32(memory, 0x80 + MSG.ptX), 3);
    assert.equal(readU32(memory, 0x80 + MSG.ptY), 4);
});

test('a RECT is written left, top, right, bottom and in that order', ()=>{
    const memory = fakeMemory();
    writeRect(memory, 0xc0, { left: 1, top: 2, right: 3, bottom: 4 });

    const written = [0, 1, 2, 3].map(index=>readU32(memory, 0xc0 + (index * 4)));
    assert.deepEqual(written, [1, 2, 3, 4]);
});
