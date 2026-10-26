/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMCTL32_ORDINALS, createComctlFunctions } from './functions.js';

/** @param {((bitmap: number) => { width: number, height: number }) | undefined} bitmapSize */
function machine(bitmapSize = undefined){
    const memory = new Uint8Array(0x400);
    const host = {
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>
            memory.slice(a, a + n),
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>
            memory.set(b, a),
        bitmapSize,
    };
    /** @param {number} at @param {number} value */
    const put32 = (at, value)=>memory.set(new Uint8Array([
        value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
    ]), at);
    const get32 = (/** @type {number} */ at)=>memory[at] | memory[at + 1] << 8
        | memory[at + 2] << 16 | memory[at + 3] << 24;
    return { memory, put32, get32,
        comctl: /** @type {any} */ (createComctlFunctions(host)) };
}

test('a list hands out indices, and Add reports the first of them', ()=>{
    const m = machine();
    const list = m.comctl.ImageList_Create.handler([16, 16, 0, 4, 4]);
    assert.notEqual(list, 0);

    assert.equal(m.comctl.ImageList_Add.handler([list, 0x111, 0]), 0);
    assert.equal(m.comctl.ImageList_Add.handler([list, 0x222, 0]), 1);
    assert.equal(m.comctl.ImageList_GetImageCount.handler([list]), 2);
});

test('a strip counts as the images it holds, when the size is knowable', ()=>{
    // A caller that adds a strip of eight and is told it added one will index
    // seven images that do not exist.
    const m = machine(()=>({ width: 128, height: 16 }));
    const list = m.comctl.ImageList_Create.handler([16, 16, 0, 0, 0]);

    assert.equal(m.comctl.ImageList_Add.handler([list, 0x111, 0]), 0);
    assert.equal(m.comctl.ImageList_GetImageCount.handler([list]), 8);
    assert.equal(m.comctl.ImageList_Add.handler([list, 0x222, 0]), 8,
        'and the next add starts after them');
});

test('without a way to size a bitmap it counts one, rather than guessing', ()=>{
    const m = machine();
    const list = m.comctl.ImageList_Create.handler([16, 16, 0, 0, 0]);
    m.comctl.ImageList_Add.handler([list, 0x111, 0]);
    assert.equal(m.comctl.ImageList_GetImageCount.handler([list]), 1);
});

test('a destroyed list is gone, and its handle answers nothing', ()=>{
    const m = machine();
    const list = m.comctl.ImageList_Create.handler([16, 16, 0, 0, 0]);
    assert.equal(m.comctl.ImageList_Destroy.handler([list]), 1);
    assert.equal(m.comctl.ImageList_Destroy.handler([list]), 0);
    assert.equal(m.comctl.ImageList_Add.handler([list, 0x111, 0]), -1,
        'Add reports failure with -1, not with zero');
});

test('a drag can only begin on an image the list has', ()=>{
    const m = machine();
    const list = m.comctl.ImageList_Create.handler([16, 16, 0, 0, 0]);
    assert.equal(m.comctl.ImageList_BeginDrag.handler([list, 0, 1, 2]), 0,
        'there is no image zero yet');

    m.comctl.ImageList_Add.handler([list, 0x111, 0]);
    assert.equal(m.comctl.ImageList_BeginDrag.handler([list, 0, 1, 2]), 1);
});

test('the drag reads back what it was told, and stops when it ends', ()=>{
    const m = machine();
    const list = m.comctl.ImageList_Create.handler([16, 16, 0, 0, 0]);
    m.comctl.ImageList_Add.handler([list, 0x111, 0]);
    m.comctl.ImageList_BeginDrag.handler([list, 0, 3, 4]);
    m.comctl.ImageList_DragEnter.handler([0x99, 10, 20]);
    m.comctl.ImageList_DragMove.handler([30, 40]);

    assert.equal(m.comctl.ImageList_GetDragImage.handler([0x100, 0x110]), list);
    assert.equal(m.get32(0x100), 30);
    assert.equal(m.get32(0x104), 40);
    assert.equal(m.get32(0x110), 3, 'the hotspot is the one BeginDrag was given');
    assert.equal(m.get32(0x114), 4);

    m.comctl.ImageList_EndDrag.handler([]);
    assert.equal(m.comctl.ImageList_GetDragImage.handler([0x100, 0x110]), 0);
    assert.equal(m.comctl.ImageList_DragMove.handler([1, 1]), 0);
});

test('a structure of the wrong size is refused rather than half read', ()=>{
    const m = machine();
    m.put32(0x200, 8);
    assert.equal(m.comctl.InitCommonControlsEx.handler([0x200]), 1);
    m.put32(0x200, 12);
    assert.equal(m.comctl.InitCommonControlsEx.handler([0x200]), 0);

    m.put32(0x210, 16);
    assert.equal(m.comctl._TrackMouseEvent.handler([0x210]), 1);
    m.put32(0x210, 24);
    assert.equal(m.comctl._TrackMouseEvent.handler([0x210]), 0);
});

test('_TrackMouseEvent is user32\'s TrackMouseEvent when there is one to hand it to', ()=>{
    // comctl32 documents _TrackMouseEvent as calling TrackMouseEvent where
    // the system has it, so the request is tracked and the answer is its.
    const memory = new Uint8Array(0x40);
    /** @type {number[]} */
    const asked = [];
    const comctl = /** @type {any} */ (createComctlFunctions({
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        trackMouseEvent: request=>{
            asked.push(request);
            return 0;
        },
    }));
    assert.equal(comctl._TrackMouseEvent.handler([0x20]), 0, 'its answer, a refusal included');
    assert.deepEqual(asked, [0x20]);
});

test('InitCommonControls is the export ordinal 17 names, and takes nothing', ()=>{
    const m = machine();
    assert.equal(COMCTL32_ORDINALS[17], 'InitCommonControls');
    assert.equal(m.comctl.InitCommonControls.argBytes, 0);
    assert.equal(m.comctl.InitCommonControls.handler([]), 0);
});

test('the ordinal-only entry point and the two drawing calls declare what they pop', ()=>{
    const fns = createComctlFunctions({ readMemory: ()=>new Uint8Array(4), writeMemory: ()=>{} });
    assert.equal(fns.InitCommonControls.argBytes, 0);
    assert.equal(fns.InitCommonControls.handler(), 0);
    assert.equal(fns.ImageList_Draw.argBytes, 24);
    assert.equal(fns.ImageList_Draw.handler([0x40, 0, 0x50, 0, 0, 0]), 0);
    assert.equal(fns.ImageList_GetImageInfo.argBytes, 12);
    assert.equal(fns.ImageList_GetImageInfo.handler(), 0);
});

test('DllGetVersion answers the 5.82 common controls of Windows XP SP3', ()=>{
    // misc.c's test_comctl32_class and imagelist.c's test_imagelist_interop:
    // the library a program gets without a version-6 manifest answers major
    // version 5. The first field says which structure was passed.
    const m = machine();
    m.memory.fill(0xaa);
    const view = new DataView(m.memory.buffer);
    const E_INVALIDARG = 0x80070057 | 0;
    assert.equal(m.comctl.DllGetVersion.argBytes, 4);

    view.setUint32(0x10, 20, true);
    assert.equal(m.comctl.DllGetVersion.handler([0x10]), 0);
    assert.deepEqual([0x14, 0x18, 0x1c, 0x20].map(at=>view.getUint32(at, true)),
        [5, 82, 2900, 2], 'major, minor, build and DLLVER_PLATFORM_NT');
    assert.equal(m.memory[0x24], 0xaa, 'nothing past a DLLVERSIONINFO');

    view.setUint32(0x40, 32, true);
    assert.equal(m.comctl.DllGetVersion.handler([0x40]), 0);
    assert.equal(view.getUint32(0x54, true), 0, 'no flags');
    assert.equal(view.getBigUint64(0x58, true), (5n << 48n) | (82n << 32n) | (2900n << 16n)
        | 5512n, 'ullVersion, a word each');

    view.setUint32(0x80, 24, true);
    assert.equal(m.comctl.DllGetVersion.handler([0x80]), E_INVALIDARG, 'a size of neither');
    assert.equal(view.getUint32(0x84, true), 0xaaaaaaaa, 'and nothing written');
    assert.equal(m.comctl.DllGetVersion.handler([0]), E_INVALIDARG, 'no structure');
});

test('CreateUpDownControl makes the control by its class and sets its buddy, range and '
    + 'position in that order', async()=>{
    const memory = new Uint8Array(0x400);
    /** @type {any[]} */
    const calls = [];
    const comctl = /** @type {any} */ (createComctlFunctions({
        readMemory: (a, n)=>memory.slice(a, a + n),
        writeMemory: (a, b)=>memory.set(b, a),
        allocate: ()=>0x100,
        release: ()=>{},
        user32: name=>({
            handler: (/** @type {number[]} */ args)=>{
                if (name === 'CreateWindowExA')
                {
                    const at = args[1];
                    calls.push([name, String.fromCharCode(...memory.subarray(at,
                        memory.indexOf(0, at))), args[3], args[8], args[9]]);
                    return Promise.resolve(0x10040);
                }
                calls.push([name, ...args]);
                return 0;
            },
        }),
    }));
    assert.equal(comctl.CreateUpDownControl.argBytes, 48);
    const hwnd = await comctl.CreateUpDownControl.handler([0x50800000, 0, 0, 10, 10, 0x10010,
        1, 0x400000, 0x10020, 100, 10, 50]);
    assert.equal(hwnd, 0x10040);
    assert.deepEqual(calls, [
        ['CreateWindowExA', 'msctls_updown32', 0x50800000, 0x10010, 1],
        ['SendMessageA', 0x10040, 0x0469, 0x10020, 0],
        ['SendMessageA', 0x10040, 0x0465, 0, (10 << 16 | 100) >>> 0],
        ['SendMessageA', 0x10040, 0x0467, 0, 50],
    ]);
});
