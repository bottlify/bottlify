/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CLSID_DIRECTMUSIC, CLSID_DIRECTMUSIC_LOADER, CLSID_DIRECTMUSIC_PERFORMANCE,
    IID_DIRECTMUSIC, IID_DIRECTMUSIC8, IID_DIRECTMUSIC_LOADER, IID_DIRECTMUSIC_LOADER8,
    IID_DIRECTMUSIC_PERFORMANCE, IID_DIRECTMUSIC_PERFORMANCE8, registerDirectMusic,
} from './classes.js';
import { CLSID_DIRECTMUSIC_SYNTH, DMUS_PORTCAPS, IID_DIRECTMUSIC_PORT } from './ids.js';
import { readGuid } from '../../win32/ole32/guid.js';

function registered(){
    /** @type {Map<string, () => any>} */
    const classes = new Map();
    const music = registerDirectMusic({
        registry: { registerClass: (clsid, factory)=>classes.set(clsid, factory) },
        divergence: ()=>{},
        memory: { readBytes: (/** @type {number} */ _a, /** @type {number} */ l)=>
            new Uint8Array(l), writeBytes: ()=>{} },
    });
    return { classes, music };
}

test('the performance, the loader and the DirectMusic object are classes', ()=>{
    const { classes, music } = registered();
    assert.equal(typeof music.tick, 'function');
    assert.ok(classes.has(CLSID_DIRECTMUSIC_PERFORMANCE));
    assert.ok(classes.has(CLSID_DIRECTMUSIC_LOADER));
    assert.ok(classes.has(CLSID_DIRECTMUSIC));
});

test('every Performance8 slot is in the order its header declares', ()=>{
    const { classes } = registered();
    const performance = /** @type {() => any} */ (
        classes.get(CLSID_DIRECTMUSIC_PERFORMANCE))();
    const byId = new Map(performance.interfaces.map((/** @type {any} */ i)=>[i.id, i.methods]));
    // IDirectMusicPerformance's 41 methods, then Performance8's 9.
    assert.equal(byId.get(IID_DIRECTMUSIC_PERFORMANCE).length, 41);
    assert.equal(byId.get(IID_DIRECTMUSIC_PERFORMANCE8).length, 50);
    assert.equal(byId.get(IID_DIRECTMUSIC_PERFORMANCE8)[41].name, 'InitAudio');
    assert.equal(byId.get(IID_DIRECTMUSIC_PERFORMANCE8)[42].name, 'PlaySegmentEx');
    assert.equal(byId.get(IID_DIRECTMUSIC_PERFORMANCE)[0].name, 'Init');
});

test('every Loader8 slot is in the order its header declares', ()=>{
    const { classes } = registered();
    const loader = /** @type {() => any} */ (classes.get(CLSID_DIRECTMUSIC_LOADER))();
    const loaders = new Map(loader.interfaces.map((/** @type {any} */ i)=>[i.id, i.methods]));
    assert.equal(loaders.get(IID_DIRECTMUSIC_LOADER).length, 9);
    assert.equal(loaders.get(IID_DIRECTMUSIC_LOADER8).length, 12);
    assert.equal(loaders.get(IID_DIRECTMUSIC_LOADER8)[11].name, 'LoadObjectFromFile');
});

test('the DirectMusic object answers both generations', ()=>{
    const { classes } = registered();
    const made = /** @type {() => any} */ (classes.get(CLSID_DIRECTMUSIC))();
    const byId = new Map(made.interfaces.map((/** @type {any} */ i)=>[i.id, i.methods]));
    assert.equal(byId.get(IID_DIRECTMUSIC).length, 9);
    assert.equal(byId.get(IID_DIRECTMUSIC8).length, 10);
    assert.equal(byId.get(IID_DIRECTMUSIC8)[9].name, 'SetExternalMasterClock');
});

test('the DirectMusic object has a default port, which it creates and activates', ()=>{
    const bytes = new Uint8Array(0x1000);
    /** @type {any[]} */
    const published = [];
    /** @type {Map<string, () => any>} */
    const classes = new Map();
    registerDirectMusic({
        registry: { registerClass: (clsid, factory)=>classes.set(clsid, factory) },
        divergence: ()=>{},
        memory: {
            readBytes: (/** @type {number} */ at, /** @type {number} */ length)=>
                bytes.slice(at, at + length),
            writeBytes: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>
                bytes.set(data, at),
        },
        publishInterface: (/** @type {any} */ object)=>published.push(object) * 0x100,
    });
    const view = new DataView(bytes.buffer);
    const made = /** @type {() => any} */ (classes.get(CLSID_DIRECTMUSIC))();
    const methods = made.interfaces.find((/** @type {any} */ i)=>i.id === IID_DIRECTMUSIC).methods;
    /** @param {any[]} list @param {string} name @param {number[]} args */
    const call = (list, name, args)=>list.find(m=>m.name === name).invoke(null, args);

    assert.equal(call(methods, 'GetDefaultPort', [0x10]), 0);
    assert.equal(readGuid(/** @type {any} */ ({ readMemory: (/** @type {number} */ at,
        /** @type {number} */ length)=>bytes.slice(at, at + length) }), 0x10),
    CLSID_DIRECTMUSIC_SYNTH);

    view.setUint32(0x100, DMUS_PORTCAPS.SIZE, true);
    assert.equal(call(methods, 'EnumPort', [0, 0x100]), 0);
    assert.equal(view.getUint32(0x100 + DMUS_PORTCAPS.dwClass, true), 1, 'an output port');
    assert.equal(call(methods, 'EnumPort', [1, 0x100]), 1, 'S_FALSE past the one port');

    assert.equal(call(methods, 'CreatePort', [0x10, 0, 0x20, 0]), 0);
    assert.equal(view.getUint32(0x20, true), 0x100);
    const port = published[0].interfaceFor(IID_DIRECTMUSIC_PORT).methods.slice(3);
    // IDirectMusicPort's seventeen methods after IUnknown (dmusicc.h), Activate the
    // thirteenth: vtable slot 15, where a program calls it.
    assert.equal(port.length, 17);
    assert.equal(port[12].name, 'Activate');
    assert.equal(call(port, 'Activate', [1]), 0);
    assert.equal(call(methods, 'CreatePort', [0x10, 0, 0x20, 0x44]), 0x80040110 | 0,
        'no aggregation');
});
