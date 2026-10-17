/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWriteClock } from './write-clock.js';

/**
 * The engine's marks, as cork keeps them: a page armed, or written since it
 * was armed; one never armed is taken as written. `unwatched` pages are always
 * taken, as a stack's are while its stores go untested.
 */
function marks(){
    /** @type {Map<number, 'armed' | 'written'>} */
    const state = new Map();
    const unwatched = new Set();
    const epochs = [0, 0, 0];
    return {
        epochs,
        unwatched,
        /** A store that tested its page now: the mark, if the page is armed. @param {number} page */
        tested(page){
            if (state.get(page) === 'armed')
            {
                state.set(page, 'written');
            }
        },
        /** @param {number} address @param {number} length */
        take(address, length){
            /** @type {number[]} */
            const written = [];
            for (let page = address >>> 12; page <= (address + length - 1) >>> 12; page++)
            {
                if (unwatched.has(page) || state.get(page) !== 'armed')
                {
                    written.push(page);
                }
                state.set(page, 'armed');
            }
            return written;
        },
    };
}

/** @param {ReturnType<typeof marks>} engine */
const clockOver = engine=>createWriteClock({ take: engine.take, epochs: ()=>engine.epochs });

test('a watch takes the pages written since its last look at them, and only those', ()=>{
    const engine = marks();
    const clock = clockOver(engine);
    const watch = clock.watch(0x10000, 4 * 4096);
    assert.deepEqual(watch.take(0x10000, 4 * 4096), [], 'nothing since the watch began');
    engine.tested(0x11);
    engine.tested(0x13);
    assert.deepEqual(watch.take(0x10000, 4 * 4096), [0x11, 0x13]);
    assert.deepEqual(watch.take(0x10000, 4 * 4096), [], 'each once');
    engine.tested(0x12);
    assert.deepEqual(watch.take(0x10000, 4096), [], 'a range the write is not in');
    assert.deepEqual(watch.take(0x12000, 1), [0x12], 'kept for the look that covers it');
    assert.deepEqual(watch.take(0x0, 0x100000), [], 'clipped to the watch');
});

test('two watches over one page each find a write the other took first', ()=>{
    // Two small buffers in one page: a draw from one armed the page again,
    // and the other's next draw found it clean and sent stale bytes.
    const engine = marks();
    const clock = clockOver(engine);
    const one = clock.watch(0x20000, 0x1800);
    const two = clock.watch(0x21800, 0x1800);
    engine.tested(0x21);
    assert.deepEqual(one.take(0x20000, 0x1800), [0x21]);
    assert.deepEqual(two.take(0x21800, 0x1800), [0x21], 'the other\'s look did not wipe it');
    assert.deepEqual(one.take(0x20000, 0x1800), []);
    assert.deepEqual(two.take(0x21800, 0x1800), []);
    // A watch begun later wipes no mark either.
    engine.tested(0x22);
    clock.watch(0x22000, 16);
    assert.deepEqual(two.take(0x21800, 0x1800), [0x22]);
});

test('a page armed while another executor ran is taken until that run has ended, once more', ()=>{
    // The store tested its page while the page was marked written, so marked
    // nothing; a look armed the page; then the store landed, unmarked.
    const engine = marks();
    const clock = clockOver(engine);
    const watch = clock.watch(0x30000, 4096);
    engine.tested(0x30);
    engine.epochs[2] = 7;
    assert.deepEqual(watch.take(0x30000, 4096), [0x30]);
    assert.equal(clock.unsettled(), 1);
    // The store lands now, and others of the same run after it.
    assert.deepEqual(watch.take(0x30000, 4096), [0x30], 'its run still on');
    assert.deepEqual(watch.take(0x30000, 4096), [0x30], 'and on');
    engine.epochs[2] = 8;
    assert.deepEqual(watch.take(0x30000, 4096), [0x30], 'its run over: one last look');
    assert.equal(clock.unsettled(), 0);
    assert.deepEqual(watch.take(0x30000, 4096), []);

    // A run begun after the arming tests the armed page and marks it itself.
    engine.epochs[1] = 3;
    engine.tested(0x30);
    assert.deepEqual(watch.take(0x30000, 4096), [0x30]);
    engine.epochs[1] = 4;
    engine.epochs[2] = 9;
    assert.deepEqual(watch.take(0x30000, 4096), [0x30], 'executor 1 ended its run');
    assert.deepEqual(watch.take(0x30000, 4096), [], 'executor 2\'s run began after the arming');
});

test('with no executor running at the arming, a page is taken once', ()=>{
    const engine = marks();
    const clock = clockOver(engine);
    const watch = clock.watch(0x40000, 4096);
    engine.tested(0x40);
    assert.deepEqual(watch.take(0x40000, 4096), [0x40]);
    assert.equal(clock.unsettled(), 0);
    assert.deepEqual(watch.take(0x40000, 4096), []);
});

test('a page the engine cannot watch is taken at every look', ()=>{
    const engine = marks();
    engine.unwatched.add(0x51);
    const clock = clockOver(engine);
    const watch = clock.watch(0x50000, 2 * 4096);
    assert.deepEqual(watch.take(0x50000, 2 * 4096), [0x51]);
    assert.deepEqual(watch.take(0x50000, 2 * 4096), [0x51]);
});
