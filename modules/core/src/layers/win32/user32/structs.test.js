/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEVMODEA,
    DEVMODEW,
    DISPLAY_DEVICEA,
    DISPLAY_DEVICEW,
    MONITORINFO,
    MONITORINFOEXA_SIZE,
    MSG,
    RECT,
    WINDOWINFO,
    WINDOWPLACEMENT,
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
        assert.deepEqual([L.CBTACTIVATESTRUCT.hWndActive, L.CBTACTIVATESTRUCT.SIZE], [8, 16]);
        assert.deepEqual([L.MOUSEHOOKSTRUCT.hwnd, L.MOUSEHOOKSTRUCT.wHitTestCode,
            L.MOUSEHOOKSTRUCT.dwExtraInfo, L.MOUSEHOOKSTRUCT.SIZE], [8, 16, 24, 32]);
        // INPUT's union holds a ULONG_PTR, so it starts on eight bytes.
        assert.deepEqual([L.INPUT.dx, L.INPUT.dwFlags, L.INPUT.wVk, L.INPUT.keyFlags,
            L.INPUT.SIZE], [8, 20, 8, 12, 40]);
        assert.equal(userLayouts(4).MSG, MSG, 'and a 32-bit one\'s are the ones it always had');
        assert.deepEqual([userLayouts(4).INPUT.dx, userLayouts(4).INPUT.SIZE,
            userLayouts(4).MOUSEHOOKSTRUCT.SIZE, userLayouts(4).CBTACTIVATESTRUCT.SIZE],
        [4, 28, 20, 8]);
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

    writeFields(memory, 0x100, L.WINDOWPOS, { hwndInsertAfter: -1, flags: 4 });
    assert.equal(view.getBigInt64(0x100 + 8, true), -1n, 'HWND_TOPMOST is -1 whole');
    assert.equal(view.getUint32(0x100 + 32, true), 4);
});

test('a 64-bit pointer field widens a dword by zero: an address past 2 GiB stays itself', ()=>{
    // A program linked /LARGEADDRESSAWARE is handed addresses past 2 GiB; the window procedure,
    // the class name, CREATESTRUCT's lpCreateParams and the hook structures' pointers are
    // addresses there, which sign extension would turn into 0xFFFFFFFF_8...: another address.
    const memory = fakeMemory(0x400);
    const L = userLayouts(8);
    memory.bytes.fill(0xaa);
    const view = new DataView(memory.bytes.buffer);
    const high = 0x9000_1000;
    writeWindowClass(memory, 0x40, { style: 0, wndProc: high, classExtra: 0, windowExtra: 0,
        instance: high + 0x1000, icon: 0, cursor: 0, background: 0, menuName: high + 0x2000,
        className: high + 0x3000, iconSm: 0 }, L, L.WNDCLASSEXA);
    for (const [name, value] of /** @type {[string, number][]} */ ([['lpfnWndProc', high],
        ['hInstance', high + 0x1000], ['lpszMenuName', high + 0x2000],
        ['lpszClassName', high + 0x3000]]))
    {
        assert.equal(view.getBigUint64(0x40 + L.WNDCLASSEXA[name], true), BigInt(value), name);
    }
    writeFields(memory, 0x100, L.CREATESTRUCTA, { lpCreateParams: high, hInstance: high,
        hwndParent: -1, lpszName: high + 4, lpszClass: high + 8 });
    for (const [name, value] of /** @type {[string, number][]} */ ([['lpCreateParams', high],
        ['hInstance', high], ['lpszName', high + 4], ['lpszClass', high + 8]]))
    {
        assert.equal(view.getBigUint64(0x100 + L.CREATESTRUCTA[name], true), BigInt(value), name);
    }
    assert.equal(view.getBigInt64(0x100 + L.CREATESTRUCTA.hwndParent, true), -1n,
        'a handle keeps its sign');
    writeFields(memory, 0x200, L.CBT_CREATEWNDA, { lpcs: high, hwndInsertAfter: -2 });
    assert.equal(view.getBigUint64(0x200 + L.CBT_CREATEWNDA.lpcs, true), BigInt(high));
    assert.equal(view.getBigInt64(0x200 + L.CBT_CREATEWNDA.hwndInsertAfter, true), -2n);
    writeFields(memory, 0x300, L.NCCALCSIZE_PARAMS, { lppos: high });
    assert.equal(view.getBigUint64(0x300 + L.NCCALCSIZE_PARAMS.lppos, true), BigInt(high));
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

test('a 64-bit class keeps a procedure and a name past 4 GiB whole, both ways', ()=>{
    // A 64-bit program's image at its own base past 4 GiB (a wide window):
    // its window procedure is that address, not the low dword's alias.
    const memory = fakeMemory();
    const layouts = userLayouts(8);
    const L = layouts.WNDCLASSEXA;
    const view = new DataView(memory.bytes.buffer);
    view.setBigUint64(0x10 + L.lpfnWndProc, 0x140001740n, true);
    view.setBigUint64(0x10 + L.lpszClassName, 0x1400023ben, true);
    const fields = readWindowClass(memory, 0x10, L);
    assert.equal(fields.wndProc, 0x140001740);
    assert.equal(fields.className, 0x1400023be);
    writeWindowClass(memory, 0x100, fields, layouts, L);
    assert.equal(view.getBigUint64(0x100 + L.lpfnWndProc, true), 0x140001740n);
    assert.equal(view.getBigUint64(0x100 + L.lpszClassName, true), 0x1400023ben);
});

test('a 64-bit MSG carries a WPARAM and an LPARAM a dword does not say, both ways', ()=>{
    const memory = fakeMemory();
    const layouts = userLayouts(8);
    const L = layouts.MSG;
    const view = new DataView(memory.bytes.buffer);
    writeMessage(memory, 0x20, { hwnd: 0x1004, message: 0x401, wParam: 0x23456789,
        lParam: 0x90000000, time: 5, x: 1, y: 2,
        wide: { w: 0x123456789n, l: 0x90000000n } }, layouts);
    assert.equal(view.getBigUint64(0x20 + L.wParam, true), 0x123456789n);
    assert.equal(view.getBigUint64(0x20 + L.lParam, true), 0x90000000n,
        'a pointer past 2 GiB, not its sign\'s ones');
    const back = readMessage(memory, 0x20, layouts);
    assert.deepEqual(back.wide, { w: 0x123456789n, l: 0x90000000n });
    assert.equal(back.lParam, 0x90000000);
    // Where the dwords say it all, nothing rides beside them.
    writeMessage(memory, 0x80, { hwnd: 0x1004, message: 0x401, wParam: 7, lParam: 0xffffffff,
        time: 5, x: 1, y: 2 }, layouts);
    assert.equal(view.getBigUint64(0x80 + L.lParam, true), 0xffffffffffffffffn);
    assert.equal(readMessage(memory, 0x80, layouts).wide, undefined);
    assert.equal(readMessage(memory, 0x80).wide, undefined, 'nor in a 32-bit MSG');
});

test('every structure has the SDK\'s size and offsets at both widths', ()=>{
    // sizeof and offsetof of each, worked out from winuser.h's and wingdi.h's
    // declarations by the x86 and x64 compilers' rule: a pointer, a handle, a
    // WPARAM or an LPARAM 4 or 8 bytes and on its own size, every other field
    // a DWORD, a LONG, a WORD or a char array on its natural boundary.
    /** @type {[string, Record<string, number>, Record<string, number>][]} */
    const expected = [
        ['WNDCLASSA', { lpfnWndProc: 4, hInstance: 16, lpszClassName: 36, SIZE: 40 },
            { lpfnWndProc: 8, hInstance: 24, lpszClassName: 64, SIZE: 72 }],
        ['WNDCLASSEXA', { style: 4, lpfnWndProc: 8, hIconSm: 44, SIZE: 48 },
            { style: 4, lpfnWndProc: 8, hIconSm: 72, SIZE: 80 }],
        ['MSG', { wParam: 8, lParam: 12, time: 16, ptX: 20, SIZE: 28 },
            { wParam: 16, lParam: 24, time: 32, ptX: 36, SIZE: 48 }],
        ['PAINTSTRUCT', { rcPaint: 8, fRestore: 24, rgbReserved: 32, SIZE: 64 },
            { rcPaint: 12, fRestore: 28, rgbReserved: 36, SIZE: 72 }],
        ['CREATESTRUCTA', { cy: 16, style: 32, lpszName: 36, dwExStyle: 44, SIZE: 48 },
            { cy: 32, style: 48, lpszName: 56, dwExStyle: 72, SIZE: 80 }],
        ['CBT_CREATEWNDA', { hwndInsertAfter: 4, SIZE: 8 }, { hwndInsertAfter: 8, SIZE: 16 }],
        ['WINDOWPOS', { x: 8, flags: 24, SIZE: 28 }, { x: 16, flags: 32, SIZE: 40 }],
        ['NCCALCSIZE_PARAMS', { lppos: 48, SIZE: 52 }, { lppos: 48, SIZE: 56 }],
        ['CBTACTIVATESTRUCT', { hWndActive: 4, SIZE: 8 }, { hWndActive: 8, SIZE: 16 }],
        ['MOUSEHOOKSTRUCT', { hwnd: 8, wHitTestCode: 12, dwExtraInfo: 16, SIZE: 20 },
            { hwnd: 8, wHitTestCode: 16, dwExtraInfo: 24, SIZE: 32 }],
        ['INPUT', { dx: 4, dwFlags: 16, mouseExtra: 24, wVk: 4, keyFlags: 8, keyExtra: 16,
            SIZE: 28 },
        { dx: 8, dwFlags: 20, mouseExtra: 32, wVk: 8, keyFlags: 12, keyExtra: 24, SIZE: 40 }],
    ];
    for (const [name, narrow, wide] of expected)
    {
        for (const [width, offsets] of /** @type {const} */ ([[4, narrow], [8, wide]]))
        {
            const table = /** @type {Record<string, any>} */ (userLayouts(width))[name];
            for (const [field, offset] of Object.entries(offsets))
            {
                assert.equal(table[field], offset, `${name}.${field} at ${width}`);
            }
        }
    }
    assert.equal(MONITORINFO.SIZE, 40);
    assert.equal(MONITORINFOEXA_SIZE, 72);
    assert.equal(DISPLAY_DEVICEA.StateFlags, 164);
    assert.equal(DISPLAY_DEVICEA.SIZE, 424);
    assert.equal(DISPLAY_DEVICEW.StateFlags, 324);
    assert.equal(DISPLAY_DEVICEW.SIZE, 840);
    assert.equal(WINDOWINFO.wCreatorVersion, 58);
    assert.equal(WINDOWINFO.SIZE, 60);
    assert.equal(WINDOWPLACEMENT.rcNormalPosition, 28);
    assert.equal(WINDOWPLACEMENT.SIZE, 44);
    assert.equal(DEVMODEA.dmDisplayOrientation, 52);
    assert.equal(DEVMODEA.dmBitsPerPel, 104);
    assert.equal(DEVMODEA.SIZE, 156);
    assert.equal(DEVMODEW.dmBitsPerPel, 168);
    assert.equal(DEVMODEW.SIZE, 220);
});

test('a structure past 4 GiB is written where it lies, not at its address cut to a dword', ()=>{
    /** @type {[number, number[]][]} */
    const writes = [];
    const memory = { readMemory: ()=>new Uint8Array(0),
        writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
            writes.push([address, [...bytes]]) };
    const L = userLayouts(8);
    const base = 0x1_4000_6000;
    writeFields(memory, base, L.WINDOWPOS, { hwndInsertAfter: -1, flags: 4 });
    assert.deepEqual(writes.map(([address])=>address),
        [base + L.WINDOWPOS.hwndInsertAfter, base + L.WINDOWPOS.flags]);
});
