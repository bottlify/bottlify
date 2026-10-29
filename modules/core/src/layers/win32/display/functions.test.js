/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDwmapiFunctions, createSessionInformationFunctions, createShcoreFunctions }
    from './functions.js';

function setup(){
    const memory = new Uint8Array(0x10000);
    const view = new DataView(memory.buffer);
    /** @type {number[]} */
    const errors = [];
    /** @type {number[]} */
    const freed = [];
    /** @type {import('./functions.js').DisplayHost} */
    const host = {
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        setLastError: code=>errors.push(code),
        windowRect: (hwnd, out)=>{
            if (hwnd !== 0x10010)
            {
                return 0;
            }
            [10, 20, 330, 260].forEach((value, i)=>view.setInt32(out + i * 4, value, true));
            return 1;
        },
        allocate: ()=>0x8000,
        free: address=>freed.push(address),
        userName: 'User',
        computerName: 'BOTTLE',
    };
    return { memory, view, errors, freed, host };
}

test('one 96-DPI monitor, and an awareness the process sets once', ()=>{
    const { view, host } = setup();
    const fns = createShcoreFunctions(host);
    assert.equal(fns.GetDpiForMonitor.handler([1, 0, 0x100, 0x104]), 0);
    assert.deepEqual([view.getUint32(0x100, true), view.getUint32(0x104, true)], [96, 96]);
    assert.equal(fns.SetProcessDpiAwareness.handler([2]), 0);
    assert.equal(fns.SetProcessDpiAwareness.handler([1]) >>> 0, 0x80070005, 'E_ACCESSDENIED');
    assert.equal(fns.GetProcessDpiAwareness.handler([0, 0x108]), 0);
    assert.equal(view.getUint32(0x108, true), 2);
    assert.equal(fns.SetProcessDpiAwareness.handler([3]) >>> 0, 0x80070057);
});

test('composition on, a window\'s frame its rectangle, attributes kept as set', ()=>{
    const { view, host } = setup();
    const fns = createDwmapiFunctions(host);
    assert.equal(fns.DwmIsCompositionEnabled.handler([0x100]), 0);
    assert.equal(view.getUint32(0x100, true), 1);
    assert.equal(fns.DwmGetWindowAttribute.handler([0x10010, 9, 0x200, 16]), 0);
    assert.deepEqual([0, 4, 8, 12].map(at=>view.getInt32(0x200 + at, true)), [10, 20, 330, 260]);
    assert.equal(fns.DwmGetWindowAttribute.handler([0x10010, 14, 0x300, 4]), 0, 'not cloaked');
    view.setUint32(0x400, 1, true);
    assert.equal(fns.DwmSetWindowAttribute.handler([0x10010, 20, 0x400, 4]), 0);
    assert.equal(fns.DwmGetWindowAttribute.handler([0x10010, 20, 0x404, 4]), 0);
    assert.equal(view.getUint32(0x404, true), 1);
    assert.equal(fns.DwmGetWindowAttribute.handler([0x10010, 99, 0x404, 4]) >>> 0, 0x80070057);
});

test('the console session, active, the machine\'s user\'s', ()=>{
    const { view, host, freed } = setup();
    const fns = createSessionInformationFunctions(host);
    assert.equal(fns.WTSQuerySessionInformationW.handler([0, 0xffffffff, 8, 0x100, 0x104]), 1);
    assert.equal(view.getUint32(view.getUint32(0x100, true), true), 0, 'WTSActive');
    assert.equal(fns.WTSQuerySessionInformationW.handler([0, 0xffffffff, 5, 0x100, 0x104]), 1);
    assert.equal(view.getUint32(0x104, true), 10, '"User" and its terminator, in UTF-16');
    fns.WTSFreeMemory.handler([0x8000]);
    assert.deepEqual(freed, [0x8000]);
    assert.equal(fns.WTSQuerySessionInformationW.handler([0, 7, 8, 0x100, 0x104]), 0);
});

test('DirectWrite is refused as a system without it, its factory cleared', async()=>{
    const { createDwriteFunctions } = await import('./functions.js');
    const memory = new Uint8Array(0x100);
    const fns = createDwriteFunctions({
        writeMemory: (address, bytes)=>memory.set(bytes, address),
    });
    memory.fill(0xff, 0x10, 0x14);
    assert.equal(fns.DWriteCreateFactory.handler([0, 0x20, 0x10]) >>> 0, 0x80004001, 'E_NOTIMPL');
    assert.deepEqual([...memory.subarray(0x10, 0x14)], [0, 0, 0, 0]);
});
