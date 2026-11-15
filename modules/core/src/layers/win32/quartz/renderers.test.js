/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFilterBase, FORMAT_WAVE_FORMAT_EX, MEDIATYPE_AUDIO, MEDIATYPE_VIDEO,
    FORMAT_VIDEO_INFO } from './filter.js';
import { CLSID_DSOUND_RENDER, CLSID_NULL_RENDERER, createRenderers } from './renderers.js';
import { createComObject } from '../ole32/objects.js';
import { parseGuid } from '../ole32/guid.js';
import { createComRegistry } from '../ole32/objects.js';
import { registerQuartzClasses } from './graph.js';
import { createPassThru } from './passthru.js';

/** The renderers over one base, its seeking passed through over the same. @param {any} host */
const renderersOver = host=>{
    const base = createFilterBase(host);
    return createRenderers(base, host, createPassThru(base, host));
};
import { CLSID_FILTER_GRAPH, IID_IFILTER_GRAPH } from './interfaces.js';

const IID_IBASE_FILTER = '{56A86895-0AD4-11CE-B03A-0020AF0BA770}';
const IID_IPIN = '{56A86891-0AD4-11CE-B03A-0020AF0BA770}';
const IID_IMEM_INPUT_PIN = '{56A8689D-0AD4-11CE-B03A-0020AF0BA770}';
const PCM = '{00000001-0000-0010-8000-00AA00389B71}';
const RGB24 = '{E436EB7D-524F-11CE-9F53-0020AF0BA770}';

/**
 * A flat memory with the program's objects in it: each a vtable of entries
 * that are functions on this side, which `callGuest` runs.
 */
function machine(){
    const memory = new Uint8Array(1 << 16);
    const view = new DataView(memory.buffer);
    let next = 0x100;
    /** @type {Map<number, (args: number[]) => number>} */
    const entries = new Map();
    let entry = 0x8000_0000;
    /** @type {any[]} */
    const published = [];
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
        callGuest: async(at, args)=>/** @type {(args: number[]) => number} */ (entries.get(at))(args),
        currentThread: ()=>null,
        publish: (object, iid)=>{
            published.push([object, iid]);
            return published.length;
        },
        createInstance: ()=>0,
    };
    /**
     * One of the program's objects: its methods by slot, IUnknown's included.
     *
     * @param {Record<number, (args: number[]) => number>} slots
     */
    const guestObject = slots=>{
        const self = allocate(4);
        const table = allocate(4 * 32);
        view.setUint32(self, table, true);
        for (let slot = 0; slot < 32; slot++)
        {
            entries.set(++entry, slots[slot] ?? (()=>0));
            view.setUint32(table + slot * 4, entry, true);
        }
        return self;
    };
    /** @param {string} major @param {string} sub @param {string} format */
    const mediaType = (major, sub, format)=>{
        const at = allocate(0x48);
        memory.set(/** @type {Uint8Array} */ (parseGuid(major)), at);
        memory.set(/** @type {Uint8Array} */ (parseGuid(sub)), at + 0x10);
        memory.set(/** @type {Uint8Array} */ (parseGuid(format)), at + 0x2c);
        return at;
    };
    /** @param {any} object @param {string} iid @param {string} name @param {number[]} args */
    const invoke = (object, iid, name, args = [])=>object.interfaceFor(iid).methods
        .find((/** @type {any} */ m)=>m.name === name).invoke(object, args);
    const objectAt = (/** @type {number} */ pointer)=>published[pointer - 1][0];
    return { host, view, guestObject, mediaType, invoke, objectAt, allocate };
}

test('a renderer takes its media type, refuses samples while stopped, and ends with EC_COMPLETE',
    async()=>{
        const m = machine();
        const renderers = renderersOver(m.host);
        const filter = createComObject(CLSID_DSOUND_RENDER,
            /** @type {any} */ (renderers.get(CLSID_DSOUND_RENDER))());
        const out = m.allocate(8);
        await m.invoke(filter, IID_IBASE_FILTER, 'EnumPins', [out]);
        const pins = m.objectAt(m.view.getUint32(out, true));
        await m.invoke(pins, '{56A86892-0AD4-11CE-B03A-0020AF0BA770}', 'Next', [1, out, 0]);
        const pin = m.objectAt(m.view.getUint32(out, true));

        // The program's output pin: it says it is one.
        const upstream = m.guestObject({ 9: ([, at])=>{
            m.view.setUint32(at, 1, true);
            return 0;
        } });
        const video = m.mediaType(MEDIATYPE_VIDEO, RGB24, FORMAT_VIDEO_INFO);
        assert.equal(await m.invoke(pin, IID_IPIN, 'ReceiveConnection', [upstream, video]),
            0x8004022a | 0, 'VFW_E_TYPE_NOT_ACCEPTED: a sound renderer takes no picture');
        const audio = m.mediaType(MEDIATYPE_AUDIO, PCM, FORMAT_WAVE_FORMAT_EX);
        assert.equal(await m.invoke(pin, IID_IPIN, 'ReceiveConnection', [upstream, audio]), 0);
        assert.equal(await m.invoke(pin, IID_IPIN, 'ReceiveConnection', [upstream, audio]),
            0x80040204 | 0, 'VFW_E_ALREADY_CONNECTED');

        const sample = m.guestObject({});
        assert.equal(await m.invoke(pin, IID_IMEM_INPUT_PIN, 'Receive', [sample]),
            0x80040227 | 0, 'VFW_E_WRONG_STATE: stopped');
        // Connected and paused with no sample yet: still on its way.
        assert.equal(await m.invoke(filter, IID_IBASE_FILTER, 'Pause'), 1, 'S_FALSE');
        assert.equal(await m.invoke(filter, IID_IBASE_FILTER, 'GetState', [0, 0x7000]),
            0x00040237, 'VFW_S_STATE_INTERMEDIATE');
        let returned = false;
        const held = Promise.resolve(m.invoke(pin, IID_IMEM_INPUT_PIN, 'Receive', [sample]))
            .then(answer=>{
                returned = true;
                return answer;
            });
        await new Promise(done=>setImmediate(done));
        assert.equal(returned, false, 'a paused renderer holds its sample');
        assert.equal(await m.invoke(filter, IID_IBASE_FILTER, 'GetState', [0, 0x7000]), 0,
            'and has reached paused');
        assert.equal(await m.invoke(filter, IID_IBASE_FILTER, 'Run', [0, 0]), 0);
        assert.equal(await held, 0, 'running lets it go');

        /** @type {number[][]} */
        const notified = [];
        const sink = m.guestObject({ 3: ([, code, param])=>{
            notified.push([code, param]);
            return 0;
        } });
        const graph = m.guestObject({ 0: ([, , at])=>{
            m.view.setUint32(at, sink, true);
            return 0;
        } });
        await m.invoke(filter, IID_IBASE_FILTER, 'JoinFilterGraph', [graph, 0]);
        assert.equal(await m.invoke(pin, IID_IPIN, 'EndOfStream'), 0);
        assert.deepEqual(notified, [[1, 0]], 'EC_COMPLETE, S_OK, at once while running');
    });

test('the Null Renderer takes any type', async()=>{
    const m = machine();
    const renderers = renderersOver(m.host);
    const filter = createComObject(CLSID_NULL_RENDERER,
        /** @type {any} */ (renderers.get(CLSID_NULL_RENDERER))());
    const out = m.allocate(8);
    const name = m.allocate(8);
    m.view.setUint16(name, 'I'.charCodeAt(0), true);
    m.view.setUint16(name + 2, 'n'.charCodeAt(0), true);
    m.host.readWideString = ()=>'In';
    assert.equal(await m.invoke(filter, IID_IBASE_FILTER, 'FindPin', [name, out]), 0);
    const pin = m.objectAt(m.view.getUint32(out, true));
    const type = m.mediaType('{11111111-0000-0000-0000-000000000000}',
        '{22222222-0000-0000-0000-000000000000}', '{33333333-0000-0000-0000-000000000000}');
    assert.equal(await m.invoke(pin, IID_IPIN, 'QueryAccept', [type]), 0);
});

test('the graph\'s ConnectDirect is the output pin\'s Connect, and Disconnect the pin\'s own',
    async()=>{
        const m = machine();
        /** @type {number[][]} */
        const calls = [];
        const pin = m.guestObject({
            3: ([, into, type])=>{
                calls.push([3, into, type]);
                return 0;
            },
            5: ()=>{
                calls.push([5]);
                return 0;
            },
        });
        const registry = createComRegistry();
        registerQuartzClasses(registry, /** @type {any} */ ({
            writeMemory: m.host.writeMemory, post: ()=>{},
            stream: { ...m.host, notices: { deliver: ()=>{}, drop: ()=>[] },
                objectAt: ()=>null },
        }));
        const graph = /** @type {any} */ (registry.create(CLSID_FILTER_GRAPH));
        assert.equal(await m.invoke(graph, IID_IFILTER_GRAPH, 'ConnectDirect', [pin, 0x1234, 0x40]),
            0);
        assert.equal(await m.invoke(graph, IID_IFILTER_GRAPH, 'Disconnect', [pin]), 0);
        assert.deepEqual(calls, [[3, 0x1234, 0x40], [5]]);
    });
