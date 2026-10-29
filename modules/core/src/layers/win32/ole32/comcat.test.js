/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatGuid, parseGuid } from './guid.js';
import { createComObject, createComRegistry } from './objects.js';
import { HKEY_CLASSES_ROOT, createHive } from '../advapi32/registry.js';
import { CLSID_STD_COMPONENT_CATEGORIES_MGR, registerComponentCategories } from './comcat.js';

const S_OK = 0;
const S_FALSE = 1;
const CATID = '{40FC6ED5-2438-11CF-A3DB-080036F12502}';
const OTHER = '{40FC6ED4-2438-11CF-A3DB-080036F12502}';
const CLSID = '{12345678-0000-1111-2222-333333333333}';
const ICATREGISTER = '{0002E012-0000-0000-C000-000000000046}';
const ICATINFORMATION = '{0002E013-0000-0000-C000-000000000046}';

function setup(){
    const bytes = new Uint8Array(0x20000);
    const view = new DataView(bytes.buffer);
    let next = 0x8000;
    const heap = {
        /** @param {number} size */
        allocate(size){
            const at = next;
            next += (size + 15) & ~15;
            return at;
        },
        free: ()=>true,
    };
    const registry = createComRegistry();
    const hive = createHive();
    /** @type {Map<number, { object: any, iid: string }>} */
    const pointers = new Map();
    let nextPointer = 0x18000;
    registerComponentCategories({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        heap, registry, hive: /** @type {any} */ (hive),
        makeObject: (clsid, definition)=>createComObject(clsid, definition),
        publish: (object, iid)=>{
            const pointer = nextPointer += 8;
            pointers.set(pointer, { object, iid });
            return pointer;
        },
        callerThread: ()=>null,
    });
    const object = /** @type {any} */ (registry.create(CLSID_STD_COMPONENT_CATEGORIES_MGR));
    /** @param {string} iid @param {number} slot @param {...number} args */
    const call = (iid, slot, ...args)=>object.interfaceFor(iid).methods[slot].invoke(object, args);
    /** @param {number} pointer @param {number} slot @param {...number} args */
    const callAt = (pointer, slot, ...args)=>{
        const entry = /** @type {{ object: any, iid: string }} */ (pointers.get(pointer));
        return entry.object.interfaceFor(entry.iid).methods[slot].invoke(entry.object, args);
    };
    /** @param {string} value @param {number} at */
    const guid = (value, at)=>{
        bytes.set(/** @type {Uint8Array} */ (parseGuid(value)), at);
        return at;
    };
    return { bytes, view, hive, call, callAt, guid };
}

test('categories registered are described, and a class\'s are listed and tested', async()=>{
    const { bytes, view, hive, call, callAt, guid } = setup();
    // A CATEGORYINFO: the CATID, the locale and the description.
    guid(CATID, 0x100);
    view.setUint32(0x110, 0x409, true);
    [...'Controls'].forEach((character, index)=>view.setUint16(0x114 + index * 2,
        character.charCodeAt(0), true));
    assert.equal(await call(ICATREGISTER, 3, 1, 0x100), S_OK);
    const root = /** @type {any} */ (hive.root(HKEY_CLASSES_ROOT));
    assert.ok(hive.open(root, `Component Categories\\${CATID}`));

    const out = 0x300;
    assert.equal(await call(ICATINFORMATION, 4, guid(CATID, 0x200), 0x409, out), S_OK);
    const text = view.getUint32(out, true);
    assert.equal(String.fromCharCode(...new Uint16Array(bytes.buffer.slice(text, text + 16))),
        'Controls');
    assert.equal((await call(ICATINFORMATION, 4, guid(OTHER, 0x200), 0x409, out)) >>> 0,
        0x80040160, 'CAT_E_CATIDNOEXIST');

    guid(CATID, 0x400);
    assert.equal(await call(ICATREGISTER, 5, guid(CLSID, 0x500), 1, 0x400), S_OK);
    assert.equal(await call(ICATINFORMATION, 6, 0x500, 1, 0x400, 0, 0), S_OK);
    guid(OTHER, 0x410);
    assert.equal(await call(ICATINFORMATION, 6, 0x500, 1, 0x410, 0, 0), S_FALSE);
    assert.equal(await call(ICATINFORMATION, 7, 0x500, out), S_OK);
    const enumerator = view.getUint32(out, true);
    assert.equal(await callAt(enumerator, 3, 1, 0x600, 0x700), S_OK);
    assert.equal(formatGuid(bytes.slice(0x600, 0x610)), CATID);
    assert.equal(await callAt(enumerator, 3, 1, 0x600, 0x700), S_FALSE);

    assert.equal(await call(ICATREGISTER, 6, 0x500, 1, 0x400), S_OK);
    assert.equal(hive.open(root, `CLSID\\${CLSID}\\Implemented Categories`), null,
        'the key goes with its last category');
    assert.equal(await call(ICATREGISTER, 4, 1, 0x400), S_OK);
    assert.equal(hive.open(root, `Component Categories\\${CATID}`), null);
});
