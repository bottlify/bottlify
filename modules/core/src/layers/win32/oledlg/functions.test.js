/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OLEDLG_ORDINALS, createOledlgFunctions } from './functions.js';

const OLEUI_CANCEL = 2;
const OLEUI_ERR_STRUCTURENULL = 101;
const OLEUI_ERR_CBSTRUCTINCORRECT = 103;
const MF_BYPOSITION = 0x400;
const MF_GRAYED = 0x1;

/** @param {4 | 8} [pointerSize] */
function setup(pointerSize = 4){
    const memory = new Uint8Array(0x10000);
    /** @type {string[]} */
    const said = [];
    /** @type {any[][]} */
    const menu = [];
    let next = 0x8000;
    const fns = createOledlgFunctions({
        pointerSize,
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        lent: (bytes, use)=>{
            const at = next;
            next += bytes.length;
            memory.set(bytes, at);
            return use(at);
        },
        user32: ()=>({
            DeleteMenu: { handler: (/** @type {number[]} */ args)=>menu.push(['delete', ...args]) },
            InsertMenuA: { handler: (/** @type {number[]} */ args)=>menu.push(['insertA', ...args,
                String.fromCharCode(...memory.subarray(args[4], memory.indexOf(0, args[4])))]) },
            InsertMenuW: { handler: (/** @type {number[]} */ args)=>
                menu.push(['insertW', ...args]) },
        }),
        divergence: (api, detail, kind)=>said.push(`${api}: ${detail}${kind ? ` (${kind})` : ''}`),
    });
    /** @param {number} address @param {number} value */
    const setU32 = (address, value)=>new DataView(memory.buffer).setUint32(address, value, true);
    return { fns, memory, said, menu, setU32 };
}

test('a dialog refuses no structure and a wrong size, otherwise cancelled as a loss', ()=>{
    const { fns, said, setU32 } = setup();
    assert.equal(fns.OleUIInsertObjectA.handler([0]), OLEUI_ERR_STRUCTURENULL);
    setU32(0x100, 100);
    assert.equal(fns.OleUIInsertObjectA.handler([0x100]), OLEUI_ERR_CBSTRUCTINCORRECT);
    setU32(0x100, 112);
    assert.equal(fns.OleUIInsertObjectA.handler([0x100]), OLEUI_CANCEL);
    assert.deepEqual(said,
        ['OleUIInsertObjectA: the dialog is not shown: answered as cancelled (loss)']);
    setU32(0x100, 580);
    assert.equal(fns.OleUIChangeIconW.handler([0x100]), OLEUI_CANCEL);
    assert.equal(fns.OleUIChangeIconA.handler([0x100]), OLEUI_ERR_CBSTRUCTINCORRECT);
});

test('a 64-bit caller\'s structures are checked at their 64-bit sizes', ()=>{
    const { fns, setU32 } = setup(8);
    setU32(0x100, 112);
    assert.equal(fns.OleUIInsertObjectW.handler([0x100]), OLEUI_ERR_CBSTRUCTINCORRECT);
    setU32(0x100, 176);
    assert.equal(fns.OleUIInsertObjectW.handler([0x100]), OLEUI_CANCEL);
});

test('the verb menu for no object is a greyed "&Object" at the place, no cascade, and FALSE', ()=>{
    const { fns, memory, menu, said, setU32 } = setup();
    setU32(0x200, 0xdeadbeef);
    assert.equal(fns.OleUIAddVerbMenuA.argBytes, 36);
    assert.equal(fns.OleUIAddVerbMenuA.handler([0, 0, 0x55, 3, 100, 200, 0, 0, 0x200]), 0);
    assert.equal(new DataView(memory.buffer).getUint32(0x200, true), 0);
    assert.deepEqual(menu, [['delete', 0x55, 3, MF_BYPOSITION],
        ['insertA', 0x55, 3, MF_BYPOSITION | MF_GRAYED, 0, 0x8000, '&Object']]);
    assert.deepEqual(said, []);
});

test('MFC\'s numbers name every export', ()=>{
    const { fns } = setup();
    assert.equal(Object.keys(OLEDLG_ORDINALS).length, 23);
    for (const name of Object.values(OLEDLG_ORDINALS))
    {
        assert.ok(fns[name], name);
    }
    assert.equal(fns.OleUIPromptUserA.convention, 'cdecl');
    assert.equal(fns.OleUIUpdateLinksW.argBytes, 16);
});
