/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComRegistry } from '../ole32/objects.js';
import { formatGuid } from '../ole32/guid.js';
import { registerQuartzClasses } from './graph.js';
import { packBottomUpRgb24 } from './stream.js';
import {
    CLSID_FILTER_GRAPH, IID_IGRAPH_BUILDER, IID_IMEDIA_CONTROL, IID_IMEDIA_EVENT,
    IID_IMEDIA_EVENT_SINK, IID_IMEDIA_POSITION, IID_IMEM_INPUT_PIN, IID_IPIN,
} from './interfaces.js';

const S_OK = 0;
const S_FALSE = 1;
const E_ABORT = 0x80004004;
const E_NOINTERFACE = 0x80004002;
const VFW_E_CANNOT_CONNECT = 0x80040217;
const VFW_E_NOT_FOUND = 0x80040216;
const EC_COMPLETE = 1;

const MEDIATYPE_VIDEO = '{73646976-0000-0010-8000-00AA00389B71}';
const MEDIASUBTYPE_RGB24 = '{E436EB7D-524F-11CE-9F53-0020AF0BA770}';
const FORMAT_VIDEO_INFO = '{05589F80-C356-11CE-BF01-00AA0055595A}';

/** A 2x2 film of `frames` frames: pixel (x, y) of frame n is BGRA (n, x, y, 255). */
function film(frames = 3){
    let given = 0;
    return {
        width: 2, height: 2, fps: 10, frameCount: frames, hasVideo: true, hasAudio: false,
        sampleRate: 0, channels: 0, closed: false,
        decode(){
            if (given >= frames)
            {
                return 'end';
            }
            given++;
            return 'frame';
        },
        frame(){
            const bgra = new Uint8Array(16);
            for (let y = 0; y < 2; y++)
            {
                for (let x = 0; x < 2; x++)
                {
                    bgra.set([given, x, y, 255], (y * 2 + x) * 4);
                }
            }
            return bgra;
        },
        readAudio: ()=>null,
        close(){
            this.closed = true;
        },
    };
}

/**
 * A machine with guest memory, the program's objects as tables of JS routines
 * standing at guest addresses, and a streaming thread the test turns by hand.
 */
function machine(){
    const bytes = new Uint8Array(0x20000);
    const view = new DataView(bytes.buffer);
    let free = 0x8000;
    /** @param {number} size */
    const allocate = size=>{
        const at = free;
        free += (size + 15) & ~15;
        return at;
    };
    /** @type {Map<number, (args: number[]) => number | Promise<number>>} */
    const routines = new Map();
    let nextRoutine = 0x7000_0000;
    /** @type {Map<number, { object: any, iid: string }>} */
    const published = new Map();
    /** @type {Map<any, Map<string, number>>} */
    const pointers = new Map();
    /** @type {{ entry: number, args: number[], done?: () => void, tag?: any }[]} */
    const queue = [];
    const thread = { name: 'main' };

    /**
     * One of the program's objects: a vtable of routines, IUnknown's three first.
     *
     * @param {((args: number[]) => number | Promise<number>)[]} methods
     */
    const guestObject = methods=>{
        const self = allocate(8);
        const table = allocate(methods.length * 4);
        view.setUint32(self, table, true);
        methods.forEach((method, slot)=>{
            const entry = nextRoutine++;
            routines.set(entry, method);
            view.setUint32(table + slot * 4, entry, true);
        });
        return self;
    };

    const host = {
        bytes, view, queue, thread,
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>bytes.set(data, at),
        /** @param {number} at @param {number} max */
        readWideString(at, max){
            let text = '';
            for (let i = 0; i < max; i++)
            {
                const unit = view.getUint16(at + i * 2, true);
                if (unit === 0)
                {
                    break;
                }
                text += String.fromCharCode(unit);
            }
            return text;
        },
        /** @param {number} at @param {string} text */
        putWide(at, text){
            [...text].forEach((ch, i)=>view.setUint16(at + i * 2, ch.charCodeAt(0), true));
            view.setUint16(at + text.length * 2, 0, true);
        },
        post: ()=>{},
        divergence: ()=>{},
        opened: /** @type {string[]} */ ([]),
        /** @type {ReturnType<typeof film>[]} */
        clips: [],
        video: {
            /** @param {string} path */
            open(path){
                host.opened.push(path);
                const clip = film();
                host.clips.push(clip);
                return Promise.resolve(clip);
            },
        },
        stream: {
            readU32: (/** @type {number} */ at)=>view.getUint32(at, true),
            writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>bytes.set(data, at),
            readWideString: (/** @type {number} */ at, /** @type {number} */ max)=>
                host.readWideString(at, max),
            allocate,
            free: ()=>{},
            /** @param {number} entry @param {number[]} args */
            callGuest: async(entry, args)=>{
                const routine = routines.get(entry);
                assert.ok(routine, `no routine at 0x${entry.toString(16)}`);
                return (await routine(args)) >>> 0;
            },
            currentThread: ()=>thread,
            /** @param {any} object @param {string} iid */
            publish(object, iid){
                let byIid = pointers.get(object);
                if (!byIid)
                {
                    byIid = new Map();
                    pointers.set(object, byIid);
                }
                const known = byIid.get(iid);
                if (known !== undefined)
                {
                    return known;
                }
                const at = allocate(8);
                byIid.set(iid, at);
                published.set(at, { object, iid });
                return at;
            },
            objectAt: (/** @type {number} */ at)=>published.get(at)?.object ?? null,
            notices: {
                /**
                 * @param {number} entry @param {number[]} args @param {() => void} [done]
                 * @param {any} [tag]
                 */
                deliver: (entry, args, done, tag)=>queue.push({ entry, args, done, tag }),
                /** @param {any} tag */
                drop(tag){
                    const dropped = queue.filter(notice=>notice.tag === tag);
                    queue.splice(0, queue.length, ...queue.filter(notice=>notice.tag !== tag));
                    return dropped;
                },
            },
        },
    };

    /** Runs what the streaming thread owes, in order. */
    const pump = async()=>{
        while (queue.length > 0)
        {
            const next = /** @type {{ entry: number, args: number[], done?: () => void }} */ (
                queue.shift());
            await host.stream.callGuest(next.entry, next.args);
            next.done?.();
        }
    };

    /** Calls a method of one of our objects the way the program would. @param {number} pointer @param {string} name @param {number[]} [args] */
    const invoke = (pointer, name, args = [])=>{
        const record = published.get(pointer);
        assert.ok(record, `0x${pointer.toString(16)} is not one of ours`);
        const methods = record.object.interfaceFor(record.iid).methods;
        const method = methods.find((/** @type {any} */ m)=>m.name === name);
        assert.ok(method?.invoke, `${name} is not implemented`);
        return method.invoke(record.object, args);
    };

    return { host, allocate, guestObject, pump, invoke, view, bytes };
}

/**
 * A renderer as the SDK's base classes build one: accepts RGB24 in a
 * VIDEOINFOHEADER, takes the allocator it is offered, copies each sample it is
 * given, and tells the graph EC_COMPLETE at the end of the stream.
 *
 * @param {ReturnType<typeof machine>} m
 */
function renderer(m){
    const seen = {
        refs: 0, graph: 0, states: /** @type {string[]} */ ([]), mediaType: /** @type {any} */ (null),
        connector: 0, allocator: 0, frames: /** @type {number[][]} */ ([]),
        discontinuities: /** @type {number[]} */ ([]), flushes: 0, ended: 0, filter: 0, pin: 0,
        memInput: 0,
    };
    /** @type {((args: number[]) => number | Promise<number>)[]} */
    const iunknown = [
        ([, iid, out])=>{
            const asked = formatGuid(m.bytes.slice(iid, iid + 16));
            const answer = asked === IID_IMEM_INPUT_PIN ? seen.memInput
                : asked === IID_IPIN ? seen.pin : 0;
            m.view.setUint32(out, answer, true);
            if (answer === 0)
            {
                return E_NOINTERFACE;
            }
            seen.refs++;
            return S_OK;
        },
        ()=>++seen.refs,
        ()=>--seen.refs,
    ];
    const graphCall = (/** @type {string} */ iid, /** @type {string} */ name, /** @type {number[]} */ args)=>{
        const object = m.host.stream.objectAt(seen.graph);
        return m.invoke(m.host.stream.publish(object, iid), name, args);
    };
    seen.filter = m.guestObject([
        ...iunknown,
        ()=>S_OK, // GetClassID
        ()=>(seen.states.push('stop'), S_OK),
        ()=>(seen.states.push('pause'), S_OK),
        ()=>(seen.states.push('run'), S_OK),
        ()=>S_OK, ()=>S_OK, ()=>S_OK, ()=>S_OK, ()=>S_OK, ()=>S_OK,
        ([, graph])=>{
            seen.graph = graph;
            return S_OK;
        },
        ()=>S_OK,
    ]);
    seen.pin = m.guestObject([
        ...iunknown,
        ()=>S_OK, // Connect
        ([, connector, mt])=>{
            const guid = (/** @type {number} */ at)=>formatGuid(m.bytes.slice(at, at + 16));
            const format = m.view.getUint32(mt + 0x44, true);
            seen.mediaType = {
                major: guid(mt), sub: guid(mt + 0x10), formatType: guid(mt + 0x2c),
                formatBytes: m.view.getUint32(mt + 0x40, true),
                width: m.view.getInt32(format + 0x34, true),
                height: m.view.getInt32(format + 0x38, true),
                bits: m.view.getUint16(format + 0x3e, true),
            };
            const accepted = seen.mediaType.major === MEDIATYPE_VIDEO
                && seen.mediaType.sub === MEDIASUBTYPE_RGB24
                && seen.mediaType.formatType === FORMAT_VIDEO_INFO
                && seen.mediaType.formatBytes >= 0x58;
            if (accepted)
            {
                seen.connector = connector;
                seen.refs++;
            }
            return accepted ? S_OK : 0x80004005;
        },
        ()=>{
            seen.connector = 0;
            return S_OK;
        },
        ()=>S_OK, ()=>S_OK, ()=>S_OK, ()=>S_OK, ()=>S_OK, ()=>S_OK, ()=>S_OK, ()=>S_OK,
        ()=>{
            seen.ended++;
            return graphCall(IID_IMEDIA_EVENT_SINK, 'Notify', [EC_COMPLETE, 0, seen.filter]);
        },
        ()=>(seen.flushes++, S_OK),
        ()=>S_OK,
        ()=>S_OK,
    ]);
    seen.memInput = m.guestObject([
        ...iunknown,
        ()=>S_OK, // GetAllocator
        ([, allocator])=>{
            seen.allocator = allocator;
            return S_OK;
        },
        ()=>S_OK,
        ([, sample])=>{
            const out = m.allocate(4);
            assert.equal(m.invoke(sample, 'GetPointer', [out]), S_OK);
            const at = m.view.getUint32(out, true);
            const length = m.invoke(sample, 'GetActualDataLength');
            seen.frames.push([...m.bytes.slice(at, at + length)]);
            seen.discontinuities.push(/** @type {number} */ (m.invoke(sample, 'IsDiscontinuity')));
            return S_OK;
        },
    ]);
    return seen;
}

/** A graph with the renderer joined and the film connected, as a texture-movie player builds it. */
async function built(){
    const m = machine();
    const registry = createComRegistry();
    const { tick } = registerQuartzClasses(registry, /** @type {any} */ (m.host));
    const graphObject = registry.create(CLSID_FILTER_GRAPH);
    assert.ok(graphObject);
    const graph = m.host.stream.publish(graphObject, IID_IGRAPH_BUILDER);
    const seen = renderer(m);

    const name = m.allocate(64);
    m.host.putWide(name, 'TEXTURERENDERER');
    assert.equal(await m.invoke(graph, 'AddFilter', [seen.filter, name]), S_OK);

    const path = m.allocate(128);
    m.host.putWide(path, String.raw`C:\App\Movies\Menu.avi`);
    const out = m.allocate(4);
    assert.equal(await m.invoke(graph, 'AddSourceFilter', [path, 0, out]), S_OK);
    const source = m.view.getUint32(out, true);

    const pinName = m.allocate(32);
    m.host.putWide(pinName, 'Output');
    assert.equal(m.invoke(source, 'FindPin', [pinName, out]), S_OK);
    const pin = m.view.getUint32(out, true);
    assert.equal(await m.invoke(graph, 'Connect', [pin, seen.pin]), S_OK);
    return { m, graph, graphObject, seen, tick, source, pin };
}

test('a renderer the program wrote joins the graph and is offered bottom-up RGB24', async()=>{
    const { m, seen, graph, pin } = await built();
    assert.notEqual(seen.graph, 0, 'told which graph it is in');
    assert.equal(m.host.stream.objectAt(seen.graph), m.host.stream.objectAt(graph));
    assert.deepEqual(seen.mediaType, {
        major: MEDIATYPE_VIDEO, sub: MEDIASUBTYPE_RGB24, formatType: FORMAT_VIDEO_INFO,
        formatBytes: 0x58, width: 2, height: 2, bits: 24,
    });
    assert.equal(seen.connector, pin, 'connected to the source pin');
    assert.notEqual(seen.allocator, 0, 'handed an allocator');
    assert.deepEqual(m.host.opened, [String.raw`C:\App\Movies\Menu.avi`]);
});

test('running feeds a frame at a time by the film clock, then ends in EC_COMPLETE', async()=>{
    const { m, seen, graph, tick } = await built();
    const control = m.host.stream.publish(m.host.stream.objectAt(graph), IID_IMEDIA_CONTROL);
    assert.equal(await m.invoke(control, 'Run'), S_OK);
    assert.deepEqual(seen.states, ['pause', 'run'], 'paused, then run');

    tick(1000);
    tick(1050);
    assert.equal(m.host.queue.length, 1, 'the next sample waits for the renderer to return');
    await m.pump();
    // Frame 1, bottom row first: (x, y=1) then (x, y=0), three bytes a pixel,
    // each row padded to four bytes.
    assert.deepEqual(seen.frames[0], [1, 0, 1, 1, 1, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0]);
    assert.deepEqual(seen.discontinuities, [S_OK], 'the first sample starts the stream');

    tick(1050);
    assert.equal(m.host.queue.length, 0, 'the second frame is not due yet');
    tick(1100);
    await m.pump();
    tick(1200);
    await m.pump();
    assert.deepEqual(seen.frames.map(frame=>frame[0]), [1, 2, 3]);
    assert.deepEqual(seen.discontinuities, [S_OK, S_FALSE, S_FALSE]);

    tick(1300);
    await m.pump();
    assert.equal(seen.ended, 1, 'EndOfStream after the last frame');
    const events = m.host.stream.publish(m.host.stream.objectAt(graph), IID_IMEDIA_EVENT);
    const codes = m.allocate(12);
    assert.equal(m.invoke(events, 'GetEvent', [codes, codes + 4, codes + 8, 0]), S_OK);
    assert.equal(m.view.getInt32(codes, true), EC_COMPLETE);
    assert.equal(m.invoke(events, 'GetEvent', [codes, codes + 4, codes + 8, 0]), E_ABORT);
    tick(1400);
    assert.equal(m.host.queue.length, 0, 'nothing after the end');
});

test('a seek to the start opens the film again and flushes the renderer first', async()=>{
    const { m, seen, graph, tick } = await built();
    const object = m.host.stream.objectAt(graph);
    await m.invoke(m.host.stream.publish(object, IID_IMEDIA_CONTROL), 'Run');
    for (const at of [0, 100, 200, 300])
    {
        tick(at);
        await m.pump();
    }
    assert.equal(seen.ended, 1);

    // put_CurrentPosition(0.0): a double pushed as two zero words.
    const position = m.host.stream.publish(object, IID_IMEDIA_POSITION);
    assert.equal(await m.invoke(position, 'put_CurrentPosition', [0, 0]), S_OK);
    assert.equal(m.host.opened.length, 2, 'opened again');
    assert.equal(m.host.clips[0].closed, true, 'and the first let go');
    tick(400);
    await m.pump();
    assert.equal(seen.flushes, 1, 'flushed, which clears the end of stream it held');
    assert.equal(seen.frames.at(-1)?.[0], 1, 'from the first frame');
    assert.equal(seen.discontinuities.at(-1), S_OK, 'marked as a break in the stream');
});

test('only the source pin can be connected, and only by name', async()=>{
    const { m, graph, source, seen } = await built();
    const out = m.allocate(4);
    const wrong = m.allocate(32);
    m.host.putWide(wrong, 'Input');
    assert.equal(m.invoke(source, 'FindPin', [wrong, out]), VFW_E_NOT_FOUND);
    assert.equal(m.view.getUint32(out, true), 0);
    assert.equal(await m.invoke(graph, 'Connect', [seen.pin, seen.pin]), VFW_E_CANNOT_CONNECT);
});

/**
 * The program's Release, as the bridge runs it: what the object owes as its
 * last reference goes is waited for first.
 *
 * @param {import('../ole32/objects.js').ComObject} object
 */
async function releaseAll(object){
    while (object.refCount > 0)
    {
        if (object.refCount === 1)
        {
            await object.lastRelease?.();
        }
        object.release();
    }
}

test('the last Release stops the renderer and takes it out of the graph first', async()=>{
    const { m, graphObject, seen, tick } = await built();
    const control = m.host.stream.publish(graphObject, IID_IMEDIA_CONTROL);
    await m.invoke(control, 'Run');
    tick(0);
    assert.equal(m.host.queue.length, 1, 'a sample is owed');
    const before = seen.refs;
    await releaseAll(graphObject);
    assert.equal(m.host.queue.length, 0, 'and taken back: nothing is left for later');
    assert.equal(seen.states.at(-1), 'stop');
    assert.equal(seen.graph, 0, 'told it is in no graph');
    assert.equal(seen.connector, 0, 'disconnected');
    assert.ok(seen.refs < before, 'its references given back');
    assert.equal(m.host.clips[0].closed, true);
});

test('the sample a renderer is given is the frame, bottom-up, rows padded to four bytes', ()=>{
    const bgra = Uint8Array.of(
        1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0,
        10, 11, 12, 0, 13, 14, 15, 0, 16, 17, 18, 0);
    const out = new Uint8Array(24);
    packBottomUpRgb24(bgra, out, 3, 2, 12);
    assert.deepEqual([...out], [
        10, 11, 12, 13, 14, 15, 16, 17, 18, 0, 0, 0,
        1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 0, 0,
    ]);
});

test('rendering the source pin plays the film in the window of the graph', async()=>{
    const m = machine();
    const registry = createComRegistry();
    const { tick } = registerQuartzClasses(registry, /** @type {any} */ (m.host));
    const graphObject = registry.create(CLSID_FILTER_GRAPH);
    assert.ok(graphObject);
    const graph = m.host.stream.publish(graphObject, IID_IGRAPH_BUILDER);
    const path = m.allocate(128);
    m.host.putWide(path, String.raw`C:\App\Movies\Intro.avi`);
    const out = m.allocate(4);
    assert.equal(await m.invoke(graph, 'AddSourceFilter', [path, 0, out]), S_OK);
    const name = m.allocate(32);
    m.host.putWide(name, 'Output');
    assert.equal(m.invoke(m.view.getUint32(out, true), 'FindPin', [name, out]), S_OK);
    assert.equal(await m.invoke(graph, 'Render', [m.view.getUint32(out, true)]), S_OK);
    await m.invoke(m.host.stream.publish(graphObject, IID_IMEDIA_CONTROL), 'Run');
    tick(0);
    const shown = tick(150);
    assert.ok(shown, 'a frame for the window');
    assert.equal(shown.width, 2);
    assert.equal(m.host.queue.length, 0, 'nothing for a renderer of the program');
});
