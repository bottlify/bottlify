/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComObject } from '../ole32/objects.js';
import { parseGuid } from '../ole32/guid.js';
import {
    CLSID_LEGACY_AM_FILTER_CATEGORY, CLSID_SYSTEM_DEVICE_ENUM, IID_ICREATE_DEV_ENUM,
    IID_IENUM_MONIKER, IID_IMONIKER, IID_IPROPERTY_BAG, createDeviceEnumeration, createFilterStore,
} from './devenum.js';

const S_OK = 0;
const S_FALSE = 1;
const MK_E_NOSTORAGE = 0x800401ed;
const NOT_FOUND = 0x80070002;
const FILTER = '{22222222-0000-0000-0000-000000000001}';

function machine(){
    const memory = new DataView(new ArrayBuffer(0x40000));
    let next = 0x20000;
    /** @type {Map<number, any>} */
    const objects = new Map();
    /** @type {[string, number, number][]} */
    const created = [];
    const host = {
        /** @param {number} at */
        readU32: at=>memory.getUint32(at, true),
        /** @param {number} at @param {number} limit */
        readWideString: (at, limit)=>{
            let text = '';
            for (let i = 0; i < limit; i += 2)
            {
                const unit = memory.getUint16(at + i, true);
                if (unit === 0)
                {
                    break;
                }
                text += String.fromCharCode(unit);
            }
            return text;
        },
        /** @param {number} at @param {Uint8Array} bytes */
        writeMemory: (at, bytes)=>bytes.forEach((b, i)=>memory.setUint8(at + i, b)),
        /** @param {number} bytes */
        allocate: bytes=>{
            const at = next;
            next += Math.ceil(bytes / 8) * 8 + 8;
            return at;
        },
        /** @param {any} object */
        publish: object=>{
            const pointer = 0x30000 + objects.size * 16;
            objects.set(pointer, object);
            return pointer;
        },
        allocateString: (/** @type {string} */ text)=>{
            const at = host.allocate(text.length * 2 + 2);
            [...text, '\0'].forEach((c, i)=>memory.setUint16(at + i * 2, c.charCodeAt(0), true));
            return at;
        },
        /** @param {string} clsid @param {number} iid @param {number} out */
        createInstance: (clsid, iid, out)=>{
            created.push([clsid, iid, out]);
            return S_OK;
        },
    };
    const store = createFilterStore();
    const devices = createDeviceEnumeration(host, store);
    /** @param {any} object @param {string} iid @param {string} name @param {number[]} args */
    const call = (object, iid, name, args)=>object.interfaceFor(iid).methods
        .find((/** @type {any} */ m)=>m.name === name).invoke(object, args);
    /** @param {string} text @param {number} at */
    const putWide = (text, at)=>[...text, '\0'].forEach((c, i)=>
        memory.setUint16(at + i * 2, c.charCodeAt(0), true));
    return { memory, host, store, devices, objects, created, call, putWide };
}

test('a category with nothing in it hands out no enumerator; one with a filter its moniker', ()=>{
    const m = machine();
    const enumerator = createComObject(CLSID_SYSTEM_DEVICE_ENUM, m.devices.systemDeviceEnum());
    m.host.writeMemory(0x100, /** @type {Uint8Array} */ (parseGuid(CLSID_LEGACY_AM_FILTER_CATEGORY)));
    assert.equal(m.call(enumerator, IID_ICREATE_DEV_ENUM, 'CreateClassEnumerator',
        [0x100, 0x200, 0]),
    S_FALSE);
    assert.equal(m.memory.getUint32(0x200, true), 0);

    m.store.register({ category: CLSID_LEGACY_AM_FILTER_CATEGORY, instance: FILTER, clsid: FILTER,
        name: 'A filter', merit: 0x200000, pins: [], properties: new Map() });
    assert.equal(m.call(enumerator, IID_ICREATE_DEV_ENUM, 'CreateClassEnumerator',
        [0x100, 0x200, 0]),
    S_OK);
    const monikers = m.objects.get(m.memory.getUint32(0x200, true));
    assert.equal(m.call(monikers, IID_IENUM_MONIKER, 'Next', [1, 0x210, 0]), S_OK);
    assert.equal(m.call(monikers, IID_IENUM_MONIKER, 'Next', [1, 0x214, 0x218]), S_FALSE);
    assert.equal(m.memory.getUint32(0x218, true), 0, 'one moniker, then none');

    const moniker = m.objects.get(m.memory.getUint32(0x210, true));
    m.call(moniker, IID_IMONIKER, 'GetDisplayName', [0, 0, 0x220]);
    assert.equal(m.host.readWideString(m.memory.getUint32(0x220, true), 512),
        `@device:sw:${CLSID_LEGACY_AM_FILTER_CATEGORY}\\${FILTER}`);
    m.call(moniker, IID_IMONIKER, 'BindToObject', [0, 0, 0x230, 0x240]);
    assert.deepEqual(m.created, [[FILTER, 0x230, 0x240]], 'binding makes the filter\'s class');
});

test('a moniker\'s storage is a property bag with the filter\'s name and class', async()=>{
    const m = machine();
    const filter = { category: CLSID_LEGACY_AM_FILTER_CATEGORY, instance: FILTER, clsid: FILTER,
        name: 'A filter', merit: 0, pins: [], properties: new Map() };
    m.store.register(filter);
    const moniker = m.objects.get(m.devices.monikerFor(filter));
    m.host.writeMemory(0x100, /** @type {Uint8Array} */ (parseGuid(IID_IMONIKER)));
    assert.equal(m.call(moniker, IID_IMONIKER, 'BindToStorage', [0, 0, 0x100, 0x200]) >>> 0,
        MK_E_NOSTORAGE);
    m.host.writeMemory(0x100, /** @type {Uint8Array} */ (parseGuid(IID_IPROPERTY_BAG)));
    assert.equal(m.call(moniker, IID_IMONIKER, 'BindToStorage', [0, 0, 0x100, 0x200]), S_OK);
    const bag = m.objects.get(m.memory.getUint32(0x200, true));
    m.putWide('FriendlyName', 0x300);
    assert.equal(await m.call(bag, IID_IPROPERTY_BAG, 'Read', [0x300, 0x400, 0]), S_OK);
    assert.equal(m.memory.getUint16(0x400, true), 8, 'VT_BSTR');
    assert.equal(m.host.readWideString(m.memory.getUint32(0x408, true), 64), 'A filter');
    m.putWide('Nothing', 0x300);
    m.memory.setUint16(0x400, 0, true);
    assert.equal(await m.call(bag, IID_IPROPERTY_BAG, 'Read', [0x300, 0x400, 0]) >>> 0, NOT_FOUND);
});
