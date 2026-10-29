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
    userLayouts,
    writeFields,
    writeMessage,
    writeRect,
    writeU32s,
    writeWindowClass,
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

    writeWindowClass(memory, 0x40, fields);

    const read = readWindowClass(memory, 0x40, WNDCLASSA);
    assert.deepEqual(read, { ...fields, iconSm: 0 });
});

test('a MSG round-trips through the fields a dispatcher reads back', ()=>{
    const memory = fakeMemory();
    writeMessage(memory, 0x80, {
        hwnd: 0x40, message: 0x0100, wParam: 0x41, lParam: 0x001e0001, time: 7, x: 3, y: 4,
    });

    assert.deepEqual(readMessage(memory, 0x80),
        { hwnd: 0x40, message: 0x0100, wParam: 0x41, lParam: 0x001e0001, time: 7 });
    assert.equal(readU32(memory, 0x80 + MSG.ptX), 3);
    assert.equal(readU32(memory, 0x80 + MSG.ptY), 4);
});

test('a RECT is written left, top, right, bottom and in that order', ()=>{
    const memory = fakeMemory();
    writeRect(memory, 0xc0, { left: 1, top: 2, right: 3, bottom: 4 });

    const written = [0, 1, 2, 3].map(index=>readU32(memory, 0xc0 + (index * 4)));
    assert.deepEqual(written, [1, 2, 3, 4]);
});

test('a 64-bit process\'s structures have their pointers eight bytes wide, as winuser.h has them',
    ()=>{
    // The offsets _WIN64 gives each: a pointer, a handle or a message
    // parameter on an eight-byte boundary, the end padded to eight.
        const L = userLayouts(8);
        assert.deepEqual([L.WNDCLASSA.lpfnWndProc, L.WNDCLASSA.cbClsExtra, L.WNDCLASSA.hInstance,
            L.WNDCLASSA.lpszClassName, L.WNDCLASSA.SIZE], [8, 16, 24, 64, 72]);
        assert.deepEqual([L.WNDCLASSEXA.style, L.WNDCLASSEXA.lpfnWndProc, L.WNDCLASSEXA.hIconSm,
            L.WNDCLASSEXA.SIZE], [4, 8, 72, 80]);
        assert.deepEqual([L.MSG.message, L.MSG.wParam, L.MSG.lParam, L.MSG.time, L.MSG.ptX,
            L.MSG.SIZE], [8, 16, 24, 32, 36, 48]);
        assert.deepEqual([L.PAINTSTRUCT.fErase, L.PAINTSTRUCT.rcPaint, L.PAINTSTRUCT.rgbReserved,
            L.PAINTSTRUCT.SIZE], [8, 12, 36, 72]);
        assert.deepEqual([L.CREATESTRUCTA.cy, L.CREATESTRUCTA.style, L.CREATESTRUCTA.lpszName,
            L.CREATESTRUCTA.dwExStyle, L.CREATESTRUCTA.SIZE], [32, 48, 56, 72, 80]);
        assert.deepEqual([L.WINDOWPOS.x, L.WINDOWPOS.flags, L.WINDOWPOS.SIZE], [16, 32, 40]);
        assert.deepEqual([L.NCCALCSIZE_PARAMS.lppos, L.NCCALCSIZE_PARAMS.SIZE], [48, 56]);
        assert.equal(userLayouts(4).MSG, MSG, 'and a 32-bit one\'s are the ones it always had');
    });

test('a 64-bit field widens a dword as its type does: a handle and an LPARAM by sign', ()=>{
    const memory = fakeMemory();
    const L = userLayouts(8);
    memory.bytes.fill(0xaa);
    writeMessage(memory, 0x80, { hwnd: 0x40, message: 0x0100, wParam: 0x80000001, lParam: -3,
        time: 7, x: 3, y: 4 }, L);
    const view = new DataView(memory.bytes.buffer);
    assert.equal(view.getBigUint64(0x80, true), 0x40n);
    assert.equal(view.getBigUint64(0x80 + 16, true), 0x80000001n, 'a WPARAM as a UINT');
    assert.equal(view.getBigInt64(0x80 + 24, true), -3n, 'an LPARAM as a LONG');
    assert.equal(memory.bytes[0x80 + 44], 0xaa, 'lPrivate is the system\'s and left alone');
    assert.deepEqual(readMessage(memory, 0x80, L),
        { hwnd: 0x40, message: 0x0100, wParam: 0x80000001, lParam: 0xfffffffd, time: 7 });

    writeFields(memory, 0x100, L, L.WINDOWPOS, { hwndInsertAfter: -1, flags: 4 });
    assert.equal(view.getBigInt64(0x100 + 8, true), -1n, 'HWND_TOPMOST is -1 whole');
    assert.equal(view.getUint32(0x100 + 32, true), 4);
});

test('a class written back at 64 bits reads the same way it was read', ()=>{
    const memory = fakeMemory();
    const L = userLayouts(8);
    const fields = {
        style: 3, wndProc: 0x401000, classExtra: 0, windowExtra: 8, instance: 0x400000,
        icon: 1, cursor: 2, background: 3, menuName: 0, className: 0x1234, iconSm: 9,
    };
    writeWindowClass(memory, 0x40, fields, L, L.WNDCLASSEXA);
    assert.deepEqual(readWindowClass(memory, 0x40, L.WNDCLASSEXA), fields);
});
