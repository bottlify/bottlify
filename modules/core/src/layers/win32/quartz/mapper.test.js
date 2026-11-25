/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFilterMapper } from './mapper.js';
import {
    CLSID_LEGACY_AM_FILTER_CATEGORY, createDeviceEnumeration, createFilterStore,
} from '../devenum/devenum.js';
import { parseGuid } from '../../../system/guid.js';

const S_OK = 0;
const S_FALSE = 1;
const FILTER = '{11111111-0000-0000-0000-000000000001}';
const OTHER = '{11111111-0000-0000-0000-000000000002}';
const VIDEO = '{73646976-0000-0010-8000-00AA00389B71}';

function machine(){
    const memory = new DataView(new ArrayBuffer(0x40000));
    let next = 0x20000;
    /** @type {Map<number, any>} */
    const objects = new Map();
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
        createInstance: ()=>S_OK,
    };
    const store = createFilterStore();
    const devices = createDeviceEnumeration(host, store);
    const mapper = createFilterMapper(host, store, devices);
    /** @param {string} text @param {number} at */
    const putWide = (text, at)=>[...text, '\0'].forEach((c, i)=>
        memory.setUint16(at + i * 2, c.charCodeAt(0), true));
    /** @param {string} guid @param {number} at */
    const putGuid = (guid, at)=>host.writeMemory(at, /** @type {Uint8Array} */ (parseGuid(guid)));
    /** The display names an IEnumMoniker hands out. @param {number} enumerator */
    const names = enumerator=>{
        const object = objects.get(enumerator);
        const step = object.interfaceFor('{00000102-0000-0000-C000-000000000046}').methods[3];
        /** @type {string[]} */
        const found = [];
        while (step.invoke(object, [1, 0x100, 0]) === S_OK)
        {
            const moniker = objects.get(memory.getUint32(0x100, true));
            const display = moniker.interfaceFor('{0000000F-0000-0000-C000-000000000046}')
                .methods.find((/** @type {any} */ m)=>m.name === 'GetDisplayName');
            display.invoke(moniker, [0, 0, 0x104]);
            found.push(host.readWideString(memory.getUint32(0x104, true), 512));
        }
        return found;
    };
    return { memory, host, store, mapper, putWide, putGuid, names, objects };
}

/**
 * A REGFILTER2 of version 2 at 0x1000: pins of the flags given, each taking any type.
 *
 * @param {ReturnType<typeof machine>} m @param {number} merit @param {number[]} flags
 */
function registration(m, merit, flags){
    const { memory } = m;
    memory.setUint32(0x1000, 2, true);
    memory.setUint32(0x1004, merit, true);
    memory.setUint32(0x1008, flags.length, true);
    memory.setUint32(0x100c, 0x1100, true);
    m.putGuid('{00000000-0000-0000-0000-000000000000}', 0x1300);
    memory.setUint32(0x1200, 0x1300, true);
    memory.setUint32(0x1204, 0x1300, true);
    flags.forEach((value, i)=>{
        memory.setUint32(0x1100 + i * 28, value, true);
        memory.setUint32(0x1104 + i * 28, 1, true);
        memory.setUint32(0x1108 + i * 28, 1, true);
        memory.setUint32(0x110c + i * 28, 0x1200, true);
    });
    return 0x1000;
}

test('a filter registered through IFilterMapper2 is enumerated by merit and by renderer pin', ()=>{
    const m = machine();
    m.putGuid(FILTER, 0x2000);
    m.putGuid(OTHER, 0x2010);
    m.putGuid(CLSID_LEGACY_AM_FILTER_CATEGORY, 0x2020);
    m.putWide('Renderer', 0x2100);
    m.putWide('Transform', 0x2200);
    const { RegisterFilter, EnumMatchingFilters, UnregisterFilter } = m.mapper.mapper2;
    const renderer = registration(m, 0x200000, [2]);
    assert.equal(RegisterFilter(null, [0x2000, 0x2100, 0, 0x2020, 0, renderer]), S_OK);
    const transform = registration(m, 0x200000, [0, 8]);
    assert.equal(RegisterFilter(null, [0x2010, 0x2200, 0, 0x2020, 0, transform]), S_OK);

    const all = [0x300, 0, 1, 0x200000, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    assert.equal(EnumMatchingFilters(null, all), S_OK);
    assert.deepEqual(m.names(m.memory.getUint32(0x300, true)).length, 2);
    const renderers = [...all];
    renderers[9] = 1;
    EnumMatchingFilters(null, renderers);
    assert.deepEqual(m.names(m.memory.getUint32(0x300, true)),
        [`@device:sw:${CLSID_LEGACY_AM_FILTER_CATEGORY}\\${FILTER}`], 'only the renderer');
    const higher = [...all];
    higher[3] = 0x400000;
    EnumMatchingFilters(null, higher);
    assert.deepEqual(m.names(m.memory.getUint32(0x300, true)), [], 'no filter reaches that merit');

    assert.equal(UnregisterFilter(null, [0x2020, 0, 0x2000]), S_OK);
    EnumMatchingFilters(null, all);
    assert.equal(m.names(m.memory.getUint32(0x300, true)).length, 1);
});

test('the first mapper registers a filter, its pin and type, and both mappers find it', ()=>{
    const m = machine();
    const words = [...new Uint32Array(/** @type {Uint8Array} */ (parseGuid(FILTER)).buffer)];
    const none = [0, 0, 0, 0];
    m.putWide('Legacy', 0x2100);
    m.putWide('Pin1', 0x2200);
    const v1 = m.mapper.mapper1;
    assert.equal(v1.RegisterFilter(null, [...words, 0x2100, 0x200000]), S_OK);
    assert.equal(v1.RegisterPin(null, [...words, 0x2200, 1, 0, 0, 0, ...none, 0]), S_OK);
    assert.equal(v1.RegisterPinType(null, [...words, 0x2200, ...none, ...none]), S_OK);
    assert.equal(v1.EnumMatchingFilters(null, [0x300, 0x200000, 1, ...none, ...none, 0, 0,
        ...none, ...none]), S_OK);
    const enumerator = m.objects.get(m.memory.getUint32(0x300, true));
    const next = enumerator.interfaceFor('{56A868A4-0AD4-11CE-B03A-0020AF0BA770}').methods[3];
    assert.equal(next.invoke(enumerator, [1, 0x310, 0]), S_OK);
    const regfilter = m.memory.getUint32(0x310, true);
    assert.equal(m.host.readWideString(m.memory.getUint32(regfilter + 16, true), 64), 'Legacy');
    assert.equal(next.invoke(enumerator, [1, 0x310, 0]), S_FALSE, 'and nothing after it');
    const all = [0x300, 0, 1, 0x200000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    m.mapper.mapper2.EnumMatchingFilters(null, all);
    assert.equal(m.names(m.memory.getUint32(0x300, true)).length, 1, 'IFilterMapper2 finds it');
});

test('FilterData made from a registration parses back to it', ()=>{
    const m = machine();
    const { CreateFilterData, ParseFilterData } = m.mapper.filterData;
    const description = registration(m, 0x5fffff, [0, 8]);
    m.putGuid(VIDEO, 0x1300);
    assert.equal(CreateFilterData(null, [description, 0x400, 0x404]), S_OK);
    const block = m.memory.getUint32(0x400, true);
    const size = m.memory.getUint32(0x404, true);
    assert.equal(m.memory.getUint32(block + 16, true), 0x33697030, 'the first pin is "0pi3"');
    assert.equal(ParseFilterData(null, [block, size, 0x408]), S_OK);
    const parsed = m.memory.getUint32(m.memory.getUint32(0x408, true), true);
    assert.equal(m.memory.getUint32(parsed + 4, true), 0x5fffff, 'the merit');
    assert.equal(m.memory.getUint32(parsed + 8, true), 2, 'two pins');
    const second = m.memory.getUint32(parsed + 12, true) + 28;
    assert.equal(m.memory.getUint32(second, true), 8, 'the second an output');
    const type = m.memory.getUint32(second + 12, true);
    const major = m.memory.getUint32(type, true);
    assert.equal(m.memory.getUint32(major, true), 0x73646976, 'its major type is video');
});
