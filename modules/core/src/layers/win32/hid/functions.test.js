/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createHidFunctions } from './functions.js';

function setup(){
    const bytes = new Uint8Array(0x100);
    /** @type {number[]} */
    const errors = [];
    const fns = createHidFunctions({
        writeMemory: (address, data)=>bytes.set(data, address),
        setLastError: code=>errors.push(code),
    });
    return { bytes, errors, fns };
}

test('HidD_GetHidGuid writes the HID interface class', ()=>{
    const { bytes, fns } = setup();
    fns.HidD_GetHidGuid.handler([0x10]);
    // {4D1E55B2-F16F-11CF-88CB-001111000030}, as a GUID lies in memory.
    assert.deepEqual([...bytes.subarray(0x10, 0x20)], [0xb2, 0x55, 0x1e, 0x4d, 0x6f, 0xf1, 0xcf,
        0x11, 0x88, 0xcb, 0x00, 0x11, 0x11, 0x00, 0x00, 0x30]);
    fns.HidD_GetHidGuid.handler([0]);
});

test('with no HID device, a call on a device fails as one on a handle that is none', ()=>{
    const { errors, fns } = setup();
    assert.equal(fns.HidD_GetAttributes.handler(), 0);
    assert.equal(fns.HidD_GetPreparsedData.handler(), 0);
    assert.equal(fns.HidD_GetProductString.handler(), 0);
    assert.equal(fns.HidD_SetFeature.handler(), 0);
    assert.deepEqual(errors, [6, 6, 6, 6], 'ERROR_INVALID_HANDLE each time');
    assert.equal(fns.HidP_GetCaps.handler(), 0xc0110001, 'HIDP_STATUS_INVALID_PREPARSED_DATA');
    assert.equal(fns.HidD_GetProductString.argBytes, 12);
});
