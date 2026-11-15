/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFilterBase, GUID_NULL, MEDIATYPE_STREAM } from './filter.js';
import { IID_IASYNC_READER, IID_IFILE_SOURCE_FILTER, MEDIASUBTYPE, createFileSource,
    streamSubtype } from './filesource.js';
import { createComObject } from '../ole32/objects.js';
import { formatGuid, parseGuid } from '../ole32/guid.js';

const IID_IBASE_FILTER = '{56A86895-0AD4-11CE-B03A-0020AF0BA770}';
const IID_IPIN = '{56A86891-0AD4-11CE-B03A-0020AF0BA770}';
const IID_IENUM = { pins: '{56A86892-0AD4-11CE-B03A-0020AF0BA770}',
    types: '{89C31040-846B-11CE-97D3-00AA0055595A}' };

/** @param {string} text */
const bytes = text=>Uint8Array.from(text, ch=>ch.charCodeAt(0));

test('a stream is named by its first bytes, as Windows\' check bytes name it', ()=>{
    const riff = (/** @type {string} */ form)=>bytes(`RIFF\0\0\0\0${form}`);
    assert.equal(streamSubtype(riff('AVI ')), MEDIASUBTYPE.AVI);
    assert.equal(streamSubtype(riff('WAVE')), MEDIASUBTYPE.WAVE);
    assert.equal(streamSubtype(Uint8Array.of(0, 0, 1, 0xba, 0x21)), MEDIASUBTYPE.MPEG1_SYSTEM);
    assert.equal(streamSubtype(Uint8Array.of(0, 0, 1, 0xba, 0x44)), MEDIASUBTYPE.MPEG2_PROGRAM);
    assert.equal(streamSubtype(Uint8Array.of(0, 0, 1, 0xb3)), MEDIASUBTYPE.MPEG1_VIDEO);
    assert.equal(streamSubtype(Uint8Array.of(0xff, 0xfb, 0x90)), MEDIASUBTYPE.MPEG1_AUDIO);
    assert.equal(streamSubtype(bytes('MThd')), MEDIASUBTYPE.MIDI);
    assert.equal(streamSubtype(bytes('hello')), GUID_NULL);
});

/** A flat memory and objects called by method name, with a file of the volume. */
function machine(){
    const memory = new Uint8Array(1 << 16);
    let next = 0x100;
    /** @type {any[]} */
    const published = [];
    const view = new DataView(memory.buffer);
    /** @type {import('./filter.js').FilterHost} */
    const host = {
        readU32: at=>view.getUint32(at, true),
        readMemory: (at, n)=>memory.slice(at, at + n),
        writeMemory: (at, data)=>memory.set(data, at),
        readWideString: at=>{
            let text = '';
            for (let i = at; view.getUint16(i, true); i += 2)
            {
                text += String.fromCharCode(view.getUint16(i, true));
            }
            return text;
        },
        allocate: n=>{
            const at = next;
            next += n + 15 & ~15;
            return at;
        },
        free: ()=>{},
        callGuest: async()=>0,
        currentThread: ()=>null,
        publish: (object, iid)=>{
            published.push([object, iid]);
            return published.length;
        },
        createInstance: ()=>0,
    };
    const file = bytes('RIFF\0\0\0\0AVI LIST and the rest of a film');
    const base = createFilterBase(host);
    const define = createFileSource(base, host, {
        open: async path=>(path === 'C:\\film.avi' ? {
            size: file.length,
            read: async(offset, length)=>file.slice(offset, offset + length),
            close: ()=>{},
        } : null),
    });
    const filter = createComObject('{E436EBB5-524F-11CE-9F53-0020AF0BA770}', define());
    /** @param {any} object @param {string} iid @param {string} name @param {number[]} args */
    const invoke = (object, iid, name, args = [])=>object.interfaceFor(iid).methods
        .find((/** @type {any} */ m)=>m.name === name).invoke(object, args);
    /** @param {number} pointer */
    const objectAt = pointer=>published[pointer - 1][0];
    /** @param {string} text */
    const wide = text=>{
        const at = host.allocate(text.length * 2 + 2);
        [...text].forEach((ch, i)=>view.setUint16(at + i * 2, ch.charCodeAt(0), true));
        return at;
    };
    return { host, view, memory, filter, invoke, objectAt, wide };
}

test('File Source has its pin once a file is loaded, offering the stream\'s type and then any',
    async()=>{
        const m = machine();
        const out = m.host.allocate(8);
        // Before Load: no file, no pin, and that is not an error.
        assert.equal(await m.invoke(m.filter, IID_IFILE_SOURCE_FILTER, 'GetCurFile', [out, 0]), 0);
        assert.equal(m.view.getUint32(out, true), 0);
        await m.invoke(m.filter, IID_IBASE_FILTER, 'EnumPins', [out]);
        const fetched = m.host.allocate(4);
        assert.equal(await m.invoke(m.objectAt(m.view.getUint32(out, true)), IID_IENUM.pins, 'Next',
            [1, out + 4, fetched]), 1, 'S_FALSE: no pin yet');

        assert.equal(await m.invoke(m.filter, IID_IFILE_SOURCE_FILTER, 'Load',
            [m.wide('C:\\nowhere.avi'), 0]), 0x80070002 | 0);
        assert.equal(await m.invoke(m.filter, IID_IFILE_SOURCE_FILTER, 'Load',
            [m.wide('C:\\film.avi'), 0]), 0);
        assert.equal(await m.invoke(m.filter, IID_IFILE_SOURCE_FILTER, 'Load',
            [m.wide('C:\\film.avi'), 0]), 0x8000ffff | 0, 'one file a filter');

        assert.equal(await m.invoke(m.filter, IID_IBASE_FILTER, 'FindPin',
            [m.wide('Output'), out]), 0);
        const pin = m.objectAt(m.view.getUint32(out, true));
        assert.equal(await m.invoke(pin, IID_IPIN, 'EnumMediaTypes', [out]), 0);
        const types = m.objectAt(m.view.getUint32(out, true));
        /** @type {string[]} */
        const seen = [];
        while (await m.invoke(types, IID_IENUM.types, 'Next', [1, out + 4, 0]) === 0)
        {
            const at = m.view.getUint32(out + 4, true);
            seen.push(`${formatGuid(m.memory.slice(at, at + 16))} ${
                formatGuid(m.memory.slice(at + 16, at + 32))}`);
        }
        assert.deepEqual(seen, [`${MEDIATYPE_STREAM} ${MEDIASUBTYPE.AVI}`,
            `${MEDIATYPE_STREAM} ${GUID_NULL}`]);

        const type = m.host.allocate(0x48);
        m.memory.set(/** @type {Uint8Array} */ (parseGuid(MEDIATYPE_STREAM)), type);
        m.memory.set(/** @type {Uint8Array} */ (parseGuid(MEDIASUBTYPE.WAVE)), type + 16);
        assert.equal(await m.invoke(pin, IID_IPIN, 'QueryAccept', [type]), 1, 'another subtype');
        m.memory.set(/** @type {Uint8Array} */ (parseGuid(MEDIASUBTYPE.AVI)), type + 16);
        assert.equal(await m.invoke(pin, IID_IPIN, 'QueryAccept', [type]), 0);

        const buffer = m.host.allocate(64);
        assert.equal(await m.invoke(pin, IID_IASYNC_READER, 'SyncRead', [8, 0, 4, buffer]), 0);
        assert.equal(String.fromCharCode(...m.memory.slice(buffer, buffer + 4)), 'AVI ');
        assert.equal(await m.invoke(pin, IID_IASYNC_READER, 'SyncRead', [30, 0, 40, buffer]), 1,
            'S_FALSE: the file ended first');
        const total = m.host.allocate(16);
        assert.equal(await m.invoke(pin, IID_IASYNC_READER, 'Length', [total, total + 8]), 0);
        assert.equal(m.view.getUint32(total, true), 39, 'its whole length');
    });
