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
