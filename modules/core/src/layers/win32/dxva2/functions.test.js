/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The monitor configuration API: one physical monitor behind the display
 * monitor, with no DDC/CI to read its settings over.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDxva2Functions } from './functions.js';

const MONITOR = 0x10001;

function setup(){
    const bytes = new Uint8Array(0x1000);
    const view = new DataView(bytes.buffer);
    /** @type {number[]} */
    const errors = [];
    const fns = createDxva2Functions({
        readMemory: (at, length)=>bytes.slice(at, at + length),
        writeMemory: (at, data)=>bytes.set(data, at),
        setLastError: code=>errors.push(code >>> 0),
        isMonitor: monitor=>monitor === MONITOR,
    });
    return { fns, view, bytes, errors };
}

test('one physical monitor, a generic one, its handle the caller destroys', ()=>{
    const { fns, view, bytes, errors } = setup();
    assert.equal(fns.GetNumberOfPhysicalMonitorsFromHMONITOR.handler([MONITOR, 0x10]), 1);
    assert.equal(view.getUint32(0x10, true), 1);
    assert.equal(fns.GetNumberOfPhysicalMonitorsFromHMONITOR.handler([0x20002, 0x10]), 0);
    assert.equal(errors.at(-1), 6);
    assert.equal(fns.GetPhysicalMonitorsFromHMONITOR.handler([MONITOR, 2, 0x100]), 0,
        'the count asked must be the count there is');
    assert.equal(fns.GetPhysicalMonitorsFromHMONITOR.handler([MONITOR, 1, 0x100]), 1);
    const handle = view.getUint32(0x100, true);
    assert.notEqual(handle, 0);
    assert.equal(String.fromCharCode(...new Uint16Array(bytes.slice(0x104, 0x104 + 38).buffer)),
        'Generic PnP Monitor');
    assert.equal(fns.DestroyPhysicalMonitors.handler([1, 0x100]), 1);
    assert.equal(fns.DestroyPhysicalMonitor.handler([handle]), 0, 'destroyed already');
});

test('every DDC/CI query fails as a monitor without an I2C bus does', ()=>{
    const { fns, view, errors } = setup();
    fns.GetPhysicalMonitorsFromHMONITOR.handler([MONITOR, 1, 0x100]);
    const handle = view.getUint32(0x100, true);
    assert.equal(fns.GetMonitorBrightness.handler([handle, 0x10, 0x14, 0x18]), 0);
    assert.equal(errors.at(-1), 0xc0262582);
    assert.equal(fns.GetMonitorCapabilities.handler([handle, 0x10, 0x14]), 0);
    assert.equal(fns.GetMonitorCapabilities.handler([0x999, 0x10, 0x14]), 0);
    assert.equal(errors.at(-1), 6, 'a handle not handed out');
    assert.equal(fns.GetMonitorCapabilities.argBytes, 12);
    assert.equal(fns.GetVCPFeatureAndVCPFeatureReply.argBytes, 20);
});
