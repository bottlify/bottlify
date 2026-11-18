/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    LEVEL_CEILING, LEVEL_FLOOR, LEVEL_STEP, createEndpointVolume, levelOf, scalarOf,
} from './endpoint-volume.js';

const S_OK = 0;
const S_FALSE = 1;
const E_POINTER = 0x80004003 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_NOTFOUND = 0x80070490 | 0;
const A = 0x100;
const B = 0x104;
const C = 0x108;

function setup(){
    const bytes = new Uint8Array(0x400);
    const view = new DataView(bytes.buffer);
    let changes = 0;
    /** @type {string[]} */
    const said = [];
    const volume = createEndpointVolume({
        readMemory: (at, length)=>bytes.slice(at, at + length),
        writeMemory: (at, data)=>bytes.set(data, at),
        channels: 2,
        changed: ()=>changes++,
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
    });
    /** @param {string} name @param {number[]} args */
    const call = (name, args)=>/** @type {any} */ (volume.descriptor.methods
        .find(method=>method.name === name)).invoke(/** @type {any} */ ({}), args);
    /** @param {number} value */
    const bits = value=>new Uint32Array(Float32Array.of(value).buffer)[0];
    /** @param {number} at */
    const float = at=>view.getFloat32(at, true);
    return { volume, call, bits, float, view, said, changes: ()=>changes };
}

test('the range, and a level past it refused (Wine\'s render test_endpointvolume)', ()=>{
    const s = setup();
    assert.equal(s.call('GetVolumeRange', [A, 0, 0]), E_POINTER);
    assert.equal(s.call('GetVolumeRange', [A, B, C]), S_OK);
    assert.deepEqual([A, B, C].map(s.float), [LEVEL_FLOOR, LEVEL_CEILING, LEVEL_STEP]);
    assert.equal(s.call('SetMasterVolumeLevel', [s.bits(LEVEL_FLOOR - LEVEL_STEP), 0]),
        E_INVALIDARG);
    assert.equal(s.call('GetMasterVolumeLevel', [A]), S_OK);
    assert.equal(s.call('SetMasterVolumeLevel', [s.bits(s.float(A)), 0]), S_OK);
    assert.equal(s.call('GetMute', [A]), S_OK);
    assert.equal(s.call('SetMute', [s.view.getUint32(A, true), 0]), S_FALSE, 'already so');
    assert.equal(s.call('SetMute', [1, 0]), S_OK);
    assert.equal(s.volume.gain(0), 0, 'muted, silent');
});

test('a level and its scalar are the same amplitude, which the streams play at', ()=>{
    const s = setup();
    assert.equal(scalarOf(LEVEL_CEILING), 1);
    assert.equal(scalarOf(LEVEL_FLOOR), 0, 'the floor is silence');
    assert.ok(Math.abs(levelOf(0.5) - -6.0206) < 1e-3);
    assert.equal(s.call('SetMasterVolumeLevelScalar', [s.bits(0.5), 0]), S_OK);
    s.call('GetMasterVolumeLevel', [A]);
    assert.ok(Math.abs(s.float(A) - -6.0206) < 1e-3);
    assert.equal(s.call('SetMasterVolumeLevelScalar', [s.bits(1.5), 0]), E_INVALIDARG);
    assert.equal(s.call('SetChannelVolumeLevelScalar', [1, s.bits(0.5), 0]), S_OK);
    assert.ok(Math.abs(s.volume.gain(0) - 0.5) < 1e-6);
    assert.ok(Math.abs(s.volume.gain(1) - 0.25) < 1e-6, 'master times channel');
    assert.equal(s.call('SetChannelVolumeLevel', [2, s.bits(0), 0]), E_INVALIDARG, 'channel 2');
    assert.equal(s.changes(), 2, 'each change told to the streams');
});

test('steps walk the range and stop at its ends', ()=>{
    const s = setup();
    assert.equal(s.call('GetVolumeStepInfo', [A, B]), S_OK);
    const steps = s.view.getUint32(B, true);
    assert.equal(steps, (LEVEL_CEILING - LEVEL_FLOOR) / LEVEL_STEP + 1);
    assert.equal(s.view.getUint32(A, true), steps - 1, 'at the ceiling');
    assert.equal(s.call('VolumeStepUp', [0]), S_OK);
    s.call('GetVolumeStepInfo', [A, B]);
    assert.equal(s.view.getUint32(A, true), steps - 1, 'no further');
    s.call('VolumeStepDown', [0]);
    s.call('GetMasterVolumeLevel', [A]);
    assert.equal(s.float(A), LEVEL_CEILING - LEVEL_STEP);
});

test('a change notification is kept and unregistered, and its silence said', ()=>{
    const s = setup();
    assert.equal(s.call('RegisterControlChangeNotify', [0]), E_POINTER);
    assert.equal(s.call('RegisterControlChangeNotify', [0x700]), S_OK);
    assert.equal(s.said.length, 1);
    assert.equal(s.call('UnregisterControlChangeNotify', [0x700]), S_OK);
    assert.equal(s.call('UnregisterControlChangeNotify', [0x700]), E_NOTFOUND);
    assert.equal(s.call('QueryHardwareSupport', [A]), S_OK);
    assert.equal(s.view.getUint32(A, true), 0);
    assert.equal(s.call('GetChannelCount', [A]), S_OK);
    assert.equal(s.view.getUint32(A, true), 2);
});
