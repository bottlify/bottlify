/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommonDialogFunctions } from './functions.js';

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
