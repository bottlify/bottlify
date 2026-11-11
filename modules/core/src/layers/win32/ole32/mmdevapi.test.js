/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComRegistry } from './objects.js';
import {
    CLSID_MMDEVICE_ENUMERATOR, E_NOTFOUND, IID_IMMDEVICE, IID_IMMDEVICE_COLLECTION,
    IID_IMMDEVICE_ENUMERATOR, IID_IPROPERTY_STORE, registerMmDevApiClasses,
} from './mmdevapi.js';

const S_OK = 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const OUT = 0x100;
const KEY = 0x200;
const VARIANT = 0x300;

/** @param {4 | 8} [pointerSize] */
function setup(pointerSize = 4){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    /** @type {string[]} */
    const reported = [];
    /** @type {Map<number, any>} */
    const records = new Map();
    let nextPointer = 0x8000;
    let nextBlock = 0x4000;
    /** @param {number} at */
    const wideAt = at=>{
        let text = '';
        for (let from = at; view.getUint16(from, true) !== 0; from += 2)
        {
            text += String.fromCharCode(view.getUint16(from, true));
        }
        return text;
    };
    const registry = createComRegistry();
    registerMmDevApiClasses({
        registry,
        vtables: {
            publish(object, interfaceId){
                const record = object.interfaceFor(interfaceId);
                if (!record)
                {
                    return 0;
                }
                nextPointer += 0x10;
                records.set(nextPointer, record);
                return nextPointer;
            },
        },
        heap: { allocate: size=>(nextBlock += size + 16) - size - 16 },
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        readWideString: address=>wideAt(address),
        pointerSize,
        divergence: (api, detail)=>reported.push(`${api}: ${detail}`),
    });
    const object = /** @type {any} */ (registry.create(CLSID_MMDEVICE_ENUMERATOR));
    const face = object.interfaceFor(IID_IMMDEVICE_ENUMERATOR);
    return {
        view, reported, wideAt,
        /** @param {string} name @param {number[]} args */
        enumerator: (name, args)=>face.methods.find((/** @type {any} */ m)=>m.name === name)
            .invoke(object, args),
        /** @param {number} pointer @param {string} name @param {number[]} args */
        call(pointer, name, args){
            const record = records.get(pointer);
            assert.ok(record, `no interface at 0x${pointer.toString(16)}`);
            return record.methods.find((/** @type {any} */ m)=>m.name === name)
                .invoke(record.object, args);
        },
        /** @param {number} pointer */
        interfaceAt: pointer=>records.get(pointer).id,
        /** A PROPERTYKEY at KEY. @param {number[]} words the GUID's four dwords @param {number} pid */
        key(words, pid){
            words.forEach((word, index)=>view.setUint32(KEY + index * 4, word, true));
            view.setUint32(KEY + 16, pid, true);
            return KEY;
        },
    };
}

/** PKEY_Device_FriendlyName's and PKEY_AudioEngine_DeviceFormat's GUIDs, as four dwords. */
const DEVICE_PROPERTIES = [0xa45c254e, 0x4efddf1c, 0xd1672080, 0xe050a846];
const ENGINE_FORMAT = [0xf19f064d, 0x4e27082c, 0x826873bc, 0x4c8ebba1];

test('the default render endpoint is the speakers; none of capture, as with no microphone', ()=>{
    const s = setup();
    assert.equal(s.enumerator('GetDefaultAudioEndpoint', [0, 1, OUT]), S_OK);
    const device = s.view.getUint32(OUT, true);
    assert.equal(s.interfaceAt(device), IID_IMMDEVICE);
    assert.equal(s.call(device, 'GetState', [OUT]), S_OK);
    assert.equal(s.view.getUint32(OUT, true), 1, 'DEVICE_STATE_ACTIVE');
    assert.equal(s.call(device, 'GetId', [OUT]), S_OK);
    const id = s.wideAt(s.view.getUint32(OUT, true));
    assert.match(id, /^\{0\.0\.0\.00000000\}\.\{/);

    assert.equal(s.enumerator('GetDefaultAudioEndpoint', [1, 0, OUT]), E_NOTFOUND);
    assert.equal(s.view.getUint32(OUT, true), 0, 'the pointer cleared');
    assert.equal(s.enumerator('GetDefaultAudioEndpoint', [2, 0, OUT]), E_INVALIDARG, 'eAll');
});

test('the endpoints listed by flow, and found again by their id', ()=>{
    const s = setup();
    assert.equal(s.enumerator('EnumAudioEndpoints', [0, 1, OUT]), S_OK);
    const collection = s.view.getUint32(OUT, true);
    assert.equal(s.interfaceAt(collection), IID_IMMDEVICE_COLLECTION);
    assert.equal(s.call(collection, 'GetCount', [OUT]), S_OK);
    assert.equal(s.view.getUint32(OUT, true), 1);
    assert.equal(s.call(collection, 'Item', [1, OUT]), E_INVALIDARG, 'past the last');
    assert.equal(s.call(collection, 'Item', [0, OUT]), S_OK);
    const device = s.view.getUint32(OUT, true);
    s.call(device, 'GetId', [OUT]);
    const id = s.view.getUint32(OUT, true);
    assert.equal(s.enumerator('GetDevice', [id, OUT]), S_OK);
    assert.equal(s.interfaceAt(s.view.getUint32(OUT, true)), IID_IMMDEVICE);

    assert.equal(s.enumerator('EnumAudioEndpoints', [1, 0xf, OUT]), S_OK);
    s.call(s.view.getUint32(OUT, true), 'GetCount', [OUT]);
    assert.equal(s.view.getUint32(OUT, true), 0, 'no capture endpoint');
});

test('the property store names the speakers and the engine\'s float mix format', ()=>{
    const s = setup();
    s.enumerator('GetDefaultAudioEndpoint', [0, 0, OUT]);
    const device = s.view.getUint32(OUT, true);
    assert.equal(s.call(device, 'OpenPropertyStore', [0, OUT]), S_OK);
    const store = s.view.getUint32(OUT, true);
    assert.equal(s.interfaceAt(store), IID_IPROPERTY_STORE);

    assert.equal(s.call(store, 'GetValue', [s.key(DEVICE_PROPERTIES, 14), VARIANT]), S_OK);
    assert.equal(s.view.getUint16(VARIANT, true), 31, 'VT_LPWSTR');
    assert.match(s.wideAt(s.view.getUint32(VARIANT + 8, true)), /^Speakers/);

    assert.equal(s.call(store, 'GetValue', [s.key(ENGINE_FORMAT, 0), VARIANT]), S_OK);
    assert.equal(s.view.getUint16(VARIANT, true), 65, 'VT_BLOB');
    assert.equal(s.view.getUint32(VARIANT + 8, true), 40, 'a WAVEFORMATEXTENSIBLE');
    const format = s.view.getUint32(VARIANT + 12, true);
    assert.deepEqual([0, 2, 4, 14].map(at=>at === 4 ? s.view.getUint32(format + at, true)
        : s.view.getUint16(format + at, true)), [0xfffe, 2, 48000, 32]);

    assert.equal(s.call(store, 'GetValue', [s.key([1, 2, 3, 4], 5), VARIANT]), S_OK);
    assert.equal(s.view.getUint16(VARIANT, true), 0, 'a key not kept is VT_EMPTY');
});

test('in a 64-bit process the pointers are quadwords, a BLOB\'s pointer on its boundary', ()=>{
    const s = setup(8);
    s.view.setUint32(OUT + 4, 0xcccccccc, true);
    s.enumerator('GetDefaultAudioEndpoint', [0, 0, OUT]);
    assert.equal(s.view.getUint32(OUT + 4, true), 0, 'the endpoint whole');
    const device = s.view.getUint32(OUT, true);
    s.call(device, 'OpenPropertyStore', [0, OUT]);
    const store = s.view.getUint32(OUT, true);
    assert.equal(s.call(store, 'GetValue', [s.key(ENGINE_FORMAT, 0), VARIANT]), S_OK);
    assert.equal(s.view.getUint32(VARIANT + 8, true), 40);
    assert.notEqual(s.view.getUint32(VARIANT + 16, true), 0, 'pBlobData at 16');
});

test('an endpoint activates nothing to play to: E_NOINTERFACE, said once', ()=>{
    const s = setup();
    s.enumerator('GetDefaultAudioEndpoint', [0, 0, OUT]);
    const device = s.view.getUint32(OUT, true);
    assert.equal(s.call(device, 'Activate', [0, 0x17, 0, OUT]), E_NOINTERFACE);
    assert.equal(s.call(device, 'Activate', [0, 0x17, 0, OUT]), E_NOINTERFACE);
    assert.equal(s.reported.length, 1);
});
