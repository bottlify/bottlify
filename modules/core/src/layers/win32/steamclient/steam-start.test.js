/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    STEAM_START, STEAM_START_FILE, STEAM_START_LOCK, STEAM_START_POSTED, STEAM_START_READY,
    createSteamStart,
} from './steam-start.js';

/** A kernel that records what is made and set, and a view over plain bytes. */
function setup(apps = [361420]){
    /** @type {any[]} */
    const set = [];
    const kernel = {
        createEvent: (/** @type {any} */ options)=>({ ...options, kind: 'event' }),
        setEvent: (/** @type {any} */ object)=>set.push(object),
    };
    const start = createSteamStart({ kernel, owns: app=>apps.includes(app) });
    const bytes = new Uint8Array(STEAM_START.SIZE);
    const view = new DataView(bytes.buffer);
    /** @type {(() => void) | null} */
    let tick = null;
    const requester = { name: 'the wrapper\'s', kind: 'event' };
    const served = {
        read: (/** @type {number} */ at, /** @type {number} */ count)=>bytes.slice(at, at + count),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>bytes.set(data, at),
        event: (/** @type {number} */ handle)=>(handle === 0x7c ? requester : null),
        every: (/** @type {number} */ _ms, /** @type {() => void} */ fn)=>{
            tick = fn;
            return ()=>{
                tick = null;
            };
        },
    };
    /** What the wrapper writes, then REQUEST. @param {number} app */
    const post = app=>{
        view.setUint32(STEAM_START.PROCESS, 0x2008, true);
        view.setBigUint64(STEAM_START.EVENT, 0x7cn, true);
        view.setUint32(STEAM_START.APP, app, true);
        bytes[STEAM_START.CODE] = 0x36;
        view.setUint32(STEAM_START.REQUEST, STEAM_START_POSTED, true);
    };
    return { start, set, bytes, view, served, post, requester,
        tick: ()=>tick?.(), watching: ()=>tick !== null };
}

test('the client offers its lock, signalled and auto-reset, and its section, ready', ()=>{
    const { start } = setup();
    const lock = start.provide(STEAM_START_LOCK, 'event');
    assert.equal(lock.manualReset, false);
    assert.equal(lock.signalled, true);
    assert.equal(start.provide(STEAM_START_LOCK, 'event'), lock, 'one lock');
    assert.equal(start.provide(STEAM_START_LOCK, 'mutex'), null, 'and only as an event');
    const section = start.provide(STEAM_START_FILE, 'mapping');
    assert.equal(section.size, STEAM_START.SIZE);
    assert.equal(new DataView(section.contents().buffer).getUint32(STEAM_START.READY, true),
        STEAM_START_READY);
    assert.equal(new DataView(section.contents().buffer).getUint32(STEAM_START.REQUEST, true), 0);
    assert.equal(start.provide('Local\\SomethingElse', 'mapping'), null);
});

test('a request for an owned app is answered on the wrapper\'s event; the lock is given back',
    ()=>{
        const { start, set, view, served, post, requester, tick, watching } = setup();
        const lock = start.provide(STEAM_START_LOCK, 'event');
        const stop = start.provide(STEAM_START_FILE, 'mapping').watch(served);
        tick();
        assert.deepEqual(set, [], 'nothing posted, nothing done');
        post(361420);
        tick();
        assert.deepEqual(set, [requester, lock]);
        assert.equal(view.getUint32(STEAM_START.REQUEST, true), 0, 'the request taken');
        assert.deepEqual(start.requests(),
            [{ app: 361420, process: 0x2008, code: 0x36, answered: true }]);
        stop();
        assert.equal(watching(), false, 'unmapped, no longer watched');
    });

test('a request for an app the account does not own is not answered', ()=>{
    const { start, set, view, served, post, tick } = setup([480]);
    const lock = start.provide(STEAM_START_LOCK, 'event');
    start.provide(STEAM_START_FILE, 'mapping').watch(served);
    post(361420);
    tick();
    assert.deepEqual(set, [lock], 'only the lock given back: the wrapper\'s wait runs out');
    assert.equal(view.getUint32(STEAM_START.REQUEST, true), 0);
    assert.equal(start.requests()[0].answered, false);
});
