/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImmFunctions } from './functions.js';

function machine(){
    const memory = new Uint8Array(0x100).fill(0xcd);
    const host = {
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>
            memory.set(b, a),
    };
    return { memory, imm: /** @type {any} */ (createImmFunctions(host)) };
}

test('the two associate calls report different kinds of answer', ()=>{
    // One answers with the previous context and one with a boolean. A caller
    // that tests the first as a boolean concludes it failed.
    const m = machine();
    assert.equal(m.imm.ImmAssociateContext.handler([0x40, 0]), 0,
        'a handle, and there was never a previous one');
    assert.equal(m.imm.ImmAssociateContextEx.handler([0x40, 0, 0]), 1,
        'a boolean, and turning the input method off succeeds');
});

test('there is no context to get, and releasing one succeeds anyway', ()=>{
    const m = machine();
    assert.equal(m.imm.ImmGetContext.handler([0x40]), 0);
    assert.equal(m.imm.ImmReleaseContext.handler([0x40, 0]), 1);
});

test('the conversion status is written, not left holding the caller\'s stack', ()=>{
    const m = machine();
    assert.equal(m.imm.ImmGetConversionStatus.handler([0, 0x10, 0x20]), 1);
    assert.deepEqual([...m.memory.slice(0x10, 0x14)], [0, 0, 0, 0]);
    assert.deepEqual([...m.memory.slice(0x20, 0x24)], [0, 0, 0, 0]);

    // A null pointer is legal for either, and must not be written through.
    assert.equal(m.imm.ImmGetConversionStatus.handler([0, 0, 0]), 1);
});

test('the input method is never open, which is the state a game is asking for', ()=>{
    const m = machine();
    // An open input method is what makes a program stop treating keystrokes as
    // its own, so FALSE here is the answer it wants rather than a refusal.
    assert.equal(m.imm.ImmGetOpenStatus.handler([0]), 0);
    assert.equal(m.imm.ImmGetOpenStatus.argBytes, 4);
});

test('turning the input method off succeeds, for a thread or the whole process', ()=>{
    const m = machine();
    assert.equal(m.imm.ImmDisableIME.argBytes, 4);
    assert.equal(m.imm.ImmDisableIME.handler([0xffffffff]), 1);
    assert.equal(m.imm.ImmDisableIME.handler([0]), 1);
});

test('there is no input method editor, no candidate list and nothing to open or simulate', ()=>{
    const m = machine();
    assert.equal(m.imm.ImmIsIME.argBytes, 4);
    assert.equal(m.imm.ImmIsIME.handler([0x04090409]), 0);
    assert.equal(m.imm.ImmSetOpenStatus.argBytes, 8);
    assert.equal(m.imm.ImmSetOpenStatus.handler([0, 1]), 0, 'there is no context to open one on');
    assert.equal(m.imm.ImmSimulateHotKey.argBytes, 8);
    assert.equal(m.imm.ImmSimulateHotKey.handler([0x40, 1]), 0);
});

test('the candidate list count is zero and written, for a caller reads it whatever the size', ()=>{
    const m = machine();
    assert.equal(m.imm.ImmGetCandidateListCountA.argBytes, 8);
    assert.equal(m.imm.ImmGetCandidateListCountA.handler([0, 0x30]), 0);
    assert.deepEqual([...m.memory.slice(0x30, 0x34)], [0, 0, 0, 0]);
    // A null pointer is legal and must not be written through.
    assert.equal(m.imm.ImmGetCandidateListCountA.handler([0, 0]), 0);
});

test('a context cannot be made, and so none can be destroyed', ()=>{
    const m = machine();
    assert.equal(m.imm.ImmCreateContext.argBytes, 0);
    assert.equal(m.imm.ImmCreateContext.handler([]), 0);
    assert.equal(m.imm.ImmDestroyContext.argBytes, 4);
    assert.equal(m.imm.ImmDestroyContext.handler([0x1234]), 0);
});

test('nothing is being composed, in either width, and the buffer is not touched', ()=>{
    /** @type {number[]} */
    const errors = [];
    const memory = new Uint8Array(0x100).fill(0xcd);
    const imm = /** @type {any} */ (createImmFunctions({
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>memory.set(b, a),
        setLastError: (/** @type {number} */ code)=>errors.push(code),
    }));
    const GCS_COMPSTR = 0x8;
    const GCS_RESULTSTR = 0x800;
    for (const name of ['ImmGetCompositionStringA', 'ImmGetCompositionStringW'])
    {
        assert.equal(imm[name].argBytes, 16);
        assert.equal(imm[name].handler([0, GCS_COMPSTR, 0x10, 0x40]), 0, name);
        assert.equal(imm[name].handler([0, GCS_RESULTSTR, 0x10, 0x40]), 0, name);
    }
    assert.deepEqual(errors, [], 'a null context leaves the last error alone');
    assert.ok(memory.every(byte=>byte === 0xcd), 'nothing written');
    assert.equal(imm.ImmGetCompositionStringW.handler([0x1234, GCS_COMPSTR, 0x10, 0x40]), 0);
    assert.deepEqual(errors, [6], 'a handle that is not a context: ERROR_INVALID_HANDLE');
});

test('the composition font and window are refused, there being no context to keep them', ()=>{
    /** @type {number[]} */
    const errors = [];
    const imm = /** @type {any} */ (createImmFunctions({
        writeMemory: ()=>{},
        setLastError: (/** @type {number} */ code)=>errors.push(code),
    }));
    for (const name of ['ImmSetCompositionFontA', 'ImmSetCompositionFontW',
        'ImmSetCompositionWindow', 'ImmSetOpenStatus'])
    {
        assert.equal(imm[name].argBytes, 8, name);
        errors.length = 0;
        assert.equal(imm[name].handler([0, 0x40]), 0, `${name} with no context`);
        assert.equal(imm[name].handler([0x1234, 0x40]), 0, `${name} with a foreign one`);
        assert.deepEqual(errors, [6, 6], `${name}: ERROR_INVALID_HANDLE`);
    }
    assert.equal(machine().imm.ImmSetCompositionWindow.handler([0, 0]), 0,
        'the same answer with nowhere to put the error');
});

test('there is no IME window, and nothing about an input method to describe', ()=>{
    const m = machine();
    assert.equal(m.imm.ImmGetDefaultIMEWnd.handler([0x40]), 0);
    assert.equal(m.imm.ImmGetDescriptionA.handler([0x04090409, 0x10, 32]), 0);
    assert.equal(m.memory[0x10], 0xcd, 'the buffer is untouched');
    assert.equal(m.imm.ImmGetProperty.handler([0x04090409, 4]), 0);
    assert.equal(m.imm.ImmEscapeA.handler([0x04090409, 0, 0x1000, 0]), 0);
    const sizes = { ImmGetDefaultIMEWnd: 4, ImmGetDescriptionA: 12, ImmGetProperty: 8,
        ImmEscapeA: 16, ImmGetCandidateListW: 16, ImmGetCandidateListCountW: 8,
        ImmSetCandidateWindow: 8, ImmSetCompositionStringA: 24, ImmIsUIMessageA: 16 };
    for (const [name, bytes] of Object.entries(sizes))
    {
        assert.equal(m.imm[name].argBytes, bytes, name);
    }
});

test('the candidate calls answer no lists, the wide count written as the narrow one is', ()=>{
    const m = machine();
    assert.equal(m.imm.ImmGetCandidateListCountW.handler([0, 0x20]), 0);
    assert.deepEqual([...m.memory.slice(0x20, 0x24)], [0, 0, 0, 0]);
    assert.equal(m.imm.ImmGetCandidateListCountW.handler([0, 0]), 0);
    assert.equal(m.imm.ImmGetCandidateListW.handler([0, 0, 0x30, 64]), 0);
    assert.equal(m.memory[0x30], 0xcd);
});

test('setting a context\'s candidate window or composition string is refused for the handle',
    ()=>{
        /** @type {number[]} */
        const errors = [];
        const imm = /** @type {any} */ (createImmFunctions({
            writeMemory: ()=>{}, setLastError: code=>errors.push(code),
        }));
        assert.equal(imm.ImmSetCandidateWindow.handler([0, 0x10]), 0);
        assert.equal(imm.ImmSetCompositionStringA.handler([0, 9, 0x10, 4, 0, 0]), 0);
        assert.deepEqual(errors, [6, 6], 'ERROR_INVALID_HANDLE');
    });

test('ImmIsUIMessage knows the IME messages and hands them to the window it is given', ()=>{
    /** @type {number[][]} */
    const sent = [];
    const imm = /** @type {any} */ (createImmFunctions({
        writeMemory: ()=>{},
        sendMessage: (hwnd, message, wParam, lParam)=>{
            sent.push([hwnd, message, wParam, lParam]);
            return 0;
        },
    }));
    assert.equal(imm.ImmIsUIMessageA.handler([0, 0x10f, 1, 2]), 1, 'WM_IME_COMPOSITION');
    assert.equal(imm.ImmIsUIMessageA.handler([0, 0x282, 1, 2]), 1, 'WM_IME_NOTIFY');
    assert.equal(imm.ImmIsUIMessageA.handler([0, 0x100, 1, 2]), 0, 'WM_KEYDOWN is not one');
    assert.equal(imm.ImmIsUIMessageA.handler([0, 0x286, 1, 2]), 0, 'WM_IME_CHAR is not one');
    assert.deepEqual(sent, [], 'no window, nothing sent');
    assert.equal(imm.ImmIsUIMessageA.handler([0x40, 0x10d, 3, 4]), 1);
    assert.equal(imm.ImmIsUIMessageA.handler([0x40, 0x100, 3, 4]), 0);
    assert.deepEqual(sent, [[0x40, 0x10d, 3, 4]], 'only the IME message reaches it');
});
