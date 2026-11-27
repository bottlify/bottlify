/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCombaseFunctions } from './functions.js';

function setup(){
    const memory = new Uint8Array(0x10000);
    const view = new DataView(memory.buffer);
    let next = 0x8000;
    /** @type {number[]} */
    const freed = [];
    const fns = createCombaseFunctions({
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        allocate: bytes=>{
            const at = next;
            next += (bytes + 15) & ~15;
            return at;
        },
        free: address=>freed.push(address),
    });
    /** @param {number} at @param {string} text */
    const wide = (at, text)=>{
        [...text, '\0'].forEach((ch, i)=>view.setUint16(at + i * 2, ch.charCodeAt(0), true));
        return at;
    };
    /** @param {number} at @param {number} length */
    const read = (at, length)=>String.fromCharCode(...Array.from({ length },
        (_, i)=>view.getUint16(at + i * 2, true)));
    return { fns, view, wide, read, freed };
}

test('the runtime starts once per apartment kind, and no class of it is registered', ()=>{
    const { fns, view } = setup();
    assert.equal(fns.RoInitialize.handler([1]), 0, 'S_OK');
    assert.equal(fns.RoInitialize.handler([1]), 1, 'S_FALSE: already');
    assert.equal(fns.RoInitialize.handler([0]) >>> 0, 0x80010106, 'RPC_E_CHANGED_MODE');
    view.setUint32(0x100, 0xdead, true);
    assert.equal(fns.RoGetActivationFactory.handler([0x200, 0x300, 0x100]) >>> 0, 0x80040154);
    assert.equal(view.getUint32(0x100, true), 0, 'the out pointer cleared');
    fns.RoUninitialize.handler();
    fns.RoUninitialize.handler();
    assert.equal(fns.RoInitialize.handler([0]), 0, 'stopped: another kind may start it');
});

test('a string is made, read and deleted; a reference is the caller\'s own', ()=>{
    const { fns, view, wide, read, freed } = setup();
    wide(0x200, 'Windows.UI');
    assert.equal(fns.WindowsCreateString.handler([0x200, 10, 0x100]), 0);
    const string = view.getUint32(0x100, true);
    assert.equal(fns.WindowsGetStringLen.handler([string]), 10);
    const text = fns.WindowsGetStringRawBuffer.handler([string, 0x104]);
    assert.equal(read(text, 10), 'Windows.UI');
    assert.equal(view.getUint16(text + 20, true), 0, 'terminated');
    assert.equal(view.getUint32(0x104, true), 10);
    assert.equal(fns.WindowsDeleteString.handler([string]), 0);
    assert.deepEqual(freed, [string]);

    assert.equal(fns.WindowsCreateStringReference.handler([0x200, 10, 0x400, 0x100]), 0);
    const reference = view.getUint32(0x100, true);
    assert.equal(reference, 0x400, 'the caller\'s header');
    assert.equal(fns.WindowsGetStringRawBuffer.handler([reference, 0]), 0x200, 'over its text');
    fns.WindowsDeleteString.handler([reference]);
    assert.equal(freed.length, 1, 'a reference is not freed');
    assert.equal(fns.WindowsCreateStringReference.handler([0x200, 4, 0x400, 0x100]) >>> 0,
        0x80070057, 'text not terminated where the length ends');

    assert.equal(fns.WindowsCreateString.handler([0, 0, 0x100]), 0);
    assert.equal(view.getUint32(0x100, true), 0, 'the empty string is NULL');
    assert.equal(fns.WindowsIsStringEmpty.handler([0]), 1);
    const empty = fns.WindowsGetStringRawBuffer.handler([0, 0x104]);
    assert.notEqual(empty, 0, 'whose text is an empty string, not NULL');
    assert.equal(view.getUint32(0x104, true), 0);
});
