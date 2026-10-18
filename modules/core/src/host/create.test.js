/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whenDetached } from './create.js';

/**
 * A clock and a queue of timers driven by hand, and a canvas whose place in
 * the page is set by the test.
 */
function rig(){
    let clock = 0;
    /** @type {{ at: number, then: () => void, id: number }[]} */
    let timers = [];
    let ids = 0;
    const canvas = { isConnected: true };
    let gone = 0;
    let idles = 0;
    const using = {
        wait: 10_000,
        every: 5000,
        now: ()=>clock,
        later: (/** @type {() => void} */ then, /** @type {number} */ ms)=>{
            const id = ++ids;
            timers.push({ at: clock + ms, then, id });
            return id;
        },
        cancel: (/** @type {number} */ id)=>{
            timers = timers.filter(timer=>timer.id !== id);
        },
        idle: (/** @type {() => void} */ then)=>{
            idles++;
            then();
        },
    };
    /** Moves the clock on, running each timer that falls due. @param {number} ms */
    const advance = ms=>{
        const until = clock + ms;
        for (;;)
        {
            const due = timers.filter(timer=>timer.at <= until).sort((a, b)=>a.at - b.at)[0];
            if (!due)
            {
                break;
            }
            timers = timers.filter(timer=>timer !== due);
            clock = due.at;
            due.then();
        }
        clock = until;
    };
    const stop = whenDetached(canvas, ()=>gone++, using);
    return { canvas, advance, stop, gone: ()=>gone, idles: ()=>idles, pending: ()=>timers.length };
}

test('a canvas out of the page ten seconds on end lets its host go, once', ()=>{
    const r = rig();
    r.advance(60_000);
    assert.equal(r.gone(), 0, 'in the page, nothing happens');
    r.canvas.isConnected = false;
    r.advance(9_000);
    assert.equal(r.gone(), 0, 'out of it for less than the wait');
    r.canvas.isConnected = true;
    r.advance(20_000);
    assert.equal(r.gone(), 0, 'back in the page starts the wait again');
    r.canvas.isConnected = false;
    r.advance(16_000);
    assert.equal(r.gone(), 1, 'out of it for the whole wait');
    r.advance(60_000);
    assert.equal(r.gone(), 1, 'and only once');
    assert.equal(r.pending(), 0, 'nothing left scheduled');
    assert.ok(r.idles() > 0, 'each look waits for the page to be idle');
});

test('a watch stopped, as a program starting on the canvas stops it, never fires', ()=>{
    const r = rig();
    r.canvas.isConnected = false;
    r.advance(5_000);
    r.stop();
    r.advance(60_000);
    assert.equal(r.gone(), 0);
    assert.equal(r.pending(), 0);
});

test('a canvas that cannot say where it is is not watched', ()=>{
    let gone = 0;
    const stop = whenDetached({}, ()=>gone++);
    stop();
    assert.equal(gone, 0);
});
