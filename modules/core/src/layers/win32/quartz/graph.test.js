/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComRegistry } from '../ole32/objects.js';
import { registerQuartzClasses } from './graph.js';
import {
    CLSID_FILTER_GRAPH, CLSID_FILTER_GRAPH_NO_THREAD, CLSID_FILTER_MAPPER2,
    IID_IBASIC_AUDIO, IID_IBASIC_VIDEO, IID_IFILTER_GRAPH, IID_IFILTER_MAPPER2,
    IID_IGRAPH_BUILDER, IID_IMEDIA_CONTROL, IID_IMEDIA_EVENT, IID_IMEDIA_EVENT_EX,
    IID_IMEDIA_POSITION, IID_IMEDIA_SEEKING, IID_IVIDEO_WINDOW,
} from './interfaces.js';

const S_OK = 0;
const S_FALSE = 1;
const E_NOTIMPL = 0x80004001 | 0;
const E_POINTER = 0x80004003 | 0;
const E_ABORT = 0x80004004 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const VFW_E_WRONG_STATE = 0x80040227 | 0;
const EC_COMPLETE = 1;
const EC_ERRORABORT = 3;

/** Somewhere to point an out-parameter at. */
const OUT = 0x1000;

/**
 * A clip that hands out `frameCount` frames and then ends, with a block of
 * sound before the first one -- which is the order a decoder that stops early
 * to drain its audio produces.
 *
 * @param {{ frameCount?: number, fps?: number, width?: number, height?: number }} [shape]
 */
function fakeClip({ frameCount = 3, fps = 10, width = 800, height = 368 } = {}){
    let given = 0;
    let sound = 1;
    return {
        width, height, fps, frameCount, hasVideo: true, hasAudio: true,
        sampleRate: 44100, channels: 2,
        closed: false,
        decode(){
            if (sound > 0)
            {
                sound--;
                return 'audio';
            }
            if (given >= frameCount)
            {
                return 'end';
            }
            given++;
            return 'frame';
        },
        frame: ()=>Uint8Array.of(given, 0, 0, 0xff),
        readAudio: ()=>Int16Array.of(0x1234, -0x1234),
        close(){
            this.closed = true;
        },
    };
}

/** @param {{ clip?: ReturnType<typeof fakeClip> | null }} [options] */
function createHost({ clip } = {}){
    const bytes = new Uint8Array(0x4000);
    const view = new DataView(bytes.buffer);
    /** @type {{ hwnd: number, message: number, wParam: number, lParam: number }[]} */
    const posted = [];
    /** @type {string[]} */
    const reported = [];
    /** @type {string[]} */
    const opened = [];
    return {
        posted,
        reported,
        opened,
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address @param {number} maxLength */
        readWideString(address, maxLength){
            let text = '';
            for (let at = 0; at < maxLength; at++)
            {
                const unit = view.getUint16(address + at * 2, true);
                if (unit === 0)
                {
                    break;
                }
                text += String.fromCharCode(unit);
            }
            return text;
        },
        /** @param {number} address @param {string} text */
        putWide(address, text){
            for (let at = 0; at < text.length; at++)
            {
                view.setUint16(address + at * 2, text.charCodeAt(at), true);
            }
            view.setUint16(address + text.length * 2, 0, true);
        },
        video: clip === undefined ? undefined : {
            /** @param {string} path */
            open(path){
                opened.push(path);
                return clip ?? null;
            },
        },
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>reported.push(`${api}: ${detail}`),
        /** @param {{ hwnd: number, message: number, wParam: number, lParam: number }} m */
        post: m=>{
            posted.push(m);
        },
        /** @param {number} address */
        i32: address=>view.getInt32(address, true),
        /** @param {number} address */
        f64: address=>view.getFloat64(address, true),
        /** @param {number} address */
        i64: address=>view.getBigInt64(address, true),
    };
}

/**
 * @param {string} clsid
 * @param {{ clip?: ReturnType<typeof fakeClip> | null }} [options]
 */
function createObject(clsid = CLSID_FILTER_GRAPH, options = {}){
    const host = createHost(options);
    const registry = createComRegistry();
    const { tick } = registerQuartzClasses(registry, host);
    const object = registry.create(clsid);
    assert.ok(object, `${clsid} produced no object`);
    return { host, registry, object, tick };
}

/** The path a program hands RenderFile, and where the test writes it. */
const PATH = 0x2000;
const MOVIE = String.raw`C:\App\Movies\TutorialIn.mpq`;

/** @param {import('../ole32/objects.js').ComObject} object @param {string} iid */
function methodsOf(object, iid){
    const record = object.interfaceFor(iid);
    assert.ok(record, `no interface ${iid}`);
    return record.methods;
}

/**
 * @param {import('../ole32/objects.js').ComObject} object
 * @param {string} iid @param {string} name @param {number[]} [args]
 */
function call(object, iid, name, args = []){
    const method = methodsOf(object, iid).find(entry=>entry.name === name);
    assert.ok(method, `${iid} has no ${name}`);
    assert.ok(method.invoke, `${iid}::${name} is not implemented`);
    // A method may answer with a promise -- RenderFile has to read a file --
    // and a test that wants the number awaits it itself.
    const answer = method.invoke(object, args);
    return typeof answer === 'number' ? answer | 0 : answer;
}

test('CoCreateInstance finds the filter graph under both of its class ids', ()=>{
    const registry = createComRegistry();
    registerQuartzClasses(registry, createHost());
    for (const clsid of [CLSID_FILTER_GRAPH, CLSID_FILTER_GRAPH_NO_THREAD, CLSID_FILTER_MAPPER2])
    {
        assert.equal(registry.isRegistered(clsid), true, clsid);
        assert.ok(registry.create(clsid), clsid);
    }
});

test('one object answers QueryInterface for every interface a player asks for', ()=>{
    const { object } = createObject();
    for (const iid of [
        IID_IFILTER_GRAPH, IID_IGRAPH_BUILDER, IID_IMEDIA_CONTROL, IID_IMEDIA_EVENT,
        IID_IMEDIA_EVENT_EX, IID_IVIDEO_WINDOW, IID_IBASIC_VIDEO, IID_IBASIC_AUDIO,
        IID_IMEDIA_POSITION, IID_IMEDIA_SEEKING,
    ])
    {
        assert.ok(object.queryInterface(iid), iid);
    }
    // A graph is not a filter mapper, and saying so is an answer a program handles.
    assert.equal(object.queryInterface(IID_IFILTER_MAPPER2), null);
});

test('IGraphBuilder derives from IUnknown, so its own methods start at slot 3', ()=>{
    const { object } = createObject();
    const methods = methodsOf(object, IID_IGRAPH_BUILDER).map(entry=>entry.name);
    assert.deepEqual(methods.slice(0, 4), ['QueryInterface', 'AddRef', 'Release', 'AddFilter']);
    assert.equal(methods[13], 'RenderFile');
    assert.equal(methods.length, 18);
});

test('the dispatch-derived interfaces put their own methods after IDispatch', ()=>{
    const { object } = createObject();
    const dispatch = ['GetTypeInfoCount', 'GetTypeInfo', 'GetIDsOfNames', 'Invoke'];
    /** @type {[string, string, number][]} slots the guest was compiled against */
    const expected = [
        [IID_IMEDIA_CONTROL, 'Run', 7],
        [IID_IMEDIA_CONTROL, 'GetState', 10],
        // Confirmed against a compiled caller: vtable+0x34.
        [IID_IMEDIA_EVENT_EX, 'SetNotifyWindow', 13],
        [IID_IMEDIA_EVENT_EX, 'GetEvent', 8],
        [IID_IVIDEO_WINDOW, 'put_Owner', 29],
        [IID_IVIDEO_WINDOW, 'SetWindowPosition', 39],
        [IID_IBASIC_VIDEO, 'get_VideoWidth', 10],
        // vtable+0x88, which is where a compiled caller reaches for it.
        [IID_IBASIC_VIDEO, 'GetVideoSize', 34],
        [IID_IBASIC_AUDIO, 'put_Volume', 7],
        [IID_IMEDIA_POSITION, 'get_CurrentPosition', 9],
    ];
    for (const [iid, name, slot] of expected)
    {
        const methods = methodsOf(object, iid).map(entry=>entry.name);
        assert.deepEqual(methods.slice(3, 7), dispatch, `${iid} IDispatch block`);
        assert.equal(methods[slot], name, `${iid} slot ${slot}`);
    }
});

test('IMediaSeeking has no IDispatch block, so it starts three slots earlier', ()=>{
    const { object } = createObject();
    const methods = methodsOf(object, IID_IMEDIA_SEEKING).map(entry=>entry.name);
    assert.equal(methods[3], 'GetCapabilities');
    assert.equal(methods[19], 'GetPreroll');
    assert.equal(methods.length, 20);
});

test('every slot counts the interface pointer, and a REFTIME counts as two words', ()=>{
    const { object } = createObject();
    for (const iid of [IID_IGRAPH_BUILDER, IID_IVIDEO_WINDOW, IID_IMEDIA_POSITION])
    {
        for (const method of methodsOf(object, iid))
        {
            assert.equal(method.argBytes % 4, 0, `${iid}::${method.name}`);
            assert.ok(method.argBytes >= 4, `${iid}::${method.name}`);
        }
    }
    const position = methodsOf(object, IID_IMEDIA_POSITION);
    const setter = position.find(entry=>entry.name === 'put_CurrentPosition');
    const getter = position.find(entry=>entry.name === 'get_CurrentPosition');
    assert.equal(setter?.argBytes, 12, 'a double by value is two words');
    assert.equal(getter?.argBytes, 8, 'a pointer to one is a single word');
});

test('a slot nothing implements keeps its place and answers E_NOTIMPL', ()=>{
    const { object } = createObject();
    const methods = methodsOf(object, IID_IGRAPH_BUILDER);
    const reconnect = methods.find(entry=>entry.name === 'Reconnect');
    assert.ok(reconnect, 'the slot exists');
    assert.equal(reconnect.invoke, undefined, 'and the bridge answers E_NOTIMPL for it');
});

test('RenderFile builds a graph, empty though it is', ()=>{
    // Nothing is decoded yet, so what it builds contains no filters and has no
    // length. That is a real state and it succeeds; refusing instead is worse,
    // because a program that handles the refusal correctly releases the graph
    // and its own timer then reads the pointer it has just released.
    const { object } = createObject();
    assert.equal(call(object, IID_IGRAPH_BUILDER, 'RenderFile', [0x2000, 0]), S_OK);
    assert.equal(call(object, IID_IMEDIA_CONTROL, 'RenderFile', [0x2000]), S_OK);
});

test('Run on an empty graph completes at once', ()=>{
    const { object, host } = createObject();
    assert.equal(call(object, IID_IGRAPH_BUILDER, 'RenderFile', [0x2000, 0]), S_OK);
    assert.equal(call(object, IID_IMEDIA_CONTROL, 'Run'), S_OK);
    assert.equal(call(object, IID_IMEDIA_CONTROL, 'GetState', [0, OUT]), S_OK);
    assert.equal(host.i32(OUT), 2, 'State_Running');

    // A presentation of no length has reached its end, which is the same event
    // a whole film ends with -- and the path every program is written for.
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'GetEvent', [OUT, OUT + 4, OUT + 8, 0]), S_OK);
    assert.equal(host.i32(OUT), EC_COMPLETE);
    assert.equal(host.i32(OUT + 8), 0);
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'FreeEventParams', [EC_COMPLETE, 0, 0]), S_OK);
});

test('GetEvent empties the queue and then reports there is nothing more', ()=>{
    const { object } = createObject();
    call(object, IID_IMEDIA_CONTROL, 'Run');
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'GetEvent', [OUT, OUT + 4, OUT + 8, 0]), S_OK);
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'GetEvent', [OUT, OUT + 4, OUT + 8, 0]),
        E_ABORT);
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'GetEvent', [0, OUT + 4, OUT + 8, 0]),
        E_POINTER, 'and refuses a null out-parameter rather than dereferencing it');
});

test('Run posts the private message to the window SetNotifyWindow named', ()=>{
    const { object, host } = createObject();
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'SetNotifyWindow', [0x40, 0x8001, 0xabcd]),
        S_OK);
    call(object, IID_IMEDIA_CONTROL, 'Run');
    assert.deepEqual(host.posted,
        [{ hwnd: 0x40, message: 0x8001, wParam: 0, lParam: 0xabcd }]);
});

test('a graph with no notify window still queues the event and posts nothing', ()=>{
    const { object, host } = createObject();
    call(object, IID_IMEDIA_CONTROL, 'Run');
    assert.equal(host.posted.length, 0);
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'GetEvent', [OUT, OUT + 4, OUT + 8, 0]), S_OK);
});

test('AM_MEDIAEVENT_NONOTIFY suppresses the message without losing the event', ()=>{
    const { object, host } = createObject();
    call(object, IID_IMEDIA_EVENT_EX, 'SetNotifyWindow', [0x40, 0x8001, 0]);
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'SetNotifyFlags', [1]), S_OK);
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'GetNotifyFlags', [OUT]), S_OK);
    assert.equal(host.i32(OUT), 1);
    call(object, IID_IMEDIA_CONTROL, 'Run');
    assert.equal(host.posted.length, 0);
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'GetEvent', [OUT, OUT + 4, OUT + 8, 0]), S_OK);
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'SetNotifyFlags', [2]), E_INVALIDARG);
});

test('WaitForCompletion answers with the abort code, and only while running', ()=>{
    const { object, host } = createObject();
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'WaitForCompletion', [0, OUT]),
        VFW_E_WRONG_STATE);
    call(object, IID_IMEDIA_CONTROL, 'Run');
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'WaitForCompletion', [0, OUT]), S_OK);
    assert.equal(host.i32(OUT), EC_ERRORABORT);
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'WaitForCompletion', [0, OUT]), E_ABORT);
});

test('GetEventHandle fails cleanly rather than handing out a handle that never signals', ()=>{
    const { object, host } = createObject();
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'GetEventHandle', [OUT]), E_NOTIMPL);
    assert.equal(host.i32(OUT), 0);
});

test('Stop and Pause move the reported state', ()=>{
    const { object, host } = createObject();
    for (const [name, state] of /** @type {[string, number][]} */ ([
        ['Pause', 1], ['Run', 2], ['Stop', 0], ['StopWhenReady', 0],
    ]))
    {
        assert.equal(call(object, IID_IMEDIA_CONTROL, name), S_OK, name);
        assert.equal(call(object, IID_IMEDIA_CONTROL, 'GetState', [0, OUT]), S_OK);
        assert.equal(host.i32(OUT), state, name);
    }
});

test('IVideoWindow remembers what it was set to', ()=>{
    const { object, host } = createObject();
    assert.equal(call(object, IID_IVIDEO_WINDOW, 'put_Owner', [0x40]), S_OK);
    assert.equal(call(object, IID_IVIDEO_WINDOW, 'get_Owner', [OUT]), S_OK);
    assert.equal(host.i32(OUT), 0x40);

    assert.equal(call(object, IID_IVIDEO_WINDOW, 'put_MessageDrain', [0x44]), S_OK);
    assert.equal(call(object, IID_IVIDEO_WINDOW, 'put_WindowStyle', [0x40000000]), S_OK);
    assert.equal(call(object, IID_IVIDEO_WINDOW, 'get_WindowStyle', [OUT]), S_OK);
    assert.equal(host.i32(OUT), 0x40000000);

    assert.equal(call(object, IID_IVIDEO_WINDOW, 'SetWindowPosition', [10, 20, 320, 240]), S_OK);
    assert.equal(call(object, IID_IVIDEO_WINDOW,
        'GetWindowPosition', [OUT, OUT + 4, OUT + 8, OUT + 12]), S_OK);
    assert.deepEqual(
        [host.i32(OUT), host.i32(OUT + 4), host.i32(OUT + 8), host.i32(OUT + 12)],
        [10, 20, 320, 240]);
    assert.equal(call(object, IID_IVIDEO_WINDOW, 'get_Owner', [0]), E_POINTER);
});

test('IBasicVideo answers a size a caller can lay a window out from', ()=>{
    const { object, host } = createObject();
    assert.equal(call(object, IID_IBASIC_VIDEO, 'get_VideoWidth', [OUT]), S_OK);
    assert.equal(call(object, IID_IBASIC_VIDEO, 'get_VideoHeight', [OUT + 4]), S_OK);
    assert.ok(host.i32(OUT) > 0 && host.i32(OUT + 4) > 0);
    assert.equal(call(object, IID_IBASIC_VIDEO, 'GetVideoSize', [OUT + 8, OUT + 12]), S_OK);
    assert.equal(host.i32(OUT + 8), host.i32(OUT));
    assert.equal(host.i32(OUT + 12), host.i32(OUT + 4));
});

test('IBasicAudio takes a volume in its declared range and refuses one outside it', ()=>{
    const { object, host } = createObject();
    assert.equal(call(object, IID_IBASIC_AUDIO, 'put_Volume', [-10000]), S_OK);
    assert.equal(call(object, IID_IBASIC_AUDIO, 'get_Volume', [OUT]), S_OK);
    assert.equal(host.i32(OUT), -10000);
    assert.equal(call(object, IID_IBASIC_AUDIO, 'put_Volume', [1]), E_INVALIDARG);
    assert.equal(call(object, IID_IBASIC_AUDIO, 'put_Volume', [-20000]), E_INVALIDARG);
});

test('IMediaPosition answers zero rather than faulting a timer that polls it', ()=>{
    const { object, host } = createObject();
    assert.equal(call(object, IID_IMEDIA_POSITION, 'get_CurrentPosition', [OUT]), S_OK);
    assert.equal(host.f64(OUT), 0);
    assert.equal(call(object, IID_IMEDIA_POSITION, 'get_Duration', [OUT]), S_OK);
    assert.equal(host.f64(OUT), 0);
    assert.equal(call(object, IID_IMEDIA_POSITION, 'get_Rate', [OUT]), S_OK);
    assert.equal(host.f64(OUT), 1);
    assert.equal(call(object, IID_IMEDIA_POSITION, 'CanSeekForward', [OUT]), S_OK);
    assert.equal(host.i32(OUT), 0);
});

test('IMediaSeeking reports no capabilities and a position of zero', ()=>{
    const { object, host } = createObject();
    assert.equal(call(object, IID_IMEDIA_SEEKING, 'GetCapabilities', [OUT]), S_OK);
    assert.equal(host.i32(OUT), 0);
    assert.equal(call(object, IID_IMEDIA_SEEKING, 'GetCurrentPosition', [OUT]), S_OK);
    assert.equal(host.i64(OUT), 0n);
    assert.equal(call(object, IID_IMEDIA_SEEKING, 'GetPositions', [OUT, OUT + 8]), S_OK);
    assert.equal(host.i64(OUT + 8), 0n);
});

test('AddSourceFilter zeroes the pointer it refused to fill', ()=>{
    const { object, host } = createObject();
    host.writeMemory(OUT, new Uint8Array([0xef, 0xbe, 0xad, 0xde]));
    assert.notEqual(call(object, IID_IGRAPH_BUILDER, 'AddSourceFilter', [0x2000, 0, OUT]), S_OK);
    assert.equal(host.i32(OUT), 0);
});

test('ShouldOperationContinue says stop, because nothing is in progress', ()=>{
    const { object } = createObject();
    assert.equal(call(object, IID_IGRAPH_BUILDER, 'ShouldOperationContinue'), S_FALSE);
    assert.equal(call(object, IID_IGRAPH_BUILDER, 'Abort'), S_OK);
});

test('IFilterMapper2 accepts a registration and refuses to invent a moniker', ()=>{
    const { object, host } = createObject(CLSID_FILTER_MAPPER2);
    const methods = methodsOf(object, IID_IFILTER_MAPPER2).map(entry=>entry.name);
    assert.deepEqual(methods.slice(3), [
        'CreateCategory', 'UnregisterFilter', 'RegisterFilter', 'EnumMatchingFilters',
    ]);
    assert.equal(call(object, IID_IFILTER_MAPPER2,
        'RegisterFilter', [0x2000, 0x2010, 0, 0, 0, 0x2020]), S_OK);
    assert.equal(call(object, IID_IFILTER_MAPPER2,
        'RegisterFilter', [0x2000, 0x2010, OUT, 0, 0, 0x2020]), E_NOTIMPL);
    assert.equal(host.i32(OUT), 0);
});

test('two graphs keep their own state', ()=>{
    const registry = createComRegistry();
    registerQuartzClasses(registry, createHost());
    const first = registry.create(CLSID_FILTER_GRAPH);
    const second = registry.create(CLSID_FILTER_GRAPH);
    assert.ok(first && second);
    call(first, IID_IMEDIA_CONTROL, 'Run');
    assert.equal(call(second, IID_IMEDIA_EVENT_EX, 'GetEvent', [OUT, OUT + 4, OUT + 8, 0]),
        E_ABORT);
});

test('RenderFile opens the file it was given and the graph takes the clip\'s size', ()=>{
    // A program sizes its window from IBasicVideo before a frame exists, so
    // these have to be the clip's and not the placeholder they used to be.
    const { object, host } = createObject(CLSID_FILTER_GRAPH, { clip: fakeClip() });
    host.putWide(PATH, MOVIE);

    assert.equal(call(object, IID_IGRAPH_BUILDER, 'RenderFile', [PATH, 0]), S_OK);
    assert.deepEqual(host.opened, [MOVIE], 'the name reached the decoder as written');

    assert.equal(call(object, IID_IBASIC_VIDEO, 'get_VideoWidth', [OUT]), S_OK);
    assert.equal(host.i32(OUT), 800);
    assert.equal(call(object, IID_IBASIC_VIDEO, 'get_VideoHeight', [OUT]), S_OK);
    assert.equal(host.i32(OUT), 368);
});

test('a clip has the length its frames add up to, not zero', ()=>{
    // A program that waits for the position to reach the duration waits for
    // ever when both are zero, which is what a graph with nothing in it says.
    const { object, host } = createObject(CLSID_FILTER_GRAPH,
        { clip: fakeClip({ frameCount: 30, fps: 10 }) });
    host.putWide(PATH, MOVIE);
    call(object, IID_IGRAPH_BUILDER, 'RenderFile', [PATH, 0]);

    assert.equal(call(object, IID_IMEDIA_POSITION, 'get_Duration', [OUT]), S_OK);
    assert.equal(host.f64(OUT), 3, 'thirty frames at ten a second');
    assert.equal(call(object, IID_IMEDIA_SEEKING, 'GetDuration', [OUT]), S_OK);
    assert.equal(host.i64(OUT), 30000000n, 'and the same in REFERENCE_TIME units');
});

test('Run with a clip plays it instead of completing at once', ()=>{
    const { object, host, tick } = createObject(CLSID_FILTER_GRAPH,
        { clip: fakeClip({ frameCount: 3, fps: 10 }) });
    host.putWide(PATH, MOVIE);
    call(object, IID_IGRAPH_BUILDER, 'RenderFile', [PATH, 0]);
    call(object, IID_IVIDEO_WINDOW, 'put_Owner', [0x40b4]);

    assert.equal(call(object, IID_IMEDIA_CONTROL, 'Run'), S_OK);
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'GetEvent', [OUT, OUT + 4, OUT + 8, 0]),
        E_ABORT, 'a film that has not been shown is not over');

    // The clock starts at the first tick, so this one is where time zero is.
    assert.equal(tick(1000), null, 'nothing is owed yet at the moment it starts');
    const shown = tick(1100);
    assert.ok(shown, 'a tenth of a second later, one frame');
    assert.equal(shown.hwnd, 0x40b4, 'addressed to the window the program owns it with');
    assert.deepEqual([shown.width, shown.height], [800, 368]);
    assert.ok(shown.bgra, 'and carries the picture');
    assert.deepEqual(shown.audio.map(block=>[...block]), [[0x1234, -0x1234]],
        'with whatever sound came with it');

    assert.equal(call(object, IID_IMEDIA_POSITION, 'get_CurrentPosition', [OUT]), S_OK);
    assert.equal(host.f64(OUT), 0.1, 'the position is what has been shown');
});

test('EC_COMPLETE arrives when the clip ends, exactly once', ()=>{
    // Once, because a program drains the queue with while (SUCCEEDED(GetEvent))
    // and an event that keeps coming back is a loop that never ends.
    const { object, host, tick } = createObject(CLSID_FILTER_GRAPH,
        { clip: fakeClip({ frameCount: 2, fps: 10 }) });
    host.putWide(PATH, MOVIE);
    call(object, IID_IGRAPH_BUILDER, 'RenderFile', [PATH, 0]);
    call(object, IID_IMEDIA_EVENT_EX, 'SetNotifyWindow', [0x40, 0x8001, 0xabcd]);
    call(object, IID_IMEDIA_CONTROL, 'Run');

    tick(0);
    tick(10000);
    assert.deepEqual(host.posted,
        [{ hwnd: 0x40, message: 0x8001, wParam: 0, lParam: 0xabcd }]);
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'GetEvent', [OUT, OUT + 4, OUT + 8, 0]), S_OK);
    assert.equal(host.i32(OUT), EC_COMPLETE);

    tick(20000);
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'GetEvent', [OUT, OUT + 4, OUT + 8, 0]),
        E_ABORT, 'and the queue stays empty however long it is ticked');
});

test('a paused graph stops advancing, and a stopped one is dropped', ()=>{
    const { object, host, tick } = createObject(CLSID_FILTER_GRAPH,
        { clip: fakeClip({ frameCount: 100, fps: 10 }) });
    host.putWide(PATH, MOVIE);
    call(object, IID_IGRAPH_BUILDER, 'RenderFile', [PATH, 0]);
    call(object, IID_IMEDIA_CONTROL, 'Run');
    tick(0);
    assert.ok(tick(200), 'running, so it advances');

    call(object, IID_IMEDIA_CONTROL, 'Pause');
    assert.equal(tick(400), null, 'paused, so it does not');

    call(object, IID_IMEDIA_CONTROL, 'Stop');
    assert.equal(tick(600), null);
    assert.ok(host.reported.some(line=>line.includes('cannot rewind')),
        'and says that stopping is not the rewind a real graph would do');
});

test('a build with no decoder behaves exactly as it did before', ()=>{
    // The empty graph is not a stub: it is what a machine with no filter for
    // the format does, and a build assembled without media must keep doing it.
    const { object, host, tick } = createObject();
    host.putWide(PATH, MOVIE);
    assert.equal(call(object, IID_IGRAPH_BUILDER, 'RenderFile', [PATH, 0]), S_OK);
    assert.equal(call(object, IID_IMEDIA_CONTROL, 'Run'), S_OK);
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'GetEvent', [OUT, OUT + 4, OUT + 8, 0]), S_OK);
    assert.equal(host.i32(OUT), EC_COMPLETE, 'completing at once, as it always has');
    assert.equal(tick(1000), null, 'and there is nothing to drive');
});

test('a file the decoder cannot open leaves the empty graph, not a failure', ()=>{
    // "No filter for this format" is an ordinary state of a Windows machine and
    // the program is written for it; the graph that results is the empty one.
    const { object, host, tick } = createObject(CLSID_FILTER_GRAPH, { clip: null });
    host.putWide(PATH, MOVIE);
    assert.equal(call(object, IID_IGRAPH_BUILDER, 'RenderFile', [PATH, 0]), S_OK);
    call(object, IID_IMEDIA_CONTROL, 'Run');
    assert.equal(call(object, IID_IMEDIA_EVENT_EX, 'GetEvent', [OUT, OUT + 4, OUT + 8, 0]), S_OK);
    assert.equal(host.i32(OUT), EC_COMPLETE);
    assert.equal(tick(1000), null);
});

test('seeking and retiming are accepted and say they did nothing', ()=>{
    const { object, host } = createObject(CLSID_FILTER_GRAPH, { clip: fakeClip() });
    host.putWide(PATH, MOVIE);
    call(object, IID_IGRAPH_BUILDER, 'RenderFile', [PATH, 0]);

    assert.equal(call(object, IID_IMEDIA_POSITION, 'put_CurrentPosition', [0, 0]), S_OK);
    assert.equal(call(object, IID_IMEDIA_POSITION, 'put_Rate', [0, 0]), S_OK);
    assert.ok(host.reported.some(line=>line.includes('does not seek')));
    assert.ok(host.reported.some(line=>line.includes('put_Rate')));
});
