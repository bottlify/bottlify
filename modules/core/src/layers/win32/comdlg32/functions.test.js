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

test('the wide file dialogs are cancelled the same way, over a record of the same sizes', ()=>{
    // OPENFILENAMEW is OPENFILENAMEA with wide string pointers: 76 and 88
    // bytes as well, and nothing in it is written when nothing was chosen.
    const m = machine();
    for (const name of ['GetOpenFileNameW', 'GetSaveFileNameW'])
    {
        for (const size of [76, 88])
        {
            m.put32(0, size);
            assert.equal(m.dialogs[name].handler([0]), 0, `${name} ${size}`);
            assert.equal(m.dialogs.CommDlgExtendedError.handler([]), 0, `${name} ${size}`);
        }
        m.put32(0, 64);
        assert.equal(m.dialogs[name].handler([0]), 0);
        assert.equal(m.dialogs.CommDlgExtendedError.handler([]), 1, `${name}: CDERR_STRUCTSIZE`);
        assert.equal(m.dialogs[name].argBytes, 4);
    }
});

/**
 * The dialogs over a memory a structure is laid out in, with the owner
 * windows that exist and what was said about what is refused.
 *
 * @param {number[]} [windows]
 */
function dialogsOver(windows = [0x100]){
    const memory = new Uint8Array(0x400);
    /** @type {string[]} */
    const said = [];
    const fns = /** @type {any} */ (createCommonDialogFunctions({
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        isWindow: hwnd=>windows.includes(hwnd),
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
    }));
    /** @param {number} at @param {number[]} values */
    const put32 = (at, values)=>memory.set(new Uint8Array(new Uint32Array(values).buffer), at);
    /** @param {number} at @param {number} value */
    const put16 = (at, value)=>memory.set([value & 0xff, value >>> 8], at);
    const error = ()=>fns.CommDlgExtendedError.handler([]);
    return { memory, fns, put32, put16, error, said };
}

const CDERR_STRUCTSIZE = 0x0001;
const CDERR_INITIALIZATION = 0x0002;
const CDERR_NOHINSTANCE = 0x0004;
const CDERR_DIALOGFAILURE = 0xffff;
const PDERR_NODEFAULTPRN = 0x1008;
const PDERR_RETDEFFAILURE = 0x1009;
const FRERR_BUFFERLENGTHZERO = 0x4001;
const RECORD = 0x10;

test('the colour and font pickers are cancelled, after their structure is checked', ()=>{
    const m = dialogsOver();
    for (const [name, size] of /** @type {[string, number][]} */ ([['ChooseColorA', 36],
        ['ChooseColorW', 36], ['ChooseFontA', 60], ['ChooseFontW', 60]]))
    {
        m.put32(RECORD, [size]);
        assert.equal(m.fns[name].handler([RECORD]), 0, name);
        assert.equal(m.error(), 0, `${name}: cancelled, which is no fault`);
        m.put32(RECORD, [size + 4]);
        assert.equal(m.fns[name].handler([RECORD]), 0);
        assert.equal(m.error(), CDERR_STRUCTSIZE, name);
        assert.equal(m.fns[name].handler([0]), 0);
        assert.equal(m.error(), CDERR_INITIALIZATION, `${name}: no structure`);
        assert.equal(m.fns[name].argBytes, 4);
    }
});

test('PrintDlg and PageSetupDlg find no printer, and the default asked with settings is refused',
    ()=>{
        const m = dialogsOver();
        const PD_RETURNDEFAULT = 0x0400;
        for (const [name, size, flags, devMode] of /** @type {[string, number, number, number][]} */ ([
            ['PrintDlgA', 66, 20, 8], ['PrintDlgW', 66, 20, 8],
            ['PageSetupDlgA', 84, 16, 8], ['PageSetupDlgW', 84, 16, 8]]))
        {
            m.memory.fill(0);
            m.put32(RECORD, [size, 0x100]);
            assert.equal(m.fns[name].handler([RECORD]), 0, name);
            assert.equal(m.error(), PDERR_NODEFAULTPRN, `${name}: no printer installed`);
            m.put32(RECORD + flags, [PD_RETURNDEFAULT]);
            assert.equal(m.fns[name].handler([RECORD]), 0);
            assert.equal(m.error(), PDERR_NODEFAULTPRN, `${name}: no default to return`);
            m.put32(RECORD + devMode, [0x55]);
            assert.equal(m.fns[name].handler([RECORD]), 0);
            assert.equal(m.error(), PDERR_RETDEFFAILURE, `${name}: settings handed in`);
            m.put32(RECORD, [size - 2]);
            m.fns[name].handler([RECORD]);
            assert.equal(m.error(), CDERR_STRUCTSIZE, name);
            m.fns[name].handler([0]);
            assert.equal(m.error(), CDERR_INITIALIZATION, name);
        }
        assert.equal(m.said.filter(line=>line.startsWith('PrintDlgA:')).length, 1, 'said once');
    });

test('PrintDlgEx answers an HRESULT: the argument, the owner, then no printer', ()=>{
    const m = dialogsOver();
    const E_INVALIDARG = 0x80070057;
    const E_HANDLE = 0x80070006;
    const E_FAIL = 0x80004005;
    for (const name of ['PrintDlgExA', 'PrintDlgExW'])
    {
        m.memory.fill(0);
        assert.equal(m.fns[name].handler([0]), E_INVALIDARG);
        m.put32(RECORD, [66, 0x100]);
        assert.equal(m.fns[name].handler([RECORD]), E_INVALIDARG, 'the wrong size');
        m.put32(RECORD, [84, 0x999]);
        assert.equal(m.fns[name].handler([RECORD]), E_HANDLE, 'an owner that is no window');
        m.put32(RECORD, [84, 0x100]);
        assert.equal(m.fns[name].handler([RECORD]), E_FAIL);
        assert.equal(m.error(), PDERR_NODEFAULTPRN);
    }
});

test('Find and Replace check their structure, then refuse to make a window', ()=>{
    const m = dialogsOver();
    const FR_ENABLETEMPLATE = 0x0020;
    for (const name of ['FindTextA', 'FindTextW', 'ReplaceTextA', 'ReplaceTextW'])
    {
        const replace = name.startsWith('Replace');
        m.memory.fill(0);
        assert.equal(m.fns[name].handler([0]), 0);
        assert.equal(m.error(), CDERR_INITIALIZATION, name);
        m.put32(RECORD, [36]);
        m.fns[name].handler([RECORD]);
        assert.equal(m.error(), CDERR_STRUCTSIZE, name);
        m.put32(RECORD, [40, 0x999]);
        m.fns[name].handler([RECORD]);
        assert.equal(m.error(), CDERR_DIALOGFAILURE, `${name}: no owner window`);
        m.put32(RECORD, [40, 0x100, 0, 0, 0x200, 0]);
        m.fns[name].handler([RECORD]);
        assert.equal(m.error(), FRERR_BUFFERLENGTHZERO, `${name}: a buffer of no length`);
        m.put16(RECORD + 24, 80);
        if (replace)
        {
            m.fns[name].handler([RECORD]);
            assert.equal(m.error(), FRERR_BUFFERLENGTHZERO, `${name}: nothing to replace with`);
            m.put32(RECORD + 20, [0x280]);
        }
        m.put32(RECORD + 12, [FR_ENABLETEMPLATE]);
        m.fns[name].handler([RECORD]);
        assert.equal(m.error(), CDERR_NOHINSTANCE, `${name}: a template with no instance`);
        m.put32(RECORD + 12, [0]);
        assert.equal(m.fns[name].handler([RECORD]), 0, `${name}: no window`);
        assert.equal(m.error(), CDERR_DIALOGFAILURE, `${name}: the dialog could not be made`);
        assert.equal(m.fns[name].argBytes, 4);
    }
    assert.equal(m.said.length, 4, 'each said once');
});

test('GetFileTitleW is GetFileTitleA in UTF-16', ()=>{
    const m = dialogsOver();
    /** @param {string} text */
    const wide = text=>new Uint8Array(Uint16Array.from(`${text}\0`, c=>c.charCodeAt(0)).buffer);
    m.memory.set(wide('C:\\Saves\\slot€.sav'), 0x40);
    assert.equal(m.fns.GetFileTitleW.handler([0x40, 0x200, 32]), 0);
    assert.deepEqual([...m.memory.subarray(0x200, 0x200 + 20)], [...wide('slot€.sav')]);
    assert.equal(m.fns.GetFileTitleW.handler([0x40, 0x200, 4]), 10, 'the room it needs');
    m.memory.set(wide('C:\\Saves\\'), 0x40);
    assert.equal(m.fns.GetFileTitleW.handler([0x40, 0x200, 32]), -1);
    assert.equal(m.fns.GetFileTitleW.handler([0, 0x200, 32]), -1);
    assert.equal(m.fns.GetFileTitleW.argBytes, 12);
});

test('GetFileTitleW reads a path that ends just short of the end of its memory', ()=>{
    // Past the end lies another allocation, or nothing: memory refuses a read
    // that runs into it, as the memory layer refuses one past a region's end.
    const memory = new Uint8Array(0x400);
    const end = memory.length;
    const fns = /** @type {any} */ (createCommonDialogFunctions({
        readMemory: (address, length)=>{
            assert.ok(address + length <= end, `read of ${length} bytes at`
                + ` 0x${address.toString(16)} runs past the end of memory`);
            return memory.slice(address, address + length);
        },
        writeMemory: (address, bytes)=>memory.set(bytes, address),
    }));
    const path = new Uint8Array(Uint16Array.from('C:\\slot.sav\0', c=>c.charCodeAt(0)).buffer);
    const at = end - 8 - path.length;
    memory.set(path, at);
    assert.equal(fns.GetFileTitleW.handler([at, 0x100, 32]), 0);
    assert.equal(new TextDecoder('utf-16le').decode(memory.subarray(0x100, 0x100 + 16)),
        'slot.sav');
});
