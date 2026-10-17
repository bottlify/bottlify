/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPresentQueue, createRaster } from './raster.js';

/** A raster at 60 Hz, or `rate`, over 480 lines, on a clock the test sets. */
function clocked(rate = 60){
    let time = 0;
    const raster = createRaster({ now: ()=>time, refresh: ()=>rate, height: ()=>480 });
    return {
        raster,
        /** @param {number} ms */
        at(ms){
            time = ms;
            return raster.position();
        },
        /** @param {number} ms */
        advance(ms){
            time += ms;
        },
        now: ()=>time,
    };
}

test('the beam runs down the frame once per refresh and spends the last lines in the blank',
    ()=>{
        const c = clocked();
        const period = 1000 / 60;
        assert.deepEqual(c.at(0), { line: 0, inBlank: false }, 'a frame starts at the top');
        assert.equal(c.at(period / 2).line, 262, 'half a frame is half of its 525 lines');
        assert.equal(c.at(period * 479.5 / 525).inBlank, false, 'the last visible line');
        assert.deepEqual(c.at(period * 500 / 525), { line: 500, inBlank: true });
        assert.deepEqual(c.at(period * 7 + 1), c.at(1), 'and again the next frame');
    });

test('a wait for the blank lands inside it, and a wait for its end on the next frame\'s top',
    ()=>{
        const c = clocked();
        const period = 1000 / 60;
        c.at(2);
        c.advance(c.raster.untilBlank('begin'));
        assert.equal(c.raster.position().inBlank, true);
        assert.equal(c.raster.position().line, 480, 'at its first line');
        assert.ok(c.raster.untilBlank('begin') > period - 1,
            'already at the edge, the edge named is the next frame\'s');

        c.advance(c.raster.untilBlank('end'));
        assert.deepEqual(c.raster.position(), { line: 0, inBlank: false });
        assert.ok(Math.abs(c.now() % period) < 0.01);
    });

/**
 * A program presenting a frame every `frameMs` for `seconds` under an
 * interval, its thread stopped as each Present says: how many frames a
 * second it made.
 *
 * @param {number} rate @param {number} frameMs @param {number} interval
 * @param {number} [seconds]
 */
function framesPerSecond(rate, frameMs, interval, seconds = 10){
    const c = clocked(rate);
    const presents = createPresentQueue(c.raster);
    c.at(0.3);
    let frames = 0;
    while (c.now() < seconds * 1000)
    {
        c.advance(frameMs);
        c.advance(presents.present(c.now(), interval));
        frames++;
    }
    return frames / seconds;
}

test('a Present queues its frame for a blank and stops the thread only with three waiting', ()=>{
    // D3DPRESENT_INTERVAL_DEFAULT and ONE beat-sync presentation to the
    // display's retrace, as a flip chain does: the frame is shown at the
    // first blank after the one before it, and the thread goes on until the
    // frames waiting fill the queue.
    const c = clocked();
    const presents = createPresentQueue(c.raster);
    c.at(1);
    const period = 1000 / 60;
    const first = c.raster.blankAt(1);
    assert.ok(first > 1 && first <= 1 + period);
    assert.deepEqual([0, 1, 2].map(()=>presents.present(1, 0)), [0, 0, 0],
        'three frames wait at once');
    const wait = presents.present(1, 1);
    assert.ok(Math.abs(wait - (first - 1)) < 0.01, 'a fourth waits for the first to be shown');
    assert.equal(presents.present(1, 0x80000000), 0, 'IMMEDIATE waits for none');
});

test('under the queue a program faster than the display keeps its rate, and a slower one its own',
    ()=>{
        // A frame of 12.5 ms on a 120 Hz display: stopped until the next blank at
        // every Present, it missed one blank in two and ran at 60.
        assert.ok(Math.abs(framesPerSecond(120, 12.5, 0) - 80) < 1, 'its own 80');
        assert.ok(Math.abs(framesPerSecond(120, 2, 0) - 120) < 1, 'the display\'s 120');
        assert.ok(Math.abs(framesPerSecond(120, 2, 2) - 60) < 1, 'TWO, every second blank');
        assert.ok(Math.abs(framesPerSecond(60, 2, 8) - 15) < 1, 'FOUR, every fourth');
        assert.ok(framesPerSecond(120, 2, 0x80000000) > 400, 'IMMEDIATE, unpaced');
    });
