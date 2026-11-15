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
    CLSID_DEVICE_MONIKER, IID_IENUM_MONIKER, IID_IMONIKER, IID_IPARSE_DISPLAY_NAME,
    IID_IPROPERTY_BAG,
    createDeviceEnumeration, createFilterStore,
} from './devenum.js';
import { CLSID_ACTIVE_MOVIE_CATEGORIES, registerWindowsFilters } from '../quartz/registrations.js';

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
        /** @param {number} pointer */
        objectAt: pointer=>objects.get(pointer) ?? null,
        /** @param {number} at @param {number} length */
        readMemory: (at, length)=>new Uint8Array(memory.buffer.slice(at, at + length)),
        /** @param {Uint8Array} bytes a SAFEARRAY of the bytes, its data at +12, count at +16 */
        allocateBytes: bytes=>{
            const array = host.allocate(24);
            const data = host.allocate(bytes.length);
            bytes.forEach((b, i)=>memory.setUint8(data + i, b));
            memory.setUint32(array + 12, data, true);
            memory.setUint32(array + 16, bytes.length, true);
            return array;
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

test('a display name parses to its device\'s moniker, and to one naming nothing where none is',
    async()=>{
        const m = machine();
        const filter = { category: CLSID_LEGACY_AM_FILTER_CATEGORY, instance: FILTER, clsid: FILTER,
            name: 'A filter', merit: 0, pins: [], properties: new Map() };
        m.store.register(filter);
        const parser = createComObject(CLSID_DEVICE_MONIKER, m.devices.deviceMoniker());
        m.putWide(`@device:sw:${CLSID_LEGACY_AM_FILTER_CATEGORY.toLowerCase()}\\${FILTER}`, 0x300);
        assert.equal(m.call(parser, IID_IPARSE_DISPLAY_NAME, 'ParseDisplayName',
            [0, 0x300, 0x400, 0x404]), S_OK);
        const parsed = m.objects.get(m.memory.getUint32(0x404, true));
        const listed = m.devices.monikerFor(filter);
        assert.equal(m.call(parsed, IID_IMONIKER, 'IsEqual', [listed]), S_OK,
            'the same registration, whichever way its moniker was made');

        // A name nothing is under parses, and writing to it makes it a device.
        const other = `@device:sw:${CLSID_LEGACY_AM_FILTER_CATEGORY}\\test`;
        m.putWide(other, 0x300);
        assert.equal(m.call(parser, IID_IPARSE_DISPLAY_NAME, 'ParseDisplayName',
            [0, 0x300, 0x400, 0x404]), S_OK);
        assert.equal(m.memory.getUint32(0x400, true), other.length, 'the whole name eaten');
        const fresh = m.objects.get(m.memory.getUint32(0x404, true));
        assert.equal(m.call(fresh, IID_IMONIKER, 'IsEqual', [listed]), S_FALSE);
        m.host.writeMemory(0x100, /** @type {Uint8Array} */ (parseGuid(IID_IPROPERTY_BAG)));
        m.call(fresh, IID_IMONIKER, 'BindToStorage', [0, 0, 0x100, 0x200]);
        const bag = m.objects.get(m.memory.getUint32(0x200, true));
        m.putWide('FriendlyName', 0x300);
        assert.equal(await m.call(bag, IID_IPROPERTY_BAG, 'Read', [0x300, 0x500, 0]) >>> 0,
            NOT_FOUND, 'nothing written yet');
        m.memory.setUint16(0x500, 8, true);
        m.memory.setUint32(0x508, m.host.allocateString('test device'), true);
        assert.equal(await m.call(bag, IID_IPROPERTY_BAG, 'Write', [0x300, 0x500]), S_OK);
        assert.equal(m.store.find(CLSID_LEGACY_AM_FILTER_CATEGORY, 'test')?.name, 'test device');

        m.putWide('test', 0x300);
        assert.equal(m.call(parser, IID_IPARSE_DISPLAY_NAME, 'ParseDisplayName',
            [0, 0x300, 0x400, 0x404]) >>> 0, 0x800401e4,
        'not a device moniker\'s name: MK_E_SYNTAX');
    });

test('a property is read back in the type it was written in: a number, bytes, a string', async()=>{
    const m = machine();
    const filter = { category: CLSID_LEGACY_AM_FILTER_CATEGORY, instance: FILTER, clsid: FILTER,
        name: 'A filter', merit: 0, pins: [], properties: new Map() };
    m.store.register(filter);
    const moniker = m.objects.get(m.devices.monikerFor(filter));
    m.host.writeMemory(0x100, /** @type {Uint8Array} */ (parseGuid(IID_IPROPERTY_BAG)));
    m.call(moniker, IID_IMONIKER, 'BindToStorage', [0, 0, 0x100, 0x200]);
    const bag = m.objects.get(m.memory.getUint32(0x200, true));
    m.putWide('Number', 0x300);
    m.memory.setUint16(0x500, 3, true);
    m.memory.setInt32(0x508, -7, true);
    assert.equal(await m.call(bag, IID_IPROPERTY_BAG, 'Write', [0x300, 0x500]), S_OK);
    m.memory.setUint16(0x600, 0, true);
    assert.equal(await m.call(bag, IID_IPROPERTY_BAG, 'Read', [0x300, 0x600, 0]), S_OK);
    assert.equal(m.memory.getUint16(0x600, true), 3, 'VT_I4');
    assert.equal(m.memory.getInt32(0x608, true), -7);

    m.putWide('Bytes', 0x300);
    const array = m.host.allocateBytes(new Uint8Array([1, 2, 3]));
    m.memory.setUint16(0x500, 0x2011, true);
    m.memory.setUint32(0x508, array, true);
    assert.equal(await m.call(bag, IID_IPROPERTY_BAG, 'Write', [0x300, 0x500]), S_OK);
    m.memory.setUint16(0x600, 0, true);
    assert.equal(await m.call(bag, IID_IPROPERTY_BAG, 'Read', [0x300, 0x600, 0]), S_OK);
    assert.equal(m.memory.getUint16(0x600, true), 0x2011, 'VT_ARRAY | VT_UI1');
    const back = m.memory.getUint32(0x608, true);
    assert.deepEqual([...m.host.readMemory(m.memory.getUint32(back + 12, true), 3)], [1, 2, 3]);
    m.memory.setUint16(0x600, 8, true);
    assert.equal(await m.call(bag, IID_IPROPERTY_BAG, 'Read', [0x300, 0x600, 0]) >>> 0, 0x80070057,
        'asked for another type: E_INVALIDARG');
});

test('Windows\' registrations are written for the classes made here, and every category', ()=>{
    const store = createFilterStore();
    const made = new Set(['{1B544C20-FD0B-11CE-8C63-00AA0044B51E}']);
    registerWindowsFilters(store, clsid=>made.has(clsid));
    const filters = store.list(CLSID_LEGACY_AM_FILTER_CATEGORY);
    assert.deepEqual(filters.map(f=>f.name), ['AVI Splitter'], 'only what CoCreateInstance makes');
    assert.equal(filters[0].merit, 0x600000);
    assert.ok(store.list(CLSID_ACTIVE_MOVIE_CATEGORIES).some(c=>c.name === 'DirectShow Filters'));
});
