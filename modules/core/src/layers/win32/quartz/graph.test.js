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

function createHost(){
    const bytes = new Uint8Array(0x4000);
    const view = new DataView(bytes.buffer);
    /** @type {{ hwnd: number, message: number, wParam: number, lParam: number }[]} */
    const posted = [];
    return {
        posted,
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
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

/** @param {string} clsid */
function createObject(clsid = CLSID_FILTER_GRAPH){
    const host = createHost();
    const registry = createComRegistry();
    registerQuartzClasses(registry, host);
    const object = registry.create(clsid);
    assert.ok(object, `${clsid} produced no object`);
    return { host, registry, object };
}

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
    return method.invoke(object, args) | 0;
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
