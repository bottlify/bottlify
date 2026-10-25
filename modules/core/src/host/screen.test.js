/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canFullscreen, exitFullscreen, fullscreenElement, keepScreenAwake, requestFullscreen,
    watchFullscreen } from './screen.js';

/** A page: its listeners, its visibility, and an element in fullscreen by some name. */
function page(){
    /** @type {Map<string, Set<() => void>>} */
    const handlers = new Map();
    const doc = {
        visibilityState: 'visible',
        /** @type {any} */ fullscreenElement: undefined,
        /** @type {any} */ webkitFullscreenElement: undefined,
        exits: 0,
        /** @param {string} type @param {() => void} handler */
        addEventListener(type, handler){
            handlers.set(type, (handlers.get(type) ?? new Set()).add(handler));
        },
        /** @param {string} type @param {() => void} handler */
        removeEventListener(type, handler){
            handlers.get(type)?.delete(handler);
        },
        /** @param {string} type */
        fire(type){
            for (const handler of [...handlers.get(type) ?? []])
            {
                handler();
            }
        },
        count: ()=>[...handlers.values()].reduce((total, set)=>total + set.size, 0),
    };
    return doc;
}

/** A wake lock that grants, and counts what it was asked for and let go of. */
function wakeLock(){
    const lock = {
        asked: 0,
        /** @type {any[]} */ granted: [],
        refuse: /** @type {string | null} */ (null),
        request(/** @type {string} */ type){
            assert.equal(type, 'screen');
            lock.asked++;
            if (lock.refuse)
            {
                return Promise.reject(new Error(lock.refuse));
            }
            const sentinel = { released: false, release(){
                sentinel.released = true;
                return Promise.resolve();
            } };
            lock.granted.push(sentinel);
            return Promise.resolve(sentinel);
        },
    };
    return lock;
}

const settle = ()=>new Promise(resolve=>setImmediate(resolve));

test('an element goes fullscreen by the standard name or by Safari\'s', async()=>{
    const standard = { calls: 0, requestFullscreen(){
        standard.calls++;
        return Promise.resolve();
    } };
    assert.equal(canFullscreen(standard), true);
    assert.deepEqual(await requestFullscreen(standard), { entered: true });
    assert.equal(standard.calls, 1);

    const webkit = { calls: 0, webkitRequestFullscreen(){
        webkit.calls++;
        return undefined;
    } };
    assert.equal(canFullscreen(webkit), true);
    assert.deepEqual(await requestFullscreen(webkit), { entered: true });
    assert.equal(webkit.calls, 1);
});

test('an iPhone\'s Safari has no fullscreen for an element, and a refusal is said', async()=>{
    assert.equal(canFullscreen({}), false);
    assert.deepEqual(await requestFullscreen({}), { entered: false, reason: 'unsupported' });
    const refusing = { requestFullscreen: ()=>Promise.reject(new TypeError('not in a gesture')) };
    assert.deepEqual(await requestFullscreen(refusing),
        { entered: false, reason: 'refused', message: 'not in a gesture' });
    const throwing = { webkitRequestFullscreen(){
        throw new Error('no');
    } };
    assert.deepEqual(await requestFullscreen(throwing),
        { entered: false, reason: 'refused', message: 'no' });
});

test('the element in fullscreen and its changes are read by either name', ()=>{
    const doc = page();
    const scope = { document: doc };
    assert.equal(fullscreenElement(scope), null);
    /** @type {any[]} */
    const seen = [];
    const stop = watchFullscreen(element=>seen.push(element), scope);
    doc.webkitFullscreenElement = 'stage';
    doc.fire('webkitfullscreenchange');
    doc.webkitFullscreenElement = undefined;
    doc.fullscreenElement = null;
    doc.fire('fullscreenchange');
    assert.deepEqual(seen, ['stage', null]);
    stop();
    assert.equal(doc.count(), 0);
});

test('leaving fullscreen uses the name the page has, and nothing when nothing is in it', ()=>{
    const doc = /** @type {any} */ (page());
    doc.webkitExitFullscreen = ()=>doc.exits++;
    exitFullscreen({ document: doc });
    assert.equal(doc.exits, 0);
    doc.webkitFullscreenElement = 'stage';
    exitFullscreen({ document: doc });
    assert.equal(doc.exits, 1);
});

test('a running program holds the screen lit, and asks again when the page is shown', async()=>{
    const doc = page();
    const lock = wakeLock();
    const awake = keepScreenAwake({ document: doc, navigator: { wakeLock: lock } });
    await settle();
    assert.equal(awake.held(), true);
    assert.equal(lock.asked, 1);

    // Hidden, the browser lets it go on its own; shown, it is asked for again.
    doc.visibilityState = 'hidden';
    lock.granted[0].released = true;
    doc.fire('visibilitychange');
    await settle();
    assert.equal(awake.held(), false);
    assert.equal(lock.asked, 1, 'not asked for while hidden');
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    await settle();
    assert.equal(awake.held(), true);
    assert.equal(lock.asked, 2);

    doc.fire('visibilitychange');
    await settle();
    assert.equal(lock.asked, 2, 'a lock still held is not asked for twice');
});

test('a paused run lets the screen dim; a released one lets go for good', async()=>{
    const doc = page();
    const lock = wakeLock();
    const awake = keepScreenAwake({ document: doc, navigator: { wakeLock: lock } });
    await settle();
    awake.pause();
    assert.equal(lock.granted[0].released, true);
    doc.fire('visibilitychange');
    await settle();
    assert.equal(awake.held(), false, 'paused stays paused when shown');
    awake.resume();
    await settle();
    assert.equal(awake.held(), true);
    awake.release();
    assert.equal(lock.granted[1].released, true);
    assert.equal(doc.count(), 0);
    awake.resume();
    await settle();
    assert.equal(lock.asked, 2, 'nothing after release');
});

test('a browser with no wake lock, or one that refuses, says so', async()=>{
    const none = keepScreenAwake({ document: page(), navigator: {} });
    assert.equal(none.refusal(), 'unsupported');
    assert.equal(none.held(), false);
    none.release();

    const lock = wakeLock();
    lock.refuse = 'the document is not visible';
    const doc = page();
    const refused = keepScreenAwake({ document: doc, navigator: { wakeLock: lock } });
    await settle();
    assert.equal(refused.held(), false);
    assert.equal(refused.refusal(), 'the document is not visible');

    // A browser that wants a gesture for it is asked again at the next one.
    lock.refuse = null;
    doc.fire('touchend');
    await settle();
    assert.equal(refused.held(), true);
    assert.equal(refused.refusal(), null);
    refused.release();
    assert.equal(doc.count(), 0);
});

test('a grant that arrives after the run let go is handed straight back', async()=>{
    const lock = wakeLock();
    const awake = keepScreenAwake({ document: page(), navigator: { wakeLock: lock } });
    awake.release();
    await settle();
    assert.equal(lock.granted.every(sentinel=>sentinel.released), true);
    assert.equal(awake.held(), false);
});
