/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { guestOver } from '../common/guest.fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IID_IUNKNOWN, createComRegistry } from './objects.js';
import { formatGuid } from '../../../system/guid.js';
import {
    CLSID_MMDEVICE_ENUMERATOR, E_NOTFOUND, IID_IMMDEVICE, IID_IMMDEVICE_COLLECTION,
    IID_IMMDEVICE_ENUMERATOR, IID_IPROPERTY_STORE, registerMmDevApiClasses,
} from './mmdevapi.js';
import { SOUND_DEVICE_GUID } from '../devices.js';

const S_OK = 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const OUT = 0x100;
const KEY = 0x200;
const VARIANT = 0x300;

/**
 * @param {4 | 8} [pointerSize]
 * @param {{ createInstance?: any, callMethod?: any }} [com]  Another library's
 *     objects, for an endpoint activated as one.
 */
function setup(pointerSize = 4, com = {}){
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
        heap: { allocate: size=>(nextBlock += size + 16) - size - 16, free: ()=>{} },
        ...com,
        guest: guestOver(bytes, pointerSize),
        pointerSize,
        divergence: (api, detail)=>reported.push(`${api}: ${detail}`),
    });
    const object = /** @type {any} */ (registry.create(CLSID_MMDEVICE_ENUMERATOR));
    const face = object.interfaceFor(IID_IMMDEVICE_ENUMERATOR);
    return {
        view, reported, wideAt, registry, object, bytes,
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
        /** @param {number} pointer */
        recordAt: pointer=>records.get(pointer),
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

test('Windows XP has no device enumerator to make; Vista and later have one', ()=>{
    // A program that finds one plays to an endpoint (WASAPI), one that does
    // not plays through DirectSound: on XP it must not find one.
    for (const [major, registered] of [[5, false], [6, true], [10, true]])
    {
        const registry = createComRegistry();
        registerMmDevApiClasses(/** @type {any} */ ({ registry, windows: { major } }));
        assert.equal(registry.isRegistered(CLSID_MMDEVICE_ENUMERATOR), registered,
            `major ${major}`);
    }
});

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

test('the property store names the speakers and the device\'s format', ()=>{
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
    // The device's own format, 16-bit PCM (Wine's propstore test, as Windows
    // answers it); the engine mixes in float (GetMixFormat).
    assert.deepEqual([0, 2, 4, 14].map(at=>at === 4 ? s.view.getUint32(format + at, true)
        : s.view.getUint16(format + at, true)), [0xfffe, 2, 48000, 16]);
    assert.equal(s.view.getUint8(format + 24), 1, 'KSDATAFORMAT_SUBTYPE_PCM');

    assert.equal(s.call(store, 'GetValue', [s.key([1, 2, 3, 4], 5), VARIANT]), S_OK);
    assert.equal(s.view.getUint16(VARIANT, true), 0, 'a key not kept is VT_EMPTY');
});

test('the endpoint names the GUID DirectSound knows the same device by', ()=>{
    // Wine's dsound8 test_first_device: PKEY_AudioEndpoint_GUID of the default
    // render endpoint is the first device DirectSoundEnumerate lists.
    const s = setup();
    s.enumerator('GetDefaultAudioEndpoint', [0, 0, OUT]);
    s.call(s.view.getUint32(OUT, true), 'OpenPropertyStore', [0, OUT]);
    const store = s.view.getUint32(OUT, true);
    const AUDIO_ENDPOINT = [0x1da5d803, 0x4eddd492, 0xc0e0238c, 0x0e7feeff];
    assert.equal(s.call(store, 'GetValue', [s.key(AUDIO_ENDPOINT, 4), VARIANT]), S_OK);
    assert.equal(s.view.getUint16(VARIANT, true), 31, 'VT_LPWSTR');
    assert.equal(s.wideAt(s.view.getUint32(VARIANT + 8, true)), SOUND_DEVICE_GUID);
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

test('an endpoint activates an audio client; another interface is E_NOINTERFACE, said once', ()=>{
    const s = setup();
    s.enumerator('GetDefaultAudioEndpoint', [0, 0, OUT]);
    const device = s.view.getUint32(OUT, true);
    // IID_IAudioClient, {1CB9AD4C-DBFA-4C32-B178-C2F568A703B2}.
    s.view.setUint32(KEY, 0x1cb9ad4c, true);
    s.view.setUint16(KEY + 4, 0xdbfa, true);
    s.view.setUint16(KEY + 6, 0x4c32, true);
    [0xb1, 0x78, 0xc2, 0xf5, 0x68, 0xa7, 0x03, 0xb2].forEach((byte, index)=>{
        s.view.setUint8(KEY + 8 + index, byte);
    });
    assert.equal(s.call(device, 'Activate', [KEY, 0x17, 0, OUT]), S_OK);
    assert.notEqual(s.view.getUint32(OUT, true), 0);
    s.view.setUint32(KEY, 0x12345678, true);
    assert.equal(s.call(device, 'Activate', [KEY, 0x17, 0, OUT]), E_NOINTERFACE);
    assert.equal(s.call(device, 'Activate', [KEY, 0x17, 0, OUT]), E_NOINTERFACE);
    assert.equal(s.reported.length, 1);
});

test('the enumerator is one per process, holding a reference of its own, and is its IUnknown',
    ()=>{
        // Wine's mmdevenum test: AddRef after CoCreateInstance answers 3, a
        // second CoCreateInstance gives the same pointer, and QueryInterface
        // for IUnknown answers the pointer it was asked through.
        const s = setup();
        assert.equal(s.object.refCount, 2, 'the class\'s and the caller\'s');
        assert.equal(s.registry.create(CLSID_MMDEVICE_ENUMERATOR), s.object);
        assert.equal(s.object.interfaceFor(IID_IUNKNOWN).sharedWith, IID_IMMDEVICE_ENUMERATOR);
        assert.equal(s.enumerator('EnumAudioEndpoints', [0, 1, OUT]), S_OK);
        const collection = s.recordAt(s.view.getUint32(OUT, true)).object;
        assert.equal(collection.interfaceFor(IID_IUNKNOWN).sharedWith, IID_IMMDEVICE_COLLECTION,
            'and a collection its own');
    });

test('the enumerator refuses as Windows does: a malformed id, a bad flow, notifications', ()=>{
    const s = setup();
    /** @param {string} text */
    const wide = text=>{
        [...`${text}\0`].forEach((unit, at)=>s.view.setUint16(0x600 + at * 2,
            unit.charCodeAt(0), true));
        return 0x600;
    };
    assert.equal(s.enumerator('GetDevice', [wide('notadevice'), OUT]), E_INVALIDARG);
    assert.equal(s.enumerator('GetDevice',
        [wide('{0.0.0.00000000}.{00000000-0000-0000-0000-000000000001}'), OUT]), E_NOTFOUND);
    s.view.setUint32(OUT, 0x12345678, true);
    assert.equal(s.enumerator('EnumAudioEndpoints', [0xffff, 0xf, OUT]), E_INVALIDARG);
    assert.equal(s.view.getUint32(OUT, true), 0, 'the collection pointer cleared');

    // A client registered twice is unregistered twice.
    const client = 0x7000;
    assert.equal(s.enumerator('RegisterEndpointNotificationCallback', [client]), S_OK);
    assert.equal(s.enumerator('RegisterEndpointNotificationCallback', [client]), S_OK);
    assert.equal(s.enumerator('UnregisterEndpointNotificationCallback', [0xdeadbeef]),
        E_NOTFOUND);
    assert.equal(s.enumerator('UnregisterEndpointNotificationCallback', [client]), S_OK);
    assert.equal(s.enumerator('UnregisterEndpointNotificationCallback', [client]), S_OK);
    assert.equal(s.enumerator('UnregisterEndpointNotificationCallback', [client]), E_NOTFOUND);
});

test('the property store lists its keys, answers its device interface, refuses a bad access', ()=>{
    // Wine's propstore test: GetAt walks what GetCount says, DeviceDesc among
    // them; the device interface key is a string; access 3 is refused with
    // the out pointer left alone.
    const s = setup();
    s.enumerator('GetDefaultAudioEndpoint', [0, 0, OUT]);
    const device = s.view.getUint32(OUT, true);
    s.view.setUint32(OUT, 0, true);
    assert.equal(s.call(device, 'OpenPropertyStore', [3, OUT]), E_INVALIDARG);
    assert.equal(s.view.getUint32(OUT, true), 0, 'untouched');
    assert.equal(s.call(device, 'OpenPropertyStore', [2, OUT]), S_OK);
    const store = s.view.getUint32(OUT, true);
    assert.equal(s.call(store, 'GetCount', [OUT]), S_OK);
    const count = s.view.getUint32(OUT, true);
    /** @type {string[]} */
    const keys = [];
    for (let at = 0; at < count; at++)
    {
        assert.equal(s.call(store, 'GetAt', [at, KEY]), S_OK, `key ${at}`);
        const pid = s.view.getUint32(KEY + 16, true);
        keys.push(`${formatGuid(s.bytes.slice(KEY, KEY + 16))} ${pid}`);
    }
    assert.equal(s.call(store, 'GetAt', [count, KEY]), E_INVALIDARG, 'past the last');
    assert.ok(keys.includes('{A45C254E-DF1C-4EFD-8020-67D146A850E0} 2'), 'DeviceDesc');
    assert.ok(keys.includes('{A45C254E-DF1C-4EFD-8020-67D146A850E0} 14'), 'FriendlyName');

    assert.equal(s.call(store, 'GetValue',
        [s.key([0x233164c8, 0x4c7d1b2c, 0x71b668bc, 0x67257a68], 1), VARIANT]), S_OK);
    assert.equal(s.view.getUint16(VARIANT, true), 31, 'VT_LPWSTR');
    assert.match(s.wideAt(s.view.getUint32(VARIANT + 8, true)), /^\\\\\?\\SWD#MMDEVAPI#\{0\.0\.0\./);
});

test('the endpoint is activated as its volume, and as DirectSound on its device', async()=>{
    /** @type {any[]} */
    const calls = [];
    let initialize = 0;
    const s = setup(4, {
        /** @param {string} clsid @param {number} iid @param {number} out */
        createInstance: (clsid, iid, out)=>
        {
            calls.push(['create', clsid]);
            new DataView(s.bytes.buffer).setUint32(out, 0x9990, true);
            return 0;
        },
        /** @param {number} object @param {number} slot @param {number[]} args */
        callMethod: (object, slot, args)=>
        {
            calls.push(['call', object, slot, slot === 10
                ? formatGuid(s.bytes.slice(args[0], args[0] + 16)) : null]);
            return slot === 10 ? initialize : 0;
        },
    });
    s.enumerator('GetDefaultAudioEndpoint', [0, 0, OUT]);
    const device = s.view.getUint32(OUT, true);
    /** @param {string} guid */
    const iid = guid=>{
        s.bytes.set(/** @type {Uint8Array} */ (parseGuidBytes(guid)), 0x500);
        return 0x500;
    };

    assert.equal(s.call(device, 'Activate',
        [iid('{5CDF2C82-841E-4546-9722-0CF74078229A}'), 1, 0, OUT]), S_OK);
    assert.equal(s.interfaceAt(s.view.getUint32(OUT, true)),
        '{5CDF2C82-841E-4546-9722-0CF74078229A}', 'IAudioEndpointVolume');

    assert.equal(await s.call(device, 'Activate',
        [iid('{C50A7E93-F395-4834-9EF6-7FA99DE50966}'), 1, 0, OUT]), S_OK);
    assert.deepEqual(calls, [['create', '{3901CC3F-84B5-4FA4-BA35-AA8172B8A09B}'],
        ['call', 0x9990, 10, SOUND_DEVICE_GUID]], 'DirectSound8, initialized on the device');
    assert.equal(s.view.getUint32(OUT, true), 0x9990);

    calls.length = 0;
    initialize = 0x88780078 | 0;
    assert.equal(await s.call(device, 'Activate',
        [iid('{279AFA83-4981-11CE-A521-0020AF0BE560}'), 1, 0, OUT]), initialize);
    assert.deepEqual(calls.map(call=>call[2] ?? call[0]), ['create', 10, 2],
        'one that fails to initialize is released');
    assert.equal(s.view.getUint32(OUT, true), 0, 'and not handed out');

    calls.length = 0;
    assert.equal(await s.call(device, 'Activate',
        [iid('{56A86895-0AD4-11CE-B03A-0020AF0BA770}'), 1, 0, OUT]), S_OK);
    assert.deepEqual(calls, [['create', '{79376820-07D0-11CF-A24D-0020AFD79767}']],
        'IBaseFilter: the DirectSound renderer, nothing to initialize');
});

/** A GUID's sixteen bytes. @param {string} text */
function parseGuidBytes(text){
    const hex = text.replace(/[{}-]/g, '');
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, parseInt(hex.slice(0, 8), 16), true);
    view.setUint16(4, parseInt(hex.slice(8, 12), 16), true);
    view.setUint16(6, parseInt(hex.slice(12, 16), 16), true);
    for (let at = 0; at < 8; at++)
    {
        bytes[8 + at] = parseInt(hex.slice(16 + at * 2, 18 + at * 2), 16);
    }
    return bytes;
}
