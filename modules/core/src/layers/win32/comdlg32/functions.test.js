/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommonDialogFunctions } from './functions.js';
import { decodeAnsi } from '../kernel32/locale.js';

function machine(){
    const memory = new Uint8Array(0x100);
    const host = {
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>
            memory.slice(a, a + n),
    };
    /** @param {number} at @param {number} value */
    const put32 = (at, value)=>memory.set(new Uint8Array([
        value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
    ]), at);
    return { put32,
        dialogs: /** @type {any} */ (createCommonDialogFunctions(host)) };
}

test('a file dialog is cancelled, which is not a fault', ()=>{
    // FALSE with an extended error of zero is how a dialog reports that nothing
    // was chosen, and every caller handles being cancelled. A non-zero code
    // would have it report a fault to the person instead.
    const m = machine();
    m.put32(0, 88);
    assert.equal(m.dialogs.GetOpenFileNameA.handler([0]), 0);
    assert.equal(m.dialogs.CommDlgExtendedError.handler([]), 0);

    assert.equal(m.dialogs.GetSaveFileNameA.handler([0]), 0);
    assert.equal(m.dialogs.CommDlgExtendedError.handler([]), 0);
});

test('both sizes the structure has had are accepted', ()=>{
    // A program built against either vintage passes its own, and refusing the
    // one this does not recognise refuses half its callers.
    const m = machine();
    for (const size of [76, 88])
    {
        m.put32(0, size);
        m.dialogs.GetOpenFileNameA.handler([0]);
        assert.equal(m.dialogs.CommDlgExtendedError.handler([]), 0, `size ${size}`);
    }

    m.put32(0, 64);
    m.dialogs.GetOpenFileNameA.handler([0]);
    assert.equal(m.dialogs.CommDlgExtendedError.handler([]), 1, 'CDERR_STRUCTSIZE');
});

test('GetFileTitleA is the name out of the path, or the room it needs, or a refusal', ()=>{
    const memory = new Uint8Array(0x200);
    /** @param {number} at @param {string} text */
    const put = (at, text)=>{
        memory.set(new TextEncoder().encode(`${text}\0`), at);
        return at;
    };
    const fns = createCommonDialogFunctions({
        readMemory: (address, length)=>memory.subarray(address, address + length),
        readCString: (address, maxLength)=>{
            let end = address;
            while (memory[end] !== 0 && end - address < maxLength)
            {
                end++;
            }
            return String.fromCharCode(...memory.subarray(address, end));
        },
        writeMemory: (address, bytes)=>memory.set(bytes, address),
    });
    assert.equal(fns.GetFileTitleA.handler([put(0x10, 'C:\\Games\\Title\\title.exe'), 0x100, 32]),
        0);
    assert.equal(String.fromCharCode(...memory.subarray(0x100, 0x109)), 'title.exe');
    assert.equal(fns.GetFileTitleA.handler([0x10, 0x100, 4]), 10,
        'the room needed, terminator included');
    assert.equal(fns.GetFileTitleA.handler([put(0x10, 'C:\\Games\\'), 0x100, 32]), -1);
    assert.equal(fns.GetFileTitleA.handler([put(0x10, '*.exe'), 0x100, 32]), -1);
    assert.equal(fns.GetFileTitleA.argBytes, 12);
});

test('GetFileTitleA gives the name back in the bytes the path had', ()=>{
    // The memory layer reads the path as Windows-1252, where 0x80 is the euro
    // sign, 0x99 the trade mark and 0x97 an em dash; the title is written in
    // the same page.
    const memory = new Uint8Array(0x200);
    const fns = createCommonDialogFunctions({
        readMemory: (address, length)=>memory.subarray(address, address + length),
        readCString: (address, maxLength)=>{
            let end = address;
            while (memory[end] !== 0 && end - address < maxLength)
            {
                end++;
            }
            return decodeAnsi(memory.subarray(address, end));
        },
        writeMemory: (address, bytes)=>memory.set(bytes, address),
    });
    memory.set([0x43, 0x3a, 0x5c, 0x80, 0x5c, 0x99, 0x97, 0xe9, 0], 0x10);
    assert.equal(fns.GetFileTitleA.handler([0x10, 0x100, 32]), 0);
    assert.deepEqual([...memory.subarray(0x100, 0x104)], [0x99, 0x97, 0xe9, 0]);
});
