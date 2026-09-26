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
