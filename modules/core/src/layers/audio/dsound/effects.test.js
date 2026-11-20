/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    FORMAT_WaveFormatEx, IID_IMediaObject, IID_IMediaObjectInPlace, MEDIASUBTYPE_PCM,
    MEDIATYPE_Audio, STANDARD_EFFECTS, registerStandardEffects,
} from './effects.js';
import { parseGuid } from '../../win32/ole32/guid.js';
import { withPointers } from '../../memory/pointers.fixture.js';

const S_OK = 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_POINTER = 0x80004003 | 0;
const DMO_E_TYPE_NOT_ACCEPTED = 0x80040205 | 0;
const DMO_E_INVALIDSTREAMINDEX = 0x80040201 | 0;

/** The effects registered over a fake registry and 64 KiB of memory. */
function machine(){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    /** @type {Map<string, () => any>} */
    const classes = new Map();
    /** @type {string[]} */
    const said = [];
    registerStandardEffects({ registerClass: (clsid, factory)=>classes.set(clsid, factory) },
        withPointers({
            readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
                bytes.slice(at, at + length),
            writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>
                bytes.set(data, at),
            divergence: (/** @type {string} */ api, /** @type {string} */ detail)=>
                said.push(`${api}: ${detail}`),
        }));
    /**
     * One effect's methods by interface and name.
     *
     * @param {string} name
     */
    const make = name=>{
        const effect = /** @type {any} */ (STANDARD_EFFECTS.find(entry=>entry.name === name));
        const definition = /** @type {any} */ (classes.get(effect.clsid))();
        /** @param {string} iid @param {string} method @param {number[]} [args] */
        return (iid, method, args = [])=>definition.interfaces
            .find((/** @type {any} */ entry)=>entry.id === iid).methods
            .find((/** @type {any} */ entry)=>entry.name === method).invoke({}, args);
    };
    /**
     * A DMO_MEDIA_TYPE of a WAVEFORMATEX at 0x100, the format at 0x200.
     *
     * @param {number} bits @param {number} [channels]
     */
    const mediaType = (bits, channels = 1)=>{
        bytes.fill(0, 0x100, 0x220);
        bytes.set(/** @type {Uint8Array} */ (parseGuid(MEDIATYPE_Audio)), 0x100);
        bytes.set(/** @type {Uint8Array} */ (parseGuid(MEDIASUBTYPE_PCM)), 0x110);
        bytes.set(/** @type {Uint8Array} */ (parseGuid(FORMAT_WaveFormatEx)), 0x100 + 44);
        view.setUint32(0x100 + 64, 18, true);
        view.setUint32(0x100 + 68, 0x200, true);
        view.setUint16(0x200, 1, true);
        view.setUint16(0x202, channels, true);
        view.setUint32(0x204, 11025, true);
        view.setUint16(0x20c, channels * bits / 8, true);
        view.setUint16(0x20e, bits, true);
        return 0x100;
    };
    return { bytes, view, classes, make, mediaType, said };
}

test('every standard effect is a class, its defaults in range', ()=>{
    const m = machine();
    assert.equal(m.classes.size, 9);
    for (const effect of STANDARD_EFFECTS)
    {
        for (const field of effect.fields)
        {
            assert.ok(field.value >= field.min && field.value <= field.max,
                `${effect.name}.${field.name}`);
        }
    }
});

test('an effect takes 8- and 16-bit PCM in and gives the same out, and no other', ()=>{
    // Wine's dsound8 test_effects: the equalizer on an 8-bit mono buffer.
    const m = machine();
    const call = m.make('ParamEq');
    assert.equal(call(IID_IMediaObject, 'SetInputType', [0, m.mediaType(8), 0]), S_OK);
    assert.equal(call(IID_IMediaObject, 'SetOutputType', [0, m.mediaType(8), 0]), S_OK);
    assert.equal(call(IID_IMediaObject, 'SetOutputType', [0, m.mediaType(16), 0]),
        DMO_E_TYPE_NOT_ACCEPTED, 'out is what went in');
    assert.equal(call(IID_IMediaObject, 'SetInputType', [0, m.mediaType(24), 0]),
        DMO_E_TYPE_NOT_ACCEPTED);
    assert.equal(call(IID_IMediaObject, 'SetInputType', [1, m.mediaType(8), 0]),
        DMO_E_INVALIDSTREAMINDEX);
    assert.equal(call(IID_IMediaObjectInPlace, 'Process', [4, 0x300, 0, 0, 0]), S_OK);
    assert.equal(m.said.length, 1, 'the sound it does not change is said');
});

test('parameters start at their defaults, are kept when in range and refused outside it', ()=>{
    const m = machine();
    const eq = m.make('ParamEq');
    const IID_PARAMEQ = '{C03CA9FE-FE90-4204-8078-82334CD177DA}';
    assert.equal(eq(IID_PARAMEQ, 'GetAllParameters', [0x400]), S_OK);
    assert.deepEqual([0, 4, 8].map(at=>m.view.getFloat32(0x400 + at, true)), [8000, 12, 0]);
    m.view.setFloat32(0x400, 1000, true);
    m.view.setFloat32(0x408, -6, true);
    assert.equal(eq(IID_PARAMEQ, 'SetAllParameters', [0x400]), S_OK);
    m.view.setFloat32(0x408, 99, true);
    assert.equal(eq(IID_PARAMEQ, 'SetAllParameters', [0x400]), E_INVALIDARG);
    assert.equal(eq(IID_PARAMEQ, 'GetAllParameters', [0x500]), S_OK);
    assert.deepEqual([0, 8].map(at=>m.view.getFloat32(0x500 + at, true)), [1000, -6],
        'a refused set keeps what was there');
    assert.equal(eq(IID_PARAMEQ, 'GetAllParameters', [0]), E_POINTER);
});

test('the I3DL2 reverb takes a preset and a quality', ()=>{
    const m = machine();
    const reverb = m.make('I3DL2Reverb');
    const IID_REVERB = '{4B166A6A-0D66-43F3-80E3-EE6280DEE1A4}';
    assert.equal(reverb(IID_REVERB, 'SetPreset', [4]), S_OK, 'the bathroom');
    assert.equal(reverb(IID_REVERB, 'GetAllParameters', [0x400]), S_OK);
    assert.deepEqual([m.view.getInt32(0x404, true), m.view.getInt32(0x41c, true)], [-1200, 1030]);
    assert.equal(reverb(IID_REVERB, 'SetPreset', [30]), E_INVALIDARG);
    assert.equal(reverb(IID_REVERB, 'GetQuality', [0x480]), S_OK);
    assert.equal(m.view.getUint32(0x480, true), 2);
    assert.equal(reverb(IID_REVERB, 'SetQuality', [4]), E_INVALIDARG);
});
