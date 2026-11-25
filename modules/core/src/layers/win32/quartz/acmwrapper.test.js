/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFilterBase, FORMAT_WAVE_FORMAT_EX, MEDIATYPE_AUDIO } from './filter.js';
import { CLSID_ACM_WRAPPER, createAcmWrapper } from './acmwrapper.js';
import { createPassThru } from './passthru.js';
import { createComObject } from '../ole32/objects.js';
import { formatGuid, parseGuid } from '../../../system/guid.js';

const IID_IBASE_FILTER = '{56A86895-0AD4-11CE-B03A-0020AF0BA770}';
const IID_IPERSIST_PROPERTY_BAG = '{37D84F60-42CB-11CE-8135-00AA004BB851}';
const ADPCM = '{00000002-0000-0010-8000-00AA00389B71}';
const PCM = '{00000001-0000-0010-8000-00AA00389B71}';

/**
 * A flat memory and an audio compression manager that converts MS ADPCM, and
 * only that, to the PCM it suggests.
 */
function machine(){
    const memory = new Uint8Array(1 << 16);
    const view = new DataView(memory.buffer);
    let next = 0x100;
    /** @type {string[]} */
    const asked = [];
    const allocate = (/** @type {number} */ n)=>{
        const at = next;
        next += n + 15 & ~15;
        return at;
    };
    /** @type {import('./filter.js').FilterHost} */
    const host = {
        readU32: at=>view.getUint32(at, true),
        readMemory: (at, n)=>memory.slice(at, at + n),
        writeMemory: (at, data)=>memory.set(data, at),
        readWideString: ()=>'',
        allocate,
        free: ()=>{},
        callGuest: async()=>0,
        currentThread: ()=>null,
        publish: ()=>1,
        createInstance: ()=>0,
    };
    /** @type {import('./filter.js').AcmHost} */
    const acm = {
        call: (name, args)=>{
            asked.push(name);
            if (name === 'acmFormatSuggest')
            {
                const [, source, into] = args;
                if (view.getUint16(source, true) !== 2)
                {
                    return 0x200;
                }
                // 22050 Hz mono 16-bit PCM, as the ADPCM driver suggests it.
                view.setUint16(into, 1, true);
                view.setUint16(into + 2, 1, true);
                view.setUint32(into + 4, 22050, true);
                view.setUint32(into + 8, 44100, true);
                view.setUint16(into + 12, 2, true);
                view.setUint16(into + 14, 16, true);
                return 0;
            }
            if (name === 'acmStreamOpen')
            {
                const [, , source, destination] = args;
                return view.getUint16(source, true) === 2 && view.getUint16(destination, true) === 1
                    ? 0 : 0x200;
            }
            return 0;
        },
    };
    const base = createFilterBase(host);
    const define = /** @type {() => any} */ (createAcmWrapper(base, host, acm,
        createPassThru(base, host)).get(CLSID_ACM_WRAPPER));
    const filter = createComObject(CLSID_ACM_WRAPPER, define());
    /** @param {number} tag */
    const audio = tag=>{
        const at = allocate(0x48 + 20);
        memory.set(/** @type {Uint8Array} */ (parseGuid(MEDIATYPE_AUDIO)), at);
        memory.set(/** @type {Uint8Array} */ (parseGuid(tag === 2 ? ADPCM : PCM)), at + 0x10);
        memory.set(/** @type {Uint8Array} */ (parseGuid(FORMAT_WAVE_FORMAT_EX)), at + 0x2c);
        view.setUint32(at + 0x40, 20, true);
        view.setUint32(at + 0x44, at + 0x48, true);
        view.setUint16(at + 0x48, tag, true);
        view.setUint16(at + 0x4a, 1, true);
        view.setUint32(at + 0x4c, 22050, true);
        return at;
    };
    /** The media type over `audio`'s format. @param {number} tag */
    const typeOf = tag=>{
        const at = audio(tag);
        return { major: MEDIATYPE_AUDIO, sub: tag === 2 ? ADPCM : PCM,
            formatType: FORMAT_WAVE_FORMAT_EX, format: memory.slice(at + 0x48, at + 0x48 + 20),
            fixed: true, temporal: false, sampleSize: 0 };
    };
    /** @param {any} object @param {string} iid @param {string} name @param {number[]} args */
    const invoke = (object, iid, name, args = [])=>object.interfaceFor(iid).methods
        .find((/** @type {any} */ m)=>m.name === name).invoke(object, args);
    return { memory, asked, filter, typeOf, invoke, allocate };
}

test('the input takes what the manager suggests PCM for and opens a stream from', async()=>{
    const m = machine();
    const input = m.filter.state.pins.find((/** @type {any} */ p)=>p.spec.direction === 'input');
    assert.equal(input.spec.id, 'In');
    assert.equal(await input.spec.accepts(input, m.typeOf(2)), true,
        'ADPCM, which the driver converts');
    assert.deepEqual(m.asked.slice(0, 2), ['acmFormatSuggest', 'acmStreamOpen']);
    assert.equal(await input.spec.accepts(input, m.typeOf(1)), false,
        'nothing here suggests PCM for PCM');
});

test('once connected, the output offers the PCM the manager suggested', async()=>{
    const m = machine();
    const [input, output] = m.filter.state.pins;
    assert.deepEqual(output.spec.types(output), [], 'nothing before the input is connected');
    assert.equal(await input.spec.connected(input, m.typeOf(2), 0), 0);
    const [offered] = output.spec.types(output);
    assert.equal(offered.sub, PCM);
    const format = new DataView(offered.format.buffer);
    assert.deepEqual([format.getUint16(0, true), format.getUint32(4, true),
        format.getUint16(14, true)], [1, 22050, 16]);
    assert.equal(await output.spec.accepts(output, offered), true);
});

test('the wrapper persists through a property bag only as far as its class', ()=>{
    const m = machine();
    const at = m.allocate(16);
    assert.equal(m.invoke(m.filter, IID_IPERSIST_PROPERTY_BAG, 'GetClassID', [at]), 0);
    assert.equal(formatGuid(m.memory.slice(at, at + 16)), CLSID_ACM_WRAPPER);
    assert.equal(m.invoke(m.filter, IID_IPERSIST_PROPERTY_BAG, 'Load', [0, 0]) >>> 0, 0x80004001,
        'a compressor\'s bag names a codec to compress with, which these drivers cannot');
    assert.ok(m.filter.interfaceFor(IID_IBASE_FILTER), 'beside the filter\'s own faces');
});
