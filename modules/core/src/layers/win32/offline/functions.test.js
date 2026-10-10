/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNetbiosFunctions, createSensFunctions, createTelephonyFunctions }
    from './functions.js';

const NCB = 0x100;
const LANA = 0x200;
const OUT = 0x300;
const COUNT = 0x304;

function setup(){
    const bytes = new Uint8Array(0x400);
    /** @type {number[]} */
    const errors = [];
    const host = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.slice(at, at + n),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>bytes.set(data, at),
        setLastError: (/** @type {number} */ code)=>errors.push(code),
    };
    const view = new DataView(bytes.buffer);
    return { bytes, view, errors, host };
}

test('NetBIOS enumerates no adapters and refuses a command on one', ()=>{
    const { bytes, view, host } = setup();
    const { Netbios } = createNetbiosFunctions(host);
    bytes[NCB] = 0x37;
    view.setUint32(NCB + 4, LANA, true);
    view.setUint16(NCB + 8, 255, true);
    bytes[LANA] = 7;
    assert.equal(Netbios.handler([NCB]), 0);
    assert.equal(bytes[LANA], 0, 'LANA_ENUM.length');
    view.setUint16(NCB + 8, 0, true);
    assert.equal(Netbios.handler([NCB]), 0x01, 'no room for the list');
    bytes[NCB] = 0x32 | 0x80;
    assert.equal(Netbios.handler([NCB]), 0x23);
    assert.equal(bytes[NCB + 1], 0x23, 'ncb_retcode');
    assert.equal(bytes[NCB + 49], 0x23, 'ncb_cmd_cplt');
    assert.equal(Netbios.argBytes, 4);
});

test('TAPI initialises with no line devices and refuses every device and line', ()=>{
    const { view, host } = setup();
    const tapi = createTelephonyFunctions(host);
    view.setUint32(COUNT, 9, true);
    assert.equal(tapi.lineInitialize.handler([OUT, 0, 0, 0, COUNT]), 0);
    const app = view.getUint32(OUT, true);
    assert.notEqual(app, 0);
    assert.equal(view.getUint32(COUNT, true), 0);
    assert.equal(tapi.lineNegotiateAPIVersion.handler([app, 0, 0x10003, 0x20000, OUT, 0]),
        0x80000002);
    assert.equal(tapi.lineOpen.handler([app, 0]), 0x80000002);
    assert.equal(tapi.lineGetDevCaps.handler([app + 1, 0]), 0x80000015);
    assert.equal(tapi.lineClose.handler(), 0x8000002b);
    assert.equal(tapi.lineAnswer.handler(), 0x80000018);
    assert.equal(tapi.lineShutdown.handler([app]), 0);
    assert.equal(tapi.lineShutdown.handler([app]), 0x80000015, 'shut down already');
    assert.equal(tapi.lineInitialize.handler([0, 0, 0, 0, COUNT]), 0x80000035);
    assert.deepEqual(Object.fromEntries(Object.entries(tapi).map(([k, v])=>[k, v.argBytes])), {
        lineInitialize: 20, lineShutdown: 4, lineNegotiateAPIVersion: 24, lineGetDevCaps: 20,
        lineOpen: 36, lineClose: 4, lineMakeCall: 20, lineGetID: 24, lineAnswer: 12 });
});

test('the network is not alive, and that is not an error', ()=>{
    const { errors, host } = setup();
    const { IsNetworkAlive } = createSensFunctions(host);
    assert.equal(IsNetworkAlive.handler(), 0);
    assert.deepEqual(errors, [0]);
});
